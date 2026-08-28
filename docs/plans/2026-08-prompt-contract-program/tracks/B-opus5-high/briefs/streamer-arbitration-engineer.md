# Brief — `streamer-arbitration-engineer`

Repo: `tb-streamer` (`RonenMars/threadbase-streamer`). Issue: **#703** — "distinguish an answered gate awaiting close from an open one in input arbitration". Nothing else.

## 1. Verified state, re-confirmed on `origin/main@e71487c8` (2026-08-28)

The issue cites `main@411f5b51`; every line number below is recomputed **against `origin/main@e71487c8` itself**, not against the root checkout (which still sits at `3ec9861a` and is one commit stale — read the file from `origin/main`). `src/api/handlers/sessions.handlers.ts` is 2160 lines there.

- `handleSendInput` arbitration: the expiry sweep is **:1071** — `this.promptRegistry.sweepExpired(sessionId)`, renamed from the bare `hasActionable` call by #702, one-line comment above it at :1070. The map read is **:1072–1076** (`pendingPermission.has` → `"permission"`, else `pendingQuestions.has` → `"question"`), the metadata log **:1078–1082**, and the refusal **:1083–1090**: `json(res, 409, { ok: false, reason: "prompt_pending", promptKind: openPrompt, error: "A prompt is waiting for an answer; answer or dismiss it before sending text" })`.
- `handlePermissionAnswer` **:1430**. The `gateClosed()` helper **:1451–1461** is the only path that deletes the entry (`pendingPermission.delete` / `pendingPermissionKey.delete` at :1457–1458). The accept path sends keys, transitions the registry record to `resolved`/`answered_legacy` (**:1525**), and answers `json(res, 200, { ok: true })` at **:1527 without touching either map**.
- The detector close is `handlePermissionChange(sessionId, null)` **:1205**, deleting at **:1222–1223**.
- The entry is written at **:1274–1280**. Two identity keys are in play and they differ: the broadcast dedupe key is `permissionContentKey` (**includes** `cursor`, `src/services/questions/detectPermissionGate.ts:57`), while `samePrompt` compares `permissionGateKey` (cursor **stripped**, :79). Consequence you must design for: **a repaint that only moves the cursor falls past the unchanged-repaint early return (:1230–1234) and rewrites the entry at :1274 with `samePrompt === true`.**
- `PendingPermission` is the exported type at `src/server-wiring.ts:67–82` (single declaration since #706 — do not re-inline it).
- Terminal registry records are retained `PROMPT_TERMINAL_RETENTION_MS` = 10 min (`src/services/prompts/promptRegistry.ts:11`), `get()` at :271, `hasActionable()` at :278, `sweepExpired()` added by #702.

## 2. The window, stated precisely

Between the accepted answer (200 at :1527) and the detector's `gate === null` branch (:1215, deleting at :1222–1223), `pendingPermission` still holds the entry, so composer text in that window is refused at :1085 with wording that tells the user to answer a prompt they already answered. **The refusal is correct and stays** — the PTY cursor may still be on the picker until the TUI repaints. Only the *classification and the wording* are wrong.

## 3. Design — decide between two shapes, in this order

**Candidate A (preferred if it verifies): derive it, add no state.** The accept path already transitions the prompt record to a terminal state (`resolved`, reason `answered_legacy`). Terminal records are retained 10 minutes, i.e. far longer than this window. So arbitration can ask: entry present in `pendingPermission` **and** `promptRegistry.get(entry.promptId)?.state` terminal → answered-awaiting-close. Zero new fields, nothing to keep in sync across repaints.

Prove or kill A on the real objects before writing it up: `promptId` is optional on `PendingPermission` (a zero-option gate registers no prompt), the pty-host path may carry a different id, and a record could be pruned or replaced under the same id. If any of those makes the derivation ambiguous in a case that actually occurs, say so with the evidence and fall back to B.

**Candidate B (fallback): mark the entry.** One optional field on the exported `PendingPermission` (e.g. `answeredAt?: number`), set on the accept path immediately after `sendKeys` succeeds. Not a second map.

If you choose B, the load-bearing detail is the cursor repaint from §1: the write at :1274 must **carry the marker forward when `samePrompt` is true and drop it when it is false**. Carrying it on a genuinely new instance would suppress a real prompt's correct wording; dropping it on a cursor move silently reverts the fix. Both directions need a test.

## 4. Wire compatibility — non-negotiable

`reason` **stays `"prompt_pending"`**. Released clients classify by exact string equality (`services/api-client.ts:182–186`, `isPromptPendingError`) and gate the no-retry/keep-the-draft behaviour on it (`hooks/useSessionActions.ts:33–37`). A new top-level `reason` would make both released clients (#864, #872) fall through to retry-plus-alert — a regression, not an improvement.

Carry the distinction **additively**, in the same shape the route already uses for `promptKind`: a new optional field on the 409 body (e.g. `promptState: "open" | "answered"`), plus a different `error` string for the answered case only. The existing `error` text for the open case is unchanged, byte for byte.

`{ keys }` stays unarbitrated. Zero bytes are written on either refusal — assert it, don't assume it. Status stays 409 for both.

## 5. Out of scope — reject in your own diff

`/queue`, `/plan-response`, status models, the `pendingQuestions` (AskUserQuestion) path, the detector, the answer route's freshness logic, any cleanup you notice on the way. #703 is permission gates only. If you find something worth filing, list it at the end of your report; do not fix it.

## 6. Tests — real objects, controls, one mutation

Extend `__tests__/input-prompt-arbitration.test.ts` (and `permission-close-on-answer.test.ts` if the accept path needs a companion). Drive the real handler, not a helper.

1. **Positive**: gate open → answer accepted (200) → `POST /input { input }` inside the window → 409, `reason: "prompt_pending"`, the new field says answered, the new wording. Assert **zero PTY bytes written**.
2. **Negative control**: same gate, text sent **before** the answer → 409 with the unchanged code, unchanged field value, and the original wording verbatim. This is what proves the new branch is caused by the answer and not by the harness.
3. **Instance control, modelled on what the detector really emits.** Live evidence from the Group C cross-version probe (1.69.6, rows 2 and 5, observed twice): an accepted answer transiently mints a *fresh* gate — new `gateId`, opened and cancelled within ~30–50 ms — before the real teardown. Drive that exact sequence: answer → transient new gate → its cancel → detector `null`. Under Candidate A the transient is a genuine new instance and classifying it "open" for those milliseconds is **correct** — assert that, do not "fix" it. Then the idealised cases: a cursor-move repaint of the same gate after the answer → still answered; a repaint with different content → open again.
4. **Lifecycle**: the detector's `gate === null` still clears the entry, and text after it is written normally (200).
5. **Untouched**: `{ keys }` in the window is still not arbitrated.
6. **Falsifiability mutation**: revert exactly the branch that distinguishes the two states (A: the registry-state check; B: the marker write), run the suite, and report **the failing test name and its assertion text**, then restore. A mutation that only reddens a compile is not a result.

## 7. Mechanics

- **Cite from `origin/main` only, never a checkout.** Both working checkouts sit on stale branches; read files with `c=origin/main; /opt/homebrew/bin/git show "${c}:<path>"`. Every line number in this brief was verified that way, and any you re-derive must be too.
- Worktree only: `tb-streamer/.worktrees/fix/<slug>` off `origin/main` (currently `e71487c8`). `ln -s /Users/ronenmars/dev/ai-tools/tb-streamer/node_modules node_modules`.
- Node from `.nvmrc`: `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`.
- `biome.json` ignores `.worktrees`, so `npm run lint` reports 0 files there — run `npx biome check <explicit changed files>` and `npx tsc --noEmit` separately.
- `npm test` is ~9–10 min and exceeds the tool timeout: run it in the background. Full suite green, not just the touched file.
- Tests that spy prompt broadcasts must spy `broadcastToClients` (message is arg[1]) since #696.
- Absolute binary paths in shell calls: `/opt/homebrew/bin/git`.

## 8. Protocol

Plan first — the A/B decision with its evidence, the exact response shape, the test list — and **stop**. I review it, the program owner approves, then you implement. After implementation: full suite + `tsc` + `biome` + `npm run build` green, then stage and present `git diff --staged`, `--stat`, and the exact commit message; stop again. No `git commit`, no push, no PR, no merge without my relayed approval.

Merge order, already ruled: #703's PR is independent of the mobile track and merges on green once approved. It is a `fix:`, so semantic-release pushes a `chore(release) [skip ci]` commit to `main` ~3 min after the squash — wait for it before touching streamer `main` again, and rebase → CI → squash for the merge itself.

Commit title: conventional, imperative, lowercase, no trailing period, e.g. `fix(input): distinguish an answered gate from an open one`. No AI attribution anywhere. PR prose one sentence per line. Never push to `main`.
