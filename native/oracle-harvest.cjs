const { abortableDelay } = require("./abort.cjs");
const chatgptClient = require("./chatgpt-client.cjs");
const oracleJobs = require("./oracle-jobs.cjs");

// Longest a single answer may take before the job is declared dead. Matches the
// ChatGPT provider request deadline; a supervisor that outlives this is stuck,
// not patient.
const HARVEST_DEADLINE_MS = 45 * 60 * 1000;
// Idle time between queued DOM probes. Each probe is one CDP evaluate, so the
// supervisor never holds the shared AI queue while waiting for the model.
const POLL_IDLE_MS = 1500;
// How often a live watcher writes its heartbeat, so the staleness reaper can
// tell a working harvest from an abandoned record without a write per poll.
const HEARTBEAT_MS = 60 * 1000;
const TERMINAL_STATES = new Set(["captured", "failed"]);

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

/**
 * Owns harvesting for dispatched oracle jobs.
 *
 * One supervisor per host process. Each watched job gets a detached loop that
 * polls ChatGPT through the shared AI queue in short bursts and drives the job
 * record to a terminal state (`captured` or `failed`) on its own. Clients only
 * read job state; nothing depends on a client staying connected.
 *
 * Dependencies are injected at construction: `queueAiRequest` serializes browser
 * work, `createBackgroundRequest` mints the request context that owns the
 * watcher's abort signal, and `browserOptions`/`closeTab` translate that context
 * into extension calls.
 */
function createHarvestSupervisor({
  queueAiRequest,
  createBackgroundRequest,
  browserOptions,
  closeTab,
  listTabs,
  log = () => {},
}) {
  const watchers = new Map();

  /** Run one bounded browser interaction under the shared AI queue. */
  const step = (request, operation) => queueAiRequest(() => operation(browserOptions(request)), request);

  const readConversationUrl = async (options, tabId) => {
    const href = await options.cdpEvaluate(tabId, "location.href");
    return chatgptClient.extractConversationUrl(href?.result?.value);
  };

  /**
   * Resolve a tab that shows this job's conversation.
   *
   * Prefers the dispatch tab; falls back to a fresh tab navigated to the durable
   * conversation URL. A job with neither is unrecoverable and fails loudly,
   * because its answer exists only in ChatGPT's web history.
   */
  async function ensureConversationTab(job, request) {
    if (job.tabId !== null && job.tabId !== undefined) {
      const tabs = await step(request, () => listTabs(request));
      if (Array.isArray(tabs) && tabs.some((tab) => tab?.id === job.tabId)) return job.tabId;
    }
    if (!job.conversationUrl) {
      throw codedError(
        "harvest_failed",
        `oracle job ${job.id} tab is no longer available; the response may still exist in ChatGPT web history but cannot be recovered without a conversation URL`,
      );
    }
    const tabId = await step(request, async (options) => {
      const tabInfo = await options.createTab();
      if (!tabInfo?.tabId) throw codedError("harvest_failed", "Failed to create ChatGPT tab");
      const cdp = (expression) => options.cdpEvaluate(tabInfo.tabId, expression);
      await options.cdpCommand(tabInfo.tabId, "Page.navigate", { url: job.conversationUrl });
      await chatgptClient.assertUsablePage(cdp, request.signal);
      return tabInfo.tabId;
    });
    oracleJobs.updateTabId(job.id, tabId);
    return tabId;
  }

  /**
   * Promote the job to `awaiting` once ChatGPT exposes a durable conversation
   * id. Until that swap happens the only recovery handle is the live tab, so
   * this is retried on every poll cycle rather than once.
   */
  async function captureConversationUrl(job, tabId, request) {
    if (job.conversationUrl) return job;
    const conversationUrl = await step(request, (options) => readConversationUrl(options, tabId));
    if (!conversationUrl) return job;
    return oracleJobs.markAwaiting(job.id, { conversationUrl, promptEcho: job.promptEcho });
  }

  /** Persist the answer, link it to its parent turn, and release the tab. */
  async function completeJob(job, response, tabId, request) {
    const captured = oracleJobs.markCaptured(job.id, { response: response.text });
    if (captured.follow) {
      oracleJobs.markTurnCaptured(captured.follow, {
        dispatchedAt: captured.dispatchedAt,
        capturedAt: captured.capturedAt,
        childJobId: captured.id,
        requestId: captured.requestId ?? null,
      });
    }
    if (tabId !== null && tabId !== undefined) {
      await closeTab(request, tabId).catch((error) => {
        log(`[oracle:${job.id}:harvest] Failed to close tab ${tabId}: ${error?.message || error}`);
      });
    }
  }

  /**
   * Drive one job from `dispatched`/`awaiting` to a terminal state.
   *
   * Every browser touch is an individual queued step; between steps the loop
   * sleeps outside the queue so other browser work is never blocked by a long
   * generation.
   */
  async function run(jobId, request) {
    const deadline = Date.now() + HARVEST_DEADLINE_MS;
    let job = oracleJobs.getJob(jobId);
    // Turn identity comes from the pre-send baseline. Without it the answer
    // cannot be attributed to this job at all, so fail now instead of spinning
    // until the deadline and then reporting an indistinguishable timeout.
    if (!job.baseline) {
      throw codedError(
        "unattributable",
        `oracle job ${jobId} has no dispatch baseline; its response cannot be identified`,
      );
    }

    // Claim the job before the first poll: resume() may be adopting a record
    // whose last state change is already older than the staleness cutoff.
    oracleJobs.touchHarvest(jobId);
    let nextHeartbeatAt = Date.now() + HEARTBEAT_MS;
    let tabId = await ensureConversationTab(job, request);
    const tracker = chatgptClient.createResponseTracker({
      baselineAssistant: job.baseline.latestAssistant,
      baselineAssistantCount: job.baseline.assistantCount,
    });
    let retriedFreshTab = false;

    while (Date.now() < deadline) {
      job = await captureConversationUrl(job, tabId, request);
      let snapshot;
      try {
        snapshot = await step(request, (options) =>
          chatgptClient.readChatGPTResponseSnapshot((expression) =>
            options.cdpEvaluate(tabId, expression),
          ),
        );
      } catch (error) {
        // A tab that dies mid-generation is recoverable exactly once, and only
        // through a durable conversation URL.
        if (error?.code === "SURF_REQUEST_ABORTED" || retriedFreshTab || !job.conversationUrl) throw error;
        log(`[oracle:${jobId}:harvest] Live tab failed (${error?.message || error}); reopening conversation`);
        retriedFreshTab = true;
        tabId = await ensureConversationTab({ ...job, tabId: null }, request);
        continue;
      }

      if (Date.now() >= nextHeartbeatAt) {
        oracleJobs.touchHarvest(jobId);
        nextHeartbeatAt = Date.now() + HEARTBEAT_MS;
      }

      const response = tracker.ingest(snapshot);
      if (response) {
        log(`[oracle:${jobId}:harvest] Response captured (${response.text.length} chars)`);
        await completeJob(job, response, tabId, request);
        return;
      }
      await abortableDelay(POLL_IDLE_MS, request.signal);
    }

    throw codedError("timeout", `oracle job ${jobId} did not finish within the harvest deadline`);
  }

  /** Record the failure on the job and drop its tab, unless it already ended. */
  async function failJob(jobId, error, request) {
    const current = oracleJobs.getJob(jobId);
    if (TERMINAL_STATES.has(current.state)) return;
    oracleJobs.markFailed(jobId, {
      code: error?.code || "harvest_failed",
      message: error?.message || String(error),
    });
    if (current.tabId !== null && current.tabId !== undefined) {
      await closeTab(request, current.tabId).catch(() => {});
    }
  }

  return {
    /**
     * Start (or join) the watcher for a job. The returned promise resolves when
     * the job reaches a terminal state; it never rejects, because failures are
     * recorded on the job itself.
     */
    watch(jobId) {
      const existing = watchers.get(jobId);
      if (existing) return existing.promise;
      const request = createBackgroundRequest(`oracle.harvest:${jobId}`);
      const promise = run(jobId, request)
        .catch(async (error) => {
          // An aborted watcher was cancelled deliberately; the canceller owns
          // the job's terminal state.
          if (error?.code === "SURF_REQUEST_ABORTED") return;
          log(`[oracle:${jobId}:harvest] Failed: ${error?.message || error}`);
          await failJob(jobId, error, request).catch((failure) => {
            log(`[oracle:${jobId}:harvest] Could not record failure: ${failure?.message || failure}`);
          });
        })
        .finally(() => watchers.delete(jobId));
      watchers.set(jobId, { promise, request });
      return promise;
    },

    /** Stop watching a job; the caller decides what terminal state it gets. */
    cancel(jobId) {
      const watcher = watchers.get(jobId);
      if (!watcher) return false;
      watcher.request.abort(codedError("SURF_REQUEST_ABORTED", `oracle job ${jobId} cancelled`));
      return true;
    },

    /**
     * Abort every watcher and wait for the loops to unwind. Job records are left
     * exactly as they are, so a restarted host resumes them unchanged.
     */
    async stop() {
      const pending = [...watchers.values()];
      for (const watcher of pending) {
        watcher.request.abort(codedError("SURF_REQUEST_ABORTED", "oracle harvest stopped"));
      }
      await Promise.all(pending.map((watcher) => watcher.promise));
    },

    /**
     * Wait up to `timeoutMs` for a watched job to settle. Resolves either way;
     * callers re-read the job record to learn the outcome.
     */
    async wait(jobId, timeoutMs) {
      const watcher = watchers.get(jobId);
      if (!watcher) return;
      let timer;
      const expiry = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([watcher.promise, expiry]);
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Resume harvesting for jobs left non-terminal by a previous host process.
     *
     * Jobs still in `created` never got as far as a send; nothing can advance
     * them, so they are failed immediately instead of holding capacity.
     */
    resume() {
      const orphans = oracleJobs.adoptOrphans();
      for (const job of orphans) {
        if (job.state === "created") {
          oracleJobs.markFailed(job.id, {
            code: "dispatch_failed",
            message: `oracle job ${job.id} was never dispatched; the host restarted first`,
          });
          continue;
        }
        this.watch(job.id);
      }
      return orphans.map((job) => job.id);
    },
  };
}

module.exports = { createHarvestSupervisor, HARVEST_DEADLINE_MS, POLL_IDLE_MS };
