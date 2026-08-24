# Surf Oracle harvest investigation — 2026-08-24

Working notes for an unfinished fix. Written to be read with no prior conversation context.

## Repo context

`janbam/surf-cli` is a fork of `nicobailon/surf-cli` (git remote `upstream`). Upstream drives ChatGPT through a **Pro** account UI. This fork targets the **Plus** composer: a single pill labeled with the active effort (Instant/Medium/High) which opens a menu whose `Model` and `Effort` rows expand into flat radio lists. Packaged Pi agent is `agents/gpt.md` (upstream calls it `gpt-pro.md`), pinned to GPT-5.6 Sol + High.

`main` is at the merge of upstream 2.16.1 plus fork-specific fixes. Fork merge policy: keep our Plus selection flow in `native/chatgpt-client-ui.cjs`; do not carry upstream's Pro-picker fixes (#217–#221) wholesale. Deliberately taken from them: #217's effort matcher shape (label words first, testId fallback) in `chatgpt-client-selection.cjs`; #219's `aria-labelledby` label fallback in `readVisibleRadios`/`clickRadio`; #221's reordering (type prompt *before* selecting effort) in `chatgpt-client.cjs::dispatch`.

**Merge trap worth remembering:** upstream #221 has two halves — (1) reorder so the prompt is typed before effort verification, (2) clear stale composer text before inserting. Taking (1) without (2) is worse than taking neither, because the reorder guarantees that a failed effort verification leaves a fully typed prompt sitting in the composer. That is exactly what happened here (root cause A).

## Symptom

`oracle.result` never captures a finished response for a job whose dispatch already returned. The job stays `awaiting` forever, even though the answer is plainly visible in the browser.

This wedges the whole subsystem: `createJob` refuses to start while any non-terminal job exists (`native/oracle-jobs.cjs:116`), so one stranded job makes every later ask fail with `oracle job capacity reached; in-flight job: <id>`.

Asymmetry that cracked the case: live `surf oracle ask` (dispatch, then poll) captures promptly, while `oracle result <id>` on an already-dispatched job spins until timeout. The live path holds an in-memory baseline snapshot; the orphan path does not and falls back to brittle prompt-string matching.

## Confirmed root causes

### A. Composer append produced a fused prompt — FIXED, needs live validation

`typePrompt` (`native/chatgpt-client-ui.cjs:372`) focused the composer, placed the caret via a range collapsed to the **end** of existing content, then issued CDP `Input.insertText`. With leftover text in the composer, the new prompt was appended rather than replacing.

Observed live: a dispatch failed during effort verification and left its prompt in the composer. The next dispatch appended to it and submitted a 250-character fusion of two prompts, while recording `promptEcho` for only the second one:

```
"Live test of the Plus composer picker: ...nothing else.Live test round 2 of the Plus composer picker: ...nothing else."
```

The old verification step only asserted the composer was **non-empty**, so the fused prompt passed unnoticed.

Fix applied: select existing composer contents instead of collapsing the caret (textareas use `node.select()`), then assert the composer contains **exactly** the intended prompt (whitespace-normalized equality). On mismatch, overwrite wholesale via the existing fallback, re-read, and throw if it still differs. This converts silent corruption into a loud failure and makes `promptEcho` trustworthy.

Upstream's #221 clearing block was deliberately **not** ported verbatim. It sets `node.textContent = ''` (or `node.value = ''`) and fires a synthetic `InputEvent`. ChatGPT's composer is ProseMirror-backed, and mutating its DOM directly is a good way to desync the editor's internal document state; driving the real input pipeline via selection plus `Input.insertText` is closer to what a human does. The equivalent of upstream's overwrite already exists here as the fallback branch, which assigns `editor.textContent = prompt` wholesale — it now runs whenever the composer content does not match exactly, instead of only when the composer is empty, and its result is re-verified. Do not re-add upstream's block on top without a reason; the coverage is already there.

Unvalidated assumption: that CDP `Input.insertText` replaces the current selection rather than inserting at its start. If a live run shows it does not, the verification catches it and the overwrite fallback takes over, so behavior stays correct either way — but confirm which path is actually being exercised, because silently relying on the fallback would hide a broken primary path.

### B. Transient conversation URL is recorded as durable

`extractConversationUrl` (`native/chatgpt-client.cjs:47`) accepts any `/c/<segment>` path. ChatGPT first routes optimistically to a **client-side placeholder** id, then swaps in the server id. `waitForConversationUrl` (`native/chatgpt-client.cjs:75`) returns the first match it sees, so jobs persist the placeholder.

Observed live for job `20260824-120653-6f6f`:

| | |
|---|---|
| stored in `job.json` | `https://chatgpt.com/c/WEB:7728c278-8336-4499-b20b-d14fd1a09004` |
| actual tab URL | `https://chatgpt.com/c/6a8c33e1-6ffc-83eb-9d17-0a69c51d45f8` |

Different conversations entirely. Any fresh-tab recovery navigates to a dead URL, so an orphan whose tab has closed is unrecoverable. An older stranded job showed the same `WEB:` shape, so this predates the upstream merge.

Fix direction: reject placeholder ids (they carry a `WEB:` prefix; real ids are plain UUIDs) and keep polling until the server id appears. Record `null` rather than a known-false URL if only placeholders were ever seen. Measure in a live run how long the swap takes before choosing the wait budget.

### C. Unmatchable jobs starve silently instead of failing

`waitForResponse` (`native/chatgpt-client-response.cjs:259`) scopes the conversation with `scopeSnapshotToPrompt` (`:157`), which requires a user turn whose whitespace-normalized, 200-character-truncated text **exactly equals** `promptEcho` (`matchesPromptEcho`, `:11`). No match yields `candidates: []`, so `latestAssistant` is null, `isNewAssistantContent` returns false, and the loop `continue`s until the deadline.

A permanent mismatch is therefore indistinguishable from "response still generating", and costs a full timeout (default 300s in `oracle-host.result`, `native/oracle-host.cjs:163`) before `oracle-host.cjs:277` converts the timeout back into an unchanged `awaiting` job. The job then wedges capacity forever.

Fix direction: distinguish "no turn matches this job" from "not ready yet". After a short grace period, if the DOM has conversation turns but none can be attributed to this job, fail with a specific error code and mark the job failed so it stops blocking capacity.

### D. The dispatch baseline is computed, returned, and thrown away — design root cause

`dispatch` snapshots the conversation immediately before sending (`native/chatgpt-client.cjs:180`) and returns it as `baseline`. `harvest` (`:209`) already prefers it over the echo:

```js
waitForResponse(cdp, ..., baseline?.latestAssistant, baseline?.assistantCount, signal, baseline ? undefined : promptEcho)
```

But the baseline is never persisted: `afterSubmit({ tabId, promptEcho, modelVerified, effortVerified })` (`:186`) omits it, `markDispatched` (`native/oracle-jobs.cjs:205`) and `markAwaiting` (`:215`) have no field for it, and `oracle-host.result` never supplies one. So every orphan harvest is forced onto the fragile string-equality path, which A and B then break.

This is why the live path works and the orphan path does not.

Fix direction (the actual design fix): persist the baseline as a durable job fact at dispatch and pass it back on recovery. Then identification is by turn identity (`messageId`, assistant turn count) instead of prompt text. For a fresh conversation the baseline is empty, so any assistant turn qualifies — no echo needed at all. For follow-ups into an existing conversation, the recorded count and last `messageId` identify the new turn. Keep `promptEcho` only as a fallback for jobs recorded before this change, and let that fallback fail loudly per C.

Persist the baseline assistant's full text, not a truncated form: `isNewAssistantContent` (`native/chatgpt-client-response.cjs:118`) falls back to text comparison when message ids are absent or equal, and a truncated baseline would compare unequal and misreport a stale answer as new. Note `baseline[RESPONSE_STARTED_AT]` uses a `Symbol` key that will not survive JSON; its only use is trimming the elapsed time budget, so its absence after reload is harmless.

## Suggested order of work

1. **B** — conversation URL correctness. Prerequisite for any recovery after the tab closes.
2. **D** — persist and use the baseline. The core fix; largely plumbing, since `harvest` already supports it.
3. **C** — fail loud and release capacity when a job cannot be attributed. Prevents future wedging.
4. Live validation (recipe below), then reassess whether `scopeSnapshotToPrompt` should survive at all.

Also worth examining: `adoptOrphans` (`native/oracle-jobs.cjs:305`) already exists and may be the right home for reconciling stranded jobs; and `surf oracle --help` still advertises Pro-only effort names (`light, standard, extended, heavy, pro`) although this fork accepts `instant`, `medium`, `high`.

## Validation recipe

Unit suite is fast and currently green: `npx vitest run` (735 passing, 2 skipped) and `npm run check` (tsc, both configs). Biome ignores `native/`.

Live testing requires Chrome running with the Surf extension and a logged-in ChatGPT Plus session.

```
node native/cli.cjs tab.list                                  # tab ids + real URLs
node native/cli.cjs js --file /tmp/probe.js --tab <TAB_ID>     # run a DOM probe
node native/cli.cjs oracle ask "<prompt>" --model gpt-5.6-sol --effort high
node native/cli.cjs oracle status <JOB_ID> --json
node native/cli.cjs oracle result <JOB_ID> --json
```

`js` evaluates an **expression**, not a statement body: top-level `return` throws `SyntaxError`. Wrap probes in an IIFE and pass them with `--file` to avoid shell quoting problems. The `--tab` flag goes after the code argument.

Job state lives in `~/.surf/state/oracle/<job-id>/job.json` (override with `SURF_STATE_DIR`). Inspecting `job.json` directly is the fastest way to see `promptEcho`, `tabId`, `conversationUrl`, and state.

To clear a wedged capacity block, remove the job directories and recreate the folder with `0700` permissions. This destroys captured history and any evidence, so copy anything interesting aside first.

## Open questions

- How long does ChatGPT take to swap the placeholder conversation id for the server id, and does the placeholder ever persist? Needed to size the wait in B.
- Does CDP `Input.insertText` replace a non-collapsed selection? Assumed yes in fix A.
- Should a job whose tab is gone and whose conversation URL is unusable fail immediately, or should recovery attempt a history search by prompt text? Failing fast is simpler and matches the fail-closed style elsewhere.
- The dispatch that failed effort verification had already submitted nothing, yet left a conversation-shaped mess behind. Worth checking whether failed dispatches should always close their tab, since a leftover tab is what fed root cause A.
