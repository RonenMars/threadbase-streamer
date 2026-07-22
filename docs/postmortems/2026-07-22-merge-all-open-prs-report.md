# Report: merging every open PR into one verification branch (round 2)

**Date:** 2026-07-22
**Branch:** `integration-dev/v1.0.0-2026-07-22`, cut from `origin/main` at `07d0812` (`chore: bump @threadbase-sh/scanner to v0.11.1 (#256)`)
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
6. **Landing order and procedure: see the Landing runbook at the end of this document.** The order that was here named 10 PRs and predates #257-#264; the runbook supersedes it.

---

# Addendum — work after the report was first written

Everything above describes the branch at `eab26e3`. Four things happened after that and the numbers in Part 4 are no longer current.

## A1. The remaining 28 failures were also test bugs — and one was a product bug

Part 5 established that 10 "environmental" failures were fixtures missing `scannerPersistent: false`. The same question was then put to the 28 failures that survived, which the report had written off as pre-existing on `main`. **They were the same class**, with one exception that mattered.

Five files (`conversation-anchored-page`, `conversation-search-target`, `codex-api`, `codex-scan`, `version`) were fixed the same way and are now **PR #260 against `main`** — deliberately cut as a fresh `main`-based branch rather than a PR from this one, which is 46 commits ahead and would have carried all 14 merged PRs into the diff. On `main` those fixes take the suite from **35 failures to 7**; the residual 7 are the `refresh=1` reconcile group that #237 fixes.

The exception: `offset-index-detail` did not recover from isolation alone. Applying only the isolation fix to `main` made it pass 3/3 while the same fix on this branch still failed 3/3 — which localised the cause to a merged PR rather than the host. **#253 had silently disabled the offset index for every conversation on Windows.**

## A2. The #253 path-canonicalization bug class

#253 established a canonical forward-slash form for `conversation_meta.file_path`, but the scanner emits **native** paths. This was measured, not assumed:

```
scanner filePath => "C:\Users\PC\AppData\Local\Temp\probe-Iutkvz\projects\-tmp-probe\probe-conv.jsonl"
```

Anywhere a scanner-derived path is joined against a cache-derived one without normalising, the join silently fails — an empty map, a `false`, a fallback, never an exception — and is structurally invisible to a Linux-only CI matrix, where the two forms are identical strings.

Three sites were found:

| Site | Effect | Fix |
|---|---|---|
| `isIndexableFile` | Lookup used a raw path → **offset index disabled for every conversation**. Correctness. | `5c56dc9` |
| `buildStatCache` | Returned a canonically-keyed map to `scanner.scan({ statCache })`, which looks up by native path → every lookup missed → full re-parse on every rescan. | `acef47f` |
| `reconcileDeletions` caller | `livePaths` native vs rows canonical → membership test never matched. | `acef47f` |

The third was checked specifically for data loss and there is none: the only thing preventing mass deletion was `if (exists(row.file_path)) continue`, and `existsSync` was verified to accept forward-slash Windows paths. A race backstop had quietly become the primary guard.

The fix (`acef47f`) is a boundary, not a patch: `canonicalizeFilePath`, `toNativeFilePath`, `canonicalLivePathSet` and `joinStatCacheByNativePath` now own every conversion in one module, under the rule **normalize for the comparison, emit in the consumer's form**. The module's own docstring previously claimed "the scanner populates `conversation_meta.file_path` with forward slashes" — the exact inverse of measured behaviour, and the mental model that produced the bug. It was corrected, and the rule is now documented in `CLAUDE.md` beside the existing `canonicalizeProjectPath` entry, whose absence for *file* paths is what let this through.

**Known gap in that work:** the 11 new tests in `__tests__/scanner-path-boundary.test.ts` pin the helper contracts but do **not** verify `server.ts` calls them — with the helpers present and `server.ts` reverted to the broken inline logic, all 11 still pass. Covering the wiring needs a test that drives `buildStatCache`, whose only route is constructing a `StreamerServer`; that opens a real database connection in this environment and produced a 21-second flake, so it was removed rather than shipped flaky.

## A3. The same extraction trap, a third time

Merging #253's new commits back into this branch produced exactly one conflict — and exactly the S1 shape from Part 2. HEAD carried #237's **extracted** `reconcileConversationsCacheFromDisk()`; #253 still had the old **inline** block, now carrying the `canonicalLivePathSet` fix. Taking HEAD's side is correct and would have discarded the fix with no marker, no error and a clean `tsc`. The extracted method was read afterwards and was indeed still building `livePaths` natively; the fix was applied there by hand.

That is now three occurrences of one pattern on this branch: #237's method losing `withWarmup` and the integrity freeze, and now this. **After resolving any conflict where one side extracted code into a method, read the method** — the conflict markers only ever show the call site.

## A4. Current state

The branch was renamed from `integration-dev/v1.0.0-07d0812-2026-07-22` to **`integration-dev/v1.0.0-2026-07-22`** (old remote deleted after verifying the old tip was a strict ancestor of the new one).

| Run | Tests |
|---|---|
| Part 4's final figure (`eab26e3`) | 28 failed / 1051 passed / 21 skipped |
| After merging #253's fixes (`af92487`) | **29 failed / 1061 passed / 21 skipped** |

Name-diff against the branch's own baseline: **0 new failures.** The single difference is `release-precheck`, which passes 5/5 in isolation.

**On that flake — three different files have now flaked under full parallel load** (`release-precheck`, `codex-pty-runner`, and `release-precheck` again), each passing in isolation. That is a property of this suite on this host worth its own investigation; it also means a single red run here should be re-checked in isolation before it is believed.

## A5. Follow-ups still open

1. **#245 should be closed, not merged.** Verified against `main`: all four of its changes are present via `171ee42`. One detail is worth salvaging first — #245's `waitFor` **throws** on timeout while `main`'s silently returns, so on `main` a genuine timeout surfaces as a confusing downstream assertion failure instead of naming its cause.
2. **The dependabot verification gap is closed** and Part 4's caveat about it is wrong. The `package.json` ranges are identical on `main` and this branch — dependabot only moved lockfile pins — and because `npm install` (not `ci`) was used, npm resolved to the newest matching versions. The installed tree is `hono 4.12.31`, `tsx 4.23.1`, `semantic-release 25.0.8`: exactly the merged lockfile. The bumps were exercised in every run.
3. **A branded `CanonicalPath` type** remains the only mechanism that would catch this class at authoring time. Not attempted here: it touches every cache signature taking a path, which is too much blast radius for a branch already carrying 14 PRs of merge risk.
4. Scanner **#46** and the `listenForTest(server)` helper, both unchanged from the list above.

---

# Log — #253 rebase onto latest `main` (2026-07-22)

Kept as a running log rather than a summary, because the most useful part is the wrong turn in the middle.

**Starting state.** `feat/live-external-sessions` at `acef47f`, 3 behind / 7 ahead of `origin/main`. `main` had gained two further scanner bumps beyond the one this branch was built on: `10ca086` (v0.11.2) and `591e197` (v0.11.3).

**Rebase.** `git rebase origin/main` replayed all 7 commits with **zero conflicts** — the incoming commits touch only `package.json`/`package-lock.json`. New tip `8c84704`; 0 behind / 7 ahead.

**Dependency drift.** The rebase moved the required range to `@threadbase-sh/scanner@^0.11.3` while `node_modules` still held `0.11.0`. Testing without syncing would have measured the wrong tree, so `npm install --ignore-scripts` was run first. Checked while there: **scanner 0.11.3 still pins `better-sqlite3@^11.10.0`**, so #46 has not landed and the nested-binding class is unchanged.

**The wrong turn — 173 failures.** The suite then reported `26 files / 173 tests failed`, against a branch baseline of 35. The instinct is to suspect the rebase or the two new scanner versions. Both were wrong.

The dominant error was `Could not locate the bindings file` pointing at `node_modules/better-sqlite3` — the **top-level** package, not the nested one this report has discussed throughout. That distinction is the whole diagnosis: the top-level `better-sqlite3@12.11.1` has a Node 24 prebuild and has worked all along. It broke because **`npm install --ignore-scripts` suppressed `prebuild-install`**, so when npm reinstalled the package during the scanner bump, the prebuilt binary was never fetched. A flag added to route around the *nested* build failure had removed the *top-level* binding.

`npm rebuild better-sqlite3` restored it — succeeding for the top-level 12.11.1 and failing only on the nested 11.10.0, exactly as expected.

**After the fix.** `34 failed / 1001 passed / 21 skipped`. Name-diff against the `main` baseline: **0 new failures**, and one that previously failed now passes (`tags ite with type=conversation…`). `tsc` and lint clean. Force-pushed with `--force-with-lease` (`acef47f...8c84704`).

**What to carry forward.**

- **`--ignore-scripts` is not a free safety flag.** It was introduced here to survive the nested native build, and it silently disabled the prebuild download for a package that was working. Prefer `npm install` followed by `npm rebuild better-sqlite3`, which repairs the top-level binding and fails only on the nested one.
- **A 5× jump in failures is an environment signal, not a code signal.** Seven commits that rebased without a single conflict, against incoming commits touching only lockfiles, cannot plausibly break 138 additional tests. Read the *first* error before forming a theory about the diff.
- **Distinguish top-level from nested `better-sqlite3` in every report of this error.** They have different versions, different causes and different fixes, and the error text looks identical apart from the path.

---

# Log — #260 merged in, branch goes fully green (2026-07-22)

**Why it was missing.** #260's five test-isolation fixes were authored on `fix/test-isolation-remaining` and then cherry-picked onto a fresh `main`-based branch for review, so they never travelled back here. A patch-id audit (not SHA reachability — the PR branches had been rebased, which makes `git log --not` report their commits as unique) confirmed neither commit was present.

**Merge.** `origin/test/isolate-scanner-fixtures` merged with zero conflicts, six test files.

**Result: the suite is fully green for the first time.**

| Run | Tests |
|---|---|
| Before the merge | 29 failed / 1061 passed / 21 skipped |
| After | **0 failed / 1089 passed / 22 skipped** — `vitest` exit 0 |

The 22nd skip is #260's symlink case, guarded by a capability probe on a host without the privilege.

**The flake explanation, at last.** The run immediately after the merge showed 2 failures (`release-precheck`, `codex-pty-runner`); a clean re-run showed none. Inspecting the process table explained every "parallel-load flake" recorded in this report: a concurrent session was running three `jest` suites in `threadbase-mobile` and a `pr346` worktree, alongside the supervised prod streamer on port 8766. The contention was never this suite's own parallelism. **Before recording a flake, check what else is running on the box** — three separate entries in this document were misattributed to vitest's own concurrency.
---

# Landing runbook — getting these PRs onto `main`

Supersedes the one-line "recommended landing order" in Recommended follow-ups #6, which predates #257–#264.

The integration branch proves the PRs *can* coexist. It does not land them. Each still goes onto `main` one at a time under the repo's rebase + squash rule, and **the conflicts documented in Part 1 will recur** — this section maps them to the order so nobody meets them cold.

## Before starting — decide these once

| PR | Decision |
|---|---|
| **#223** `typescript-7.0.2` | **Excluded.** Standing instruction, carried from the 2026-07-20 round. |
| **#251** `chore/verify-open-prs-merge` | **Excluded and closeable.** It *is* the previous verification branch; `integration-dev/v1.0.0-2026-07-22` supersedes it. |
| **#245** `fix/grace-timer-flake` | **Close, do not merge.** Fully superseded by `171ee42` on `main` (C5). Optionally salvage one line first: #245's `waitFor` throws on timeout, `main`'s silently returns, so a real timeout on `main` surfaces as a confusing downstream assertion instead of naming its cause. |

That leaves **18 PRs to land**.

## The per-PR loop

Run this for one PR at a time. Never two in parallel — each merge advances `main` and stales the next.

1. `git fetch origin && git rebase origin/main` on the PR branch. **Rebase immediately before merging, not in advance** — see "Moving target" below.
2. Resolve conflicts using the matching entry in Part 1. Do not improvise a resolution that Part 1 already documents.
3. If the PR extracted code into a method, or the other side did, **read the extracted method** before continuing. See "The two silent-drop traps".
4. `npx tsc --noEmit && npm run lint`, then the affected suites.
5. `git push --force-with-lease` (never plain `--force`).
6. Wait for CI green. If red on a flake, re-run **once**; if still red, stop and report. Check what else is running on the box before calling anything a flake.
7. `gh pr merge <N> --squash --delete-branch`. Conventional title, no AI attribution.
8. If the merged PR was the base of a stacked PR, immediately `--onto` rebase the child (see "Stacked pairs").

## Order

Grouped by risk, not by number. Within a group the order does not matter.

**Group 1 — land first, independent and green.**

`#260` `test/isolate-scanner-fixtures` — **do this one first.** It takes `main` from 35 failing tests to 7 on its own, which is what makes every later PR's local verification trustworthy. Nothing depends on it and it touches only test files.

Then `#255`, `#240`, `#241`, `#252`, `#258`, `#259`. All independent, no documented conflicts.

**Group 2 — dependabot.** `#224`, `#226`, `#227`, `#264`. Lockfile-only; dependabot rebases them itself. Land whenever; they will need no manual conflict work.

**Group 3 — the cache cluster, in this exact order.** This is where every documented conflict lives.

1. `#232` `feat/cache-integrity-alert` — clean onto `main`.
2. `#234` `feat/cache-warmup-status` — **stacked on #232** (`baseRefName`), never merge it first. Expect C1, C2, C3: 3 files, 10 hunks. C1's whole-file resolution is only safe because the file is new in #232 — re-verify that before using `--theirs`.
3. `#237` `fix/stale-conversation-history` — expect C4, 3 hunks, **plus trap S1 below**.

**Group 4 — the live-sessions pair.**

4. `#253` `feat/live-external-sessions` — expect C6, 3 hunks. One is an ordering decision, not a formatting one: `detachExternalTail` must run **before** the pending-alert freeze's early `return`, or the watcher teardown is silently skipped whenever an alert is pending.
5. `#254` `fix/adopt-resolve-cwd-from-jsonl` — **stacked on #253**; see "Stacked pairs".

**Group 5 — docs last.**

`#242` and `#257`. Every product PR edits `docs/BACKLOG.md`, and #257 rewrites item statuses wholesale. Landing it last means resolving that file once against a settled `main` instead of on every merge. Expect the same semantic conflict seen here: a PR's own entry says "Fixed" while #257's table says "In flight". Once the PR is on `main`, "Fixed" is the true statement.

## The two silent-drop traps

Both produce a **clean auto-merge with no conflict marker**, a green `tsc`, and quietly deleted safety code. Both have already happened, one of them twice.

**Trap 1 — merging #237.** #237 extracts the refresh logic into `reconcileConversationsCacheFromDisk()`. Because that method is new code, git merges it cleanly — and it does **not** inherit the protections already on `main` from #232 and #234: `withWarmup("conversation_refresh", ...)` around `rescanForRefresh()`, and the pending-alert freeze around `reconcileDeletions()`. #237 also makes that path fire automatically on `scannerStale` and freshness drift, so the unprotected version runs far more often than the protected one ever did.

*After merging #237, open `reconcileConversationsCacheFromDisk()` and confirm both are present.*

**Trap 2 — merging #253 after #237.** The same shape, opposite direction. #253 still carries the **inline** version of that block; `main` will have #237's **extracted** method. Taking `main`'s side is correct and discards #253's `canonicalLivePathSet(metas)` fix with no marker.

*After merging #253, confirm `reconcileConversationsCacheFromDisk()` calls `canonicalLivePathSet(metas)` and not a hand-rolled `new Set(metas.map(...))`.*

The general rule: **after resolving any conflict where one side extracted code into a method, read the method.** Conflict markers only ever show the call site.

## Stacked pairs

`#232 → #234` and `#253 → #254`. Identify these from `baseRefName`, never from PR number.

Two separate rebases are needed for a child, and they are not interchangeable:

- **Whenever the parent is force-pushed** (a rebase, a new commit), the child is left on orphaned commits. Replay it onto the parent's new tip:
  `git rebase --onto origin/<parent-branch> <old-parent-tip> <child-branch>`
  This already bit us once: rebasing #253 orphaned #254's base, and #254 was missing #253's three newest commits until it was replayed.
- **After the parent squash-merges**, GitHub retargets the child to `main`, but the branch still carries the parent's individual commits, which the squash collapsed into one commit git cannot match. Replay only the child's own work:
  `git rebase --onto main <parent-branch> <child-branch>`

A stacked PR also gets **no CI in this repo**: `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on a feature branch reports Snyk and nothing else until its base becomes `main`. Treat a green badge on one as meaningless.

## Moving target

`main` took five auto-merged scanner bumps in a few hours (`0.11.1` → `0.11.5`). Any branch rebased more than a few minutes ahead of its merge will be behind again. Rebase as step 1 of the merge, not as preparation the day before.

These bumps are lockfile-only and conflict with nothing, so being behind is cheap — but branch protection may still block the merge until it is resolved.

## Content that exists in no PR

The integration branch carries changes that belong to no individual PR and therefore **cannot be landed by merging PRs**. They are consequences of combining the branches:

- `b972dcd` — import order in `src/server.ts`, only wrong once #232's and #237's import blocks are combined. Biome sorts `./services/cache/cacheMetadata` **before** `./services/cache-integrity/cacheIntegrityMonitor`; the 2026-07-20 report's rule for this is wrong.
- `e2ac107` — formatting in `cli/prod.ts` after #259's edits meet the existing ones.
- Six merge commits carrying conflict resolutions (9–80 lines each), the largest being #237's.

Expect to re-derive equivalents while landing. If `npm run lint` fails after a merge with nothing obviously wrong, this is why — run `npx biome check --write <file>` on the file the merge touched.

## Definition of done

`main` green, and `integration-dev/v1.0.0-2026-07-22` reduced to nothing but the postmortem file. Any code still unique to the integration branch at that point is a change that was never landed.
