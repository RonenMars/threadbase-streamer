# Report: merging every open PR into one verification branch (round 2)

**Date:** 2026-07-22
**Branch:** `integration-dev/v1.0.0-07d0812-2026-07-22`, cut from `origin/main` at `07d0812` (`chore: bump @threadbase-sh/scanner to v0.11.1 (#256)`)
**Worktree:** `tb-new/worktrees/streamer-merge-all-prs` — deliberately *not* `.claude/worktrees/` (see Obstacle 1)
**Scope:** All 14 open PRs except #223 and #251.
**Result:** `tsc --noEmit` clean, `npm run lint` exit 0, full suite **28 failed / 1051 passed / 21 skipped** against a `main` baseline of **35 failed / 919 passed / 21 skipped** — **zero new failures, and 7 tests that fail on `main` now pass.** All 28 remaining failures are shared with the baseline.
**Status:** Verification branch only. Each PR still needs its own rebase + squash-merge per the one-PR-at-a-time rule.

> **Correction to the first draft of this report.** It classified 10 of the 11 then-remaining failures as "environmental — the nested `better-sqlite3` has no Node 24 prebuild." That was **wrong**, and the previous round's report made the same mistake before it. The binding error is real, but it is only *reached* by test fixtures that forget to disable the persistent scanner index. Every one of those 10 was a fixable test-isolation bug in the PR that introduced the fixture. See Part 5.

## PRs merged, and why this order

| # | Branch | Base | Conflicts |
|---|--------|------|-----------|
| 232 | `feat/cache-integrity-alert` | `main` | No |
| 234 | `feat/cache-warmup-status` | **`feat/cache-integrity-alert`** | Yes (3 files, 10 hunks) |
| 237 | `fix/stale-conversation-history` | `main` | Yes (1 file, 3 hunks) |
| 240 | `fix/bootstrap-agent-exit5` | `main` | No |
| 241 | `fix/upload-filename-sanitize` | `main` | No |
| 242 | `docs/pre-release-status-2026-07-19` | `main` | No |
| 245 | `fix/grace-timer-flake` | `main` | Yes (1 file, 2 hunks) — superseded |
| 224 | `dependabot/…/semantic-release-25.0.7` | `main` | No |
| 226 | `dependabot/…/tsx-4.23.1` | `main` | No |
| 227 | `dependabot/…/hono-4.12.30` | `main` | No |
| 252 | `fix/pty-quiet-marker-screen-recheck` | `main` | No |
| 253 | `feat/live-external-sessions` | `main` | Yes (1 file, 3 hunks) |
| 254 | `fix/adopt-resolve-cwd-from-jsonl` | **`feat/live-external-sessions`** | No |
| 255 | `fix/find-free-port-flake` | `main` | No |

Stacked pairs were identified from `baseRefName`, never from PR number: **#232 → #234** and **#253 → #254**. Merging either pair in reverse would have applied incomplete code.

**Exclusions.** #223 (`typescript-7.0.2`) per the standing instruction carried over from the 2026-07-20 report. **#251** was also excluded — that PR *is* the previous verification branch, so merging it would re-import the earlier merge history circularly. It is not a feature PR.

---

## Part 1 — Merge conflicts and their resolutions

### C1. #234 `src/services/cache-integrity/cacheIntegrityMonitor.ts` (2 hunks)

**Obstacle.** Both hunks pitted HEAD (= `main` + #232) against #234's superset: a new `runDuringReset?` constructor parameter, and a rewrite of `resolve()`'s `reset_rescan` case from an inline try/catch into an async closure routed through `runDuringReset`.

**Solution.** Took the incoming side wholesale — but *proved* the superset relationship first rather than assuming it:

```
git cat-file -e origin/main:…/cacheIntegrityMonitor.ts   → absent (file is new in #232)
diff <#232's copy> <HEAD's copy>                          → IDENTICAL
diff <#232's copy> <#234's copy>                          → additive only
```

Because HEAD's copy is byte-identical to #232's and `main` has never touched the file, `git checkout --theirs` is provably lossless here. That check is what makes taking a whole file safe; without it, `--theirs` silently discards HEAD-only work.

### C2. #234 `src/server.ts` (2 hunks)

**Obstacle.** (a) A one-line comment differing only in wording (`"pre-cacheReady startup window"` vs `"startup warm-up window"`). (b) The `CacheIntegrityMonitor` constructor call site needed the `runDuringReset` argument matching C1's signature change.

**Solution.** Took incoming for both — the wording matches the renamed concept, and the closure (`withWarmup("cache_reset", operation)` + `trackCacheWrite`) is mandatory once the constructor takes the parameter. Resolved hunk-by-hunk, **not** with `--theirs`: unlike C1, HEAD's `server.ts` carries `main` commits that #234's branch predates, so taking the whole file would have reverted them.

### C3. #234 `__tests__/server.test.ts` (6 hunks)

**Obstacle.** The classic shape from the previous report. HEAD does `await x.listen(port); port = x.port;` because `main`'s `getRandomPort()` now returns the literal ephemeral port `0` and the real port must be read back after binding. #234 does `await x.listen(port, { awaitReady: true })` with no readback, because its branch still carries the old synchronous port probe.

**Solution.** Kept **both** halves in all six spots — incoming's `awaitReady` flag *and* HEAD's readback. Applied mechanically with a `perl -0777` pass over the conflict blocks (emit the incoming side, then HEAD's lines minus its `listen` line) so all six got an identical, non-hand-edited resolution.

**Follow-up check.** Four *non-conflicted* `listen(...)` sites in the same file also lack a readback (lines ~1266, 1288, 1313, 1847). Each was inspected individually: they use `subscribeAndClose(srv)` or fetch `http://localhost:${server.port}`, reading the port off the object rather than a stale local, so all four are safe. This is the exact spot where the previous round found a real bug, so it was re-verified rather than assumed.

### C4. #237 `src/server.ts` (3 hunks)

**Obstacle (a) — import block.** Two independent additions: `CacheIntegrityMonitor` (from #232, on HEAD) and `setCacheMetadata` (new in #237).
**Solution.** Combined both. **The previous report's ordering rule is wrong** — it claims `cache-integrity` sorts before `cache/cacheMetadata` because `-` < `/`. Biome 2.5.3 sorts the opposite way. My hand-resolution following the old rule failed lint; `biome check --write` corrected it to `cache/cacheMetadata` first. See Obstacle 8.

**Obstacle (b) — startup ghost-prune block.** HEAD (#232) gates `pruneGhostFiles()` behind "no cache-integrity alert pending". #237 adds new post-prune reconcile work (`refreshConversationCache` / `setCacheMetadata`) that knows nothing about the freeze.
**Solution.** Nested #237's new block *inside* HEAD's `else` branch, so the integrity freeze protects the reconcile too, not just the prune. Both are cache writes; letting one run during a freeze would defeat the freeze.

**Obstacle (c) — `handleListConversations`.** #237 extracts the refresh logic into `reconcileConversationsCacheFromDisk()` and calls it on `bustCache || shouldAutoReconcileConversationList()`.
**Solution.** Took incoming for the call site — see S1 below for the much more dangerous half of this one.

### C5. #245 `__tests__/server.test.ts` (2 hunks) — superseded, discarded

**Obstacle.** #245 reimplements a polling `waitFor` / `subscribeAndClose` that `main` already has.

**Solution.** Verified `171ee42 test(server): fix port-probe race and fixed-sleep grace-timer flake (#248)` is on `main` and implements the identical fix, then kept HEAD (`--ours`) for the whole file. HEAD's version reads `srv.port` directly; #245's threads a `srvPort` parameter — the older approach. **#245 is fully redundant and should be closed rather than merged.**

### C6. #253 `src/server.ts` (3 hunks)

**Obstacle (a) — type-import block.** HEAD (#234) added `ServerWarmingUpResponse`/`ServerWarmupState`; #253 added `SessionActivity`/`SessionResponse`.
**Solution.** Combined; alphabetical order already correct.

**Obstacle (b) — `onFileDeleted`.** HEAD (#232) freezes cache invalidation while an alert is pending, via an **early `return`**. #253 adds `detachExternalTail(...)` to tear down a live external tail once its file is gone.
**Solution.** `detachExternalTail` runs **first**, before the freeze can return. Order is load-bearing: putting the freeze first would silently skip the watcher teardown whenever an alert is pending, leaking a tail on a deleted file. Tearing down a watcher is safe regardless of alert state, so it belongs above the guard.

**Obstacle (c) — `handleListSessions`.** HEAD (#234) added an early `rejectIfWarmingUp(res)` plus a function-local `const DISCOVERY_TTL_MS = 15_000`; #253 hoisted that same constant to module scope for reuse by a second discovery method.
**Solution.** Kept the warm-up guard, deleted the now-duplicate local constant. Verified afterwards that only the module-scope definition remains (`src/server.ts:150`) with two consumers.

---

## Part 2 — Problems git did *not* flag

These produced no conflict marker. Each was found by reading merged output or by running the suite — not by the conflict resolver.

### S1. #237's extracted method silently dropped two safety features

**Obstacle.** `reconcileConversationsCacheFromDisk()` is new code relative to HEAD, so git auto-merged it **cleanly, with no marker**. But the logic it replaced had accumulated two protections from already-merged PRs that the extraction never inherited:

- `#234`'s `withWarmup("conversation_refresh", …)` wrapping around `rescanForRefresh()`
- `#232`'s pending-alert freeze around `reconcileDeletions()`

The net effect: #237 turns an explicit-`?refresh=1`-only path into one that also fires automatically on `scannerStale` and freshness drift — so the *unprotected* version would have run far more often than the protected one ever did.

**Solution.** Read the merged method by hand and manually re-added both, then re-ran `tsc`. This is the single highest-value find of the merge and is invisible to any conflict-driven review.

### S2. `discovery-cache.test.ts` — #234's guard vs a test added to `main` afterwards

**Obstacle.** `expected "vi.fn()" to be called 1 times, but got 0 times`. #234 adds `rejectIfWarmingUp` to `handleListSessions`; the test calls `await server.listen(port)` **without** `awaitReady`, so both of its fetches land inside the warm-up window, receive `503 SERVER_WARMING_UP`, and `discoverClaudeProcesses` is never reached.

The test exists on `main`, on #234's branch, and on #253's — so why is #234's CI green? Because it is a **race**, not a determinism: it landed on `main` in `00175bb`, after #234 branched, and on Linux CI warm-up completes before the fetch arrives. This machine's slow, failing binding search makes the same race lose every time.

Investigated and ruled out a worse hypothesis first: whether a *failed* warm-up wedges the server at 503 forever. It does not — `withWarmup` uses `try/finally`, so `finishWarmup` always runs.

**Solution.** Added `{ awaitReady: true }` and a port readback to the fixture. Commit `8a352eb`. **This is a latent flake on CI too, not a Windows-only artifact** — it should be cherry-picked back to #234.

### S3. `api-e2e.test.ts` — #253 changes the `filePath` separator form on Windows

**Obstacle.** `expected 'C:/Users/…' to contain 'C:\Users\…'`. #253 deliberately stores the canonical **forward-slash** form in `conversation_meta.file_path` (`src/utils/canonicalizeFilePath.ts`, documented as P1.a) so that native-separator lookups from chokidar hit scanner-populated rows. The side effect is that `/api/conversations` now returns `filePath` with forward slashes on Windows.

**Linux CI cannot catch this**: there `/` already *is* the native separator, so nothing changes and the test passes. It is structurally invisible to the entire CI matrix.

**Solution.** Checked the blast radius before touching anything — `filePath` appears in neither `docs/compatibility/tb-mobile.md` nor mobile's `services/`/`hooks/`, so this is not a client-facing contract break, and the canonical storage is intentional. Updated the assertion to compare separator-insensitively. Commit `c7ab5a5`. **Should be cherry-picked back to #253.**

---

## Part 3 — Environment and tooling obstacles

### O1. Worktree location vs biome's own exclusion

**Obstacle.** The previous round placed the worktree at `.claude/worktrees/merge-all-open-prs`. `biome.json` excludes `"!!**/.claude"`, so biome's working directory matched its own exclusion pattern and `npm run lint` reported "No files were processed" — lint was silently a no-op for that entire exercise.

**Solution.** Deliberate deviation: created this worktree at `tb-new/worktrees/streamer-merge-all-prs`. Lint then processed 278 files and **caught a real error** (the C4(a) import order) that the old location would have missed entirely.

### O2. `npm ci` is unusable in this repo on this machine

**Obstacle.** `@threadbase-sh/scanner` pins `better-sqlite3@11.10.0`, which ships no Node 24 prebuild, so it must compile; node-gyp needs VS2019+ for Node >21 and only VS2017 BuildTools is installed. `npm ci` deletes `node_modules` **first**, then aborts on that build — leaving nothing installed.

**Solution.** Copied `node_modules` from the main checkout with `robocopy` (invoked via `powershell.exe`, not Git Bash — see O3), then ran incremental installs. Never `npm ci` in this repo on this host.

### O3. `robocopy` fails when invoked from Git Bash

**Obstacle.** `robocopy` run directly in the Bash tool exited 16 (fatal) — Git Bash mangles the `/E`-style switches and backslash paths.

**Solution.** Invoked through `powershell.exe -NoProfile -Command "robocopy … "`, which exits 1 (= success, files copied). The previous report's alternative — `MSYS_NO_PATHCONV=1` — also works; the PowerShell wrapper is simply less fragile.

### O4. Copied `node_modules` was a scanner version behind

**Obstacle.** `main` now requires `@threadbase-sh/scanner@^0.11.1` (merged earlier today); the copied tree had `0.11.0`.

**Solution.** `npm install --ignore-scripts` — `--ignore-scripts` because scanner still pins the nested `better-sqlite3@11.x` whose native build is exactly the O2 failure, and that binding is already absent regardless. Synced to `0.11.1` without touching native modules.

### O5. Commit hook rejects merge commits

**Obstacle.** `block-invalid-commit.js` enforces conventional-commit titles, so both git's default `Merge branch …` message and a hand-written `merge: …` are rejected.

**Solution.** Every merge commit uses `chore(merge): <branch> (#N)`.

### O6. A blocked hook aborts the *entire* Bash call

**Obstacle.** The rejected command was `git add <file> && npx tsc … ; git commit -m "merge: …"`. The hook blocked the whole invocation, so the `git add` never ran either. The next command's `tsc` then passed — because the conflict markers were already resolved *on disk* — while git still had the file as `UU`. Two green-looking signals, one unstaged conflict.

**Solution.** Re-ran the `git add` explicitly and asserted `git status --short | grep -c "^UU"` was `0` before committing. **Never infer that an earlier half of a blocked compound command executed.**

### O7. `vitest run --reporter=basic` no longer exists

**Obstacle.** Vitest 4 removed the `basic` reporter; the flag fails with `Failed to load url basic`.

**Solution.** Used the default reporter and captured to a log file for the name-diff.

### O8. The previous report's import-order rule is incorrect

**Obstacle.** It states `cache-integrity` sorts before `cache/cacheMetadata` because `-` < `/`. Biome 2.5.3 sorts them the other way. Following the documented rule produced a lint error.

**Solution.** Let `biome check --write` decide; corrected order is `./services/cache/cacheMetadata` **then** `./services/cache-integrity/cacheIntegrityMonitor`. Recorded here so the next round does not repeat it.

### O9. Shell working directory silently reverted

**Obstacle.** Mid-run, the Bash tool's cwd reverted from the worktree to the main checkout. Two `grep`s for `canonicalizeFilePath` then returned nothing, which briefly looked like a missing symbol in the merged tree.

**Solution.** Verified with `pwd` + `git rev-parse --abbrev-ref HEAD` + `git status` that the worktree was untouched (correct branch, correct HEAD, only the expected edits) before drawing any conclusion. **Confirm `pwd` before believing a negative grep result.**

### O10. `release-precheck.test.ts` flakes under parallel load

**Obstacle.** `fix: commit → patch release (1.0.1)` failed in the full run (17.3 s) and appeared in the new-failure diff, suggesting a regression.

**Solution.** Re-ran the file in isolation: **5/5 pass**. It is contention under a fully parallel suite, not a merge effect.

---

## Part 5 — The "environmental" failures were test bugs

This section supersedes the environmental classification in Parts 2–4 of the first draft.

**The wrong conclusion.** 10 of 11 remaining failures showed `Could not locate the bindings file … @threadbase-sh/scanner/node_modules/better-sqlite3`, so both this report and the 2026-07-20 one filed them under "this machine lacks VS2019+, nothing to do here."

**What was actually happening.** `server.test.ts` defines `const HOST_ISOLATION = { codexRoots: [] as string[], scannerPersistent: false }` and spreads it into 21 of its server fixtures. Without `scannerPersistent: false`, `StreamerServer` opens the scanner's *own* persistent SQLite index — which needs the native binding. The binding error is a **symptom of missing isolation**, not an independent environment problem. Fixtures that isolate correctly never touch the nested module at all.

That also means these tests were never properly isolated on *any* machine: the same omission is what leaks real host conversations into fixtures, which is precisely what the comment above `api-e2e.test.ts`'s isolation test warns about.

**The fixes**, each committed to the branch that introduced the fixture and then cherry-picked here:

| Branch | PR | Change | Tests fixed |
|---|---|---|---|
| `feat/cache-integrity-alert` | #232 | `cache-alert-wiring.test.ts` — add `codexRoots: []` + `scannerPersistent: false` (the file had neither) | 7 |
| `feat/cache-warmup-status` | #234 | `server.test.ts` — `...HOST_ISOLATION` on `reuseServer`; plus `discovery-cache.test.ts` awaitReady (S2) | 2 |
| `fix/stale-conversation-history` | #237 | `server.test.ts` — `scannerPersistent: false` on `autoServer`, **and** `awaitReady` + port readback | 2 |
| `feat/live-external-sessions` | #253 | `api-e2e.test.ts` — separator-insensitive path compare (S3) | 1 |

**#237's fixture had two independent bugs stacked.** Adding `scannerPersistent: false` cleared the binding error but the tests still failed, now with `TypeError: fetch failed` / `EADDRNOTAVAIL`. Cause: `getRandomPort()` returns the literal ephemeral `0` on current `main`, and the fixture never read `autoServer.port` back after binding — so every request targeted `localhost:0`. This is the **third** independent occurrence of the missing-port-readback bug across two merge rounds (previous report §"Bug found during verification", C3 here, and now this). It is a systemic hazard of `EPHEMERAL_PORT = 0`, not bad luck.

**Method note.** The first fix attempt was applied with a Python script using `open(p, 'w')`. On Windows that opens in text mode and rewrites every `\n` as `\r\n`, turning a 2-line edit into a 6131-line diff. Caught it on `git diff --stat` and reverted; all real edits were then made with an editor that preserves line endings. Check `--stat` after any scripted file rewrite.

## Part 4 — Verification

| Run | Test Files | Tests |
|---|---|---|
| Baseline — `origin/main` @ `07d0812`, same `node_modules` | 7 failed / 118 passed / 2 skipped | 35 failed / 919 passed / 21 skipped |
| Merged, before fixes | 11 failed / 127 passed / 2 skipped | 41 failed / 1038 passed / 21 skipped |
| Merged, after S2 + S3 fixes | 9 failed / 129 passed / 2 skipped | 39 failed / 1040 passed / 21 skipped |
| **Merged, after all 6 fixes (final)** | 6 failed / 132 passed / 2 skipped | **28 failed / 1051 passed / 21 skipped** |

**Final name-diff: 0 new failures.** All 28 remaining failures are present on the `main` baseline too. 7 tests that fail on `main` pass here (#237's reconcile suite). The paragraphs below describe the intermediate state before Part 5's fixes landed and are kept for the reasoning trail.

Raw counts are meaningless here; the branch adds ~125 tests. What matters is the **name-diff**, and it must not be read naively either — most "new" failing names belong to tests that do not exist on `main` at all.

**11 failing names appear on the merged branch but not on `main`:**

- **7** — `cache-alert-wiring.test.ts`, a file introduced by #232. Every failure is preceded by `Could not locate the bindings file … @threadbase-sh/scanner/node_modules/better-sqlite3`. Environmental (O2).
- **2** — #237's `surfaces a new JSONL …` and `updates preview after external append …`. Same binding error.
- **1** — #234's `returns conversation_refresh while an explicit conversation refresh is running`. Same binding error; the previous report traced this to that test omitting the `...HOST_ISOLATION` spread every sibling test uses, so the scanner opens its own nested SQLite. A pre-existing PR-author-side gap, not merge-induced.
- **1** — `release-precheck`, the O10 flake, passes in isolation.

**Zero real regressions remain.**

**7 tests that fail on `main` now pass on the merged branch** — the #237 reconcile suite (`drops a removed conversation on the next refresh=1`, `reflects an added conversation…`, `passes fullRescan:true…`, and four more). The merge is a net improvement on this host.

`tsc --noEmit`: clean at every checkpoint. `npm run lint`: exit 0 (4 infos — the pre-existing `biome.json` schema-version notice and three `useTemplate` suggestions inherited from merged branches).

### Verification gap worth stating plainly

`npm install` ran **before** the merges, so `node_modules` matches `main`'s lockfile, not the merged one. That made the baseline comparison cleanly apples-to-apples on *code* — dependency changes are held constant across both runs — but it means **#224, #226 and #227 are not actually exercised**. `hono` in particular is a runtime dependency (4.12.29 → 4.12.31). Closing that gap needs `npm install --ignore-scripts` followed by another full run.

---

## Takeaways

- **Prove a superset before `git checkout --theirs`.** Two `diff`s (HEAD vs the base PR's copy, base vs incoming) turn "take theirs" from a guess into a fact. Cheap, and the only thing separating a safe whole-file resolution from silent data loss.
- **The dangerous merges produce no conflict.** S1 is the second consecutive round where the worst problem was a *clean* auto-merge — new code that never inherited safety features accumulated by already-merged PRs. Read every extracted or relocated method by hand.
- **Ordering around an early `return` is a correctness decision, not a formatting one** (C6b). A guard that returns will swallow anything placed below it.
- **CI blindness is structural, not accidental.** S3 is invisible to a Linux-only matrix because the bug *is* the separator. When merging path-handling work, assume the platform CI does not run is unverified.
- **A "new" failing test name is not a regression.** Split the diff into tests that exist on the base and tests the branch introduces, then check the error signature. Ten of eleven here were one environmental root cause.
- **Re-run a suspicious failure in isolation before reporting it** (O10). A 17-second test in a fully parallel suite is a contention suspect first.
- **Verify tooling claims from the previous report rather than inheriting them** (O8). The import-order rule was stated confidently and was wrong.
- **A blocked compound command runs none of its parts** (O6), and a negative grep can mean the wrong working directory (O9). Assert state; do not infer it.
- **"Environmental" is a conclusion that has to be earned, not a bucket for failures with an infrastructure-shaped error message** (Part 5). Two consecutive reports wrote off 10 real test bugs because the symptom mentioned a native module. The test that settles it costs one command: fix the isolation and re-run. A plausible environmental story is exactly what stops anyone from running it.
- **`EPHEMERAL_PORT = 0` is a systemic hazard.** Three independent fixtures across two merge rounds have now shipped a `listen()` without the matching `port` readback, each failing as a confusing `EADDRNOTAVAIL` rather than an obvious mistake. A `listenForTest()` helper that binds and returns the real port would end this class outright.
- **Check `git diff --stat` after any scripted file rewrite.** Python's `open(p, 'w')` on Windows silently converts every line ending and turns a 2-line edit into a whole-file diff.

## Recommended follow-ups

1. ~~Cherry-pick the fixes back to their PRs~~ — **done.** All four branches carry their own fix and are pushed: `feat/cache-integrity-alert` `4867ab1`, `feat/cache-warmup-status` `6174db7` + `e8992ac`, `fix/stale-conversation-history` `b46e3f7`, `feat/live-external-sessions` `fefd91a`. Each is independent of whether this branch lands.
2. **Close #245.** Fully superseded by `171ee42` on `main` (C5).
3. Merge scanner **#46** (`better-sqlite3` 11 → 12) — still worth doing for the 28 remaining baseline failures, but note it is **no longer the story for this branch**: the failures attributed to it here were test bugs (Part 5).
4. Re-install dependencies and re-run once to actually exercise #224/#226/#227 — the one verification gap that remains open.
5. Add a shared `listenForTest(server)` helper that binds and returns the real port, to end the readback class described in Part 5.
6. Recommended landing order, one at a time, each rebased onto the `main` the previous merge produced: **#255 → #232 → #234 → #237 → #240 → #241 → #242 → #252 → #253 → #254**, with the dependabot bumps anywhere. #234 after #232, #254 after #253 — and #254's rebase needs `git rebase --onto main feat/live-external-sessions fix/adopt-resolve-cwd-from-jsonl`, because squashing #253 produces a commit git cannot match against the originals.
