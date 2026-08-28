# Prompt — PR #700 follow-on: occurrence identity after a replayed reopen

Scope: **tb-streamer only**, on the existing PR branch `feat/prompt-contract-foundation` (PR #700, head `6aff35a7` "fix(prompts): harden id replay, pty-exit clear and answer statuses"). Do not touch `tb-mobile`. Push one fix commit to the existing branch; do not open a new PR. Do not pop or delete the parked stash (`stash@{0}`, "expired prompt keeps blocking composer") — it is being dropped as a product decision, separately.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md` — workspace directives.
2. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/codex-results.md` — D9 (server-owned instance identity) and the verification methodology section.
3. `tb-streamer/CLAUDE.md` and `tb-streamer/AGENTS.md` — commands, worktree layout, merge gotchas. Verify the working directory before every shell command.

Then, read-only: `gh pr diff 700`, and specifically `src/api/handlers/sessions.handlers.ts` `handlePermissionChange`, `src/services/prompts/promptRegistry.ts` `open()`, `src/pty-host/host.ts` (how the host mints and keeps `occurrenceId`), and the test "reopens a host gate whose occurrence id a legacy gate_closed already retired" in `__tests__/prompt-contract-producers.test.ts`.

## Working rules

- Worktree off the PR branch under `.worktrees/`, never the root checkout; symlink `node_modules`; lint with `npx biome check <explicit files>`; Node from `.nvmrc`; `npm test` (~10 min) in the background.
- Plan first and wait for explicit approval before modifying files.
- Additive only; legacy events and routes unchanged; the wire `gateId` stays the server-owned answer identity (equal to `promptId`), which mobile #864 echoes.
- One test on the real `SessionHandlers` with a positive and a negative control, and one falsifiability mutation (revert the comparison, watch the test fail, restore). Report the mutation result.
- Full `npm test`, `npm run lint`, `npm run build` before presenting the staged diff. Commit only after the diff and exact message are approved. Conventional-commit title, no AI attribution, PR prose one sentence per line, never push to main.

## The defect

`6aff35a7` made `PromptRegistry.open()` mint a fresh `promptId` when the caller-supplied id (the pty-host `occurrenceId`) is still held by a retained terminal record. That is correct. But `handlePermissionChange` still uses `promptId` as a stand-in for the occurrence in both of its identity checks:

```ts
// unchanged repaint
if (this.pendingPermissionKey.get(sessionId) === key &&
    (occurrenceId === undefined || prior?.promptId === occurrenceId)) return;
// same instance, cursor moved
const samePrompt = prior && priorPromptId !== undefined &&
  permissionGateKey(prior) === permissionGateKey(gate) &&
  (occurrenceId === undefined || priorPromptId === occurrenceId);
```

Before the fix `promptId === occurrenceId` held by construction. After a replayed reopen it does not: the pending entry carries the fresh id while the host keeps sending the original occurrence `O` for as long as its detector sees the same gate (`host.ts` reuses the id across cursor-only repaints). So on the next cursor move: `samePrompt` is false → the just-opened prompt is transitioned `cancelled`/`replaced` → `open(…, O)` → `O` is held terminal → another fresh id. Every repaint after one legacy `gate_closed` therefore produces a cancel+open pair, two `prompt_event`s and a new `gateId`; the client card flaps and an in-flight answer settles `prompt_cancelled`. The existing reopen test stops after the first reopen and cannot observe this.

`handleLiveQuestion` is not affected: it dedupes on `pendingQuestionKey` only and never compares `promptId` to `occurrenceId`. Confirm that by reading, and do not change it.

## Required behaviour

- Occurrence identity is compared to the occurrence, never to the prompt id. Store the host's `occurrenceId` on the pending permission entry (`PendingPermission.occurrenceId?: string` in `server-wiring.ts`, mirrored in the `SessionHandlersDeps` and `StreamerServer` map types) and use it in both checks above. `promptId` and `gateId` keep their current meaning and values.
- In-process PTY (no host, `occurrenceId === undefined`): behaviour byte-identical to today.
- After a replayed reopen, a cursor-only repaint of the same gate with the same `occurrenceId` is an unchanged instance: no new prompt, no `cancelled` event, `pendingPermission.promptId` and `gateId` unchanged, no `permission` re-broadcast beyond what a cursor move already produces today.
- A genuinely different occurrence (host minted a new id after seeing the gate close and reopen) still replaces the prompt exactly as now.

## Tests (`__tests__/prompt-contract-producers.test.ts`, real `SessionHandlers` via the existing harness)

1. Extend the reopen test or add "keeps the reopened prompt across cursor repaints of the same occurrence": after the existing reopen sequence, call `handlePermissionChange(SESSION, sameGateWithCursorMoved, "host-occurrence-c")` twice. Assert: open `prompt_event` count stays 2 for the whole test, no `prompt_event` in state `cancelled` after the reopen, `pendingPermission.get(SESSION).promptId` unchanged across the two repaints, `gateId` unchanged.
2. Negative control: the same sequence but the second repaint carries `"host-occurrence-d"` → the prompt is replaced (one more `cancelled`, one more `open`), proving the check keys on the occurrence and not on "any repaint".
3. Positive control: the existing "does not revise the normalized prompt for a cursor-only repaint" test stays green for the no-`occurrenceId` path.
4. Falsifiability mutation: put `prior.promptId === occurrenceId` back in either check → test 1's open-event count becomes 3 or more. Report the exact failing assertion, then restore.

## Out of scope

`handleLiveQuestion`, the registry, status codes, the stash, any refactor of the pending maps, the pty-host protocol.

## Deliverable for the first turn

Your plan: the exact fields and comparisons you will change, the test you will write, and the mutation you will run. Stop there and wait for approval.
