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
// A browser round trip can fail for reasons that have nothing to do with the
// job: the extension is still warming up after a host restart, or one request
// gets dropped. Those are weather. The watcher rides them out and only gives up
// once the browser has been unreachable for this long without a single answer.
const UNREACHABLE_PATIENCE_MS = 5 * 60 * 1000;
// How many times a conversation may be reopened in a fresh tab before that
// theory is exhausted and the watcher just keeps polling what it has.
const MAX_REOPENS = 3;
const FAILURE_RETRY_MS = 2000;
// Errors that describe the job itself rather than the connection to the
// browser. Everything else is assumed transient until patience runs out.
// Registry codes belong here too: a record that refuses a transition is a
// verdict about the job, and retrying it just burns tabs for five minutes.
const FATAL_CODES = new Set([
  "auth",
  "cloudflare",
  "harvest_failed",
  "invalid_transition",
  "not_found",
  "unattributable",
]);
const TERMINAL_STATES = new Set(["captured", "failed"]);

/**
 * True when the job record can no longer receive this watcher's outcome:
 * already terminal, or gone entirely.
 *
 * A watcher that keeps working past this point cannot record anything, but can
 * still create a browser tab on every retry.
 */
function jobIsSettled(jobId) {
  try {
    return TERMINAL_STATES.has(oracleJobs.getJob(jobId).state);
  } catch (error) {
    return error?.code === "not_found";
  }
}

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
  // Pause after a failed browser step. Injectable so tests can exercise the
  // retry policy without sleeping through it.
  failureRetryMs = FAILURE_RETRY_MS,
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
      // Uncoded on purpose: a tab that failed to appear is a browser problem,
      // and the caller retries those.
      if (!tabInfo?.tabId) throw new Error("Failed to create ChatGPT tab");
      try {
        const cdp = (expression) => options.cdpEvaluate(tabInfo.tabId, expression);
        await options.cdpCommand(tabInfo.tabId, "Page.navigate", { url: job.conversationUrl });
        await chatgptClient.assertUsablePage(cdp, request.signal);
        return tabInfo.tabId;
      } catch (error) {
        // A tab that never became usable is not a recovery handle, it is
        // litter. Retries are unbounded in wall time, so leaking one per
        // attempt would bury the browser.
        await closeTab(request, tabInfo.tabId).catch(() => {});
        throw error;
      }
    });
    // Recording the tab is what makes it recoverable. If the record refuses the
    // write, the tab is unreachable litter, not a handle.
    try {
      oracleJobs.updateTabId(job.id, tabId);
    } catch (error) {
      await closeTab(request, tabId).catch(() => {});
      throw error;
    }
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
    const tracker = chatgptClient.createResponseTracker({
      baselineAssistant: job.baseline.latestAssistant,
      baselineAssistantCount: job.baseline.assistantCount,
    });

    let tabId = null;
    let unreachableSince = null;
    let reopens = 0;

    while (Date.now() < deadline) {
      try {
        // Tab acquisition lives inside the retry loop: right after a host
        // restart even listing tabs can time out, and that must not decide the
        // fate of an answer ChatGPT is already writing.
        if (tabId === null) tabId = await ensureConversationTab(job, request);
        job = await captureConversationUrl(job, tabId, request);
        const snapshot = await step(request, (options) =>
          chatgptClient.readChatGPTResponseSnapshot((expression) =>
            options.cdpEvaluate(tabId, expression),
          ),
        );
        // One clean round trip retires the whole failure theory, reopen budget
        // included: a tab that dies an hour from now deserves the same recovery
        // as one that died in the first minute.
        unreachableSince = null;
        reopens = 0;

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
      } catch (error) {
        if (error?.code === "SURF_REQUEST_ABORTED" || FATAL_CODES.has(error?.code)) throw error;
        // The job may have ended underneath this watcher — cancelled, or reaped
        // by another process. Then there is nothing left to harvest and nothing
        // to report; retrying would create a tab per cycle for the whole
        // patience window.
        if (jobIsSettled(jobId)) return;
        unreachableSince = unreachableSince ?? Date.now();
        // Patience is measured in wall time, not attempts: a 30s extension
        // timeout and an instant socket error must buy the same grace.
        if (Date.now() - unreachableSince >= UNREACHABLE_PATIENCE_MS) throw error;
        log(
          `[oracle:${jobId}:harvest] Browser step failed (${error?.message || error}); retrying`,
        );
        // A failing tab is the likeliest cause, so reopen the conversation from
        // its durable URL. Bounded, because if reopening is not helping either
        // the browser is the problem and new tabs only add noise.
        if (job.conversationUrl && reopens < MAX_REOPENS) {
          log(`[oracle:${jobId}:harvest] Reopening conversation in a fresh tab`);
          reopens++;
          // Give up the old tab explicitly. Nothing else will: this one was
          // usable when it was created, so the acquisition cleanup never sees it.
          if (tabId !== null) await closeTab(request, tabId).catch(() => {});
          tabId = null;
          job = { ...job, tabId: null };
        }
        await abortableDelay(failureRetryMs, request.signal);
        continue;
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

module.exports = {
  createHarvestSupervisor,
  HARVEST_DEADLINE_MS,
  MAX_REOPENS,
  POLL_IDLE_MS,
  UNREACHABLE_PATIENCE_MS,
};
