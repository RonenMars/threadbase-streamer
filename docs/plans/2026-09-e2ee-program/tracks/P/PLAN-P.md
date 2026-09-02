# Group P — streamer pairing-contract close-out — PLAN (approved 2026-08-28 22:00 IDT)

Owner ref: `e2ee-owner [ddde5e]`. Orchestrator: `e2ee-P-sonnet5-medium [e517a2]`. Sub-agent: `streamer-pairing-contract-engineer`.

## Precondition (re-verified at kick-off)

- PR #630 MERGED, PR #649 MERGED, tag `v1.70.6` present.
- Starting commit: `0069afc1` (v1.70.6). Rebased onto `76d6d420` after streamer PR #737 (docs-only) merged mid-track.

## Checklist item audit (origin/main @ 76d6d420)

- **Item 1** (rebase/merge #630) — done, confirmed, not redone.
- **Item 2** (QR omits `spk`/`v` while disabled) — landed #649. Covered by `__tests__/pair-banner.test.ts`, real `printServerBanner` path. Mutation run & reverted (10/10 → 6/10 fail → 10/10).
- **Item 3** (msg1/msg2 authenticated fields) — landed #649. Covered by `__tests__/pair-exchange-authenticated.test.ts` (real HTTP, real Noise handshake). `publicUrl` null-vs-absent ruled not a gap (server-authored, always present by construction; owner confirmed design.md §8 + M's observation against 1.70.6).
- **Item 4** (single-use token / no orphan row — no PR against it) — **APPROVED RULE**: after `consume`, a registration failure on the E2EE path returns 500 `E2EE_REGISTRATION_FAILED` with no `e2ee`/`deviceToken`/ciphertext fields; no device row is ever inserted (`DevicesRepository.register` is one read then exactly one write — all-or-nothing); the token stays consumed — a same-token retry hits `PairTokenStore.consume`'s `used` branch, 401 "Pair token used", and logs `pair.token_replayed` (server.ts:2078-2097).
  Cited: server.ts:2078-2097 (replay-on-retry), 2185 (consume timing), 2223-2254 (best-effort legacy register), 2275-2287 (mandatory E2EE 500), devices.repository.ts:173-230 (all-or-nothing insert), pair-store.ts:70-98 (check/consume/wouldConsume).
  Existing coverage (pair-exchange-authenticated.test.ts:293) stubs `repo.register` — not real-path. New permanent test replaces/supplements it with a real-path injection (close the live better-sqlite3 handle so `register` throws inside the production route), three assertions in order: (a) status+body shape, (b) zero rows via a fresh on-disk `SELECT COUNT(*) FROM devices`, (c) same-token retry → 401 + `pair.token_replayed` captured from the real logger. Keep the existing stub-based test as the positive control that the branch exists.
- **Item 5** (interop + legacy-compat) — landed #630/#649. `noise-ikpsk1-vectors.json` untouched since #631 (predates #630/#649), still consistent (31/31 pass). Old-client byte-identical response shape covered by pair-exchange-authenticated.test.ts:353.
- **Item 6** (`E2EE_SUPPORTED` local edit) — obsolete, constant is `true` since #674/v1.69.0. Record in close-out, do not touch.
- **Item 7** (one-line go-live PR) — obsolete, same reason. Leave stage-2 flag default to Group R.

## Owner conditions before PR (all to be closed by the sub-agent, verified by me)

1. Item 3 mutation — RUN (not just reasoned): `server.ts:2226` read `body?.deviceName` instead of `registration.deviceName` → must fail `pair-exchange-authenticated.test.ts` "uses the authenticated deviceName and readOnly, not the outer body's" (L123). Report file::name + verbatim assertion, then revert.
2. Item 5 old-client mutation — RUN, time-boxed 20 min: drop one sealed API-key field from the legacy response → must fail L353's exact key-set test. If not completed in 20 min, say "not run" explicitly rather than fabricate.
3. Read `pair-exchange-e2ee-gate.test.ts` L158 and L213 in full (previously only located, not read) before the table is called final.
4. Fix stale code comment: `devices.repository.ts:141-146` (`repairStmt`, re-pair clearing `revoked_at`) currently reads as an open question; design.md §4.4 + remaining-work.md decision register settle it 2026-08-16 ("re-pairing a revoked device is allowed and clears `revoked_at`"). Correct the comment to cite §4.4. One comment change, no logic change, bundled into the same PR as the item-4 test.

## Diff scope for the PR

- New permanent real-path test for item 4 (replacing/supplementing the stubbed L293 test) in `pair-exchange-authenticated.test.ts` (or a dedicated new test file if cleaner — sub-agent's call, report which).
- One falsifiability mutation per rule for items 4 (already run) — 3 and 5 conditions above.
- One-line comment fix in `devices.repository.ts:141-146`.
- No changes to `feature-flags.ts`, `ws-hub.ts`, Phase 3-5 work, #619, at-rest encryption, or per-project scoping.
- `E2EE_SUPPORTED` and the go-live flag: untouched, close-out notes only.

## Merge order

- W's `refactor(ws)` (feat/e2ee-ws-hub-routing) may merge first — doesn't touch pairing route or `src/e2ee/pair-*.ts`, no expected conflict; rebase again if it lands first.
- One PR, rebase onto latest origin/main, CI green, squash-merge.

## Gate fired

- None directly; this close-out (tests cited, #590 Phase 2 items ticked/reported obsolete) is one of three preconditions for Group D.

## Close-out (2026-08-28 22:53 IDT)

Streamer PR #739 merged (squash, 3f7f9924, no new release tag — `test:` commits are `"release": false` in `.releaserc.json`, expected). Item 4 (single-use token / no orphan device row on registration failure) now has a permanent real-path test (`__tests__/pair-exchange-e2ee-registration-real-failure.test.ts`) that closes the actual `better-sqlite3` handle under `DevicesRepository` rather than stubbing `register` — this was the strongest piece of evidence in the track, since the prior coverage (`pair-exchange-authenticated.test.ts:293`) only proved the branch exists, not that the real SQLite layer fails the way it assumes. Items 2/3/5 were already landed by #630/#649 and were re-verified here with fresh falsifiability mutations against the real path. Items 6-7 are obsolete (`E2EE_SUPPORTED` true since #674). Close-out posted to streamer#590: https://github.com/RonenMars/threadbase-streamer/issues/590#issuecomment-5457103249. Worktree `.worktrees/fix/e2ee-pairing-closeout` removed and local branch deleted post-merge.

Two operational notes for whoever runs the next streamer track:
1. **`npm run lint` inside any `tb-streamer/.worktrees/*` checkout silently checks 0 files** — `biome.json`'s `files.includes` has `"!.worktrees"`, so biome excludes the entire worktree tree by design and prints "No files were processed" without erroring. Do not read that as a pass. Use `npx tsc --noEmit && npx biome check src cli __tests__ && node scripts/check-no-nul-bytes.mjs` instead and report those three exit codes.
2. **Full-suite (`npm test`, unfiltered) runs across concurrent worktrees collide** — shared ports/temp dirs cause runs to get killed mid-flight or produce false reds (`pair-endpoints.test.ts` in particular probes-then-binds a port and is known-racy per remaining-work.md). Serialize with a lock dir before any full-suite run: `until mkdir /tmp/tb-streamer-suite.lock 2>/dev/null; do sleep 20; done`, run, then `rmdir /tmp/tb-streamer-suite.lock` in an EXIT trap so a kill still releases it. Targeted `vitest run <file>` and lint don't need the lock.
