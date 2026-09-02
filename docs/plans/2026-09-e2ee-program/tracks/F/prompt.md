# Group F — mobile pairing follow-ups (orchestrator brief)

Model: **Sonnet 5**. Effort: **medium**. Reason: both items are fully specified once Group M's audit says the pairing contract holds; a wrong answer fails loudly in a test or on a screen.

You are the **orchestrator** for two small mobile tracks. You own the plans, diff reviews, commit-approval hand-offs and the merge. One named sub-agent. You report every step to **`e2ee-owner`**.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md`.
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2.
3. `tb-mobile/CLAUDE.md`.
4. From streamer `origin/main`: `specs/end-to-end-encryption/mobile-design.md` §3.3, §6.1, §7, §9; `remaining-work.md` §3–§4.
5. `gh issue view 759` — the four corrected acceptance criteria; `gh issue view 831` — the two add-server implementations; `gh pr view 782`, `833` — the gate wiring and the modal fix; Group M's close-out (the owner sends it).

## Precondition to re-verify on arrival

- Group M closed: the owner names either "audit holds, no PR" or a PR number that must read `MERGED` via `gh pr view`. Mobile `origin/main` pinned; streamer `@threadbase-sh/streamer@1.70.6` exact for any interop run.

## Scope — two items, one PR each or one PR if the diff is small

**F1 — close #759 with evidence.** The code path exists on `main`: every pair call site passes `requireEncryption: exchanged.e2eeRequired` into `addServer` (`app/pair.tsx:141`, `hooks/useTBPair.ts:91`, `:113`, `components/servers/ServerEditModal.tsx:180`, `AddServerScreen.tsx:214`, `onboarding/steps/ConnectStep.tsx:176`), `addServer` routes it through the single `setRequireEncryption` writer (`stores/servers.ts:292`), and `services/pair-exchange.ts:596` refuses a msg2 whose `e2eeRequired !== true`. Prove the four criteria on the **real pair path** (not a hand-built store call): (1) a fully authenticated and validated msg2 reaches `setRequireEncryption(serverId, true)`; (2) missing, malformed, `false`-`e2eeRequired` or unauthenticated msg2 never sets the pin and never adds a plaintext server; (3) the pin survives a restart through `loadPersistedServers`; (4) the refusal state still leaves the settings-based clearing path reachable and the failure screen has no "connect anyway". Add tests only where a criterion has none; then tick the issue's boxes and close it citing the tests.

**F2 — #831.** One reachable add-server host that presents `PairConfirmGate` without a modal-in-modal, so a deep-link/paste add never fails silently. Plan first: either retire the dead `AddServerScreen` add path or make it the host — the issue lays out both; pick the smaller diff that keeps `ServerFormFields`, `PairScannerModal`, `pendingTargetFromApiKey` and `addServer` shared. House rule 2: the gate needs a **real screen-path exercise** (component test that mounts the host and drives the deep-link/paste result through it, and one Maestro flow if `e2e/` already has the pairing flow — `promo_02_pairing.yaml` exists), not a component test with a hand-built prop.

**F3 — carried in from Group M's audit (closed 2026-08-29 01:08; read `tracks/M/AUDIT-M.md` first), take after F1/F2 or fold where the files overlap:** (i) `ServerEditModal` → `editServer` has no test that a rename leaves `identityReplaced` false and the device key, server key and pin intact — add it through the real modal; (ii) **#904** `ConnectStep.commitScan` omits the authenticated `publicUrl` that `app/pair.tsx:139` forwards — make the two paths agree; (iii) **#903** (P2) the crash window in `addServer` between the two `persistServerList` writes (`serverPublicKey` present, `requireEncryption` absent → read as unpinned) — plan a single serialized persist if the diff stays inside `stores/servers.ts`, otherwise report and leave it filed; (iv) **#905** and **#906** (P3s) are yours to take only if F1/F2 finish early — otherwise leave filed.

**Program rule since M (applies to F's #759 evidence map):** an audit verdict gets an isolated second reader — a fresh one-shot agent with the same brief and none of your context — before the owner accepts it; M's first table said five rows held when four did, and only the context-free reader caught it.

Out of scope: transport (X-client), #760 copy review (the user's), D-5.

## Sub-agent

### `mobile-pairing-followups-engineer` — speciality: the pair screens, `ServerEditModal`/`AddServerScreen`, `stores/servers.ts`, Maestro flows

Worktree `../tb-mobile-worktrees/e2ee-pairing-followups`, branch `fix/pair-gate-single-host` (and `test/require-encryption-pin-evidence` if split), own `npm ci`. Verification set with exit codes: `npx tsc --noEmit && npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e`; `npm run test:e2e:mock` for F2. Shut down simulators it boots.

## Verification bar

- Real path: the real `pair-exchange` with the streamer's response shape from its fixtures, the real store and SecureStore mock, the real host component.
- **At least one interop run for F1 criterion 1 against the pinned streamer** (`@threadbase-sh/streamer@1.70.6` on loopback, scratch `HOME`, `--feature e2ee=true`): a real pairing ends with the pin set. A fixture cannot catch shape drift between the repos.
- Positive control (a valid msg2 pins); negative control (with the `e2eeRequired !== true` guard removed, a `false` msg2 adds a server — the test must fail).
- One mutation per criterion and per gate rule, reported as `<file>::<test>` + verbatim assertion.

## Merge order and gate

- One PR at a time in tb-mobile; rebase, CI green, squash-merge, confirm `MERGED`.
- **Gates you fire (via `e2ee-owner`)**: F `MERGED` is a precondition of both D1 and X-client.

## Rules

- Plan → owner approval → implement → staged diff + exact message → the user's approval in your pane → commit.
- Conventional-commit titles, one sentence per line, no AI attribution, never push to `main`.
- Persist `tracks/F/PLAN-F.md` on plan approval.
- Report every step to `e2ee-owner`; if the name changes, confirm with the user in your own pane.
- Stop-work: a key or token in any log; a change that would require force-updating released apps.

**Mutation-driver rules (program-wide, from W1a):** revert every mutation in a `finally` and assert `git diff --quiet` after each; a mutated module that fails to parse or import is reported `BROKEN — did not run`, never counted as a pass — absence of a failure line is not evidence, only an observed red is; after any interruption, check for a stranded mutation before anything else.
