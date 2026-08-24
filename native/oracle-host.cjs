const chatgptClient = require("./chatgpt-client.cjs");
const { createHarvestSupervisor } = require("./oracle-harvest.cjs");
const oracleJobs = require("./oracle-jobs.cjs");

const TERMINAL_STATES = new Set(["captured", "failed"]);

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertLocalOracleRequest(request) {
  if (request?.context?.isRemote) {
    throw codedError("remote_unsupported", "oracle tools are not supported for remote clients");
  }
}

function withJobId(error, jobId, fallbackCode) {
  const result = error instanceof Error ? error : new Error(String(error));
  if (!result.code) result.code = fallbackCode;
  result.jobId = jobId;
  return result;
}

/**
 * Oracle tool surface: creates jobs, dispatches them into ChatGPT, and reads
 * back state that the harvest supervisor produces on its own.
 *
 * `createBackgroundRequest(label)` must return a request context that outlives
 * the client request which created the job; the supervisor uses it to keep
 * talking to the browser after `oracle.ask` has already answered.
 */
function createOracleHost({
  queueAiRequest,
  requestCallExtension,
  createBackgroundRequest,
  buildProviderUploadMessage,
  log,
}) {
  const closeTab = (request, tabId) => requestCallExtension(
    request,
    "close_tab",
    { type: "CHATGPT_CLOSE_TAB", tabId },
    45000,
    true,
  );

  const browserOptions = (request) => ({
    signal: request.signal,
    getCookies: () => requestCallExtension(
      request,
      "get_cookies",
      { type: "GET_CHATGPT_COOKIES" },
    ),
    createTab: () => requestCallExtension(
      request,
      "create_tab",
      { type: "CHATGPT_NEW_TAB" },
    ),
    closeTab: (tabId) => closeTab(request, tabId),
    cdpEvaluate: (tabId, expression) => requestCallExtension(
      request,
      "cdp_evaluate",
      { type: "CHATGPT_EVALUATE", tabId, expression },
    ),
    cdpCommand: (tabId, method, params) => requestCallExtension(
      request,
      "cdp_command",
      { type: "CHATGPT_CDP_COMMAND", tabId, method, params },
    ),
    uploadFile: (tabId, filePaths) => requestCallExtension(
      request,
      "upload_file",
      buildProviderUploadMessage("chatgpt", tabId, filePaths),
    ),
  });

  const listTabs = async (request) => {
    const result = await requestCallExtension(request, "list_tabs", { type: "LIST_TABS" });
    if (result?.error) throw new Error(result.error);
    return result?.tabs;
  };

  const supervisor = createHarvestSupervisor({
    queueAiRequest,
    createBackgroundRequest,
    browserOptions,
    closeTab,
    listTabs,
    log,
  });

  async function ask(request, args) {
    assertLocalOracleRequest(request);
    const model = args.model ? chatgptClient.normalizeChatGPTModelChoice(args.model) : null;
    const created = oracleJobs.createJob({
      prompt: args.prompt,
      contextManifest: args.contextManifest,
      model,
      effortRequested: args.effort ?? null,
      follow: args.follow ?? null,
      requestId: args.requestId ?? null,
    });
    if (created.requestDeduped) return oracleJobs.getJob(created.id);
    let createdTabId = null;

    try {
      let parent = null;
      if (args.follow) {
        parent = oracleJobs.getJob(args.follow);
        if (parent.state !== "captured" || !parent.conversationUrl) {
          throw codedError(
            "invalid_transition",
            `oracle follow parent ${parent.id} must be captured; current state: ${parent.state}`,
          );
        }
      }

      const dispatched = await queueAiRequest(() => chatgptClient.dispatch({
        ...browserOptions(request),
        prompt: args.prompt,
        model,
        effort: args.effort,
        file: args.bundlePath,
        startUrl: parent?.conversationUrl,
        createTab: async () => {
          const tabInfo = await browserOptions(request).createTab();
          createdTabId = tabInfo?.tabId || null;
          return tabInfo;
        },
        afterSubmit: ({ tabId, promptEcho, modelVerified, effortVerified, baseline }) => {
          const dispatchedJob = oracleJobs.markDispatched(created.id, {
            tabId,
            promptEcho,
            modelVerified,
            effortVerified,
            baseline,
          });
          if (parent) {
            oracleJobs.appendTurn(parent.id, {
              prompt: args.prompt,
              dispatchedAt: dispatchedJob.dispatchedAt,
              childJobId: created.id,
              requestId: args.requestId ?? null,
            });
          }
        },
        log: (message) => log(`[oracle:${created.id}:dispatch] ${message}`),
      }), request);

      if (dispatched.conversationUrl) {
        oracleJobs.markAwaiting(created.id, {
          conversationUrl: dispatched.conversationUrl,
          promptEcho: dispatched.promptEcho,
        });
      }
      // Harvesting belongs to the host from here on: the answer is captured
      // even if this client never asks for it again.
      supervisor.watch(created.id);
      return oracleJobs.getJob(created.id);
    } catch (error) {
      const current = oracleJobs.getJob(created.id);
      // Once the job leaves `created` the prompt is already in ChatGPT. Hand it
      // to the supervisor and report the failure as recoverable instead of
      // discarding an answer that is on its way.
      if (
        error?.code !== "SURF_REQUEST_ABORTED"
        && (current.state === "dispatched" || current.state === "awaiting")
      ) {
        supervisor.watch(created.id);
        const recoverable = withJobId(error, created.id, "dispatch_failed");
        recoverable.recoverable = true;
        throw recoverable;
      }
      if (error?.code !== "SURF_REQUEST_ABORTED" && !TERMINAL_STATES.has(current.state)) {
        oracleJobs.markFailed(created.id, {
          code: error?.code || "dispatch_failed",
          message: error?.message || String(error),
        });
      }
      const keepForManualClearance = ["auth", "cloudflare"].includes(error?.code)
        && current.state === "created";
      if (
        createdTabId
        && !keepForManualClearance
        && (error?.code !== "SURF_REQUEST_ABORTED" || current.state === "created")
      ) {
        await closeTab(request, createdTabId).catch(() => {});
      }
      throw withJobId(error, created.id, "dispatch_failed");
    }
  }

  function status(request, args) {
    assertLocalOracleRequest(request);
    if (args.id) return oracleJobs.getJob(args.id);
    const newest = oracleJobs.listJobs({ limit: 1 })[0];
    if (!newest) throw codedError("not_found", "no oracle jobs found");
    return newest;
  }

  function list(request) {
    assertLocalOracleRequest(request);
    return oracleJobs.listJobs({});
  }

  /**
   * Read a job's outcome, waiting for the supervisor if it is still working.
   *
   * This never harvests itself: the supervisor owns the browser loop, so a
   * client that gives up costs nothing and a client that keeps polling sees the
   * result within one poll cycle of the answer settling.
   */
  async function result(request, args) {
    assertLocalOracleRequest(request);
    let job = oracleJobs.getJob(args.id);
    if (job.state === "created") return job;
    if (!TERMINAL_STATES.has(job.state)) {
      // Adopt jobs whose watcher never started or died with the previous host.
      supervisor.watch(job.id);
      const requestedTimeout = Number(args.timeout);
      const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout * 1000
        : 300000;
      await supervisor.wait(job.id, timeout);
      job = oracleJobs.getJob(job.id);
    }
    if (job.state === "captured") {
      return { ...job, response: oracleJobs.getResponse(job.id) };
    }
    if (job.state === "failed") {
      throw codedError(job.error?.code || "harvest_failed", job.error?.message || "oracle job failed", {
        jobId: job.id,
      });
    }
    return job;
  }

  /**
   * Abandon a job on purpose: stop its watcher, record the cancellation, and
   * release both the tab and the single-job capacity slot.
   */
  async function cancel(request, args) {
    assertLocalOracleRequest(request);
    const job = oracleJobs.getJob(args.id);
    if (TERMINAL_STATES.has(job.state)) return job;
    supervisor.cancel(job.id);
    const cancelled = oracleJobs.markFailed(job.id, {
      code: "cancelled",
      message: `oracle job ${job.id} was cancelled`,
    });
    if (job.tabId !== null && job.tabId !== undefined) {
      await closeTab(request, job.tabId).catch(() => {});
    }
    return cancelled;
  }

  return {
    ask,
    assertLocal: assertLocalOracleRequest,
    /** Restart watchers for jobs the previous host process left behind. */
    resumeHarvest: () => supervisor.resume(),
    /** Abort every watcher without touching job records. */
    stopHarvest: () => supervisor.stop(),
    handle(request, message) {
      if (message.type === "ORACLE_ASK") return ask(request, message);
      if (message.type === "ORACLE_STATUS") return status(request, message);
      if (message.type === "ORACLE_RESULT") return result(request, message);
      if (message.type === "ORACLE_CANCEL") return cancel(request, message);
      if (message.type === "ORACLE_LIST") return list(request);
      throw new Error(`Unknown oracle request: ${message.type}`);
    },
  };
}

module.exports = { assertLocalOracleRequest, createOracleHost };
