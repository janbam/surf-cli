import { afterEach, vi } from "vitest";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const oracleJobs = require("../../native/oracle-jobs.cjs");
const { createHarvestSupervisor } = require("../../native/oracle-harvest.cjs");

const CONVERSATION_URL = "https://chatgpt.com/c/6a8c33e1-6ffc-83eb-9d17-0a69c51d45f8";
const EMPTY_BASELINE = { latestAssistant: null, assistantCount: 0, stopVisible: false };

const roots: string[] = [];
const originalStateDir = process.env.SURF_STATE_DIR;

function useTempState() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "surf-oracle-harvest-"));
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

type Snapshot = { candidates: unknown[]; stopVisible: boolean };

/** One finished assistant turn: the DOM state a settled answer produces. */
function finishedSnapshot(text: string, messageId = "message-1"): Snapshot {
  return {
    candidates: [
      {
        role: "user",
        isUser: true,
        isAssistant: false,
        text: "question",
        hasFinishedActions: false,
      },
      {
        role: "assistant",
        isAssistant: true,
        isUser: false,
        text,
        messageId,
        hasFinishedActions: true,
      },
    ],
    stopVisible: false,
  };
}

/**
 * Minimal fake of the extension bridge.
 *
 * `evaluate` answers the page-health probes so fresh-tab recovery can run, and
 * routes everything else to the conversation snapshot under test.
 */
function createBrowser({
  tabs = [{ id: 7 }],
  href = CONVERSATION_URL,
  snapshots = [finishedSnapshot("The answer.")],
  evaluateFailsOnTab,
  newTabId = 9,
  transientFailures = 0,
  listTabsTransientFailures = 0,
}: {
  tabs?: Array<{ id: number }>;
  href?: string;
  snapshots?: Snapshot[];
  evaluateFailsOnTab?: number;
  newTabId?: number;
  /** Extension timeouts to raise from the first N evaluate calls. */
  transientFailures?: number;
  /** Extension timeouts to raise from the first N tab listings. */
  listTabsTransientFailures?: number;
} = {}) {
  const closed: number[] = [];
  const created: number[] = [];
  const queue = [...snapshots];
  let remainingTransientFailures = transientFailures;
  let remainingListTabsFailures = listTabsTransientFailures;
  // Page-health probes answer statically; the conversation probe walks the
  // scripted snapshots and then repeats the last one.
  const answers: Array<[string, () => unknown]> = [
    ["document.readyState", () => "complete"],
    ["document.title", () => "chatgpt"],
    ["cf-turnstile", () => false],
    ["backend-api/me", () => ({ status: 200, hasLoginCta: false })],
    ["location.href", () => href],
    ["stopVisible", () => (queue.length > 1 ? queue.shift() : queue[0])],
  ];
  const evaluate = (tabId: number, expression: string) => {
    if (evaluateFailsOnTab === tabId) {
      throw new Error(`tab ${tabId} is gone`);
    }
    // Models the extension still warming up after a host restart: the call
    // times out with no verdict about the tab or the job.
    if (remainingTransientFailures > 0) {
      remainingTransientFailures--;
      throw new Error("Timeout waiting for extension: cdp_evaluate");
    }
    const answer = answers.find(([marker]) => expression.includes(marker));
    if (!answer) {
      throw new Error(`unexpected evaluate: ${expression.slice(0, 60)}`);
    }
    return { result: { value: answer[1]() } };
  };

  const options = {
    signal: undefined,
    createTab: async () => {
      created.push(newTabId);
      return { tabId: newTabId };
    },
    closeTab: async (tabId: number) => {
      closed.push(tabId);
    },
    cdpEvaluate: async (tabId: number, expression: string) => evaluate(tabId, expression),
    cdpCommand: async () => ({}),
  };

  return {
    closed,
    created,
    supervisorOptions: {
      queueAiRequest: (operation: () => unknown) => operation(),
      createBackgroundRequest,
      browserOptions: () => options,
      closeTab: async (_request: unknown, tabId: number) => {
        closed.push(tabId);
      },
      listTabs: async () => {
        if (remainingListTabsFailures > 0) {
          remainingListTabsFailures--;
          throw new Error("Timeout waiting for extension: list_tabs");
        }
        return tabs;
      },
      log: vi.fn(),
      // The retry policy is under test, not the wait between retries.
      failureRetryMs: 10,
    },
  };
}

function dispatchedJob({
  baseline = EMPTY_BASELINE,
  conversationUrl,
  tabId = 7,
}: {
  baseline?: unknown;
  conversationUrl?: string;
  tabId?: number | null;
} = {}) {
  const job = oracleJobs.createJob({ prompt: "question" });
  oracleJobs.markDispatched(job.id, { tabId, promptEcho: "question", baseline });
  if (conversationUrl) {
    oracleJobs.markAwaiting(job.id, { conversationUrl, promptEcho: "question" });
  }
  return oracleJobs.getJob(job.id);
}

afterEach(() => {
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

describe("oracle harvest supervisor", () => {
  it("captures a settled answer, links it to the job, and releases the tab", async () => {
    useTempState();
    const job = dispatchedJob({ conversationUrl: CONVERSATION_URL });
    const browser = createBrowser();
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getJob(job.id)).toMatchObject({ state: "captured" });
    expect(oracleJobs.getResponse(job.id)).toBe("The answer.");
    expect(browser.closed).toEqual([7]);
  });

  // The conversation URL is a recovery aid, not a precondition: an answer that
  // is already on screen must never be thrown away for lack of one.
  it("captures from the live tab even when no durable URL was ever recorded", async () => {
    useTempState();
    const job = dispatchedJob();
    const browser = createBrowser({
      href: "https://chatgpt.com/c/WEB:6a8c33e1-6ffc-83eb-9d17-0a69c51d45f8",
    });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getJob(job.id)).toMatchObject({
      state: "captured",
      conversationUrl: null,
    });
  });

  it("promotes the job to awaiting once the durable conversation id appears", async () => {
    useTempState();
    const job = dispatchedJob();
    const browser = createBrowser();
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getJob(job.id)).toMatchObject({
      state: "captured",
      conversationUrl: CONVERSATION_URL,
      awaitingAt: expect.any(String),
    });
  });

  // Without a baseline the answer cannot be attributed to this job at all;
  // spinning until the deadline would look identical to "still generating" and
  // would hold the single capacity slot for an hour.
  it("fails a job that has no dispatch baseline instead of waiting it out", async () => {
    useTempState();
    const job = dispatchedJob({ baseline: null, conversationUrl: CONVERSATION_URL });
    const browser = createBrowser();
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getJob(job.id)).toMatchObject({
      state: "failed",
      error: { code: "unattributable" },
    });
  });

  it("reopens the conversation in a fresh tab after the dispatch tab dies", async () => {
    useTempState();
    const job = dispatchedJob({ conversationUrl: CONVERSATION_URL });
    const browser = createBrowser({ evaluateFailsOnTab: 7 });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(browser.created).toEqual([9]);
    expect(oracleJobs.getJob(job.id)).toMatchObject({ state: "captured", tabId: 9 });
    expect(oracleJobs.getResponse(job.id)).toBe("The answer.");
  });

  // Live regression: a watcher resumed after a host restart hit two consecutive
  // 30s extension timeouts and killed a job whose answer was already written.
  // Extension timeouts describe the connection, not the job.
  it("rides out extension timeouts instead of failing the job", async () => {
    useTempState();
    const job = dispatchedJob({ conversationUrl: CONVERSATION_URL });
    const browser = createBrowser({ listTabsTransientFailures: 1, transientFailures: 2 });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getJob(job.id)).toMatchObject({ state: "captured" });
    expect(oracleJobs.getResponse(job.id)).toBe("The answer.");
  });

  // Retries are bounded by wall time, not attempts, so a tab that never becomes
  // usable must not be left behind on every attempt.
  it("closes a fresh tab that never became usable", async () => {
    useTempState();
    const job = dispatchedJob({ tabId: null, conversationUrl: CONVERSATION_URL });
    const browser = createBrowser({ tabs: [], transientFailures: 1 });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(browser.closed).toContain(9);
    expect(oracleJobs.getJob(job.id)).toMatchObject({ state: "captured" });
  });

  // A record can end underneath a live watcher: a concurrent cancel, or the
  // staleness reaper in another host process. Every browser step then fails
  // with `invalid_transition`, and treating that as "the browser is flaky"
  // opens a fresh ChatGPT tab on every retry until patience runs out.
  it("stops instead of retrying once the job record has ended", async () => {
    useTempState();
    const job = dispatchedJob({ tabId: null, conversationUrl: CONVERSATION_URL });
    oracleJobs.markFailed(job.id, { code: "cancelled", message: "cancelled by the user" });
    const browser = createBrowser({ tabs: [] });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(browser.created.length).toBeLessThanOrEqual(1);
    expect(oracleJobs.getJob(job.id)).toMatchObject({
      state: "failed",
      error: { code: "cancelled" },
    });
  });

  it("fails with the web-history limitation when neither tab nor URL survive", async () => {
    useTempState();
    const job = dispatchedJob({ tabId: 7 });
    const browser = createBrowser({ tabs: [] });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getJob(job.id)).toMatchObject({
      state: "failed",
      error: {
        code: "harvest_failed",
        message: expect.stringContaining("cannot be recovered without a conversation URL"),
      },
    });
  });

  it("cancels a watcher without deciding the job's terminal state", async () => {
    useTempState();
    const job = dispatchedJob({ conversationUrl: CONVERSATION_URL });
    // A conversation that never settles keeps the watcher in its poll loop.
    const browser = createBrowser({ snapshots: [{ candidates: [], stopVisible: true }] });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    const watching = supervisor.watch(job.id);
    expect(supervisor.cancel(job.id)).toBe(true);
    await watching;

    expect(oracleJobs.getJob(job.id)).toMatchObject({ state: "awaiting" });
  });

  // A follow-up dispatches into a conversation that already holds a finished
  // answer. That turn re-renders (late reasoning summaries, a different turn
  // count in a reopened tab), and treating the drift as new content would hand
  // the parent's answer back as the follow-up's response.
  it("ignores the baseline turn re-rendering and captures only the next answer", async () => {
    useTempState();
    const job = dispatchedJob({
      conversationUrl: CONVERSATION_URL,
      baseline: {
        latestAssistant: { text: "PARENT ANSWER", messageId: "parent-1", turnIndex: 1 },
        assistantCount: 1,
        stopVisible: false,
      },
    });
    const browser = createBrowser({
      snapshots: [
        finishedSnapshot("PARENT ANSWER\nThought for 12s", "parent-1"),
        finishedSnapshot("The follow-up answer.", "child-1"),
      ],
    });
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    await supervisor.watch(job.id);

    expect(oracleJobs.getResponse(job.id)).toBe("The follow-up answer.");
  });

  it("resumes dispatched orphans and retires ones that never got sent", async () => {
    useTempState();
    const stranded = oracleJobs.createJob({ prompt: "never sent" });
    const browser = createBrowser();
    const supervisor = createHarvestSupervisor(browser.supervisorOptions);

    expect(supervisor.resume()).toEqual([stranded.id]);
    expect(oracleJobs.getJob(stranded.id)).toMatchObject({
      state: "failed",
      error: { code: "dispatch_failed" },
    });

    // With the stranded record retired, capacity is free again.
    const revived = dispatchedJob({ conversationUrl: CONVERSATION_URL });
    expect(supervisor.resume()).toEqual([revived.id]);
    await supervisor.stop();
  });
});
