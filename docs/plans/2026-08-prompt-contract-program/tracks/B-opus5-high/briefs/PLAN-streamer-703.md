# Approved-pending plan — streamer #703 (from `streamer-arbitration-engineer`, 2026-08-28)

Sub-agent died on the usage limit after delivering this. A respawned agent implements **this plan**, it does not re-derive it. All lines are `origin/main@e71487c8`.

## Decision: Candidate A, narrowed to `state === "resolved"`

Verified by the sub-agent and spot-checked by the orchestrator:

- `pendingPermission.set` has exactly one site (`sessions.handlers.ts:1274`); deletes at `:1222` (detector null), `:1457` (`gateClosed`), `server-wiring.ts:104` (expiry, guarded on promptId), `:524` (session end).
- Exactly three `transition(..., "resolved", ...)` sites exist: `promptRegistry.ts:375` (after the adapter returned ok), `sessions.handlers.ts:1525` (after `sendKeys` at :1517), `:1612` (question path, never a permission promptId). **Orchestrator confirmed by grep.** So for an id held by a `pendingPermission` entry, `resolved` ⇔ keys were written.
- **Why not "terminal":** `permissionAnswerAdapter:1323–1327` returns `terminal: { state: "cancelled", reason: "provider_closed" }` when the freshness scrape fails, **and does not delete `pendingPermission`** (unlike `questionAnswerAdapter`, which deletes at :1377/:1398). **Orchestrator confirmed by reading :1298–1341.** A `state !== "open"` predicate would tell a user "your answer was sent" when it was refused and zero bytes were written. `=== "resolved"` removes that and the `unavailable` case.
- Four probed cases: promptId absent ⇒ zero-option gate, can never reach an accepted answer (`unknown_option` at :1498) so "answered" is unreachable, classifies open = today's behaviour; pty-host ⇒ `occurrenceId` *is* the promptId arg (`promptRegistry.ts:159`), entry and record cannot drift; replaced-under-same-id ⇒ `open()` throws on a live id (:162) and mints fresh over a retained one (:173); pruned ⇒ `sweepExpired` needs 10 min, `enforceCap` evicts oldest terminal first and a just-resolved record is the newest.
- A also covers the structured route `handlePromptAnswer` (:1633), which resolves through the adapter and likewise leaves the entry in place. A marker on the legacy accept path alone would miss it.

Candidate B is **not** implemented. Nothing is added to `PendingPermission`.

## Code

Replaces `sessions.handlers.ts:1077–1090`:

```ts
const pendingGate = openPrompt === "permission" ? this.pendingPermission.get(sessionId) : undefined;
const promptState =
  pendingGate?.promptId !== undefined &&
  this.promptRegistry.get(pendingGate.promptId)?.state === "resolved"
    ? "answered"
    : "open";
```

Open case (`error` byte-identical to today):
`{ ok: false, reason: "prompt_pending", promptKind: openPrompt, promptState: "open", error: "A prompt is waiting for an answer; answer or dismiss it before sending text" }`

Answered case (permission only):
`{ ok: false, reason: "prompt_pending", promptKind: "permission", promptState: "answered", error: "Your answer was sent; wait for the prompt to close before sending text" }`

409 both. `promptState` is always present; for `promptKind: "question"` it is always `"open"` — accurate, because both question accept paths delete `pendingQuestions` (`:1398`, `:1614`; **orchestrator confirmed :1614**), so no answered-awaiting-close window exists there. The metadata log at :1078–1082 gains `state=${promptState}` / `promptState` (two-value enum, content-free).

Files: `src/api/handlers/sessions.handlers.ts` (arbitration block only) + `__tests__/input-prompt-arbitration.test.ts`.

## Tests (harness: arbitration deps `:48–87` merged with gate-identity deps `permission-gate-identity.test.ts:81–120`; real detector → change → answer → sendInput)

1. `"names an answered gate awaiting close and still writes zero bytes"` — positive; fails today (no `promptState`, open wording).
2. `"keeps the open wording for text sent before the answer"` — negative control, `error` asserted as a literal.
3a. `"treats the transient gate minted after an answer as open"` — Group C sequence; open is **correct**, assert it.
3b. `"keeps answered across a cursor-move repaint"` — same promptId.
3c. `"returns to open when the gate repaints with different content"`.
4. `"clears the gate on the detector's close and writes the text"` — doubles as the harness positive control (200, `inputs === ["hello"]`).
5. `"does not arbitrate { keys } in the answered window"`.
6. `"calls a cancelled-but-pending gate open, not answered"` — **keep**; this is what stops a future widening to `!== "open"`.

Mutations, both required: `=== "resolved"` → `=== "cancelled"` (expect test 1 to fail), then `=== "resolved"` → `!== "open"` (expect test 6 to fail). Report each failing test name and its verbatim assertion text, then restore.

`permission-close-on-answer.test.ts` needs no companion (PTYManager-level, no handler).

## Constraints carried over

`npx tsc --noEmit` does **not** cover `__tests__` (`tsconfig.json:21` excludes it) — do not claim test types are checked. Do not fix the pre-existing missing `gateId` at `input-prompt-arbitration.test.ts:54` (out of scope, list as a finding).
