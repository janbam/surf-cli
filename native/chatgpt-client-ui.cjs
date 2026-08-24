const { abortableDelay, throwIfAborted } = require("./abort.cjs");
const {
  CHATGPT_EFFORT_CHOICES,
  boundedOptionLabels,
  effortCandidateMatches,
  modelCandidateMatches,
  normalizeChatGPTEffortChoice,
  normalizeChatGPTModelChoice,
  resolveChatGPTEffortMenuOption,
  resolveChatGPTModelMenuOption,
  verifyChatGPTEffortSelection,
  verifyChatGPTModelSelection,
} = require("./chatgpt-client-selection.cjs");

const SELECTORS = {
  promptTextarea:
    '#prompt-textarea, [data-testid="composer-textarea"], textarea[name="prompt-textarea"], .ProseMirror, [contenteditable="true"][data-virtualkeyboard="true"]',
  promptEditor: "#prompt-textarea",
  promptFallback: 'textarea[name="prompt-textarea"]',
  loginCta: 'a[href*="/auth/login"], button',
  sendButton:
    'button[data-testid="send-button"], button[data-testid*="composer-send"], form button[type="submit"]',
  modelButton:
    '[data-testid="model-switcher-dropdown-button"], [data-testid="composer-footer-actions"] button[aria-haspopup="menu"], button.__composer-pill[aria-haspopup="menu"], .__composer-pill-composite button[aria-haspopup="menu"]',
  assistantMessage:
    '[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant-message"], [data-testid*="assistant-turn"], [data-testid*="assistant-response"]',
  assistantContent:
    '.markdown, [data-message-content], .prose, [class*="markdown"], [dir="auto"]',
  stopButton:
    '[data-testid="stop-button"], [data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="stop"]',
  finishedActions:
    'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid*="turn-action"], button[aria-label*="Copy"], button[aria-label*="copy"], button[aria-label*="Read aloud"], button[aria-label*="read aloud"]',
  conversationTurn: '[data-testid^="conversation-turn"], [data-testid*="conversation-turn"]',
  cloudflareScript: 'script[src*="/challenge-platform/"]',
};

function delay(ms, signal) {
  return abortableDelay(ms, signal);
}

function buildClickDispatcher() {
  return `function dispatchClickSequence(target){
    if(!target || !(target instanceof EventTarget)) return false;
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of types) {
      const common = { bubbles: true, cancelable: true, view: window };
      let event;
      if (type.startsWith('pointer') && 'PointerEvent' in window) {
        event = new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
      } else {
        event = new MouseEvent(type, common);
      }
      target.dispatchEvent(event);
    }
    return true;
  }`;
}

async function evaluate(cdp, expression, signal) {
  throwIfAborted(signal);
  const result = await cdp(expression);
  throwIfAborted(signal);
  if (result.exceptionDetails) {
    const desc =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Evaluation failed";
    throw new Error(desc);
  }
  if (result.error) {
    throw new Error(result.error);
  }
  return result.result?.value;
}

async function waitForPageLoad(cdp, timeoutMs = 45000, signal) {
  throwIfAborted(signal);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, "document.readyState");
    if (ready === "complete" || ready === "interactive") {
      return;
    }
    await delay(100, signal);
  }
  throw new Error("Page did not load in time");
}

async function isCloudflareBlocked(cdp) {
  const title = await evaluate(cdp, "document.title.toLowerCase()");
  if (title && (title.includes("just a moment") || title.includes("verify you are human"))) {
    return true;
  }
  return evaluate(
    cdp,
    `(() => {
      const hasPrompt = Boolean(document.querySelector(${JSON.stringify(SELECTORS.promptTextarea)}));
      if (hasPrompt) return false;
      const text = (document.body?.innerText || '').toLowerCase();
      const challengeText = [
        'checking if the site connection is secure',
        'verify you are human',
        'review the security of your connection',
        'needs to review the security of your connection',
        'cloudflare ray id'
      ];
      return challengeText.some(marker => text.includes(marker))
        || Boolean(document.querySelector('input[name="cf-turnstile-response"], .cf-turnstile, #challenge-stage, iframe[src*="challenges.cloudflare.com"]'));
    })()`,
  );
}

async function checkLoginStatus(cdp) {
  const result = await evaluate(
    cdp,
    `(async () => {
      try {
        const response = await fetch('/backend-api/me', {
          cache: 'no-store',
          credentials: 'include'
        });
        const hasLoginCta = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.loginCta)}))
          .some(el => {
            const text = (el.textContent || '').toLowerCase().trim();
            return text.startsWith('log in') || text.startsWith('sign in');
          });
        return {
          status: response.status,
          hasLoginCta,
          url: location.href
        };
      } catch (e) {
        return { status: 0, error: e.message, url: location.href };
      }
    })()`,
  );
  return result || { status: 0 };
}

async function waitForPromptReady(cdp, timeoutMs = 30000, signal) {
  throwIfAborted(signal);
  const deadline = Date.now() + timeoutMs;
  const selectors = JSON.stringify(SELECTORS.promptTextarea.split(", "));
  while (Date.now() < deadline) {
    const found = await evaluate(
      cdp,
      `(() => {
        const selectors = ${selectors};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
    );
    if (found) return true;
    await delay(200, signal);
  }
  return false;
}

function verificationError(kind, requested, items = [], invalid = false) {
  const safeRequested = String(requested || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const available = boundedOptionLabels(items);
  const accepted = kind === "effort" ? ` Accepted: ${CHATGPT_EFFORT_CHOICES.join(", ")}.` : "";
  const availableMessage = available.length > 0 ? ` Available: ${available.join(", ")}.` : "";
  const error = new Error(
    invalid
      ? `Invalid ChatGPT effort "${safeRequested}".${accepted}`
      : `ChatGPT ${kind} verification failed for "${safeRequested}".${accepted}${availableMessage}`,
  );
  error.code = "model_verification_failed";
  return error;
}

// Current ChatGPT composer layout: one pill whose whole label is the active
// effort ("Instant", "Medium", or "High"). Clicking it opens a menu containing
// "Model<value>" and "Effort<value>" rows; each row expands to a flat list of
// menuitemradio entries (models like "GPT-5.6 Sol"; efforts Instant/Medium/High).

// Open the composer menu by clicking the unique effort-labeled pill.
async function openComposerMenu(cdp) {
  return evaluate(
    cdp,
    `(() => {
      ${buildClickDispatcher()}
      const labels = ${JSON.stringify(["instant", "medium", "high"])};
      const pills = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.modelButton)})).filter((node) => {
        if (node.getAttribute?.('aria-haspopup') !== 'menu') return false;
        const text = (node.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        return labels.includes(text);
      });
      if (pills.length !== 1) return false;
      return dispatchClickSequence(pills[0]);
    })()`,
  );
}

// Read-only scan for the "Model<value>" / "Effort<value>" row.
async function findSubmenuRow(cdp, kind) {
  return evaluate(
    cdp,
    `(() => {
      const kind = ${JSON.stringify(kind)};
      const row = Array.from(document.querySelectorAll('[role="menuitem"]'))
        .filter((el) => el.offsetParent !== null)
        .find((el) => {
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          return kind === 'model' ? /^model/i.test(text) : /^effort/i.test(text);
        });
      if (!row) return null;
      return (row.textContent || '').replace(/\\s+/g, ' ').trim();
    })()`,
  );
}

async function clickSubmenuRow(cdp, kind) {
  return evaluate(
    cdp,
    `(() => {
      ${buildClickDispatcher()}
      const kind = ${JSON.stringify(kind)};
      const row = Array.from(document.querySelectorAll('[role="menuitem"]'))
        .filter((el) => el.offsetParent !== null)
        .find((el) => {
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          return kind === 'model' ? /^model/i.test(text) : /^effort/i.test(text);
        });
      return row ? dispatchClickSequence(row) : false;
    })()`,
  );
}

// Prefer visible text, but fall back through aria-labelledby / aria-label /
// title when a radio renders its name outside its own text content.
const resolveRadioLabelSource = `
  const resolveLabel = (el) => {
    const direct = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (direct) return direct;
    const labelledBy = String(el.getAttribute?.('aria-labelledby') || '')
      .split(/\\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ');
    const parts = [el.getAttribute?.('aria-label'), labelledBy, el.getAttribute?.('title')]
      .map((value) => String(value || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    return parts.join(' | ');
  };
`;

// Visible radios deduped by label: nested menu containers can surface the same
// entry twice, and downstream uniqueness checks would break on duplicates.
async function readVisibleRadios(cdp) {
  return evaluate(
    cdp,
    `(() => {
      ${resolveRadioLabelSource}
      const seen = new Set();
      const radios = [];
      for (const el of document.querySelectorAll('[role="menuitemradio"]')) {
        if (el.offsetParent === null) continue;
        const text = resolveLabel(el);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        radios.push({ role: 'menuitemradio', label: text, checked: el.getAttribute('aria-checked') === 'true' });
      }
      return radios;
    })()`,
  );
}

async function clickRadio(cdp, label) {
  return evaluate(
    cdp,
    `(() => {
      ${buildClickDispatcher()}
      ${resolveRadioLabelSource}
      const expected = ${JSON.stringify(label)};
      const targets = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        .filter((el) => el.offsetParent !== null && resolveLabel(el) === expected);
      return targets.length >= 1 ? dispatchClickSequence(targets[targets.length - 1]) : false;
    })()`,
  );
}

async function waitFor(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const value = await predicate();
    if (value) return value;
    await delay(150, signal);
  }
  return null;
}

// Ensure the given radio is selected: open the submenu, click the target if it
// is unchecked, then reopen and require it checked before dismissing the menu.
// Clicking the already-checked entry is harmless and closes the menu.
// One overall deadline bounds every stage and retry attempt so a menu that
// never opens fails within ~timeoutMs instead of paying timeoutMs per stage.
async function ensureSelection(cdp, kind, requested, matchesTarget, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
    if (!(await openComposerMenu(cdp))) throw verificationError(kind, requested);
    const row = await waitFor(() => findSubmenuRow(cdp, kind), remaining(), signal);
    if (!row || !(await clickSubmenuRow(cdp, kind))) throw verificationError(kind, requested, [{ label: row || "" }]);
    const radios = await waitFor(async () => {
      const list = await readVisibleRadios(cdp);
      return list.length > 0 ? list : null;
    }, remaining(), signal);
    if (!radios) throw verificationError(kind, requested);
    const candidates = radios.filter(matchesTarget);
    if (candidates.length !== 1) throw verificationError(kind, requested, radios);
    const candidate = candidates[0];
    if (candidate.checked) {
      await clickRadio(cdp, candidate.label);
      return candidate.label;
    }
    if (!(await clickRadio(cdp, candidate.label))) throw verificationError(kind, requested, radios);
    await delay(600, signal);
  }
  throw verificationError(kind, requested);
}

async function selectModel(cdp, desiredModel, timeoutMs = 8000, signal) {
  throwIfAborted(signal);
  const targetModel = normalizeChatGPTModelChoice(desiredModel);
  if (!targetModel) throw verificationError("model", desiredModel);
  return ensureSelection(
    cdp,
    "model",
    desiredModel,
    (item) => modelCandidateMatches(item, targetModel),
    timeoutMs,
    signal,
  );
}

async function selectEffort(cdp, desiredEffort, timeoutMs = 8000, signal) {
  throwIfAborted(signal);
  const normalizedEffort = normalizeChatGPTEffortChoice(desiredEffort);
  if (!normalizedEffort) throw verificationError("effort", desiredEffort, [], true);
  const label = await ensureSelection(
    cdp,
    "effort",
    desiredEffort,
    (item) => effortCandidateMatches(item, normalizedEffort),
    timeoutMs,
    signal,
  );
  // The pill itself mirrors the active effort; trust it as final readback.
  const pillMatches = await evaluate(
    cdp,
    `(() => {
      const labels = ${JSON.stringify(["instant", "medium", "high"])};
      const pills = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.modelButton)})).filter((node) => {
        if (node.getAttribute?.('aria-haspopup') !== 'menu') return false;
        const text = (node.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        return labels.includes(text);
      });
      return pills.length === 1 ? pills[0].textContent.trim().toLowerCase() : null;
    })()`,
  );
  if (pillMatches !== normalizedEffort) throw verificationError("effort", desiredEffort);
  return label;
}

async function typePrompt(cdp, inputCdp, prompt, signal) {
  throwIfAborted(signal);
  const selectors = JSON.stringify(SELECTORS.promptTextarea.split(", "));
  const encodedPrompt = JSON.stringify(prompt);
  const focused = await evaluate(
    cdp,
    `(() => {
      ${buildClickDispatcher()}
      const selectors = ${selectors};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') node.focus();
        // Select whatever the composer already holds so the inserted text
        // replaces it. A failed dispatch leaves its prompt behind, and
        // appending would submit a fused prompt the harvest can never match.
        if ('value' in node) {
          node.select?.();
          return true;
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      }
      return false;
    })()`,
  );
  if (!focused) {
    throw new Error("Failed to focus prompt textarea");
  }
  await inputCdp("Input.insertText", { text: prompt });
  await delay(300, signal);
  // The composer must hold exactly the prompt we are about to submit: the
  // harvest later scopes the conversation by this text, so a fused or partial
  // composer would strand the job with an echo that never matches.
  const readComposerText = `(() => {
      const selectors = ${selectors};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        return node.innerText || node.value || node.textContent || '';
      }
      return null;
    })()`;
  const normalizeComposerText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const expectedText = normalizeComposerText(prompt);
  let composerText = normalizeComposerText(await evaluate(cdp, readComposerText));
  if (composerText !== expectedText) {
    // Incremental insertion drifted; overwrite the composer wholesale.
    await evaluate(
      cdp,
      `(() => {
        const editor = document.querySelector(${JSON.stringify(SELECTORS.promptEditor)});
        const fallback = document.querySelector(${JSON.stringify(SELECTORS.promptFallback)});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
        if (editor) {
          editor.textContent = ${encodedPrompt};
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
    );
    await delay(200, signal);
    composerText = normalizeComposerText(await evaluate(cdp, readComposerText));
  }
  // Fail closed instead of submitting something that cannot be harvested back.
  if (composerText !== expectedText) {
    throw new Error(
      `Composer content does not match the prompt (expected ${expectedText.length} chars, found ${composerText.length})`,
    );
  }
}

async function clickSend(cdp, inputCdp, signal) {
  throwIfAborted(signal);
  const selectorsJson = JSON.stringify(SELECTORS.sendButton.split(", "));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await evaluate(
      cdp,
      `(() => {
        ${buildClickDispatcher()}
        const selectors = ${selectorsJson};
        let button = null;
        for (const selector of selectors) {
          button = document.querySelector(selector);
          if (button) break;
        }
        if (!button) return 'missing';
        const disabled = button.hasAttribute('disabled') ||
                        button.getAttribute('aria-disabled') === 'true' ||
                        button.getAttribute('data-disabled') === 'true';
        if (disabled) return 'disabled';
        dispatchClickSequence(button);
        return 'clicked';
      })()`,
    );
    if (result === "clicked") return true;
    if (result === "missing") break;
    await delay(100, signal);
  }
  await inputCdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: "\r",
  });
  await inputCdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  return true;
}

module.exports = {
  SELECTORS,
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
  verifyChatGPTEffortSelection,
  verifyChatGPTModelSelection,
  typePrompt,
  waitForPageLoad,
  waitForPromptReady,
};
