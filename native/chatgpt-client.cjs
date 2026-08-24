const path = require("path");
const { raceAbort, throwIfAborted } = require("./abort.cjs");
const {
  checkLoginStatus,
  clickSend,
  delay,
  evaluate,
  isCloudflareBlocked,
  normalizeChatGPTEffortChoice,
  normalizeChatGPTModelChoice,
  resolveChatGPTEffortMenuOption,
  resolveChatGPTModelMenuOption,
  selectEffort,
  selectModel,
  typePrompt,
  verifyChatGPTEffortSelection,
  verifyChatGPTModelSelection,
  waitForPageLoad,
  waitForPromptReady,
} = require("./chatgpt-client-ui.cjs");
const {
  cleanChatGPTResponseText,
  createResponseTracker,
  extractLatestAssistantSnapshot,
  isChatGPTResponseComplete,
  isNewAssistantContent,
  normalizePromptEcho,
  normalizeResponseSnapshot,
  readChatGPTResponseSnapshot,
  waitForResponse,
} = require("./chatgpt-client-response.cjs");

const CHATGPT_URL = "https://chatgpt.com/";

// ChatGPT routes optimistically to a client-side placeholder id ("WEB:<uuid>")
// and only later swaps in the server id. Only the server id survives a reload,
// so anything else must be treated as "not durable yet" instead of recorded.
const DURABLE_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasRequiredCookies(cookies) {
  if (!cookies || !Array.isArray(cookies)) return false;
  return cookies.some(
    (cookie) =>
      typeof cookie?.name === "string" &&
      Boolean(cookie.value) &&
      (cookie.name === "__Secure-next-auth.session-token" ||
        /^__Secure-next-auth\.session-token\.\d+$/.test(cookie.name)),
  );
}

/**
 * Extract a durable ChatGPT conversation URL from a browser location.
 *
 * Returns null for anything that cannot be navigated back to later, including
 * the transient placeholder ids ChatGPT shows before the server id arrives.
 */
function extractConversationUrl(value) {
  try {
    const url = new URL(String(value));
    const match = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || !match) return null;
    if (!DURABLE_CONVERSATION_ID.test(match[1])) return null;
    return `${url.origin}/c/${match[1]}`;
  } catch {
    return null;
  }
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function classifyError(error, fallbackCode, preservedCodes = []) {
  const classified = error instanceof Error ? error : new Error(String(error));
  if (
    classified.code !== "SURF_REQUEST_ABORTED" &&
    !preservedCodes.includes(classified.code)
  ) {
    classified.code = fallbackCode;
  }
  return classified;
}

/**
 * Fail fast on the two page states that make every later step meaningless:
 * a Cloudflare interstitial and a logged-out session.
 */
async function assertUsablePage(cdp, signal) {
  await waitForPageLoad(cdp, 45000, signal);
  if (await isCloudflareBlocked(cdp)) {
    throw codedError("Cloudflare challenge detected - complete in browser", "cloudflare");
  }
  const loginStatus = await checkLoginStatus(cdp);
  if (loginStatus.status === 0) {
    throw codedError(
      loginStatus.error
        ? `ChatGPT login check failed: ${loginStatus.error}`
        : "ChatGPT login check failed",
      "auth",
    );
  }
  if (loginStatus.status !== 200 || loginStatus.hasLoginCta) {
    throw codedError("ChatGPT login required", "auth");
  }
}

/**
 * Wait until a reopened conversation has rendered its existing turns.
 *
 * `waitForPromptReady` only proves the composer exists, and the composer is
 * live well before the transcript paints. A baseline taken in that window sees
 * an empty conversation, which silently disables message-id turn identity for
 * follow-ups — the answer the next dispatch captures could then be the parent's.
 *
 * Resolves as soon as any turn is present. Rejects on timeout rather than
 * returning an empty baseline, because guessing here means answering the wrong
 * question with the wrong answer.
 */
async function waitForConversationTurns(cdp, timeoutMs = 15000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const snapshot = await readChatGPTResponseSnapshot(cdp);
    if (snapshot?.candidates?.length > 0) return snapshot;
    await delay(250, signal);
  }
  throw codedError(
    "Conversation turns did not render; refusing to dispatch without a turn baseline",
    "baseline_unavailable",
  );
}

async function waitForConversationUrl(cdp, timeoutMs = 30000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conversationUrl = extractConversationUrl(await evaluate(cdp, "location.href", signal));
    if (conversationUrl) return conversationUrl;
    await delay(200, signal);
  }
  return null;
}

async function dispatch(options) {
  const {
    prompt,
    model,
    effort,
    file,
    getCookies,
    createTab,
    cdpEvaluate,
    cdpCommand,
    uploadFile,
    beforeSubmit,
    afterSubmit,
    startUrl,
    log = () => {},
    signal,
  } = options;

  try {
    throwIfAborted(signal);
    const guardedUploadFile = uploadFile
      ? (...args) => raceAbort(() => uploadFile(...args), signal)
      : uploadFile;
    log("Starting ChatGPT query");
    const { cookies } = await raceAbort(getCookies, signal);
    if (!hasRequiredCookies(cookies)) {
      throw codedError("ChatGPT login required", "auth");
    }
    log(`Got ${cookies.length} cookies`);
    const tabInfo = await raceAbort(createTab, signal);
    const { tabId } = tabInfo;
    if (!tabId) {
      throw new Error("Failed to create ChatGPT tab");
    }
    log(`Created tab ${tabId}`);

    const cdp = (expression) => raceAbort(() => cdpEvaluate(tabId, expression), signal);
    const inputCdp = (method, params) =>
      raceAbort(() => cdpCommand(tabId, method, params), signal);

    if (startUrl) await inputCdp("Page.navigate", { url: startUrl });
    await assertUsablePage(cdp, signal);
    log("Page loaded, login verified");
    const promptReady = await waitForPromptReady(cdp, 30000, signal);
    if (!promptReady) {
      throw new Error("Prompt textarea not ready");
    }
    log("Prompt ready");
    // Reopening an existing conversation: its turns must be on screen before
    // anything snapshots them, or this dispatch has no identity to work from.
    if (startUrl && extractConversationUrl(startUrl)) {
      await waitForConversationTurns(cdp, 15000, signal);
      log("Conversation turns rendered");
    }
    let modelVerified = null;
    let effortVerified = null;
    if (model) {
      modelVerified = await selectModel(cdp, model, 8000, signal);
      log(`Verified model: ${modelVerified}`);
    }
    if (file) {
      if (!uploadFile) {
        throw new Error(
          "ChatGPT file upload unavailable: native host did not provide upload callback",
        );
      }
      const files = Array.isArray(file) ? file : [file];
      const absFiles = files.map((filePath) => path.resolve(process.cwd(), filePath));
      log(`Uploading ${absFiles.length} file(s) to ChatGPT...`);
      const uploadResult = await guardedUploadFile(tabId, absFiles);
      if (uploadResult?.error) {
        throw new Error(`ChatGPT file upload failed: ${uploadResult.error}`);
      }
      if (!uploadResult?.success) {
        throw new Error("ChatGPT file upload failed: upload did not report success");
      }
      log("File uploaded, waiting for ChatGPT attachment processing...");
      await delay(1500, signal);
    }
    await typePrompt(cdp, inputCdp, prompt, signal);
    log("Prompt typed");
    if (effort) {
      effortVerified = await selectEffort(cdp, effort, 8000, signal);
      log(`Verified effort: ${effortVerified}`);
    }
    // Snapshot the conversation before sending: this baseline is what later
    // identifies our answer by turn identity, so it must be recorded durably
    // by the caller before the response can arrive.
    const baseline = normalizeResponseSnapshot(await readChatGPTResponseSnapshot(cdp));
    if (beforeSubmit) await raceAbort(beforeSubmit, signal);
    await clickSend(cdp, inputCdp, signal);
    const promptEcho = normalizePromptEcho(prompt);
    if (afterSubmit) {
      await afterSubmit({ tabId, promptEcho, modelVerified, effortVerified, baseline });
    }
    log("Prompt sent, waiting for response...");
    const conversationUrl = await waitForConversationUrl(cdp, 30000, signal);

    return {
      tabId,
      conversationUrl,
      promptEcho,
      model: model || "current",
      modelVerified,
      effortVerified,
      baseline,
    };
  } catch (error) {
    throw classifyError(error, "dispatch_failed", [
      "auth",
      "cloudflare",
      "model_verification_failed",
      "baseline_unavailable",
    ]);
  }
}

async function harvest(options) {
  const {
    tabId: liveTabId,
    conversationUrl,
    baseline,
    timeout = 2700000,
    createTab,
    closeTab,
    cdpEvaluate,
    cdpCommand,
    keepCreatedTabOpen = false,
    log = () => {},
    signal,
  } = options;
  const startTime = Date.now();
  let tabId = liveTabId;
  let ownsTab = false;

  try {
    throwIfAborted(signal);
    if (!tabId) {
      if (!conversationUrl) {
        throw new Error("ChatGPT conversation URL required for fresh-tab harvest");
      }
      const tabInfo = await raceAbort(createTab, signal);
      tabId = tabInfo?.tabId;
      if (!tabId) {
        throw new Error("Failed to create ChatGPT tab");
      }
      ownsTab = true;
    }

    const cdp = (expression) => raceAbort(() => cdpEvaluate(tabId, expression), signal);
    const inputCdp = (method, params) =>
      raceAbort(() => cdpCommand(tabId, method, params), signal);

    if (ownsTab) {
      await inputCdp("Page.navigate", { url: conversationUrl });
      await assertUsablePage(cdp, signal);
    }

    const response = await waitForResponse(
      cdp,
      timeout,
      baseline?.latestAssistant,
      baseline?.assistantCount,
      signal,
    );
    log(`Response received (${response.text.length} chars)`);
    return {
      response: response.text,
      messageId: response.messageId,
      tookMs: Date.now() - startTime,
    };
  } catch (error) {
    const fallbackCode = error?.message === "Response timeout" ? "timeout" : "harvest_failed";
    throw classifyError(error, fallbackCode, ["auth", "cloudflare", "timeout"]);
  } finally {
    if (ownsTab && !keepCreatedTabOpen) {
      try {
        await closeTab(tabId);
      } catch (error) {
        log(`Failed to close ChatGPT tab ${tabId}: ${error?.message || error}`);
      }
    }
  }
}

async function query(options) {
  const { closeTab, createTab, log = () => {}, signal, timeout = 2700000 } = options;
  throwIfAborted(signal);
  const startTime = Date.now();
  let tabId = null;

  try {
    const dispatched = await dispatch({
      ...options,
      createTab: async () => {
        const tabInfo = await createTab();
        tabId = tabInfo?.tabId || null;
        return tabInfo;
      },
    });
    const result = await harvest({
      ...options,
      tabId: dispatched.tabId,
      conversationUrl: dispatched.conversationUrl,
      baseline: dispatched.baseline,
      timeout,
    });
    return {
      response: result.response,
      model: dispatched.model,
      messageId: result.messageId,
      tookMs: Date.now() - startTime,
    };
  } finally {
    if (tabId) {
      try {
        await closeTab(tabId);
      } catch (error) {
        log(`Failed to close ChatGPT tab ${tabId}: ${error?.message || error}`);
      }
    }
  }
}

module.exports = {
  query,
  dispatch,
  harvest,
  assertUsablePage,
  createResponseTracker,
  hasRequiredCookies,
  readChatGPTResponseSnapshot,
  waitForConversationTurns,
  waitForConversationUrl,
  cleanChatGPTResponseText,
  extractLatestAssistantSnapshot,
  normalizeChatGPTEffortChoice,
  normalizeChatGPTModelChoice,
  resolveChatGPTEffortMenuOption,
  resolveChatGPTModelMenuOption,
  isNewAssistantContent,
  isChatGPTResponseComplete,
  isCloudflareBlocked,
  normalizePromptEcho,
  extractConversationUrl,
  verifyChatGPTEffortSelection,
  verifyChatGPTModelSelection,
  CHATGPT_URL,
};
