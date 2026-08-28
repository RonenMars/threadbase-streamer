# Group D — mechanical follow-ups (orchestrator brief)

Model: Sonnet 5. Effort: medium. You are the **orchestrator** for three small, self-contained tracks whose oracle is the existing test suite. You own the plans, the diff reviews, the commit approvals relayed to the user, and the merges — serial within each repo. Two named sub-agents implement, one per repo.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md`
2. `tb-streamer/CLAUDE.md` + `AGENTS.md`; `tb-mobile/CLAUDE.md`. Working directory verified before every shell command.
3. The issues: threadbase-streamer #701, #702; threadbase-mobile #870 (`gh issue view`).

## Non-negotiables

- Worktrees only: streamer under `tb-streamer/.worktrees/<type>/<slug>` (symlink `node_modules`, `npx biome check <files>`, Node from `.nvmrc`, `npm test` ~10 min in the background, never two streamer suites at once); mobile as a sibling `../tb-mobile-worktrees/<slug>` (own `npm ci`; `xargs npx eslint` on changed files; `npm run test:i18n` when a locale key changes; `npm run i18n:bless` after adding keys).
- Plan → user approval → implement → staged diff + exact commit message → user approval → commit. The orchestrator relays; the user approves.
- No behaviour change in #701 and #702; #870 is one branch, one key in four locales, one test. Nothing "while we're here".
- Each track: the existing suites are the positive control; one falsifiability check per track as listed. Full suite, lint, build/typecheck green before the diff is presented. Conventional commits, no AI attribution, one sentence per line, never push to main, rebase → CI → squash, one PR at a time per repo, `--delete-branch` only after `state=MERGED`.

## Sub-agents

### `streamer-refactor-engineer` — speciality: type-level refactors in tb-streamer with zero behaviour change

Track 1 — #701: `PendingPermission` is declared three times (`server-wiring.ts` exported type, `server.ts` inline, `sessions.handlers.ts` inline); import the exported type in the other two and delete the inline copies; fold `PendingQuestion` the same way if it is also triplicated. Falsifiability: add a bogus field to the exported type and confirm `tsc` fails in both consumers.

Track 2 — #702: `handleSendInput` calls `promptRegistry.hasActionable(sessionId)` for its side effect (the synchronous expiry sweep). Add `sweepExpired(sessionId): void` to `PromptRegistry` (the current `prune`, or a thin public wrapper), have `hasActionable` call it, and call `sweepExpired` by name in `handleSendInput` with the comment reduced to one line. Falsifiability: remove the call and confirm the expired-prompt cases in `__tests__/input-prompt-arbitration.test.ts` go red, then restore. The `409 prompt_pending` contract is unchanged.

Order: #701 first, then #702 rebased on it.

### `mobile-composer-engineer` — speciality: tb-mobile composer and card-phase UX

Track 3 — #870: when `409 prompt_pending` arrives while `answerPhase === 'pending'` (ghost card), show a local translated line ("Waiting for the prompt to close; try again in a moment") instead of the server text; every other phase keeps the server text. Both live views (`TerminalView`, `LiveConversationView`) route through the same `sendInputErrorMessage` derivation — find the single place to branch, or if there are two, change both and cover both. One key in `terminal.json` × 4 locales. Test on the real `LiveConversationView`: ghost → local line (positive), active card → server text (negative). Falsifiability: revert the branch, confirm the ghost test fails.

## Orchestrator loop

1. Confirm the three issues' `## Verified state` citations on current `main`; write the two sub-agent briefs; present and wait.
2. Dispatch streamer tracks serially, the mobile track in parallel.
3. Review each diff for scope creep before relaying it.
4. Merge on green CI, one at a time per repo; close each issue with the squash commit.
5. Report to the user when all three are merged.
6. **Hand-off to the child session.** Group B is gated on your streamer PRs. Once #701 and #702 show `state=MERGED` on `main` (verify with `gh pr view`, not from memory), send the Group B kick-off to the session named `opus5-high` with SendMessage — the message is the paste section of `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/B-opus5-high/kickoff.md` (everything below the `---`), sent verbatim, followed by one line: `Sent by sonnet5-medium: #701 <squash sha> and #702 <squash sha> are merged on main; your dependency is cleared.` If `opus5-high` is not listed by ListAgents, tell the user instead of retrying.

## Deliverable for the first turn

The two sub-agent briefs and the verified-state check. Stop there and wait for approval.
