# Prompt — apply the review fixes to threadbase-streamer PR #700

Scope: **tb-streamer only**, on the existing PR branch `feat/prompt-contract-foundation` (PR #700, "feat(prompts): add provider-neutral prompt contract"). Do not touch `tb-mobile`. Do not open a new PR — push fix commits to the existing branch.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md` — workspace directives (no "while we're here" changes, client compatibility, verification methodology, stop-work triggers).
2. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/codex-results.md` — sections "B. Provider-neutral prompt contract", D9, D12, D13, D14, and "Missing Decisions → Error taxonomy".
3. `tb-streamer/CLAUDE.md` and `tb-streamer/AGENTS.md` — build/test/lint commands and the merge gotchas for this repo. Verify your working directory before every shell command.

Then, read-only, the PR itself: `gh pr view 700 --repo RonenMars/threadbase-streamer`, `gh pr diff 700`. The files you will change: `src/services/prompts/promptRegistry.ts`, `src/api/handlers/sessions.handlers.ts`, `src/server-wiring.ts`, plus tests under `__tests__/prompt-*.test.ts`.

## Working rules

- Work in a worktree off the PR branch, never in the root checkout: `git worktree add .worktrees/fix/pr700-review-fixes feat/prompt-contract-foundation` (this repo nests worktrees under `.worktrees/`; symlink `node_modules` from the root checkout; `biome.json` ignores `.worktrees`, so lint with `npx biome check <explicit files>`; use Node from `.nvmrc`; `npm test` takes ~10 min — run it in the background).
- Plan first and wait for explicit approval before modifying files.
- Every change additive and safe for released mobile clients; legacy `question`/`permission` events and the legacy `/answer` and `/permission/answer` routes keep their current behaviour.
- For each fix: a test on the real production object, with a positive control and a negative control, and one falsifiability mutation (revert the fix, watch the test fail, restore). Report each mutation result.
- Full `npm test`, `npm run lint`, `npm run build` before presenting the staged diff. Commit only after the diff and the exact message are approved. Conventional-commit titles, no AI attribution anywhere, PR prose one sentence per line. Never push to `main`.

## The fixes

### F1 (must) — `PromptRegistry.open()` must not throw into a detector callback on a retained occurrence id

`promptRegistry.ts` `open()` throws `Prompt id already exists` when the caller-supplied `promptId` is still held. Both `handlePermissionChange` and `handleLiveQuestion` in `sessions.handlers.ts` pass the pty-host `occurrenceId` straight in whenever no pending entry exists. The host keeps an occurrence id for as long as its detector sees the same content, while the registry retains terminal records for `PROMPT_TERMINAL_RETENTION_MS`. A streamer-side clear the host does not see (`gateClosed` on the legacy 409 path, `cancelPendingQuestion` on the JSONL timeout) followed by the host re-emitting the same occurrence (a cursor-only repaint of the same gate) reaches the throw, and nothing in `RemoteSessionRunner.handleEvent` or `restorePromptSnapshots` catches it.

Required behaviour:
- `open()` with a `promptId` that is held by a **terminal** record mints a fresh id and opens normally (keep throwing for a duplicate that is still actionable — that is a real bug, not a replay).
- A caller-visible way to know the id changed is not required; `pendingPermission.gateId` / `promptId` and `pendingQuestions.promptId` must be set from the returned prompt, which they already are.

Tests (in `__tests__/prompt-registry.test.ts` and `__tests__/prompt-contract-producers.test.ts`):
- Registry: open with id X → `transition(X, "cancelled", …)` → `open(draft, adapter, X)` returns a prompt whose `promptId !== X`, state `open`, and the cancelled record is still readable via `get(X)`. Negative control: open X → `open(draft, adapter, X)` while X is still actionable throws.
- Producer path, through the real `SessionHandlers`: open a gate with occurrence `O`, drive the legacy `/permission/answer` path so `gateClosed` fires, then call `handlePermissionChange(sessionId, sameGate, O)` — expect a `permission` broadcast with a new `gateId`, a new `prompt_event` in state `open`, and no throw. Same shape for `handleLiveQuestion` after `cancelPendingQuestion`.
- Falsifiability mutation: restore the unconditional throw; both producer tests must fail with `Prompt id already exists`.

### F2 (must) — clear `pendingQuestions` on PTY exit unconditionally

`server-wiring.ts` idle branch: `cancelPendingQuestion(session.id)` sits inside `if (filePath)`, while `pendingPermission` / `pendingPermissionKey` are cleared unconditionally and `invalidateSession` runs after. A screen-detected question on a session with no JSONL mapping survives the exit with its prompt now `unavailable`; the stale `pendingQuestionKey` then suppresses the same menu on resume, and a later JSONL flush of that question reaches `handleJsonlQuestion` → `update()` → `Cannot update terminal prompt`.

Required behaviour: on idle, cancel the pending question whether or not a file was mapped, **before** `invalidateSession` (so the prompt's terminal reason is `provider_closed`/cancelled, matching the permission path).

Test (`__tests__/prompt-contract-producers.test.ts` or the existing exit-path suite): open a live question with no `sessionFileMap` entry → drive the idle status change → `pendingQuestions` and `pendingQuestionKey` are empty, the normalized prompt is terminal, and a subsequent `handleJsonlQuestion` for the same content opens a **new** prompt instead of throwing. Positive control: the mapped-file case already cancels — assert it still does. Mutation: put the call back under `if (filePath)`; the unmapped test must fail.

### N1 (should) — remove or use the dead `hasActionable` call

`handleSendInput` calls `this.promptRegistry.hasActionable(sessionId)` and discards the result; arbitration still keys off the pending maps. Either delete the line (preferred — the pending maps are the authority the answer routes use, and the comment above the call says so) or make arbitration consult it and add the test. Do not change the `409 prompt_pending` contract either way — mobile #864 depends on it.

### N2 (should) — align the new route's status codes with the Phase 1 taxonomy

`handlePromptAnswer` maps `unknown_question` / `unknown_option` / `incomplete_answer` / `unsupported_prompt_shape` to **409**; the legacy `/answer` route (#695) returns **400** for the same validation class, and the malformed-body reply uses `code` where legacy uses `reason`. Return 400 for the validation class on `/prompt/answer` (keep 409 for state conflicts: `already_resolved`, `prompt_revision_mismatch`, `prompt_expired`, `prompt_cancelled`, `prompt_unavailable`; 404 `prompt_not_found`; 502 `provider_error`). Keep `code` as the key on the new route — it is the taxonomy the doc asks for — but document the `code`-vs-`reason` split in one sentence in the route's JSDoc. Update `__tests__/prompt-answer-route.test.ts` ("returns stable errors …") to assert the status per code.

### N3 (should) — document that `prompt_snapshot` carries terminal prompts

`snapshot()` returns every retained record (up to `PROMPT_MAX_RECORDS_PER_SESSION`, for `PROMPT_TERMINAL_RETENTION_MS`), so a subscriber must filter on `state`. Add that sentence to the `PromptSnapshot` JSDoc in `promptRegistry.ts` and to the `promptContract` capability comment in `misc.routes.ts`, and note that an idempotent retry after the retention window answers `404 prompt_not_found` rather than the recorded outcome. No behaviour change.

## Out of scope

Structured transport, detector retirement, `gateKey` changes on mobile, the `/queue` and `/plan-response` endpoints, the pty-host protocol version (already bumped to 4 in this PR), any refactor of the pending maps.

## Deliverable for the first turn

Your step-by-step plan and test strategy for F1–N3, including which existing tests you will extend versus add. Stop there and wait for approval.
