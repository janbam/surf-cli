// @ts-expect-error - CommonJS module without type definitions
import * as chatgptClient from "../../native/chatgpt-client.cjs";

const SERVER_ID = "6a8c33e1-6ffc-83eb-9d17-0a69c51d45f8";

describe("chatgpt-client primitives", () => {
  it("normalizes whitespace and truncates the prompt echo to 200 characters", () => {
    expect(chatgptClient.normalizePromptEcho("  review\n\tthis   code  ")).toBe("review this code");
    expect(chatgptClient.normalizePromptEcho(`Review ${"x".repeat(250)}`)).toHaveLength(200);
  });

  it.each([
    [`https://chatgpt.com/c/${SERVER_ID}`, `https://chatgpt.com/c/${SERVER_ID}`],
    [`https://chatgpt.com/c/${SERVER_ID}?model=pro#turn`, `https://chatgpt.com/c/${SERVER_ID}`],
    ["https://chatgpt.com/", null],
    [`https://example.com/c/${SERVER_ID}`, null],
    ["not a URL", null],
  ])("extracts a canonical conversation URL from %s", (input, expected) => {
    expect(chatgptClient.extractConversationUrl(input)).toBe(expected);
  });

  // ChatGPT routes to a client-side placeholder id first; recording it would
  // persist a URL that resolves to a different conversation after a reload.
  it.each([
    `https://chatgpt.com/c/WEB:${SERVER_ID}`,
    "https://chatgpt.com/c/abc-123",
    `https://chatgpt.com/c/${SERVER_ID}extra`,
  ])("refuses the non-durable conversation id in %s", (input) => {
    expect(chatgptClient.extractConversationUrl(input)).toBeNull();
  });

  // Live regression: the composer is ready long before a reopened conversation
  // paints its turns, and a baseline taken in that window is empty — which
  // silently disables message-id turn identity for the follow-up that needs it.
  describe("waitForConversationTurns", () => {
    const snapshotWith = (candidates: unknown[]) => ({
      result: { value: { candidates, stopVisible: false } },
    });

    // User turns paint first. A transcript showing only those still normalizes
    // to an empty baseline, so it must not satisfy the gate.
    it("waits for the assistant turn, not merely for any rendered turn", async () => {
      const renders = [
        snapshotWith([]),
        snapshotWith([{ role: "user", isUser: true, text: "parent question" }]),
        snapshotWith([
          { role: "user", isUser: true, text: "parent question" },
          { role: "assistant", isAssistant: true, text: "parent", messageId: "m1" },
        ]),
      ];
      let call = 0;
      const cdp = async () => renders[Math.min(call++, renders.length - 1)];

      const snapshot = await chatgptClient.waitForConversationTurns(cdp, 5000);

      expect(chatgptClient.normalizeResponseSnapshot(snapshot).latestAssistant).toMatchObject({
        messageId: "m1",
      });
      expect(call).toBeGreaterThan(2);
    });

    it("refuses to continue with an empty conversation rather than guess", async () => {
      const cdp = async () => snapshotWith([]);

      await expect(chatgptClient.waitForConversationTurns(cdp, 300)).rejects.toMatchObject({
        code: "baseline_unavailable",
      });
    });
  });
});
