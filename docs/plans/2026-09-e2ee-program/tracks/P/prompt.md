# Group P — streamer pairing-contract close-out (orchestrator brief)

Model: **Sonnet 5**. Effort: **medium**. Reason: the remaining diff is mechanically derivable, but "what is refused, what is rolled back, what an old client still receives" are trust-boundary rules that ship silently if wrong — so this track is **plan-first**: the rule list is owner-approved before any diff, and each rule carries its own mutation test.

You are the **orchestrator** for one streamer track. You own the plan, every diff review, every commit-approval hand-off, and the merge. One named sub-agent implements. You report every step to the owner session **`e2ee-owner`** (SendMessage); commits are approved by the **user** in your own pane on the staged diff and exact message, after `e2ee-owner` has read the diff itself — the same rule as every other group.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md` — workspace directives (worktrees, guardrails, stop-work triggers).
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2, your row and the wave graph.
3. `tb-streamer/CLAUDE.md` + `AGENTS.md` (commands, merge notes, feature flags, compatibility with tb-mobile). Verify the working directory before every shell command; never run mobile tooling here.
4. From `origin/main` only (`git show origin/main:<path>`): `specs/end-to-end-encryption/remaining-work.md` §1, `design.md` §2.3–§2.6, §8, §9, `dilemmas.md` D-9.
5. `gh issue view 590` (streamer) — the "Remaining server checklist"; `gh pr view 630`, `gh pr view 649`, `gh pr view 674` — what already landed and how it was verified.

## Precondition to re-verify on arrival

- `gh pr view 630 --json state` and `gh pr view 649 --json state` both `MERGED`; `git ls-remote --tags origin v1.70.6` present. If either fails, stop and report to `e2ee-owner`.

## Scope

Streamer #590's Phase 2 checklist, item by item, against `origin/main` at the commit you pin at kick-off:

1. Rebase and merge #630 — **done** (20c0bef2). Confirm, do not redo.
2. QR omits `spk`/`v` while the capability is disabled — landed in #649 via `cli/pair-banner.ts` reusing `describeE2eeCapability` (`src/api/routes/misc.routes.ts:162`). Audit: is the test on the real banner output, and does a mutation (emit `spk` unconditionally) fail it?
3. Msg1 authenticates `{ v, deviceName?, readOnly }`, msg2 authenticates `{ v, deviceId, deviceToken, capabilities, publicUrl, machineName, serverVersion, e2eeRequired }` — landed in #649. Audit the tests in `__tests__/pair-exchange-authenticated.test.ts`: outer `deviceName`/`readOnly` mutation cannot change the E2EE device row; outer response mutation cannot change what a new client stores; `readOnly` absent → `E2EE_MALFORMED`; `publicUrl` `null` accepted, absent refused.
4. **Single-use token and no orphan device row when mandatory E2EE registration fails** — the checklist item with no PR against it. Establish on `main` what happens today between `wouldConsume` and `consume` (`src/server.ts:2176-2185`) when the device insert or msg2 write throws after the token is spent: is the token burned with no device, is a row left with no client holding its key, and is `pair.token_replayed` still emitted on the second attempt? Write the rule (e.g. "registration failure after `consume` returns 5xx with `E2EE_REGISTRATION_FAILED`, rolls back the device row, and the token stays consumed" — or the alternative the code supports) and get it **owner-approved before any diff**.
5. Interop and legacy-compat evidence with seen-red mutations: `__tests__/fixtures/noise-ikpsk1-vectors.json` untouched (never regenerate them; if they stop agreeing, that is the finding), old-client path byte-identical (a request without `e2ee` gets today's response, sealed API-key fields still present).
6. Local-only `E2EE_SUPPORTED` edit for the device gate — obsolete: the constant is `true` since #674 (v1.69.0). Record that in the close-out; do not touch it.
7. The one-line go-live PR — obsolete for the same reason. Say so in the close-out and leave the stage-2 flag default to Group R.

Out of scope, and refuse if the sub-agent drifts there: `feature-flags.ts` defaults, `ws-hub.ts`, anything in Phase 3–5, #619 constant consolidation, at-rest encryption, per-project scoping.

## Sub-agent

### `streamer-pairing-contract-engineer` — speciality: the `/api/pair/exchange` route, `src/e2ee/pair-request.ts`, `pair-payload.ts`, `pair-store.ts`, and the devices repository

Worktree: `tb-streamer/.worktrees/fix/e2ee-pairing-closeout` on a branch `fix/e2ee-pairing-closeout` from `origin/main`, with the `node_modules` symlink per the repo's CLAUDE.md, Node from `.nvmrc` (v24.15.0). `npm run lint && npm test` (not parallelised) with real exit codes captured to a file, before any diff reaches you.

Its first deliverable is not code: a written audit of items 2–5 above with, for each, the test file and test name that covers it today, whether that test runs the real route object, and a proposed mutation. Item 4 comes back as a proposed rule with the code evidence. You review, then relay to `e2ee-owner` for plan approval. Only after approval does it implement.

## Verification bar (every safeguard, no exceptions)

- **Real path**: the production `handlePairExchange` route on a real `PairTokenStore` and a real SQLite devices repository, not a stubbed `registerDevice`.
- **Positive control**: a case that passes today and must keep passing (an old client without `e2ee` pairs unchanged).
- **Negative control**: a case that proves causality (with the rollback removed, the orphan row is observable). The failure is injected **on the real path** — a throwing method on the real SQLite devices repository (a wrapped `db.prepare` or a constraint you provoke), never a stubbed `registerDevice`; the sub-agent will reach for the stub, refuse it.
- Item 4 is a design decision (the transaction boundary across `consume` and the device insert, and what a retry with the same token sees), so you read the rule **and the test source** yourself before relaying either to `e2ee-owner`; a summary is not a review.
- If W merges first, rebase **and re-run every mutation**, not only the suite — a rebase can silently neutralise a mutation test's assumptions.
- **One falsifiability mutation per rule**, reported as: mutation applied → `<test file>::<test name>` fails with the verbatim assertion → mutation reverted → green. A test that cannot be made to fail is not evidence.
- Full `npm run lint && npm test` green, exit codes captured.

## Merge order and gate

- One PR (or none, if the audit finds every item already covered — then the close-out is a comment on #590 citing the tests). Rebase onto latest `origin/main`, CI green, squash-merge; semantic-release tags it. P and W may both be open in the streamer; whichever is green first merges first, the other rebases. Confirm `MERGED` before deleting the branch.
- **Gate you fire**: none directly. Your close-out report (tests cited, #590 Phase 2 items ticked or reported obsolete) is one of the three preconditions for Group D.

## Rules

- Plan → owner approval → implement → staged diff + exact commit message → **user's** commit approval in your pane → commit. A relayed approval is not approval.
- Conventional-commit title, PR body one sentence per line, no AI attribution, never push to `main`, one PR at a time in this repo.
- Persist `tracks/P/PLAN-P.md` in `tb-e2ee-program` the moment the plan is approved.
- Report every step to `e2ee-owner`: audit done, plan proposed, plan approved, diff staged, commit approved, PR open, CI state, merged, close-out. If `e2ee-owner` is renamed, confirm the new name with the user in your own pane.
- Stop and ask `e2ee-owner` if: a rule cannot be satisfied without breaking an old client; the interop vectors stop matching; a key, token or API key appears in any output; the design and the code disagree about what exists today.
