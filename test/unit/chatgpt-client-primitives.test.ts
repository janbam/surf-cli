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
});
