// @vitest-environment jsdom
// @ts-expect-error - CommonJS module without type definitions
import * as chatgptClient from "../../native/chatgpt-client.cjs";

const fs = require("node:fs");
const path = require("node:path");

/**
 * The conversation snapshot runs as JavaScript injected into the ChatGPT page,
 * so every selector and attribute assumption in it is invisible to tests that
 * feed hand-written snapshot objects. Two live defects came from exactly that
 * blind spot: message ids read off the turn wrapper (which never carries one),
 * and a stop button that counted as "generating" merely by existing.
 *
 * These tests run the real injected expression against recorded ChatGPT markup,
 * so a selector that stops matching fails here instead of during a live consult.
 */

const FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test/fixtures/chatgpt-conversation-turns.html"),
  "utf8",
);

/**
 * Run the injected snapshot expression against the current jsdom document.
 *
 * Mirrors the extension bridge: the expression is evaluated in page context and
 * its value is returned as the CDP `result.value` envelope the client unwraps.
 */
/**
 * Place extra markup inside `<main>`, which is the scope the snapshot walks.
 * Appending after `</main>` silently puts it out of reach and makes any
 * assertion about it pass for the wrong reason.
 */
function withinMain(markup: string) {
  return FIXTURE.replace("</main>", `${markup}</main>`);
}

async function snapshotFixture(html: string = FIXTURE) {
  document.body.innerHTML = html;
  const cdp = async (expression: string) => ({
    // Evaluating page-context code is the whole point: the expression under
    // test is a string that only ever runs inside a browser tab.
    result: { value: new Function(`return (${expression})`)() },
  });
  return chatgptClient.readChatGPTResponseSnapshot(cdp);
}

describe("readChatGPTResponseSnapshot against recorded ChatGPT markup", () => {
  it("extracts both turns with their roles", async () => {
    const snapshot = await snapshotFixture();

    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.candidates.map((c: { role: string }) => c.role)).toEqual(["user", "assistant"]);
  });

  // The regression that survived 763 unit tests and two review rounds: ChatGPT
  // renders a turn as a SECTION carrying data-turn, while the durable id lives
  // on an inner DIV. Reading identity off the wrapper leaves every turn
  // anonymous and silently demotes attribution to comparing rendered text.
  it("reads message ids from the inner message node, not the turn wrapper", async () => {
    const snapshot = await snapshotFixture();

    expect(snapshot.candidates[0].messageId).toBe("75bf0572-c24f-4853-85e2-47f6f9255cf8");
    expect(snapshot.candidates[1].messageId).toBe("5f529a6f-2522-494d-8b01-ae33059afda3");
  });

  it("identifies the assistant turn and its answer text", async () => {
    const normalized = chatgptClient.normalizeResponseSnapshot(await snapshotFixture());

    expect(normalized.assistantCount).toBe(1);
    expect(normalized.latestAssistant).toMatchObject({
      messageId: "5f529a6f-2522-494d-8b01-ae33059afda3",
      text: "FIRST-ANSWER-7",
      turnIndex: 1,
    });
  });

  // The action row is what marks a turn finished, so losing this selector would
  // strand every job until the stability fallback or the harvest deadline.
  it("sees the finished-actions row on the settled assistant turn", async () => {
    const snapshot = await snapshotFixture();

    expect(snapshot.candidates[1].hasFinishedActions).toBe(true);
  });

  describe("stopVisible", () => {
    it("is false for a settled conversation", async () => {
      expect((await snapshotFixture()).stopVisible).toBe(false);
    });

    it("is true while a usable stop button is on the page", async () => {
      const generating = withinMain('<button data-testid="stop-button">Stop</button>');

      expect((await snapshotFixture(generating)).stopVisible).toBe(true);
    });

    // A stop button left behind after a turn settles stalled a live job in
    // `awaiting` for 16 minutes. Presence alone must not mean "generating".
    it.each([
      ["hidden by display", '<button data-testid="stop-button" style="display:none">Stop</button>'],
      [
        "hidden by visibility",
        '<button data-testid="stop-button" style="visibility:hidden">Stop</button>',
      ],
      ["marked hidden", '<button data-testid="stop-button" hidden>Stop</button>'],
      ["disabled", '<button data-testid="stop-button" disabled>Stop</button>'],
    ])("ignores a stop button %s", async (_label, markup) => {
      expect((await snapshotFixture(withinMain(markup))).stopVisible).toBe(false);
    });
  });
});
