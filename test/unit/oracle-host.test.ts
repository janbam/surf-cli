import { afterEach, vi } from "vitest";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
type ChatGptDispatchOptions = {
  startUrl?: string | null;
  createTab(): Promise<{ tabId?: number }>;
  afterSubmit(result: {
    tabId: number;
    promptEcho: string;
    modelVerified?: string;
    effortVerified?: string;
    baseline?: unknown;
  }): unknown;
};
const chatgptClient = require("../../native/chatgpt-client.cjs") as {
  dispatch(options: ChatGptDispatchOptions): Promise<{
    tabId: number;
    conversationUrl: string;
    promptEcho: string;
  }>;
  harvest(options: Record<string, unknown>): Promise<{ response: string }>;
};
const oracleJobs = require("../../native/oracle-jobs.cjs");
const { assertLocalOracleRequest, createOracleHost } = require("../../native/oracle-host.cjs");

const CONVERSATION_URL = "https://chatgpt.com/c/6a8c33e1-6ffc-83eb-9d17-0a69c51d45f8";
const EMPTY_BASELINE = { latestAssistant: null, assistantCount: 0, stopVisible: false };
const LOCAL_REQUEST = { context: { isRemote: false } };

const roots: string[] = [];
const hosts: Array<{ stopHarvest(): Promise<void> }> = [];
const originalStateDir = process.env.SURF_STATE_DIR;

function useTempState() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "surf-oracle-host-"));
  roots.push(parent);
  process.env.SURF_STATE_DIR = path.join(parent, "state");
  return process.env.SURF_STATE_DIR;
}

function createBackgroundRequest(label: string) {
  const controller = new AbortController();
  return {
    id: label,
    tool: label,
    startedAt: Date.now(),
    deadlineMs: 60000,
    controller,
    signal: controller.signal,
    context: { isRemote: false },
    abort: (reason?: unknown) => controller.abort(reason),
  };
}

/**
 * Extension bridge that keeps every started watcher alive but idle: the tab
 * exists and the conversation never settles, so background harvesting cannot
 * race the assertions in these tests.
 */
function idleBrowser(tabId = 7) {
  return vi.fn(async (_request: unknown, tool: string) => {
    if (tool === "list_tabs") {
      return { tabs: [{ id: tabId }] };
    }
    if (tool === "cdp_evaluate") {
      return { result: { value: { candidates: [], stopVisible: true } } };
    }
    if (tool === "cdp_command" || tool === "close_tab") {
      return {};
    }
    throw new Error(`Unexpected extension call: ${tool}`);
  });
}

function createHost(requestCallExtension: ReturnType<typeof vi.fn>) {
  const host = createOracleHost({
    queueAiRequest: (operation: () => unknown) => operation(),
    requestCallExtension,
    createBackgroundRequest,
    buildProviderUploadMessage: vi.fn(),
    log: vi.fn(),
  });
  hosts.push(host);
  return host;
}

function mockDispatch(
  overrides: Partial<{ tabId: number; conversationUrl: string; promptEcho: string }> = {},
) {
  const dispatched = {
    tabId: 7,
    conversationUrl: CONVERSATION_URL,
    promptEcho: "review",
    ...overrides,
  };
  return vi.spyOn(chatgptClient, "dispatch").mockImplementation(async (options) => {
    await options.afterSubmit({
      tabId: dispatched.tabId,
      promptEcho: dispatched.promptEcho,
      baseline: EMPTY_BASELINE,
    });
    return dispatched;
  });
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stopHarvest();
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (originalStateDir === undefined) {
    delete process.env.SURF_STATE_DIR;
  } else {
    process.env.SURF_STATE_DIR = originalStateDir;
  }
});

describe("oracle host request guard", () => {
  it("rejects the existing remote request context with a structured code", () => {
    expect(() => assertLocalOracleRequest({ context: { isRemote: true } })).toThrow(
      expect.objectContaining({
        code: "remote_unsupported",
        message: "oracle tools are not supported for remote clients",
      }),
    );
  });

  it("allows local request contexts", () => {
    expect(() => assertLocalOracleRequest({ context: { isRemote: false } })).not.toThrow();
  });
});

describe("oracle host dispatch", () => {
  it("persists the context manifest received by oracle.ask", async () => {
    const root = useTempState();
    mockDispatch();
    const host = createHost(idleBrowser());
    const contextManifest = { files: [{ path: "src/a.ts", bytes: 12 }] };

    const result = await host.handle(LOCAL_REQUEST, {
      type: "ORACLE_ASK",
      prompt: "review",
      contextManifest,
    });

    expect(result.state).toBe("awaiting");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(root, "oracle", result.id, "context-manifest.json"), "utf8"),
      ),
    ).toEqual(contextManifest);
  });

  // Turn identity for the later harvest is decided before the send; if the
  // baseline is not written here, nothing can attribute the answer afterwards.
  it("records the pre-send baseline as part of the dispatch", async () => {
    useTempState();
    mockDispatch();
    const host = createHost(idleBrowser());

    const job = await host.handle(LOCAL_REQUEST, { type: "ORACLE_ASK", prompt: "review" });

    expect(oracleJobs.getJob(job.id).baseline).toEqual(EMPTY_BASELINE);
  });

  it("deduplicates repeated oracle.ask requests by requestId", async () => {
    useTempState();
    const dispatch = mockDispatch();
    const host = createHost(idleBrowser());

    const first = await host.handle(LOCAL_REQUEST, {
      type: "ORACLE_ASK",
      prompt: "review",
      requestId: "request-1",
    });
    const duplicate = await host.handle(LOCAL_REQUEST, {
      type: "ORACLE_ASK",
      prompt: "review",
      requestId: "request-1",
    });

    expect(duplicate.id).toBe(first.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(
      host.handle(LOCAL_REQUEST, {
        type: "ORACLE_ASK",
        prompt: "different",
        requestId: "request-1",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", jobId: first.id });
  });

  it("records follow turns with child and request identity", async () => {
    useTempState();
    const parent = oracleJobs.createJob({ prompt: "first" });
    oracleJobs.markDispatched(parent.id, {
      tabId: 6,
      promptEcho: "first",
      baseline: EMPTY_BASELINE,
    });
    oracleJobs.markAwaiting(parent.id, {
      conversationUrl: CONVERSATION_URL,
      promptEcho: "first",
    });
    oracleJobs.markCaptured(parent.id, { response: "first answer" });
    vi.spyOn(chatgptClient, "dispatch").mockImplementation(async (options) => {
      expect(options.startUrl).toBe(CONVERSATION_URL);
      await options.afterSubmit({ tabId: 8, promptEcho: "follow", baseline: EMPTY_BASELINE });
      return { tabId: 8, conversationUrl: CONVERSATION_URL, promptEcho: "follow" };
    });
    const host = createHost(idleBrowser(8));

    const child = await host.handle(LOCAL_REQUEST, {
      type: "ORACLE_ASK",
      prompt: "follow",
      follow: parent.id,
      requestId: "follow-request",
    });

    expect(child).toMatchObject({ follow: parent.id, requestId: "follow-request" });
    expect(oracleJobs.getJob(parent.id).turns).toEqual([
      expect.objectContaining({
        prompt: "follow",
        childJobId: child.id,
        requestId: "follow-request",
      }),
    ]);
  });

  it("fails closed when a follow parent is missing", async () => {
    useTempState();
    const dispatch = vi.spyOn(chatgptClient, "dispatch").mockResolvedValue({
      tabId: 7,
      conversationUrl: CONVERSATION_URL,
      promptEcho: "follow",
    });
    const host = createHost(idleBrowser());

    await expect(
      host.handle(LOCAL_REQUEST, {
        type: "ORACLE_ASK",
        prompt: "follow",
        follow: "20260729-120000-dead",
        requestId: "missing-parent",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves Cloudflare challenge tabs open for manual clearance", async () => {
    useTempState();
    vi.spyOn(chatgptClient, "dispatch").mockImplementation(async (options) => {
      await options.createTab();
      throw Object.assign(new Error("Cloudflare challenge detected - complete in browser"), {
        code: "cloudflare",
      });
    });
    const requestCallExtension = vi.fn(async (_request: unknown, tool: string) => {
      if (tool === "create_tab") {
        return { tabId: 7 };
      }
      if (tool === "close_tab") {
        return {};
      }
      throw new Error(`Unexpected extension call: ${tool}`);
    });
    const host = createHost(requestCallExtension);

    await expect(
      host.handle(LOCAL_REQUEST, { type: "ORACLE_ASK", prompt: "review" }),
    ).rejects.toMatchObject({ code: "cloudflare" });

    expect(requestCallExtension).not.toHaveBeenCalledWith(
      expect.anything(),
      "close_tab",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("oracle host result", () => {
  it("returns the stored response for an already captured job", async () => {
    useTempState();
    const job = oracleJobs.createJob({ prompt: "review" });
    oracleJobs.markDispatched(job.id, { tabId: 7, promptEcho: "review", baseline: EMPTY_BASELINE });
    oracleJobs.markCaptured(job.id, { response: "the answer" });
    const requestCallExtension = vi.fn();
    const host = createHost(requestCallExtension);

    const result = await host.handle(LOCAL_REQUEST, { type: "ORACLE_RESULT", id: job.id });

    expect(result).toMatchObject({ state: "captured", response: "the answer" });
    // Reading a finished job must not touch the browser at all.
    expect(requestCallExtension).not.toHaveBeenCalled();
  });

  it("raises the recorded failure of a failed job", async () => {
    useTempState();
    const job = oracleJobs.createJob({ prompt: "review" });
    oracleJobs.markFailed(job.id, { code: "cancelled", message: "gave up" });
    const host = createHost(vi.fn());

    await expect(
      host.handle(LOCAL_REQUEST, { type: "ORACLE_RESULT", id: job.id }),
    ).rejects.toMatchObject({ code: "cancelled", jobId: job.id });
  });

  // Nothing outside its own dispatch can advance a `created` job, so polling
  // one forever would be a wedge with extra steps.
  it("retires a job whose dispatch is gone instead of reporting it as pending", async () => {
    useTempState();
    const job = oracleJobs.createJob({ prompt: "review" });
    const host = createHost(vi.fn());

    await expect(
      host.handle(LOCAL_REQUEST, { type: "ORACLE_RESULT", id: job.id }),
    ).rejects.toMatchObject({ code: "dispatch_failed", jobId: job.id });
    expect(oracleJobs.getJob(job.id)).toMatchObject({ state: "failed" });
  });

  // The supervisor keeps working after the wait window closes; a client that
  // times out gets the current record instead of an error or a wedged job.
  it("returns the unfinished job when the harvest outlives the wait window", async () => {
    useTempState();
    const job = oracleJobs.createJob({ prompt: "review" });
    oracleJobs.markDispatched(job.id, { tabId: 7, promptEcho: "review", baseline: EMPTY_BASELINE });
    oracleJobs.markAwaiting(job.id, { conversationUrl: CONVERSATION_URL, promptEcho: "review" });
    const host = createHost(idleBrowser());

    const result = await host.handle(LOCAL_REQUEST, {
      type: "ORACLE_RESULT",
      id: job.id,
      timeout: 0.05,
    });

    expect(result).toMatchObject({ state: "awaiting" });
  });
});

describe("oracle host cancel", () => {
  it("retires a live job and frees the capacity slot", async () => {
    useTempState();
    mockDispatch();
    const requestCallExtension = idleBrowser();
    const host = createHost(requestCallExtension);
    const job = await host.handle(LOCAL_REQUEST, { type: "ORACLE_ASK", prompt: "review" });

    const cancelled = await host.handle(LOCAL_REQUEST, { type: "ORACLE_CANCEL", id: job.id });

    expect(cancelled).toMatchObject({ state: "failed", error: { code: "cancelled" } });
    expect(requestCallExtension).toHaveBeenCalledWith(
      expect.anything(),
      "close_tab",
      expect.objectContaining({ tabId: 7 }),
      expect.anything(),
      expect.anything(),
    );
    // Capacity is the whole point of cancelling: the next ask must go through.
    await expect(
      host.handle(LOCAL_REQUEST, { type: "ORACLE_ASK", prompt: "next" }),
    ).resolves.toMatchObject({ state: "awaiting" });
  });

  it("leaves an already finished job untouched", async () => {
    useTempState();
    const job = oracleJobs.createJob({ prompt: "review" });
    oracleJobs.markDispatched(job.id, { tabId: 7, promptEcho: "review", baseline: EMPTY_BASELINE });
    oracleJobs.markCaptured(job.id, { response: "the answer" });
    const host = createHost(vi.fn());

    const result = await host.handle(LOCAL_REQUEST, { type: "ORACLE_CANCEL", id: job.id });

    expect(result).toMatchObject({ state: "captured" });
  });
});

describe("oracle host dispatch failure", () => {
  // A failure after the send (for example while waiting for the conversation
  // URL) must not discard an answer ChatGPT is already producing.
  it("keeps harvesting when dispatch fails after the prompt was submitted", async () => {
    useTempState();
    vi.spyOn(chatgptClient, "dispatch").mockImplementation(async (options) => {
      await options.afterSubmit({ tabId: 7, promptEcho: "review", baseline: EMPTY_BASELINE });
      throw Object.assign(new Error("lost the tab while reading the URL"), {
        code: "dispatch_failed",
      });
    });
    const host = createHost(idleBrowser());

    await expect(
      host.handle(LOCAL_REQUEST, { type: "ORACLE_ASK", prompt: "review" }),
    ).rejects.toMatchObject({ code: "dispatch_failed", recoverable: true });

    const job = oracleJobs.listJobs({})[0];
    expect(job).toMatchObject({ state: "dispatched" });
    // The job is still owned by a watcher, so `result` can recover it.
    await expect(
      host.handle(LOCAL_REQUEST, { type: "ORACLE_RESULT", id: job.id, timeout: 0.05 }),
    ).resolves.toMatchObject({ state: "dispatched" });
  });
});
