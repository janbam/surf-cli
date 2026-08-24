import { vi } from "vitest";
// @ts-expect-error - CommonJS module without type definitions
import * as chatgptClient from "../../native/chatgpt-client.cjs";
// @ts-expect-error - CommonJS module without type definitions
import * as selection from "../../native/chatgpt-client-selection.cjs";

function createReadyChatGptEvaluate(
  loginStatus: Record<string, unknown> = { status: 200, hasLoginCta: false },
) {
  return async (_tabId: number, expression: string) => {
    if (expression === "document.readyState") {
      return { result: { value: "complete" } };
    }
    if (expression === "document.title.toLowerCase()") {
      return { result: { value: "chatgpt" } };
    }
    if (expression.includes("challenge-platform") || expression.includes("cloudflare ray id")) {
      return { result: { value: false } };
    }
    if (expression.includes("fetch('/backend-api/me'")) {
      return { result: { value: loginStatus } };
    }
    if (expression.includes("const selectors") && expression.includes("prompt-textarea")) {
      return { result: { value: true } };
    }
    throw new Error(`Unexpected expression: ${expression}`);
  };
}

describe("chatgpt-client", () => {
  describe("isCloudflareBlocked", () => {
    it("does not treat normal logged-in ChatGPT pages with challenge scripts as blocked", async () => {
      const result = await chatgptClient.isCloudflareBlocked(async (expression: string) => {
        if (expression === "document.title.toLowerCase()") {
          return { result: { value: "chatgpt" } };
        }
        return { result: { value: false } };
      });

      expect(result).toBe(false);
    });

    it("detects visible Cloudflare challenge pages", async () => {
      const result = await chatgptClient.isCloudflareBlocked(async (expression: string) => {
        if (expression === "document.title.toLowerCase()") {
          return { result: { value: "chatgpt" } };
        }
        return { result: { value: true } };
      });

      expect(result).toBe(true);
    });
  });

  describe("cleanChatGPTResponseText", () => {
    it.each([
      [
        "trims outer blank lines and strips chrome at both ends",
        ["", "Copy", "Answer line", "Read aloud", "Share", ""].join("\n"),
        "Answer line",
      ],
      // Observed live: some layouts render the action row above the message,
      // so captured answers arrived with an "Edit" line glued to the front.
      [
        "strips a leading action label from the captured answer",
        ["Edit", "", "The real answer.", "", "More answer."].join("\n"),
        "The real answer.\n\nMore answer.",
      ],
      [
        "preserves markdown and code fences",
        [
          "Good response",
          "Here is code:",
          "```js",
          "Copy",
          "const x = 1;    ",
          "```",
          "Retry",
        ].join("\r\n"),
        ["Here is code:", "```js", "Copy", "const x = 1;", "```", "Retry"].join("\n"),
      ],
      ["preserves legitimate standalone single-word response: Copy", "Copy", "Copy"],
      ["preserves legitimate standalone single-word response: Edit", "Edit", "Edit"],
      [
        "strips only trailing chrome clusters",
        ["Answer line", "Copy", "Read aloud"].join("\n"),
        "Answer line",
      ],
      [
        "preserves a single trailing chrome-like line",
        ["Answer line", "Edit"].join("\n"),
        "Answer line\nEdit",
      ],
    ])("%s", (_, input, expected) => {
      expect(chatgptClient.cleanChatGPTResponseText(input)).toBe(expected);
    });
  });

  describe("extractLatestAssistantSnapshot", () => {
    it("returns latest populated assistant", () => {
      const snapshot = chatgptClient.extractLatestAssistantSnapshot([
        { role: "user", turn: "user", text: "hello" },
        {
          role: "assistant",
          turn: "assistant",
          isAssistant: true,
          text: "Earlier answer",
          messageId: "msg-1",
        },
        {
          role: "assistant",
          turn: "assistant",
          isAssistant: true,
          text: "Final answer\nCopy\nRead aloud",
          messageId: "msg-2",
          hasFinishedActions: true,
        },
      ]);

      expect(snapshot).toEqual({
        role: "assistant",
        turn: "assistant",
        isAssistant: true,
        text: "Final answer",
        messageId: "msg-2",
        hasFinishedActions: true,
        turnIndex: 2,
      });
    });

    it("prefers populated over empty trailing shell", () => {
      const snapshot = chatgptClient.extractLatestAssistantSnapshot([
        {
          role: "assistant",
          turn: "assistant",
          isAssistant: true,
          text: "Actual reply",
          messageId: "msg-1",
        },
        {
          role: "assistant",
          turn: "assistant",
          isAssistant: true,
          text: "\n\nCopy\nRead aloud\n",
          messageId: "msg-2",
        },
      ]);

      expect(snapshot).toEqual({
        role: "assistant",
        turn: "assistant",
        isAssistant: true,
        text: "Actual reply",
        messageId: "msg-1",
        turnIndex: 0,
      });
    });

    it("falls back to empty assistant when all are empty", () => {
      const snapshot = chatgptClient.extractLatestAssistantSnapshot([
        { role: "assistant", turn: "assistant", isAssistant: true, text: "", messageId: "msg-1" },
        {
          role: "assistant",
          turn: "assistant",
          isAssistant: true,
          text: "\n\n",
          messageId: "msg-2",
        },
      ]);

      expect(snapshot).toEqual({
        role: "assistant",
        turn: "assistant",
        isAssistant: true,
        text: "",
        messageId: "msg-2",
        turnIndex: 1,
      });
    });

    it("returns null for non-assistant candidates only", () => {
      expect(
        chatgptClient.extractLatestAssistantSnapshot([
          { role: "user", turn: "user", text: "hello" },
        ]),
      ).toBeNull();
    });

    it("accepts isAssistant: true without role/turn metadata", () => {
      const snapshot = chatgptClient.extractLatestAssistantSnapshot([
        { role: null, turn: null, isAssistant: true, text: "Answer from testid-only node" },
      ]);

      expect(snapshot?.text).toBe("Answer from testid-only node");
      expect(snapshot?.turnIndex).toBe(0);
    });
  });

  describe("normalizeChatGPTModelChoice", () => {
    it.each([
      ["Instant", "instant"],
      ["gpt-5-3", "instant"],
      ["Thinking", "thinking"],
      ["gpt-5-4-thinking", "thinking"],
      ["Pro", "pro"],
      ["gpt-5-4-pro", "pro"],
      ["GPT-5.5", "gpt55"],
      ["ChatGPT 5.5", "gpt55"],
      ["5.5", "gpt55"],
      ["GPT-5.6 Sol", "gpt56sol"],
      ["ChatGPT 5.6 Sol", "gpt56sol"],
      ["5.6 Sol", "gpt56sol"],
      ["something-else", "somethingelse"],
    ])("normalizes %s", (input, expected) => {
      expect(chatgptClient.normalizeChatGPTModelChoice(input)).toBe(expected);
    });
  });

  describe("resolveChatGPTModelMenuOption", () => {
    it("matches current ChatGPT model menu options by visible label", () => {
      expect(
        chatgptClient.resolveChatGPTModelMenuOption(
          [
            { role: null, label: "Latest", testId: null },
            { role: "menuitemradio", label: "Instant", testId: "model-switcher-gpt-5-3" },
            { role: "menuitemradio", label: "Thinking", testId: "model-switcher-gpt-5-4-thinking" },
            { role: "menuitemradio", label: "Pro", testId: "model-switcher-gpt-5-4-pro" },
            { role: "menuitem", label: "Configure...", testId: "model-configure-modal" },
          ],
          "thinking",
        ),
      ).toEqual({
        role: "menuitemradio",
        label: "Thinking",
        testId: "model-switcher-gpt-5-4-thinking",
      });
    });

    it("matches current ChatGPT model menu options by internal test id alias", () => {
      expect(
        chatgptClient.resolveChatGPTModelMenuOption(
          [
            { role: null, label: "Latest", testId: null },
            { role: "menuitemradio", label: "Instant", testId: "model-switcher-gpt-5-3" },
            { role: "menuitemradio", label: "Thinking", testId: "model-switcher-gpt-5-4-thinking" },
            { role: "menuitemradio", label: "Pro", testId: "model-switcher-gpt-5-4-pro" },
            { role: "menuitem", label: "Configure...", testId: "model-configure-modal" },
          ],
          "gpt-5-4-pro",
        ),
      ).toEqual({
        role: "menuitemradio",
        label: "Pro",
        testId: "model-switcher-gpt-5-4-pro",
      });
    });

    it("matches nested advanced model options without model-switcher test ids", () => {
      expect(
        chatgptClient.resolveChatGPTModelMenuOption(
          [
            { role: "menuitemradio", label: "GPT-5.6 Sol", testId: null },
            { role: "menuitemradio", label: "GPT-5.5", testId: null },
            { role: "menuitemradio", label: "o3 Leaving on August 26", testId: null },
          ],
          "gpt-5.6-sol",
        ),
      ).toEqual({ role: "menuitemradio", label: "GPT-5.6 Sol", testId: null });
      expect(
        chatgptClient.resolveChatGPTModelMenuOption(
          [
            { role: "menuitemradio", label: "GPT-5.6 Sol", testId: null },
            { role: "menuitemradio", label: "GPT-5.5", testId: null },
            { role: "menuitemradio", label: "o3 Leaving on August 26", testId: null },
          ],
          "gpt-5.5",
        ),
      ).toEqual({ role: "menuitemradio", label: "GPT-5.5", testId: null });
      expect(
        chatgptClient.resolveChatGPTModelMenuOption(
          [
            { role: "menuitemradio", label: "GPT-5.6 Sol", testId: null },
            { role: "menuitemradio", label: "GPT-5.5", testId: null },
          ],
          "pro",
        ),
      ).toBeNull();
    });

    it("ignores non-selectable menu rows like section labels and configure", () => {
      expect(
        chatgptClient.resolveChatGPTModelMenuOption(
          [
            { role: null, label: "Latest", testId: null },
            { role: "menuitem", label: "Configure...", testId: "model-configure-modal" },
          ],
          "latest",
        ),
      ).toBeNull();
    });
  });

  describe("verified ChatGPT picker state", () => {
    const modelState = [
      {
        role: "button",
        label: "ChatGPT 5.4 Thinking",
        testId: "model-switcher-dropdown-button",
      },
    ];
    const effortOptions = [
      { role: "menuitemradio", label: "Light", testId: "thinking-time-light" },
      { role: "menuitemradio", label: "Standard", testId: "thinking-time-standard" },
      { role: "menuitemradio", label: "Extended", testId: "thinking-time-extended" },
      { role: "menuitemradio", label: "Heavy", testId: "thinking-time-heavy" },
    ];
    const plusEffortOptions = [
      { role: "menuitemradio", label: "Instant", checked: false },
      { role: "menuitemradio", label: "Medium", checked: false },
      { role: "menuitemradio", label: "High", checked: true },
    ];

    it.each([
      ["requested model found", modelState, "thinking", "ChatGPT 5.4 Thinking"],
      [
        "GPT-5.5 readback",
        [{ role: "button", label: "ChatGPT 5.5 | Current model is ChatGPT 5.5", testId: null }],
        "gpt-5.5",
        "ChatGPT 5.5 | Current model is ChatGPT 5.5",
      ],
      [
        "GPT-5.6 Sol readback",
        [
          {
            role: "button",
            label: "ChatGPT 5.6 Sol | Current model is ChatGPT 5.6 Sol",
            testId: null,
          },
        ],
        "gpt-5.6-sol",
        "ChatGPT 5.6 Sol | Current model is ChatGPT 5.6 Sol",
      ],
      [
        "advanced menu current model row",
        [{ role: "menuitem", label: "Model GPT-5.6 Sol", testId: null }],
        "gpt-5.6-sol",
        "Model GPT-5.6 Sol",
      ],
      [
        "model readback ignores separate Pro effort",
        [
          {
            role: "button",
            label: "ChatGPT 5.6 Sol | Current model is ChatGPT 5.6 Sol",
            testId: null,
          },
          { role: "button", label: "Pro", testId: null },
        ],
        "gpt-5.6-sol",
        "ChatGPT 5.6 Sol | Current model is ChatGPT 5.6 Sol",
      ],
      [
        "Pro model readback",
        [
          {
            role: "button",
            label: "Pro | Current model is Pro",
            testId: null,
          },
        ],
        "pro",
        "Pro | Current model is Pro",
      ],
      ["requested model missing", modelState, "pro", null],
      ["ambiguous model state", [...modelState, ...modelState], "thinking", null],
      ["unreadable model state", [{ role: "button", label: "", testId: null }], "thinking", null],
    ])("handles %s", (_, items, requested, expectedLabel) => {
      expect(chatgptClient.verifyChatGPTModelSelection(items, requested)?.label ?? null).toBe(
        expectedLabel,
      );
    });

    it.each([
      ["requested effort found", [effortOptions[2]], "extended", "Extended"],
      [
        "plus radio with Effort-prefixed label",
        [{ role: "menuitemradio", label: "EffortHigh", checked: true, testId: null }],
        "high",
        "EffortHigh",
      ],
      ["requested effort missing", [effortOptions[1]], "extended", null],
      ["ambiguous effort state", [effortOptions[2], effortOptions[2]], "extended", null],
      [
        "unreadable effort state",
        [{ role: "menuitemradio", label: "", testId: null }],
        "extended",
        null,
      ],
    ])("handles %s", (_, items, requested, expectedLabel) => {
      expect(chatgptClient.verifyChatGPTEffortSelection(items, requested)?.label ?? null).toBe(
        expectedLabel,
      );
    });

    it("resolves effort options and accepts only the documented vocabulary", () => {
      expect(chatgptClient.resolveChatGPTEffortMenuOption(effortOptions, "extended")).toEqual(
        effortOptions[2],
      );
      expect(chatgptClient.normalizeChatGPTEffortChoice("STANDARD")).toBe("standard");
      expect(chatgptClient.normalizeChatGPTEffortChoice("Pro")).toBe("pro");
      // ChatGPT Plus exposes Instant/Medium/High instead of the legacy tiers.
      expect(chatgptClient.normalizeChatGPTEffortChoice("High")).toBe("high");
      expect(chatgptClient.normalizeChatGPTEffortChoice("MEDIUM")).toBe("medium");
      expect(chatgptClient.normalizeChatGPTEffortChoice("instant")).toBe("instant");
      expect(chatgptClient.resolveChatGPTEffortMenuOption(plusEffortOptions, "high")).toEqual(
        plusEffortOptions[2],
      );
      expect(
        chatgptClient.resolveChatGPTEffortMenuOption(plusEffortOptions, "extended"),
      ).toBeNull();
    });

    describe("plus composer helpers", () => {
      it("recognizes the effort pill by its exact label", () => {
        expect(selection.isPlusComposerEffortPillLabel("High")).toBe(true);
        expect(selection.isPlusComposerEffortPillLabel("  instant ")).toBe(true);
        expect(selection.isPlusComposerEffortPillLabel("Pro")).toBe(false);
        expect(selection.isPlusComposerEffortPillLabel("Higher")).toBe(false);
        expect(selection.isPlusComposerEffortPillLabel("")).toBe(false);
      });

      it.each([
        ["ModelGPT-5.6 Sol", "model", "GPT-5.6 Sol"],
        ["EffortHigh", "effort", "High"],
        ["Advanced", null, ""],
      ])("classifies row %j", (label, kind, value) => {
        expect(selection.plusMenuRowKind(label)).toBe(kind);
        expect(kind ? selection.plusMenuRowCurrentValue(label, kind) : "").toBe(value);
      });

      it("matches Plus model radios through the shared model matcher", () => {
        const radios = [
          { role: "menuitemradio", label: "GPT-5.6 Sol", checked: true },
          { role: "menuitemradio", label: "GPT-5.5", checked: false },
        ];
        const matches = radios.filter((item) => selection.modelCandidateMatches(item, "gpt56sol"));
        expect(matches).toHaveLength(1);
        expect(matches[0].label).toBe("GPT-5.6 Sol");
      });
    });
  });

  describe("isNewAssistantContent", () => {
    it.each([
      ["no latest", null, { text: "Answer" }, 2, 1, false],
      ["no baseline", { text: "Answer" }, null, 1, 0, true],
      [
        "identical snapshot",
        { text: "Answer", messageId: "msg-1" },
        { text: "Answer", messageId: "msg-1" },
        2,
        2,
        false,
      ],
      [
        "new turn with same text",
        { text: "4", messageId: null, turnIndex: 1 },
        { text: "4", messageId: null, turnIndex: 0 },
        2,
        1,
        true,
      ],
      [
        "empty shell growth",
        { text: "4", messageId: null, turnIndex: 0 },
        { text: "4", messageId: null, turnIndex: 0 },
        2,
        1,
        false,
      ],
      // Same message id means the same turn, however much its rendered text
      // drifts. Treating a re-rendered baseline turn as new content is how a
      // follow-up job would capture its parent's answer.
      [
        "baseline turn re-rendered under the same message id",
        { text: "Old answer\nThought for 12s", messageId: "msg-1", turnIndex: 2 },
        { text: "Old answer", messageId: "msg-1", turnIndex: 1 },
        3,
        2,
        false,
      ],
      [
        "text changed without message ids",
        { text: "New answer", messageId: null, turnIndex: 0 },
        { text: "Old answer", messageId: null, turnIndex: 0 },
        2,
        2,
        true,
      ],
      [
        "messageId changed",
        { text: "Answer", messageId: "msg-2" },
        { text: "Answer", messageId: "msg-1" },
        2,
        2,
        true,
      ],
    ])(
      "%s",
      (_, latestAssistant, baselineAssistant, assistantCount, baselineAssistantCount, expected) => {
        expect(
          chatgptClient.isNewAssistantContent(
            latestAssistant,
            baselineAssistant,
            assistantCount,
            baselineAssistantCount,
          ),
        ).toBe(expected);
      },
    );
  });

  describe("isChatGPTResponseComplete", () => {
    it("returns false for empty text", () => {
      expect(
        chatgptClient.isChatGPTResponseComplete(
          { text: "", stopVisible: false, hasFinishedActions: true },
          6,
          1200,
        ),
      ).toBe(false);
    });

    it("returns false when stop button is still visible", () => {
      expect(
        chatgptClient.isChatGPTResponseComplete(
          { text: "Answer", stopVisible: true, hasFinishedActions: true },
          6,
          1200,
        ),
      ).toBe(false);
    });

    it("returns true when finished actions are visible and stop is hidden", () => {
      expect(
        chatgptClient.isChatGPTResponseComplete(
          { text: "Answer", stopVisible: false, hasFinishedActions: true },
          0,
          0,
        ),
      ).toBe(true);
    });

    it("returns true when text has been stable long enough", () => {
      expect(
        chatgptClient.isChatGPTResponseComplete(
          { text: "Answer", stopVisible: false, hasFinishedActions: false },
          6,
          1200,
        ),
      ).toBe(true);
    });

    it("returns false when stability thresholds are not met", () => {
      expect(
        chatgptClient.isChatGPTResponseComplete(
          { text: "Answer", stopVisible: false, hasFinishedActions: false },
          5,
          1199,
        ),
      ).toBe(false);
    });
  });

  describe("fresh-tab harvest gates", () => {
    it("preserves Cloudflare challenge classification", async () => {
      const closeTab = vi.fn(async () => undefined);

      await expect(
        chatgptClient.harvest({
          tabId: null,
          conversationUrl: "https://chatgpt.com/c/conversation-id",
          promptEcho: "review",
          createTab: async () => ({ tabId: 123 }),
          closeTab,
          cdpCommand: vi.fn(async () => ({})),
          cdpEvaluate: async (_tabId: number, expression: string) => {
            if (expression === "document.readyState") {
              return { result: { value: "complete" } };
            }
            if (expression === "document.title.toLowerCase()") {
              return { result: { value: "just a moment" } };
            }
            throw new Error(`Unexpected expression: ${expression}`);
          },
        }),
      ).rejects.toMatchObject({ code: "cloudflare" });
      expect(closeTab).toHaveBeenCalledWith(123);
    });

    it("preserves login failure classification", async () => {
      const closeTab = vi.fn(async () => undefined);

      await expect(
        chatgptClient.harvest({
          tabId: null,
          conversationUrl: "https://chatgpt.com/c/conversation-id",
          promptEcho: "review",
          createTab: async () => ({ tabId: 123 }),
          closeTab,
          cdpCommand: vi.fn(async () => ({})),
          cdpEvaluate: createReadyChatGptEvaluate({ status: 401, hasLoginCta: true }),
        }),
      ).rejects.toMatchObject({ code: "auth" });
      expect(closeTab).toHaveBeenCalledWith(123);
    });
  });

  describe("query", () => {
    it("invokes the upload callback for ChatGPT files and propagates upload errors", async () => {
      const uploadFile = vi.fn(async () => ({ error: "composer file input not found" }));
      const closeCalls: number[] = [];

      await expect(
        chatgptClient.query({
          prompt: "summarize this",
          file: "fixtures/report.txt",
          getCookies: async () => ({
            cookies: [{ name: "__Secure-next-auth.session-token.0", value: "abc" }],
          }),
          createTab: async () => ({ tabId: 123 }),
          closeTab: async (tabId: number) => {
            closeCalls.push(tabId);
          },
          uploadFile,
          cdpCommand: async () => {
            throw new Error("cdpCommand should not be called before upload succeeds");
          },
          cdpEvaluate: createReadyChatGptEvaluate(),
        }),
      ).rejects.toThrow("ChatGPT file upload failed: composer file input not found");

      expect(uploadFile).toHaveBeenCalledWith(123, [
        expect.stringContaining("fixtures/report.txt"),
      ]);
      expect(closeCalls).toEqual([123]);
    });

    it("throws a clear error when ChatGPT file upload is requested without a host callback", async () => {
      await expect(
        chatgptClient.query({
          prompt: "summarize this",
          file: "report.txt",
          getCookies: async () => ({
            cookies: [{ name: "__Secure-next-auth.session-token.0", value: "abc" }],
          }),
          createTab: async () => ({ tabId: 123 }),
          closeTab: async () => undefined,
          cdpCommand: async () => {
            throw new Error("cdpCommand should not be called");
          },
          cdpEvaluate: createReadyChatGptEvaluate(),
        }),
      ).rejects.toThrow(
        "ChatGPT file upload unavailable: native host did not provide upload callback",
      );
    });

    // A login probe that never completed says nothing about the session, so it
    // must keep its own message and stay uncoded: harvest watchers retry
    // uncoded failures and treat `auth` as final.
    it("reports an incomplete login check as transient, not as a login wall", async () => {
      const closeCalls: number[] = [];

      await expect(
        chatgptClient.query({
          prompt: "hello",
          getCookies: async () => ({
            cookies: [{ name: "__Secure-next-auth.session-token.0", value: "abc" }],
          }),
          createTab: async () => ({ tabId: 123 }),
          closeTab: async (tabId: number) => {
            closeCalls.push(tabId);
          },
          cdpCommand: async () => {
            throw new Error("cdpCommand should not be called");
          },
          cdpEvaluate: createReadyChatGptEvaluate({
            status: 0,
            error: "TypeError: Failed to fetch",
            url: "https://chatgpt.com/",
          }),
        }),
      ).rejects.toThrow("ChatGPT login check did not complete: TypeError: Failed to fetch");

      await expect(
        chatgptClient.query({
          prompt: "hello",
          getCookies: async () => ({
            cookies: [{ name: "__Secure-next-auth.session-token.0", value: "abc" }],
          }),
          createTab: async () => ({ tabId: 124 }),
          closeTab: async (tabId: number) => {
            closeCalls.push(tabId);
          },
          cdpCommand: async () => {
            throw new Error("cdpCommand should not be called");
          },
          cdpEvaluate: createReadyChatGptEvaluate({
            status: 0,
            error: "TypeError: Failed to fetch",
            url: "https://chatgpt.com/",
          }),
        }),
      ).rejects.not.toMatchObject({ code: "auth" });

      expect(closeCalls).toEqual([123, 124]);
    });
  });

  describe("hasRequiredCookies", () => {
    it("accepts exact session cookie", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token", value: "abc" },
        ]),
      ).toBe(true);
    });

    it("accepts chunked session cookie .0", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token.0", value: "abc" },
        ]),
      ).toBe(true);
    });

    it("accepts chunked session cookie .1", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token.1", value: "abc" },
        ]),
      ).toBe(true);
    });

    it("rejects exact cookie with empty value", () => {
      expect(
        chatgptClient.hasRequiredCookies([{ name: "__Secure-next-auth.session-token", value: "" }]),
      ).toBe(false);
    });

    it("rejects chunked cookie with empty value", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token.0", value: "" },
        ]),
      ).toBe(false);
    });

    it("rejects non-numeric chunk suffix", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token.foo", value: "abc" },
        ]),
      ).toBe(false);
    });

    it("rejects trailing dot without suffix", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token.", value: "abc" },
        ]),
      ).toBe(false);
    });

    it("rejects lookalike with different separator", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "__Secure-next-auth.session-token-extra", value: "abc" },
        ]),
      ).toBe(false);
    });

    it("rejects null and undefined", () => {
      expect(chatgptClient.hasRequiredCookies(null)).toBe(false);
      expect(chatgptClient.hasRequiredCookies(undefined)).toBe(false);
    });

    it("rejects non-array input", () => {
      expect(chatgptClient.hasRequiredCookies({} as unknown as [])).toBe(false);
    });

    it("rejects unrelated cookies", () => {
      expect(
        chatgptClient.hasRequiredCookies([
          { name: "oai-did", value: "abc" },
          { name: "__Host-next-auth.csrf-token", value: "abc" },
        ]),
      ).toBe(false);
    });
  });
});
