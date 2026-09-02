# Group M — mobile pairing trust-boundary audit (orchestrator brief)

Model: **Opus 5**. Effort: **high**. Reason: the 2026-08-16 review of mobile #768 found security and durability defects that a green suite did not catch; the repair merged on 08-20 and nobody has reviewed it adversarially since. A false "it holds" here looks plausible and ships a broken trust boundary, which is exactly the failure this tier exists for.

You are the **orchestrator** for one mobile track. You own the audit verdict, every plan, every diff review, every commit-approval hand-off, and the merge. One named sub-agent does the work. You report every step to **`e2ee-owner`**.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md`.
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2.
3. `tb-mobile/CLAUDE.md` (worktrees outside the repo root, jest isolation rule, no `unknown`/`any`, lint before commit, native-deps checksums, simulators shut down). Never run streamer tooling in the mobile repo.
4. From `origin/main` only: `tb-streamer/specs/end-to-end-encryption/remaining-work.md` §2, `mobile-design.md` §3, §5.2, §6, §9, `design.md` §2.4–§2.6, §8; `dilemmas.md` D-5 (out of scope, know why).
5. `gh issue view 698` (mobile) — the corrected contract and the "Remaining mobile checklist"; `gh pr view 768`, `782`, `833` — what landed; the 08-15 comments on #698 and #759 about persisting `D_priv` before msg1.

## Precondition to re-verify on arrival

- `gh pr view 768 --json state`, `766`, `782` all `MERGED`; mobile `origin/main` at or after 229faf6b; streamer tag `v1.70.6` on the remote (`git ls-remote --tags` in tb-streamer, read-only). Pin `@threadbase-sh/streamer@1.70.6` exact for any interop run.

## Scope — the seven items, audited on the real entry paths

For each item: where the guard lives on `main`, which test covers it, whether that test enters through a **real** path (`app/pair.tsx` deep link, `PairScannerModal` scan result, the paste handlers in `ServerEditModal`/`ConnectStep`, `useTBPair`) rather than a hand-built prop, and one mutation that makes it fail.

1. Absent `spk` ≠ present-invalid `spk` — legacy path for absent, hard error for malformed (wrong length, bad base64, wrong `v`), through QR, deep link and paste.
2. Pairing gated on valid `spk`, never pre-pair `/api/info`; after msg1 was sent, a response without msg2 is a failed pairing — no server added, no plaintext retry.
3. `D_priv` load-or-create per server in SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, written **before** msg1 when new, reused on response-loss retry and on re-pair (same device row on the server).
4. Complete authenticated msg2 validated (`v, deviceId, deviceToken, capabilities, publicUrl: string | null, machineName, serverVersion, e2eeRequired === true`); outer compatibility credentials and metadata ignored — an outer `deviceToken` or `publicUrl` mutation cannot change what is stored.
5. Device key, server key and pin preserved on label-only edits; cleared together only on explicit identity replacement.
6. Web refuses E2EE pairing with the native-app explanation; never writes `D_priv` to `localStorage`; never drops to plaintext. Legacy no-`spk` and manual API-key paths still work on web.
7. Persisted-server read-back covers every encryption field (`__tests__/unit/e2ee-require-encryption.test.ts:170` exists — confirm the key material and pin both round-trip through the real `loadPersistedServers`).

House rule 2 applies with force here: for item 1 the audit needs a **positive control that currently passes green and should not** before any fix is trusted — find the entry path where a malformed `spk` still reaches the legacy branch, or prove none exists with a test that enters through the real handler.

Out of scope: #759 and #831 (Group F), transport (Group X-client), D-5 persist inversion, copy review #760.

## Sub-agent

### `mobile-pairing-trust-boundary-engineer` — speciality: `services/pair-exchange.ts`, `services/e2ee/pair-handshake.ts`, `hooks/useTBPair.ts`, `stores/servers.ts`, `app/pair.tsx`, and the pair components

Worktree: `../tb-mobile-worktrees/e2ee-pairing-audit` on branch `fix/e2ee-pairing-audit` from `origin/main`, own `npm ci` (never a symlinked `node_modules`). Verification command set, exit codes to a file: `npx tsc --noEmit && npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e` (the jest `e2e` folder, not Maestro). Confirm any suite failure in isolation per the repo's CLAUDE.md before blaming the change.

First deliverable: the seven-row audit table (guard location, covering test, real-path yes/no, proposed mutation, verdict holds/defect). Defects become plans — one per defect, each owner-approved before its diff. If every row holds, the deliverable is the table plus the mutation evidence and no PR.

## Verification bar

- Real path: the real `pair-exchange` against a fetch mock that returns the streamer's actual response shape (take it from `tb-streamer` `__tests__/pair-exchange-authenticated.test.ts` fixtures at v1.70.6), the real SecureStore mock the repo uses, the real store.
- **At least one interop run against the pinned streamer itself** — `@threadbase-sh/streamer@1.70.6` on loopback under a scratch `HOME`/`THREADBASE_CONFIG_DIR` with `--feature e2ee=true` — for item 4 (msg2 validation) and item 3 (same device row on re-pair). A fixture is not a real object; shape drift between the two repos is the reason #619's consolidation is deferred, and a fixture cannot see it.
- Positive control, negative control, one mutation per safeguard with the failing `<file>::<test>` and verbatim assertion.
- For item 3, the seen-red test asserts the SecureStore write happens before the fetch of msg1 (order, not just presence).
- Never log, snapshot or fixture-commit a real private key; test keys come from the committed vectors.

## Merge order and gate

- At most one PR at a time in tb-mobile. Rebase onto latest `origin/main`, CI green, squash-merge. Confirm `MERGED` before branch deletion.
- **Gate you fire**: your close-out ("audit holds" or "defects fixed and merged") accepted by `e2ee-owner` is what lets the owner kick off Group F. Do not message F yourself.

## Rules

- Plan → owner approval → implement → staged diff + exact message → the user's approval in your pane → commit.
- Conventional-commit titles, PR body one sentence per line, no AI attribution, never push to `main`.
- Persist `tracks/M/PLAN-M.md` on plan approval.
- Report every step to `e2ee-owner`; if the name changes, confirm with the user in your own pane.
- Stop and ask: a defect that would require force-updating released apps; `D_priv` or a device token in any log; the design and the code disagree about what exists.
