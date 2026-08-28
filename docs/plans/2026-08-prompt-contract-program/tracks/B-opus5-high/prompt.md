# Group B — contract-sensitive follow-ups (orchestrator brief)

Model: Opus 5. Effort: high. You are the **orchestrator** for two implementation tracks that touch prompt identity and arbitration — the seams the Phase 1/2 safety work made load-bearing. You own the plan, every diff review, every commit approval hand-off to the user, and both merges. Two named sub-agents implement, one per repo.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md`
2. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/codex-results.md` — Track A "Composer arbitration", D9, D12, D13, and the verification methodology.
3. `tb-streamer/CLAUDE.md` + `AGENTS.md`; `tb-mobile/CLAUDE.md`. Working directory verified before every shell command; never run one repo's tests in the other.
4. The two issues: threadbase-streamer #703, threadbase-mobile #871 (read them with `gh issue view`).

## Non-negotiables (apply to both sub-agents)

- Worktrees only: streamer under `tb-streamer/.worktrees/<type>/<slug>` (symlink `node_modules`, `npx biome check <files>`, Node from `.nvmrc`, `npm test` ~10 min in the background); mobile as a sibling `../tb-mobile-worktrees/<slug>` (own `npm ci`).
- Plan → user approval → implement → staged diff + exact commit message → user approval → commit. The orchestrator relays; the user approves. Never commit or push without that approval.
- Every change additive and safe for released mobile clients; the `409 prompt_pending` contract, `gateId`/`contentKey` answer bodies, and legacy events are unchanged on the wire.
- Each safeguard: a test on the real production object, a positive control, a negative control, and one falsifiability mutation reported with the failing assertion.
- Full suite, lint, build/typecheck green before the diff is presented. Conventional-commit titles, no AI attribution, PR prose one sentence per line, never push to main, rebase → CI → squash, one PR at a time per repo.
- Depends on: Group D's streamer PRs (#701, #702) merged first — they touch the same files. Your kick-off normally arrives from the session `sonnet5-medium` once they are merged; whoever sent it, verify yourself with `gh pr view 701` / `gh pr view 702` (`state=MERGED`) before starting the streamer track. If they are not merged, start the mobile track only and hold the streamer one until they are.

## Sub-agents

### `streamer-arbitration-engineer` — speciality: PTY prompt arbitration and pending-map lifecycle in tb-streamer

Track: issue #703 — an accepted permission answer leaves the gate in `pendingPermission` until the detector sees the picker gone, so composer text in that window gets `409 prompt_pending` whose wording says "answer or dismiss".

Design constraints to put in the plan:
- Do not drop the entry on accept unless the provider path proves it safe; the PTY cursor may still be on the picker until the TUI repaints.
- Preferred shape: mark the entry answered (a flag, not a new map), so `handleSendInput` can distinguish open from answered-awaiting-close and answer a distinct, stable code or wording for the second. Keep `{ keys }` unarbitrated; zero bytes on refusal.
- Mobile #864 classifies `prompt_pending` by code; a new code must be additive and the old one must keep its meaning.
- Tests: answer → text within the window → the new response; pre-answer refusal as the control; the detector's close still clears the entry; mutation reverts the flag.

### `mobile-card-identity-engineer` — speciality: tb-mobile `useActiveQuestion` card identity and suppression

Track: issue #871 — `gateKey` is content-derived, so an identical gate that closes and reopens stays hidden by the answered-card suppression; the streamer sends `gateId` since 1.69.6.

Design constraints:
- `gateKey` returns `gateId` when the frame carries one and the content key otherwise; `dismissedKey`, `markPending`, `clear` unchanged in shape.
- The long comment in `useActiveQuestion.ts` about why the key must work on old streamers stays true — the content fallback is the old-streamer control, asserted byte-identical.
- Contract-path cards (`source: 'prompt'`, keyed on `promptId` since #872) are untouched.
- Tests: identical gate reopened under a new `gateId` after an answer shows a fresh card; same `gateId` with a moved cursor stays suppressed; no `gateId` behaves exactly as today; mutation reverts the key choice.

## Orchestrator loop

1. Read both issues, confirm the verified-state citations still hold on current `main` (line numbers move), and write the two sub-agent briefs. Present them and wait.
2. Dispatch. Review each plan before the sub-agent implements; relay to the user for approval.
3. Review each staged diff yourself against the constraints above before relaying it; reject anything that touches `/queue`, `/plan-response`, status models, or unrelated cleanup.
4. Merge each PR in dependency order on green CI, one at a time, per the repo's merge notes; confirm `MERGED` before any branch deletion.
5. Close the issues with a comment citing the squash commit.

## Deliverable for the first turn

The two sub-agent briefs and the dependency check on Group D. Stop there and wait for approval.
