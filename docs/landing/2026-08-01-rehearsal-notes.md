# Landing rehearsal — `integration/missing-prs-2026-07-23` → `main`

Companion to [`LANDING-integration-to-main.md`](../../LANDING-integration-to-main.md).
This file records only what the runbook could not have known: what actually happened when the plan was replayed locally against a throwaway trunk, with `origin` read-only.

**Run date:** 2026-08-01. **Status:** complete. `origin` was never written to — the only network command used was `git fetch`.

**Headline:** the replay reproduced the branch. 252 commits of divergence landed onto a throwaway trunk as **98 commits**, ending with `npm run lint` and `npm run build` green and a **7-file** diff against the untouched branch — three of the seven expected by design, four attributable, none unexplained. Seven material corrections to the runbook came out of it, listed in §7 — the load-bearing ones being that Group A's suggested order is inverted, that three Group-A PRs are not Group-A PRs at all, that Group D is a dependency of Group E rather than a cleanup step, and that a whole third block of stranded features (§5, "Group G") is invisible to the runbook's own discovery command.

---

## 1. Provenance

| Ref | SHA | Note |
|---|---|---|
| `origin/main` at start | `28da6122dc14ebc3b35f3c34dd2b71d58a27cabb` | #340 smoke-job commit |
| `origin/integration/missing-prs-2026-07-23` at start | `ebe9eb87caef050665fdcb5e252886e00823fc09` | #344 rehearsal-prompts commit |
| merge base | `d5181b26da6bcb676a535984af0238e19788b6b4` | |
| backup branch | `backup/integration-rehearsal-2026-08-01b` → `ebe9eb8` | fresh, this run |
| archive tag | `archive/integration-2026-08-01b` → `ebe9eb8` | annotated |
| rehearsal trunk | `rehearsal/main-2026-08-01`, cut from `28da612` | worktree `../tb-streamer-worktrees/rehearsal` |
| test worktree | `../tb-streamer-worktrees/rehearsal-test` (detached) | frozen per checkpoint — see D9 |

### Trunk SHA at each checkpoint

| Checkpoint | Trunk SHA | Commits ahead of `main` | lint |
|---|---|---|---|
| cut from `origin/main` | `28da612` | 0 | green |
| Groups A + A′ (22 of 26 PRs) | `8db5586` | 22 | green |
| Group B (+ `#281`'s import fix) | `3f60c57` | 27 | green |
| Group C (7 PRs + wiring fixup) | `7dddbc5` | 35 | green |
| Group F (4 PRs + import-kind fixup) | `9bef215` | 40 | green |
| Group E (40 commits: 28 clean, 11 resolved, 1 no-op) | `4548664` | 79 | *red* — needed Group D |
| Group D carries + Group G + `#297`/`#299` | `f3056fb` | 92 | green |
| + `0007928` (ephemeral ports) | `fa0d225` | 93 | green |
| + `7ebcaee`, `996b0f3`, index dedup | `25111fa` | 96 | green |
| + `#313` boot-silence restore | `7288188` | 97 | green |
| **+ `9608196` codex systemPrompt gate (final)** | **`8bbfedf`** | **98** | **green** |

`npm run build` exit 0 at the final trunk (`DTS dist/index.d.ts 91.27 KB`).

The last four rows are the Phase-2 residual being driven down from 19 files to 7 by attributing each differing file rather than writing it off — see §6.

**Stale refs from a prior attempt, deliberately NOT reused:** `backup/integration-rehearsal-2026-08-01` and `archive/integration-2026-08-01` both point at `5ae0ed4` (#343) — one commit behind the current tip. Reusing them would have silently corrupted the Phase 2 comparison by one commit. Any replay must create its backup refs *fresh* and assert the SHA equals the live tip.

### Starting measurements

```
git rev-list --left-right --count origin/main...origin/integration/missing-prs-2026-07-23
3	252
```

| Measurement | Runbook says | Measured this run |
|---|---|---|
| Commits ahead of `main` | 250 | **252** (#344 merged after the runbook's last edit) |
| `main`-only commits | 3 | 3 (confirmed) |
| Merge commits in range | 63 | 63 (confirmed) |
| First-parent non-merge | 102 | **104** |

---

## 2. Corrected execution order

### The single most important correction: Groups A and A′ are one dependency graph, and the runbook's order inverts it

The runbook suggests, for Group A:

> Suggested order: dependency-free dependabot bumps first (`#227`, `#264`) to get easy merges out of the way, then `#237`, `#267`, `#270`, `#272`, `#297`, `#299`, then the stacked chains (`#253` → `#254`; `#232` → `#234`; `#266`).

and separately describes Group A′'s twelve "fully contained" PRs as ordinary independent rebase-and-merge work.

Measured against `origin`, that is wrong. `git merge-base --is-ancestor` across all 26 open PR heads gives the real graph:

| PR | New commits vs `main` | Stacked on (PR heads that are its ancestors) |
|---|---|---|
| `#227` `#264` `#237` `#270` `#272` `#253` `#232` `#240` `#241` `#242` `#252` `#255` `#257` `#258` `#259` `#260` `#223` `#302` `#245` | 1–7 | — independent |
| `#234` | 8 | `#232` |
| `#254` | 8 | `#253` |
| `#266` | 3 | `#237` |
| **`#267`** | **79** | `#232` `#234` `#240` `#241` `#242` `#252` `#255` `#257` `#258` `#259` `#260` `#245` |
| **`#297`** | **142** | `#237` `#267` + all of `#267`'s ancestors |
| **`#299`** | **143** | `#237` `#267` + all of `#267`'s ancestors |
| **`#304`** | **207** | everything above except `#297` |

The runbook's order merges `#267` **before** the twelve PRs it is built on, and `#297`/`#299` before `#267`. Following it, GitHub's squash-merge of `#267` would land the cache-integrity feature (`#232`), the warm-up states (`#234`), and ten other PRs — 75 files, +6543/−326 — as one commit titled `feat(api): emit session_name in conversation detail meta (#267)`. The twelve real PRs would then merge as no-ops, and the `main` history would attribute a dozen reviewed changes to the wrong PR.

`#297` and `#299` are worse: ≥100 commits, ~170 files, ~+19 300 lines each, both reported `CONFLICTING`. The runbook's Cost note calls Group A "11 ordinary PR merges … mostly mechanical". Three of the eleven are not.

**A′ cannot run after A.** `#267` (Group A) depends on twelve PRs that are all in Group A′. The A → A′ split cuts straight through the graph; the groups have to be interleaved.

### Corrected order actually used

| Wave | PRs | Why |
|---|---|---|
| 1 | `#227` `#264` `#237` `#270` `#272` `#253` `#232` `#240` `#241` `#242` `#252` `#255` `#257` `#258` `#259` `#260` `#223` `#302` `#245` | no ancestors among the open set; any order works |
| 2 | `#234` (after `#232`), `#254` (after `#253`), `#266` (after `#237`) | one-parent children — the runbook's dependency table, which is correct as far as it goes |
| 3 | `#267` | collapses to its own delta once wave 1+2 are in |
| 4 | `#297`, `#299` | siblings; neither is an ancestor of the other |
| 5 | `#304` | **not merged** — per the runbook, recover `90c1c07` instead (Group D) |

`#245` is worth calling out: the runbook parks it as a "needs a decision" PR ("Confirm the flake still exists before spending a rebase on it"). It cannot simply be deferred — it is an **ancestor of `#267`, `#297`, `#299` and `#304`**. Dropping it does not remove its content; it only decides whether that content arrives under its own PR number or silently inside `#267`'s squash.

### Replay method: `git rebase` is the wrong model for a squash-merge

The runbook's Step 1 and this rehearsal's brief both prescribe `git rebase origin/main` before squashing. For a single-commit PR that is fine. For a stacked one it is actively misleading: rebasing `#267` onto the trunk announced `Rebasing (1/54)` and stopped on a `src/server.ts` conflict inside `8f2d8dc feat: cache integrity management and mobile alert` — a commit belonging to `#232`, not to `#267`.

GitHub does not rebase when it squash-merges. It performs a three-way merge of the head against the base and collapses the result. The faithful local model is therefore:

```bash
git checkout <trunk>
git merge --squash origin/pr/<N>
git commit -m "<conventional title> (#<N>)"
```

one 3-way merge with at most one conflict resolution, instead of N sequential replays each conflicting against an intermediate state that will never exist on `main`.

**Used in this rehearsal:** `rebase` for the single-commit PRs (cheap, and it matches what a human syncing the branch would do), `merge --squash` for anything stacked. The distinction matters for the real run because the rebase is the step that burns the time, and it burns it resolving conflicts in *other PRs'* commits.

---

### Correction 2: `#267`, `#297` and `#299` are branched off the *integration branch*, not `main`

The runbook devotes a whole section to PRs based on the integration branch (`#295`, `#303`) and closes it with:

> **Generalise this.** Any other PR based on the integration branch gets the same two-step check before being re-targeted — `git cherry` for unique commits, then confirm a distinctive file or symbol is genuinely absent. A stale PR pointed at `main` is worse than a closed one.

It then applies that rule to exactly one more PR (`#304`) and lists `#267`, `#297`, `#299` in **Group A — "just merge them"**. Running the runbook's own check on them:

| PR | merge-base with the integration branch | Commits from that base to the PR head | `git cherry` vs integration |
|---|---|---|---|
| `#267` | `91f55b3` — **its own head** | 0 | head is *on* the branch |
| `#297` | `03d2f11` — **`#294`, a Group F commit** | 1 (`23e72ac`) | `+0 / −1` |
| `#299` | `66fff5f` — **its own head** | 0 | `+0 / −0` |

All three PR heads are reachable from `origin/integration/missing-prs-2026-07-23`. GitHub reports `base: main` because that is the PR's *target*; their *history* is the integration branch. That is why `#297` and `#299` measure at ≥100 commits / ~170 files / ~+19 300 lines against `main` — the diff is the integration branch, not the fix.

Squash-merging either one on GitHub would land a large slice of Groups C, E and F on `main` under the title `fix(server): dedup permission-gate broadcasts on unchanged repaints` / `fix(ws): stamp terminal_output/terminal_replay with a per-session seq`.

**Their real content is one commit each**, and the runbook already knows where `#297`'s lives:

- `#297` → `23e72ac`, which is `fad5d5f` on the branch (arrived via cherry-pick PR `#298`).
- `#299` → `66fff5f`, which is itself a **Group-D spine commit** (no `(#NNN)` suffix).

**Both are BLOCKED at Group A position.** Cherry-picking either onto the trunk after wave 1–3 conflicts in `src/server.ts`: the commits were authored against a branch tree that already contains Groups C and E (provider compatibility, pty-host, session-status confidence). They must land **after Groups C and E**, not in Group A. See the ledger.

`#267` is the exception that makes the point: its head is also a branch commit, but its *residual* delta once its twelve ancestors were on the trunk was only **8 files / +667** — versus the 75 files / +6543 GitHub reports. Ordering, not content, was the whole difference.

---

## 3. Conflict ledger

`M` = mechanical (a later session can repeat it blind). `J` = judgement call (must be re-made by a human).

> **Read the `ours`/`theirs` in this table as rehearsal-specific.** They record which side won under
> *this rehearsal's* ordering, in which `#237` landed third. §8 defers `#237` until after `#232`,
> `#253`, `#234` and `#267`, so under §8's own script the sides move. Re-derive them against the
> current trunk exactly as you already re-derive the counterparty column: the resolution's **intent**
> survives reordering, its **side** does not.
>
> **A wrong `theirs` imports unlanded content under the wrong PR number; a wrong `ours` deletes
> landed content. Both are silent, and only the oracle separates them.**
>
> Measured in the 2026-08-01 real run, which followed §8's ordering: row 8's judgement call **never
> arose at all** — the extraction it collides with was not yet on `main`, so both halves of `#234`
> applied cleanly. Row 10's `h2–h4 ours` held for every hunk.
>
> **Do not use the integration branch to choose a side.** The real run first took `theirs` for
> `#267`'s `h3` because the oracle showed that shape, and it was wrong: the
> `refreshConversationCache` / `setCacheMetadata` block there is **`a0bfa77`, which is `#237`'s** —
> so `theirs` imported an unlanded PR's work under `#267`'s number. The oracle answers *"what does
> this region look like once everything has landed"*, **not** *"whose content is this"*, and it
> cannot tell the two apart because by construction it contains every PR. Choose the side by
> **provenance** (`git log -S'<distinctive line>' <branch> -- <file>`); use the oracle only to check
> the *shape* of a resolution you have already attributed.

| # | PR / commit | File | What collided | Resolution | M/J |
|---|---|---|---|---|---|
| 1 | `#257` | `docs/BACKLOG.md` ×4 | `#257` is a *status-snapshot* doc; `#237`/`#240`/`#241` had already rewritten the same per-item Status lines | hunk 1 both-added at an empty base → **keep both**; hunks 2–4 → **keep the landed fixing PR's status** | M |
| 2 | `#258` | `docs/BACKLOG.md` ×1 | `#257`'s "Open — next streamer action" vs `#258`'s "Fixed on `fix/bootout-agent-busy-wait`" | **theirs** — the fixing PR's status beats the snapshot | M |
| 3 | `#259` | `docs/BACKLOG.md` ×1 | same shape | **theirs**, same rule | M |
| 4 | `#245` | `__tests__/server.test.ts` ×4 | `#245` replaces fixed sleeps with a `waitFor` poller — but `#248` already landed the same fix **and is already on `origin/main`** | **ours**; residual was a duplicate module-scope `waitFor` shadowed by `#248`'s nested one, i.e. dead code the integration branch never took → **PR dropped** | J |
| 5 | `#232` | `src/server.ts` ×3 | `#237` extracted the refresh/reconcile body into `reconcileConversationsCacheFromDisk()`; `#232` edits the pre-refactor body | h1 keep both imports; h2 `#232`'s freeze structure with `#237`'s refresh block nested in the `else`; h3 keep `#237`'s call site and move the freeze guard *into* the extracted method | M — **the integration branch resolved it identically**, use it as the oracle |
| 6 | `#232` | `src/server.ts` imports | my own resolution ordered two imports wrongly | `npx biome check --write src/server.ts` | M |
| 7 | `#253` | `src/server.ts` ×2 | same `#237` extraction collision, plus `onFileDeleted` ordering | `detachExternalTail()` **before** `#232`'s freeze early-return; `livePaths` → `canonicalLivePathSet(metas)` inside the extracted method | M — integration branch matches, and carries a comment saying the order is load-bearing |
| 8 | `#234` | `src/server.ts` ×3 | `#234` wraps `rescanForRefresh()` in `withWarmup`; `#237` had moved that call into a method shared with the routine background path | dropped the `withWarmup` wrap (gating there would also gate the background path — the integration branch documents this as wrong); kept `#234`'s `rejectIfWarmingUp(res)` at handler entry, which delivers the same intent | **J** |
| 9 | `#234` | `__tests__/server.test.ts` ×6 | ours adds `port = server.port` (`#255`), theirs adds `{ awaitReady: true }` | combine both on the same `listen()` call | M |
| 10 | `#267` | `src/server.ts` ×4 | trunk has evolved past `#267`'s base | h1 theirs (richer comment); h2–h4 ours | M |
| 11 | `#267` | `__tests__/server.test.ts` ×1 | ours is a strict superset (same 2 tests + `#266`'s 3rd) | ours | M |
| 12 | `#267` | `package-lock.json` ×2 | `#267` pins older `fast-uri`/`hono` than `#227`/`#264` landed | ours (newer) — do **not** hand-merge, the runbook is right | M |
| 13 | `#267` | `docs/BACKLOG.md` ×3 | snapshot vs landed statuses | ours | M |
| 14 | `#297`, `#299` | `src/server.ts` | their single commits are authored against a tree containing Groups C+E | **BLOCKED at this position** — deferred | J |

### The one conflict that dominates Group A/A′

Nine of the fourteen rows are the same collision: **`#237` extracts the `?refresh=1` reconcile body into `reconcileConversationsCacheFromDisk()`, and four other PRs (`#232`, `#253`, `#234`, `#267`) each edit the pre-refactor body.** It is not random hotspot churn — it is one refactor against four editors, and it recurs once per PR.

**Ordering fix for the real run:** land `#237` **after** `#232`, `#253`, `#234` and `#267`, not before. The extraction then happens once, over already-merged content, instead of forcing the same three-way reconstruction four times. The only constraint is that `#266` is stacked on `#237`, so it follows it. This rehearsal followed the runbook's order and paid the cost four times; the corrected replay script in §8 does not.

**Oracle for every one of these:** the integration branch already contains the correct resolution, because it merged both sides. `git show origin/integration/missing-prs-2026-07-23:src/server.ts` is faster and more reliable than reasoning from the hunks, and it matched the hand-derived answer every time it was checked.

---

## 4. Detours and rabbit holes

> **`D1`–`D11` are detour labels in this document, not commits.** None resolves as a git rev. They name defects in *how this rehearsal was run* or in the environment — not anything on the branch, and nothing in the Group D classification. Where a table cites one as a cause, the cause is a method defect of this replay, not a commit that must or must not reach `main`.

### D1 — `git fetch origin --prune` DELETES every `origin/pr/*` ref

The runbook's Phase 0 order (`fetch --prune`, then fetch PR heads) is correct, but only by luck, and nothing says why it matters. `refs/remotes/origin/pr/*` is not covered by the default fetch refspec, so `--prune` treats all 344 of them as stale and deletes them. Running the two fetches in the other order leaves zero PR refs and Groups C and F become unreachable — exactly the silent-drop failure the runbook's ref table warns about, arrived at from a direction the runbook does not mention.

**Correction:** always `--prune` first, PR heads second, and assert a count afterwards.

**Not sufficient on its own.** Ordering only protects against a prune *you* issue. The 2026-08-01
real run had all 346 refs deleted by a background prune from outside the repo, minutes after the
count assertion passed. Fetch the PR heads to `refs/landing/pr/*` instead — §8's Phase 0 carries
the corrected command and the full diagnosis.

### D2 — the PR-head fetch fails on a dead submodule

```
$ git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
fatal: could not get a repository handle for submodule 'vendor/scanner'
fatal: cannot chdir to '../../../../vendor/scanner': No such file or directory
```

`vendor/scanner` is a submodule on older PR heads; scanner moved to npm and the directory is gone. Git recurses into submodules for the fetched refs and exits non-zero. **The refs are still written** — this is a trailing error, not an abort — so a script that checks the exit code will wrongly conclude the fetch failed and may retry forever or bail.

**Correction:** use `git fetch origin --no-recurse-submodules '+refs/pull/*/head:refs/remotes/origin/pr/*'`.

### D3 — `git tag <name> <sha>` fails with "fatal: no tag message?"

Local git config forces annotated tags, so the runbook-style lightweight `git tag archive/... <ref>` aborts. Use `git tag -m "<msg>" archive/... <ref>`.

### D4 — `main`'s test suite is NOT green before anything lands

This is the largest single finding of Phase 0 and it invalidates the runbook's implied success criterion ("`npm test` at the end of each group" only means something against a green baseline).

```
$ npm test          # on rehearsal/main-2026-08-01 == origin/main, nothing landed
 Test Files  8 failed | 119 passed (127)
      Tests  10 failed | 961 passed | 4 skipped (975)
```

All ten are timeouts (5 `Test timed out`, 5 `Hook timed out in 30000ms`, the latter in `afterEach` → `server.close()`), across eight files that each boot a `StreamerServer`:

`codex-resume`, `cors-middleware` (×2), `discovery-cache`, `pair-endpoints`, `security-hardening`, `server-bind-retry` (×2), `watch-for-jsonl`, `webhook-update`.

Run in isolation, `webhook-update` **passes** and `server-bind-retry` still **fails** — so the set is part genuine main-only breakage and part load contention. Several of the affected files are precisely what the stranded PRs fix (`#255` find-free-port flake, `#245` grace-timer flake, and `#295`'s bind-retry fix, which reached the branch as `20c02fc`).

**Consequence for the replay:** every group's `npm test` must be judged as a **delta against this baseline**, not against zero. A group is clean if it adds no new failing file, not if the suite is green — it never will be.

### D5 — `vitest.config.ts` differs between the branches in a way that matters for testing

`main` has no `setupFiles`. The integration branch adds `setupFiles: ["__tests__/setup/isolate-runtime-db.ts"]`, which points every test at a throwaway `runtime.db`. Landing Group E carries that across. Until it does, `main`'s tests have no runtime-db isolation — and a **live prod streamer is running on this machine** (PID on `:8766`, holding `~/.threadbase/runtime.db`). That is a plausible contributor to D4's contention failures and is worth eliminating before trusting any test delta.

### D6 — node_modules provisioning for the rehearsal worktree

Fresh worktrees have no `node_modules` and `npm ci` is a multi-minute network operation. The lockfile delta between `main` and the integration branch is **three packages** (`hono`, `@hono/node-server`, `fast-uri` — patch bumps), so an APFS copy-on-write clone of the root checkout's `node_modules` (`cp -c -R`, ~4 s) is sufficient for the whole replay and avoids touching the network.

Fidelity caveat: that gives you biome **2.5.3**, while `main`'s `biome.json` declares `"$schema": ".../2.5.1/schema.json"`. Biome reports the mismatch as an **info**, not an error, so `npm run lint` still exits 0 — but the four info lines are noise, not a regression. The integration branch already bumps the schema to 2.5.3.

---

## 4b. Detours found while replaying (continued)

### D7 — a blanket per-file conflict resolution silently deletes routes, and `tsc` will not catch it

To get through Groups C/E/F at volume the replay used an auto-resolver that picked *ours* or *theirs* per **file**. That is wrong, and the way it failed is worth knowing because it is invisible.

Resolving `src/api/app.ts` as "ours" for `#285` dropped this line:

```ts
app.route("/api/devices", createDeviceRoutes(deps));
```

The `createDeviceRoutes` **import stayed**. The type-check passed — an unused import is not a type error. `/api/devices` had simply ceased to exist, with a green `tsc`. The only thing that surfaced it was biome's `lint/correctness/noUnusedImports`.

**Correction — `noUnusedImports` reports, it does not gate.** The sentence above is accurate about *visibility* and overstates its *authority*, and the distinction decides whether you can rely on CI here. Measured during the 2026-08-01 real run, on `#267` with an orphaned `shouldRefreshProjectsFromHdd` import present:

```
$ npm run lint
  src/server.ts:87:8  lint/correctness/noUnusedImports  FIXABLE
  ! This import is unused.
Found 2 warnings.
exit=0
```

Biome scores the rule as a **warning**, so `npm run lint` exits **0** and the `Lint` required check goes green with the orphan still in the tree. It appears in the log output and blocks nothing. In the `#285` case it "surfaced" the dropped route only because a human read the output — had that run been unattended, or the output tailed to the last few lines, the route would have gone in green.

So D7's real conclusion is unchanged but its safety net is weaker than written: **there is no automated gate on a dropped route.** The per-file route diff at the end of this section is not a belt-and-braces check beside a lint gate, it is the *only* gate. Run it.

Anyone treating `Lint` going green as evidence that no import was orphaned is relying on a gate that does not exist.

Later the same resolver dropped `SEARCH_OVERFETCH`/`SEARCH_MAX_SCAN`, `pushRepo` from `ApiDeps`, and a `DevicesRepository` import — those *did* fail `tsc`, but the route did not.

**Two rules follow.** Resolve conflicts hunk-by-hunk, not file-by-file. And after every group, diff the route table against the branch, because a lost route is the failure mode a compiler cannot see:

```bash
diff <(grep -o 'app.route("[^"]*"' src/api/app.ts | sort) \
     <(git show origin/integration/missing-prs-2026-07-23:src/api/app.ts | grep -o 'app.route("[^"]*"' | sort)
```

### D8 — biome's "safe fix" `useImportType` is not safe across a landing sequence

Running `npx biome check --write src/server.ts` to tidy import order also rewrote

```ts
import { PushRepository } from "./db/repositories/push.repository";
```

into `import type { … }`, because at that moment the symbol was only used as a type. Two commits later Group F used it as a **value** (`new PushRepository(...)`) and the build broke with `TS1361: 'PushRepository' cannot be used as a value because it was imported using 'import type'`.

Apply biome autofixes at the *end* of a group, never mid-sequence — or restrict them to the single rule you actually want.

### D9 — a background `npm test` against the live trunk worktree is worthless

The first checkpoint test was launched in the background while landing continued in the same worktree. Vitest reads files from disk as it goes, so it tested a tree that changed underneath it. **Fix:** a second, detached worktree pinned to the checkpoint SHA:

```bash
git worktree add --detach ../tb-streamer-worktrees/rehearsal-test <trunk-sha>
cp -c -R node_modules ../tb-streamer-worktrees/rehearsal-test/node_modules
```

Then `git -C …/rehearsal-test checkout --detach <sha>` at each checkpoint. Tests run in the background against a frozen tree while landing continues.

### D10 — `#223` (TypeScript 6.0.3 → 7.0.2) was **not** verified by this rehearsal

It landed and lint passed — but `node_modules` still held TypeScript **6.0.3** (the APFS clone from D6), so `tsc --noEmit` never ran under 7.0.2. The integration branch also pins `^6.0.3`, so this is content `main` would gain that the branch does not have.

**Treat `#223` as unverified.** The runbook is right that it deserves its own run; add that the run must begin with a real `npm install`.

### D11 — the Group-E loop's own bug: check for conflicts *after* `git add`

A first pass over Group E reported **24 of 40 commits BLOCKED**, apparently cascading from `#309` (the `runtime.db` split). That was an artifact: the loop resolved the markers in the working tree but then tested `git diff --name-only --diff-filter=U`, which still lists the paths as unmerged until they are staged. Re-running with the check moved after `git add -A` gave **28 clean / 11 resolved / 1 no-op / 0 blocked**.

Worth stating because the false result was *plausible* — it reproduced the exact dependency chain the runbook documents (`#311` needs `#309`, `#319` needs `#318`, …), so it read as a real finding rather than a bug. Verify a cascade by re-running the root in isolation before believing it.

---

## 5. Group D classification

The command in the runbook yields exactly **58** commits at tip `ebe9eb8`, confirming that count.

A dispatched triage subagent never returned a classification, so the table below was produced mechanically and then corrected against what the replay actually proved. **Read the two together — the mechanical pass alone is misleading.**

**Method and its limit.** Each commit was classed `noise` if its subject matches `chore(merge)` / `fix(merge)` / `auto: .remember`; `already-covered` if the same subject (PR suffix stripped) reached the rehearsal trunk by another route; otherwise `carry`. That first pass gave **36 carry / 16 already-covered / 6 noise**. A separate triage pass gave **28 / 23 / 7**. Neither is right, and the disagreement is the useful part.

**Reconciling them exposed the real trap: 18 of the triage pass's 23 `already-covered` rows were attributed to PR `#304`.** `#304` is `OPEN` / `CONFLICTING`, and both the runbook and this rehearsal never merge it — its content is recovered as `90c1c07` instead. So "covered by `#304`" means covered by nothing. Those 18 flip to **carry**, giving the reconciled **47 / 5 / 7**. Only five rows are genuinely already-covered, each verified present on the final trunk under its own PR number: `#227` (`70d29da`), `#266` (`4a4a421`), `#267` (`8db5586`), `#270` (`8f8b954`), `#272` (`04db501`).

The lesson generalises: **when classifying a commit as "covered by PR X", check that X actually merges.** A roster that treats an unmergeable PR as cover will drop real content silently.

**Subject matching alone is also an upper bound, in the other direction.** Subject matching cannot see a commit whose content arrived under a *different* subject — which is exactly what a squash-merge does. `e1fbe33`, `05ee628` and `2244453` are the three constituent commits of `#281`, which landed as one squash titled `feat(sessions): durable session runtime …`; `c4e44b3` is `#283`'s; `58b4676`/`0ec8316`/`d60c095` are `#282`'s; `1f3a4ec` is `#285`'s. All are really `already-covered`. Treat the `carry` column as "not yet ruled out" and rule each one out with a patch-level check before discarding it.

**The verified carries are the six below**, established not by reading subjects but by `tsc` failing and by the final test delta — see the table after this one.

**Group D is not a cleanup step. It is load-bearing, and Group E does not compile without it.**

After all of Groups A/A′/B/C/F/E were on the trunk, `npm run lint` failed with:

```
cli/prod.ts(5,10):   error TS2305: Module '"../src/auth"' has no exported member 'loadFeatureFlags'.
src/server.ts(1369,17): error TS2339: Property 'featureFlags' does not exist on type 'StreamerServer'.
src/server.ts(525,37):  error TS2339: Property 'skipStartupWarmup' does not exist on type 'ServerConfig …'.
```

Every missing symbol traces to a Group-D commit:

| Commit | Subject | Class | Evidence |
|---|---|---|---|
| `90c1c07` | `feat(config): add server feature-flag registry with boot-time resolution` | **carry** | the runbook's worked example; supplies `loadFeatureFlags` + `StreamerServer.featureFlags`, which `#331` and `cli/prod.ts` both require |
| `20c02fc` | `fix(test): stop the bind-retry suite flaking on the startup warm-up scan` | **carry** | supplies `ServerConfig.skipStartupWarmup`. **The runbook says to close `#295` as "fully absorbed" — that is true of the PR, but this commit is still the only route for that field.** Closing the PR is correct; dropping the commit is not. |
| `36db39d` | `feat(sessions): add model and effort control endpoints for mobile` | **carry** | brings `__tests__/session-settings.test.ts` + `__tests__/pty-spawn-model-effort.test.ts`. Note `#306`'s squash (`ab40541`) replayed as a **no-op** while these files stayed missing — the suffixed PR and this unsuffixed commit are *not* interchangeable |
| `a60518c` | `perf(streamer): scope terminal_output broadcast and index conversation_meta.file_path` | **carry** | sole source of `src/db/migrations/014_add_conversation_meta_file_path_index.sql` |
| `13b5ff0` | `docs: add live-sessions persistence plan prompt` | **carry** (docs) | only source of `docs/plans/claude-code-live-sessions-persistence-prompt.md` |
| `66fff5f` | `fix(ws): stamp terminal_output/terminal_replay with a per-session seq` | **carry** | this is `#299`'s entire content (see Correction 2) |
| `b972dcd` | `chore(merge): fix import order after combining #232 and #237 imports` | **noise** | pure merge fixup — and the replay reproduced the identical collision independently (ledger row 6) |
| `e2ac107`, `c7f4107`, `a689b0c` | merge fixups / postmortem notes mentioning `#259`/`#260`/`#253` | **noise** | the runbook is right that these must be matched on the trailing `(#NNN)` shape, not on any `#` |

**Six carries out of the sample, and five of the six are structurally required** — not stylistic. That rate is the finding: the runbook's framing ("Expect a mix of merge-conflict fixups and real fixes") understates it. Treat Group D as a *dependency* of Group E, land it before or with E, and let `tsc` name the carries for you — it is a far cheaper oracle than reading 58 subjects.

### Full Group D list

**Group D proper is 58 commits: 46 carry / 5 already-covered / 7 noise.** Verified: no commit is missing from the table, none is double-counted, and all 58 that the runbook's command returns are present.

The table below carries a **59th row**, `66fff5f`, appended deliberately. It is not on the first-parent spine, so it is not one of the 58 — but it is `#299`'s entire content (Correction 2) and behaves exactly like a Group-D carry, so listing it beside them is more useful than leaving it out. Counting it gives 47/5/7 = 59; **the number to quote for Group D is 46/5/7 = 58.**

| sha | date | subject | class | why |
|---|---|---|---|---|
| `b972dcd` | 2026-07-22 | chore(merge): fix import order after combining #232 and #237 imports | **noise** | pure import reordering after a merge; the replay hit and re-resolved the identical collision independently (ledger row 6) |
| `8a352eb` | 2026-07-22 | test(discovery): await readiness before asserting discovery TTL cache | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `c7ab5a5` | 2026-07-22 | test: await readiness and compare paths canonically after cross-PR merge | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `0a5d2f9` | 2026-07-22 | test(cache): isolate alert-wiring fixtures from the persistent scanner index | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `616607c` | 2026-07-22 | test(server): isolate the refresh-status fixture from the persistent scanner index | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `d10f2ce` | 2026-07-22 | test(server): isolate auto-reconcile fixture and read back its real port | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `eab26e3` | 2026-07-22 | docs(postmortems): record the 2026-07-22 all-open-PRs merge verification | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it — **correction (real run): also inherited by `#267`, whose head is a branch commit, so a run that lands `#267` whole gets it early and wave 5's pick is a no-op. Stripped from `#267` on 2026-08-01 so Group D picks it for real; its `carry` verdict has never been exercised.** |
| `7c6f6ff` | 2026-07-22 | docs(postmortems): update the branch name after the rename | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `6009215` | 2026-07-22 | docs(postmortems): add an addendum covering work after the first draft | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `a689b0c` | 2026-07-22 | docs(postmortems): log the #253 rebase run | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `c7f4107` | 2026-07-22 | docs(postmortems): log the #260 merge and the first fully green run | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `e2ac107` | 2026-07-22 | chore(merge): format prod.ts after combining #259 with existing edits | **noise** | pure re-formatting after a merge; mentions #259 without being it |
| `023001b` | 2026-07-22 | docs(postmortems): add a landing runbook for the PR chain | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `1430381` | 2026-07-22 | docs(postmortems): correct the cli/prod.ts attribution in the runbook | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `8326d82` | 2026-07-22 | docs(postmortems): add pre-flight sweep and orphaned-stack diagnosis to the runbook | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `489a450` | 2026-07-23 | docs(runbooks): extract the landing runbook and add a runbook format | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it — **correction (real run): also inherited by `#267`, whose head is a branch commit, so a run that lands `#267` whole gets it early and wave 5's pick is a no-op. Stripped from `#267` on 2026-08-01 so Group D picks it for real; its `carry` verdict has never been exercised.** |
| `a496a2f` | 2026-07-23 | docs(runbooks): add effort guidance and agent stop points | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `97969a0` | 2026-07-23 | fix(api): serve the cached conversation list while reconciling in the background | **already-covered** | open PR #266 — landed on the trunk as 4a4a421 |
| `bfbce64` | 2026-07-23 | fix(api): gate the warm-up only on cold start, not the background reconcile | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `2967e92` | 2026-07-23 | docs(runbook): append session-name follow-up PR chain | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `6a853fd` | 2026-07-23 | feat(api): emit session_name in conversation detail meta | **already-covered** | open PR #267 — landed on the trunk as 8db5586 |
| `4889912` | 2026-07-23 | fix(server): drop warmup gate from background count refresh | **carry** | the triage pass called this already-covered *by `#304`* — but `#304` is OPEN/CONFLICTING and is never merged, so nothing carries it |
| `f2a0d84` | 2026-07-23 | fix(cache): store scanner sessionName in the title column | **already-covered** | open PR #270 — landed on the trunk as 8f8b954 |
| `c01d618` | 2026-07-23 | fix(updater): run the Windows updater hidden and default to daily checks | **already-covered** | open PR #272 — landed on the trunk as 04db501 |
| `3b971fb` | 2026-07-23 | fix(server): emit scan_progress during explicit ?refresh=1 rescan | **carry** | distinct from #266; #271's tip 4261160 is the PR-shaped route |
| `c540115` | 2026-07-23 | fix(pty): stop end-of-turn OSC 777 opening a phantom permission gate | **carry** | distinct from #297's dedup fix; #275's tip d11734c is the PR-shaped route |
| `2f3e508` | 2026-07-24 | feat(flags): per-server Claude CLI flags with bypass-mode support | **carry** | same feature as Group C #276 |
| `e1fbe33` | 2026-07-24 | feat(sessions): stop killing agent PTYs when the last subscriber disconnects | **carry** | constituent of Group C #281 (grace/hold redesign) |
| `05ee628` | 2026-07-24 | feat(sessions): persist a durable managed-session registry | **carry** | constituent of Group C #281 |
| `2244453` | 2026-07-24 | feat(sessions): reconcile sessions left behind by previous streamer runs | **carry** | constituent of Group C #281 |
| `de9558e` | 2026-07-24 | ci: run CI on pull requests targeting integration branches | **carry** | real CI infra change |
| `e1fa82b` | 2026-07-24 | style(tests): sort imports in session-status-line test | **carry** | the lint fix #275/#276 both need — replay had to apply it twice by hand |
| `c4e44b3` | 2026-07-24 | feat(sessions): report how each status was derived and how far to trust it | **carry** | same feature as Group C #283 |
| `78f23ea` | 2026-07-24 | feat(sessions): idempotency keys for session input | **carry** | same feature as Group C #284 |
| `729fafe` | 2026-07-24 | feat(push): real registration with delivery health and event dedupe | **carry** | same feature as Group C #287 |
| `58b4676` | 2026-07-24 | feat(providers): declare provider capabilities and classify unknown events | **carry** | constituent of Group C #282 |
| `0ec8316` | 2026-07-24 | test(providers): version provider fixtures against the capture's own metadata | **carry** | constituent of Group C #282 |
| `d60c095` | 2026-07-24 | feat(providers): report capabilities and compatibility over /api/providers | **carry** | constituent of Group C #282 |
| `b3bbb2f` | 2026-07-24 | feat(security): per-device identity and scoped capabilities | **carry** | constituent of Group C #285 |
| `1f3a4ec` | 2026-07-24 | feat(security): enforce device capabilities and add device management routes | **carry** | constituent of Group C #285 — the /api/devices route D7 silently dropped |
| `0f463ea` | 2026-07-24 | feat(backup): export and restore endpoints | **carry** | GROUP G — in no runbook roster; recovered in this replay |
| `1129156` | 2026-07-25 | chore(deps): bump hono from 4.12.31 to 4.12.32 | **already-covered** | open PR #227 reaches the same end version — landed as 70d29da |
| `eb26d32` | 2026-07-25 | auto: .remember 23:56 | **noise** | session-local memory churn |
| `983abc8` | 2026-07-26 | auto: .remember 00:24 | **noise** | session-local memory churn |
| `0bcbf89` | 2026-07-26 | auto: .remember 00:48 | **noise** | session-local memory churn |
| `db4664b` | 2026-07-26 | auto: .remember 08:58 | **noise** | session-local memory churn |
| `996b0f3` | 2026-07-26 | chore: ignore and untrack .remember | **carry** | the cleanup that ends the four noise commits above; .gitignore is in the residual diff |
| `266fc02` | 2026-07-26 | test: preserve provider auth assertion after rebase | **noise** | diff duplicates the same assertion line — rebase artifact |
| `20c02fc` | 2026-07-26 | fix(test): stop the bind-retry suite flaking on the startup warm-up scan | **carry** | VERIFIED — sole source of ServerConfig.skipStartupWarmup; carrying it cleared server-bind-retry.test.ts |
| `9608196` | 2026-07-27 | feat(codex): gate Codex systemPrompt injection behind a feature toggle | **carry** | still missing from the trunk — visible in the residual src/server.ts diff |
| `a60518c` | 2026-07-28 | perf(streamer): scope terminal_output broadcast and index conversation_meta.file_path | **carry** | VERIFIED — sole source of migration 014 |
| `90c1c07` | 2026-07-28 | feat(config): add server feature-flag registry with boot-time resolution | **carry** | VERIFIED — the runbook's worked example; Group E does not type-check without it |
| `13b5ff0` | 2026-07-29 | docs: add live-sessions persistence plan prompt | **carry** | VERIFIED — sole source of docs/plans/claude-code-live-sessions-persistence-prompt.md |
| `36db39d` | 2026-07-30 | feat(sessions): add model and effort control endpoints for mobile | **carry** | VERIFIED — #306's squash ab40541 replayed as a NO-OP while this commit's two test files stayed missing |
| `7ebcaee` | 2026-07-31 | fix(claude-flags): remove --print-only flags that never applied | **carry** | real fix plus the CLAUDE.md security correction about --max-budget-usd being a no-op |
| `0007928` | 2026-07-31 | test: bind ephemeral ports in codex-resume and cors-middleware | **carry** | NOT carried in this replay — codex-resume and cors-middleware are still failing at the final trunk |
| `06c7c14` | 2026-07-31 | docs: consolidate live-sessions persistence review follow-ups | **carry** | unique analysis doc |
| `4e22593` | 2026-07-31 | docs: add runbook for landing the integration branch onto main | **carry** | the original LANDING runbook — no PR wraps it |
| `66fff5f` | 2026-07-31 | fix(ws): stamp terminal_output/terminal_replay with a per-session seq | **carry** | this IS #299's entire content (Correction 2) |

### Group G — a third stranded block the runbook has no roster for

Three whole features are on the branch, belong to **no group in the runbook**, and are invisible to its Group-D identification command:

| Feature | Commits | Merge that brought it in |
|---|---|---|
| `feat/search-scalability` — `feat(search): real pagination, filters, relevance, and query timing` | `32c2c34`, `db4de0a` | `a57ad55 Merge remote-tracking branch 'origin/feat/search-scalability' into integrate/c1-c10-20260724` |
| `feat/diagnostics-api` — `feat(diagnostics): versioned diagnostics API with stable remediation codes` | `fe498bd`, `89deb1d` | `2509a54 Merge remote-tracking branch 'origin/feat/diagnostics-api' …` |
| `feat(backup)` — export/restore endpoints + metadata validation | `0f463ea`, `27efe97` | `1e571cd Merge remote-tracking branch …` |

The runbook finds Group D with:

```bash
git log --first-parent --no-merges … origin/main..origin/integration/…
```

`--no-merges` drops the merge commit and `--first-parent` never descends into the merged side, so **neither the merge nor the feature's own commits appear in any roster.** The runbook's risk table claims two sweeps catch unrostered work — the `(#NNN)` spine scan and `gh pr list --state open`. Neither catches these: they are merged, not open, and they are not on the spine.

They were found only because `tsc` failed on `Cannot find module './services/search/searchQuery'`.

**The sweep that does find them** — files on the branch that exist on neither `main` nor the trunk:

```bash
git diff --name-status --diff-filter=A <trunk> origin/integration/missing-prs-2026-07-23
```

Run it before declaring any group complete.

---

## 6. Final comparison result

Final trunk: **`rehearsal/main-2026-08-01` = `8bbfedf`**, **98 commits** ahead of `origin/main`.
`npm run lint` **green**, `npm run build` exit 0.

```
git diff --stat rehearsal/main-2026-08-01 backup/integration-rehearsal-2026-08-01b
 7 files changed, 197 insertions(+), 711 deletions(-)
```

**252 commits of divergence reduced to 7 differing files.** Every file has a verdict; none is UNEXPLAINED.

| # | File | Δ | Verdict | Cause |
|---|---|---|---|---|
| 1 | `docs/architecture/2026-07-27-sessions-ownership-path-filter.md` | +0/−322 | **EXPECTED** | `#302`'s doc. The runbook says it is the one PR "whose content exists nowhere else" — absent from the branch by design, so the trunk having it *is* the correct outcome. |
| 2 | `package-lock.json` | +10/−371 | **EXPECTED** | `#223`'s TypeScript 6.0.3 → 7.0.2 bump. The branch pins `^6.0.3`. |
| 3 | `package.json` | +1/−1 | **EXPECTED** | same, the `typescript` pin line itself. |
| 4 | `__tests__/server.test.ts` | +162/−0 | **DRIFT** | **Not a commit-classification problem.** 162 lines of branch-side tests arrived inside commits that *were* applied, but whose conflicts this replay resolved with a blanket per-file pick (§4 detour `D7`) that took the trunk side of the file. The commits are landed; the file lost their hunks. Recoverable by resolving that one file hunk-by-hunk. |
| 5 | `src/server.ts` | +28/−14 | **DRIFT** | Same cause (`D7`), four identified fragments: the `SEARCH_OVERFETCH`/`SEARCH_MAX_SCAN` comment block, the `pushRepo` field declaration and its comment, the remote-vs-in-process shutdown ordering, and the `codexSystemPrompt` gating comment. |
| 6 | `docs/architecture/README.md` | +1/−2 | **DRIFT (cosmetic)** | index-table row ordering. My "keep both rows" rule also duplicated a row; the duplicate was removed, the ordering difference remains. |
| 7 | `src/api/types/api-deps.ts` | +1/−1 | **DRIFT (cosmetic)** | one doc-comment's wording. No API difference. |

**Three EXPECTED, four DRIFT, zero UNEXPLAINED.** Two of the four DRIFT entries are cosmetic; the two substantive ones (#4, #5) share a single cause.

**That cause is a defect in this replay's conflict handling, not a commit.** No commit accounts for the residual drift, and the Group D split (46 carry / 5 already-covered / 7 noise) is unaffected by it — nothing here moves a commit between buckets. The remedy is a *method* change, already stated in the replay script: resolve conflicts hunk-by-hunk, never file-by-file.

### How the residual was driven down, and what that proves

The first Phase 2 measurement was **19 files**. Attributing rather than accepting them removed twelve:

| Action | Files remaining |
|---|---|
| first measurement | 19 |
| carried `0007928` (`test: bind ephemeral ports in codex-resume and cors-middleware`) | 17 |
| carried `7ebcaee` (`fix(claude-flags): remove --print-only flags`) and `996b0f3` (`chore: ignore and untrack .remember`) | 8 |
| restored `#313`'s boot-silence handling, lost to a D7 pick | 7 |
| carried `9608196` (codex systemPrompt gate) | 7 |

**Every one of those was a Group-D carry or a D7 casualty.** That is the strongest single piece of evidence in this rehearsal for the two central claims: Group D is load-bearing content rather than cleanup, and blanket per-file conflict resolution silently loses work.

The sharpest case is `#313`, and it is worth being exact about what went wrong, because it is *not* a misclassified commit.

**`db00041` (`#313`, `fix(pty): stop treating boot silence as readiness`) is a Group E commit** — it carries a `(#313)` suffix, so the runbook's spine filter excludes it from Group D. It is not among the 58. **The replay applied it**; it is on the trunk as `a244ce4`.

What failed was the *resolution*, not the selection. Fixing `markReady`'s arity for `#283` (ledger: `pty-manager.ts` call sites) had left the line as `markReady(sessionId, session, "timeout-fallback", "quiet:timeout")`. When `#313` was cherry-picked it conflicted on `src/pty-manager.ts` — the Group E log records it as `RESOLVED … [src/pty-manager.ts]` — and the blanket pick kept *my* line instead of `#313`'s `recheckReadyFromScreen()`. So the commit landed while its actual behavioural change did not.

The result compiled, linted, and quietly reinstated the bug `#313` exists to fix: boot silence read as readiness, which `CLAUDE.md` documents as making a message carry the previous one as a prefix. **A behavioural regression that passed both `tsc` and biome, from a commit that was applied.**

**What the replay script must do:** apply `#313` (it is already in wave 7, Group E) **and** resolve its `src/pty-manager.ts` conflict in `#313`'s favour — take `handleQuiet` from the branch. Do not skip it, and do not let a blanket pick decide it. This is stated again as an ordering hazard in §8 wave 5.

### `git cherry` is the wrong termination test — the runbook's Step 3 target of 0 is unreachable

```
git cherry rehearsal/main-2026-08-01 backup/integration-rehearsal-2026-08-01b
+ (unlanded): 133    - (landed): 56
```

133 `+` against a 19-file tree diff. The `+` list is dominated by commits this rehearsal demonstrably landed — `feat: cache integrity management and mobile alert` (`#232`), `feat(api): report explicit server warm-up states` (`#234`), `fix(uploads): sanitize spaces in filenames` (`#241`), `fix(logs): reopen supervised fds` (`#259`) and so on.

`git cherry` compares **patch-ids**. A squash-merge collapses N commits into one commit with a new patch-id, so every one of the N originals is reported `+` forever. The runbook's Step 3 says:

> ```bash
> $G cherry origin/main origin/integration/missing-prs-2026-07-23 | grep '^+' | wc -l
> # target: 0
> ```

**That target cannot be reached by a landing strategy built on squash-merges — which is the strategy this runbook prescribes.** Chasing it would mean re-landing already-landed work. The correct termination test is the tree diff plus the added-files sweep:

```bash
git diff --stat <main> origin/integration/missing-prs-2026-07-23
git diff --name-status --diff-filter=A <main> origin/integration/missing-prs-2026-07-23   # must be empty
```

### Test baseline, and two falsified predictions

`npm test` never reaches zero failures, on `main` or after any group — see D4. The criterion used throughout was **"no new failing test file versus the baseline"**.

| Point | Trunk | Total tests | Failing files | Failing tests |
|---|---|---|---|---|
| `origin/main` (baseline, 2 runs) | `28da612` | 975 | 8 / 7 | 10 / 9 |
| after Groups A + A′ + B | `3f60c57` | 975 | 8 | 14 |
| after Groups C/F/E/D/G + `#297`/`#299` | `f3056fb` | 1778 | 10 | 20 |
| **final, all carries applied** | **`8bbfedf`** | **1777** | **9** | **15** |

The replay adds **~800 tests** (975 → 1777), 1757 of which pass. Lint green, build exit 0.

**Versus the 8-file baseline the final trunk fixes one file and adds two:**

- **fixed** — `__tests__/server-bind-retry.test.ts`. That is `20c02fc` (`ServerConfig.skipStartupWarmup`) working, and it independently justifies carrying that commit even though the runbook says to close its PR (`#295`).
- **added** — `__tests__/pty-host-survival.test.ts` and `__tests__/server.test.ts`.

Of the 15 failing tests, **12 are `Hook timed out` / `Test timed out`** in the same server-lifecycle suites that fail on bare `main`, and **3 are real `AssertionError`s**:

| Failing assertion | Status |
|---|---|
| `server.test.ts` — *omits systemPrompt for a fresh codex-cli session by default* | **unresolved, cause not isolated** |
| `pty-host-survival.test.ts` — *re-adopts host sessions once…* (`expected 1785606585682 to be null`) | **unresolved, not investigated** |
| `codex-resume.test.ts` — *resumes a placeholder id via `codex resume <boundId>`* | **unresolved, not investigated** |

#### Two hypotheses were tested and both were wrong — recorded because being wrong here is the useful part

An earlier draft of these notes wrote off failures on untested predictions. Both were then tested, and both failed:

1. **"Carrying `0007928` (`test: bind ephemeral ports in codex-resume and cors-middleware`) will clear those two files."** `0007928` was carried; the full suite was re-run. **`codex-resume` and `cors-middleware` still fail.** What carrying it *did* do is remove both files from the Phase-2 diff (19 → 17 files) — so the commit is a genuine carry, it just does not fix the failures.
2. **"Carrying `9608196` (`feat(codex): gate Codex systemPrompt injection behind a feature toggle`) will clear the `systemPrompt` assertion."** `9608196` was carried; the suite was re-run. **Identical result: 15 failed / 1757 passed.** `grep -c codexSystemPromptEnabled` gives **7** in `src/server.ts` on both the trunk and the branch, so the gate *is* present — the failure is elsewhere and was not isolated before this rehearsal ended.

**Do not treat the three assertion failures as explained.** They are the first thing the real run should investigate, and the fact that two plausible one-commit fixes both failed is evidence the cause is a resolution defect (D7-class) rather than a missing commit.

#### Correction (2026-08-03, verified against `main` @ `eb4f6ad`): all three no longer reproduce

The "unresolved" status above was measured on the rehearsal trunk `8bbfedf`, not on `main`. Re-run today in a fresh worktree off `origin/main` (Node pinned via `.nvmrc`; `node_modules` reused from an already-installed, lockfile-identical checkout, no `npm install`/`npm ci` run), the same three files pass, individually and together:

```
npx vitest run --no-file-parallelism __tests__/server.test.ts __tests__/pty-host-survival.test.ts __tests__/codex-resume.test.ts
# Test Files  3 passed (3)
#      Tests  148 passed (148)
```

Isolated by name (`-t`), each also passes on its own:

- `server.test.ts` — *omits systemPrompt for a fresh codex-cli session by default* — ✓ 225ms
- `pty-host-survival.test.ts` — *re-adopts host sessions once, preserves replay, and leaves the host alive on close* — ✓ 347ms
- `codex-resume.test.ts` — *resumes a placeholder id via `codex resume <boundId>` while keeping the placeholder as the session id* — ✓ 7953ms

**What this does not establish:** which commit(s) landed between `8bbfedf` and `main` cleared them, or whether the D7-class resolution-defect hypothesis above was correct — no bisect was run. Treat the three as currently green on `main`, not as explained.

### The runbook's own docs — deliberate decision

`LANDING-integration-to-main.md`, `docs/landing/` and `docs/testing/cross-platform-ci.md` are **CARRIED to the trunk**, not dropped. They arrived naturally as part of Group E (`#334`, `#341`, `#342`, `#343`, `#344` are edits to those files and are Group E members). Dropping them would have required deliberately excluding five Group-E commits.

**Recommendation: keep them.** `docs/testing/cross-platform-ci.md` documents a live operational hazard (a required check that does not exist on the target branch makes every PR permanently unmergeable — it happened on 2026-08-01 and had to be reverted). That is reference material for `main`, not scaffolding. The runbook itself is the record of how `main` came to look like this.

---

## 7. Corrections to `LANDING-integration-to-main.md`

Quoted line → correction.

**1.** > "### Group A — still open against `main` (10 remaining of 12) → just merge them"
> "No new PRs needed. Their content is already reviewed and targeted correctly."

Wrong for three of them. `#267`, `#297` and `#299` are branched off the **integration branch**; their PR heads are reachable from it. Merging them lands Groups C/E/F content under an unrelated title. Apply the runbook's own "Generalise this" rule to them. See Correction 2 in §2.

**2.** > "Suggested order: dependency-free dependabot bumps first (`#227`, `#264`) …, then `#237`, `#267`, `#270`, `#272`, `#297`, `#299`, then the stacked chains (`#253` → `#254`; `#232` → `#234`; `#266`)."

Inverted. `#267` is a descendant of twelve Group-A′ PRs and `#297`/`#299` are descendants of `#267`. Use the wave order in §2. Groups A and A′ must be interleaved, not run in sequence.

**3.** > "Group A is 11 ordinary PR merges remaining (10 listed plus `#297`) — mostly mechanical, and two are dependabot bumps."

Three of the eleven are ≥79-commit, 75–180-file PRs (`#267`: 79/75/+6543; `#297`: 142/169/+19281; `#299`: 143/170/+19408). The cost estimate should say so.

**4.** > "`#245` … Confirm the flake still exists before spending a rehearsal on it."

The answer is no, and the reason is not the one implied. `#245` is superseded by **`#248`, which is already on `origin/main`** — not by `#305`/Group E. Its residual is a duplicate module-scope `waitFor` shadowed by `#248`'s nested one, i.e. dead code, and the integration branch never took it. **Close `#245`.** Also note it is an *ancestor* of `#267`/`#297`/`#299`/`#304`, so closing it does not remove its content from those PRs.

**5.** > "Group C … Reach them through `origin/pr/<N>` after the PR-head fetch, **or through their squash commits on the spine**."

There are no squash commits on the spine for Group C. All seven landed as `chore(merge): integrate PR #NNN` **merge** commits (`dc5f4bf`, `faad022`, `a4a066b`, `270d34b`, `2ea5742`, `d0c15c0`). Only the `origin/pr/<N>` route exists. (Group F's four *are* squashes — the runbook is right there.)

**6.** > "**`#295` … fully absorbed. Close it; do not re-target.**"

Correct about the PR, incomplete about the content. Its commit `20c02fc` is the only source of `ServerConfig.skipStartupWarmup`, which Group E requires. Close the PR **and** carry the commit as Group D.

**7.** > Step 3: "`$G cherry … | grep '^+' | wc -l` — target: 0"

Unreachable by construction under squash-merge. Use the tree diff + `--diff-filter=A` sweep instead. See §6.

**8.** > "### Group D — 58 direct commits on the branch spine → triage required" (framed as a final cleanup, after Groups A–C in Step order)

Group D is a **dependency of Group E**, not a postscript. Group E does not type-check without `90c1c07`, `20c02fc`, `36db39d` and `a60518c`. Land Group D's carries before or alongside E.

**9.** Group rosters are incomplete: **Group G** (`feat/search-scalability`, `feat/diagnostics-api`, `feat(backup)`) is on the branch, in no roster, and structurally invisible to the runbook's `--first-parent --no-merges` scan. See §5.

**10.** Hotspot table omits `docs/BACKLOG.md`. It conflicted on four separate PRs (`#257`, `#258`, `#259`, `#267`) — more often than `src/types.ts`. The rule that resolves it every time: **the fixing PR's status line beats `#257`'s status-snapshot line.**

**11.** > "`main` is **250 commits behind**" / "First-parent spine commits (non-merge) | **102**"

Re-measured 2026-08-01 at tip `ebe9eb8` (after `#344`): **252** and **104**. The runbook is right to say re-measure; these are the current values.

**12.** Step 0's ref-fetch order is load-bearing in a way the runbook does not state: `git fetch origin --prune` **deletes all 344 `origin/pr/*` refs**. Prune first, PR heads second, and add `--no-recurse-submodules` (see D1, D2).

---

## 8. Replay script for `origin`

Written for the next session, with the unknowns resolved. `origin` is still read-only until the final step of each block.

### Step −1 — measure the artifact, never a proxy. Run this before every measurement and every commit.

```bash
# PRECONDITION: the working tree must be clean before you measure or commit anything.
test -z "$($G -C <worktree> diff --stat)" || { echo "unstaged changes — stage them first"; exit 1; }

# Every residual number quoted anywhere must come from the COMMIT:
$G show --stat <sha>            # yes — the artifact
# NOT:
$G diff --cached --stat         # no — the index, which may not be what you edited
$G diff --stat                  # no — the worktree, which may not be what you commit
```

**Phrase every gate as a property of current state, never as a record of what you did.** This is the
constructive form of the failure that recurs throughout these notes, and it is worth stating
positively because every other instance is recorded negatively.

Each thing that went wrong in the 2026-08-01 run was a **proxy standing in for a fact**: an exit code
for whether a merge happened, the index for what was committed, a check rollup for whether the matrix
had run, a `grep` for a symbol that did not exist, `git cherry`'s patch-ids for whether content had
landed. In every case the proxy was accurate about itself and silent about its subject.

The resumability guard is the same distinction applied deliberately, and it is the one gate that
*worked*:

```bash
git merge-base --is-ancestor origin/main HEAD    # a property of current state
# NOT: "have I already rebased this PR?"          # a memory of an action
```

They differ exactly when something moves in between — and something does. It caught a release commit
landing inside the window between a PR going green and being merged, where the action-memory form
would have merged a stale branch. **When writing any check, ask whether it interrogates the world or
your own record of it.**

**Why this is a step and not advice.** On 2026-08-01 the `#267` residual was measured with
`git diff --cached --stat` while the strip that produced it existed only in the **working tree** —
the merge had already staged `src/server.ts`, and the edits were never re-staged. Local
`npm run lint` passed (it reads the worktree) and the pushed commit failed CI with
`error TS2561: 'projectsDirs' does not exist in type 'ShouldRefreshOptions'`, because the commit
carried the *unstripped* file. Every residual figure reported in between — "8 files / +199",
`src/server.ts | +82` — described a tree that was never committed. The true values were
**4 files / +140** and `src/server.ts | +24`.

`git status` printed ` M src/server.ts` throughout and was simply not in the loop. The index and the
worktree are both **proxies for the artifact**, and they diverge exactly when a merge stages files
that you then edit — which is *every* conflict resolution in this document.

The precondition retires the whole class: if `git diff --stat` is empty, worktree, index and commit
are the same object, and it no longer matters which one you measured.

```bash
G=/opt/homebrew/bin/git

# ---- Phase 0: refs (order matters — see D1/D2) -----------------------------
$G fetch origin --prune
# PR heads go to refs/landing/pr/*, NOT refs/remotes/origin/pr/* — see below
$G fetch origin --no-recurse-submodules '+refs/pull/*/head:refs/landing/pr/*'
test "$($G for-each-ref refs/landing/pr/ | wc -l)" -gt 300 || exit 1
$G branch  backup/integration-<date> origin/integration/missing-prs-2026-07-23
$G tag -m archive archive/integration-<date> origin/integration/missing-prs-2026-07-23
# assert the backup equals the LIVE tip — a stale backup silently corrupts the final diff
test "$($G rev-parse backup/integration-<date>)" = "$($G rev-parse origin/integration/missing-prs-2026-07-23)"
```

**Fetch the PR heads to `refs/landing/pr/*`, not `refs/remotes/origin/pr/*`.** D1 established that
`git fetch origin --prune` deletes every `origin/pr/*` ref, because the default fetch refspec does
not cover them, and prescribed an ordering fix: prune first, PR heads second.

**That ordering fix is not sufficient, because the prune is not necessarily yours.** During the
2026-08-01 real run the Phase-0 count assertion passed at 346 refs and the same command returned
**0** about two minutes later, with no fetch issued by the run in between. `fetch.prune` was unset,
`remote.origin.fetch` held only `+refs/heads/*:refs/remotes/origin/*`, and there was no
`maintenance.*` config, no scheduled git job in launchd or cron, and no repo hook — some process
outside the repo (an editor auto-fetch is the likely candidate) prunes periodically. No command
ordering can protect a ref namespace against a prune that fires an hour later.

This matters more than a re-fetch would suggest. **Groups B, C and F are reachable only through
these refs** — correction 5 in §7 establishes that Group C has no squash commits on the spine, so
`pr/<N>` is the *sole* route to those seven PRs, and Group B's four and Group F's four sit behind
the same fetch. An async prune mid-run makes eleven PRs silently unreachable: `git rev-parse` fails,
a loop reports "not found", and nothing distinguishes that from a PR that was never fetched. It is
the silent-drop failure the runbook's Risks table warns about, arriving from a direction neither the
runbook nor D1 anticipated.

`refs/landing/` sits outside `refs/remotes/`, so no `origin` prune can consider it stale. Same
objects, prune-proof name, no config change, and nothing else in the repo is affected.

**The oracle's scope, stated once because it was misread three times.** The integration branch is
**reliable on shape and silent on what the shape displaced**. It shows what a region looks like once
everything has landed, so it verifies the *form* of a resolution you have already attributed — on the
real run its ghost-prune block matched the hand-made resolution exactly. It cannot tell you whose
content a hunk is (it contains every PR), and it cannot tell you what a resolution removed from the
surrounding context. `#237`'s `h2` matched it perfectly while `h3` still needed a call-site wrap
restored that the branch's own version obtains from `#266`/`#271` content not yet landed.

**Everywhere below that names `origin/pr/<N>` — wave 2's `--onto` rebases and wave 4's Group C
route — read `refs/landing/pr/<N>`.**

### Before EVERY `gh pr merge --delete-branch`: re-point the children first

**This applies to every merge in every wave, not just the stacked ones.** Deleting a branch closes
every open PR whose **base ref** is that branch — GitHub does not retarget them, it closes them, and
the PR reports `state: CLOSED` with `mergedAt: null`. The merge itself succeeds, so nothing in the
merge's own result says anything went wrong.

```bash
# BEFORE merging PR <N> whose head branch is <head>:
gh pr list --state open --base "<head>" --json number --jq '.[].number'
# For every number returned:
gh pr edit <child> --base main
# only then:
gh pr merge <N> --squash --delete-branch
```

**Ancestry-stacked is harmless; base-ref-stacked is fatal — and §2's dependency table records only
the former.** The two relations are not the same, and §2 measures the wrong one for this purpose:

- §2 defines "stacked" by ancestry (`git merge-base --is-ancestor` across PR heads), and §8's wave 2
  prescribes a purely *git* remedy, `git rebase --onto main origin/pr/<parent>`.
- GitHub defines it by `baseRefName`, PR metadata that appears nowhere in these notes.

`#234` is the proof they differ: §2 lists it as stacked on `#232`, but its base ref is `main`, so
deleting `#232`'s branch did nothing to it. Of the three wave-2 children only `#254` and `#266` were
base-ref-stacked, and those are exactly the two that break.

`rebase --onto` is therefore **correct and insufficient** — it fixes the child's *commits* and never
re-points the *PR*, leaving it aimed at a branch that is about to be deleted.

**This happened.** On 2026-08-01, `gh pr merge 253 --squash --delete-branch` closed `#254`, whose
base was `#253`'s head branch `feat/live-external-sessions`. Its one commit — `c847033 fix(adopt):
resolve the working directory from the conversation JSONL`, 191 lines of new test plus 45 lines of
`src/server.ts` — did not reach `main`, and the wave reported success.

Recovery, if it has already happened: the child's *head* branch survives (`--delete-branch` deletes
only the merged PR's own head), so nothing is lost. GitHub refuses to reopen a PR whose base ref no
longer exists, so restore it first:

```bash
git push origin <parent-pre-merge-sha>:refs/heads/<deleted-base-branch>
gh pr reopen <child>
gh pr edit <child> --base main
git push origin --delete <deleted-base-branch>     # safe once the child points at main
```

**Wave 1 — independent PRs.** Rebase onto `main`, wait for green, squash-merge, one at a time.
Order is free *except* `#237` (see below). `docs/BACKLOG.md` conflicts are expected on `#257`/`#258`/`#259`; the fixing PR's status wins.

```
#227  #264  #270  #272  #253  #232  #240  #241  #242  #252  #255  #260  #302  #257  #258  #259
```

- **Do not merge `#245`** — close it (correction 4).
- **`#223` last, on its own**, after a real `npm install` (D10).

**Wave 2 — one-parent children.** Rebase with `--onto`, never a plain rebase, or the parent's squashed commits replay:

```bash
$G checkout -B replay/pr-<child> origin/pr/<child>
$G rebase --onto main origin/pr/<parent>
```

```
#234 (parent #232)    #254 (parent #253)    #266 (parent #237)
```

`#254` and `#266` are **base-ref-stacked**, not merely ancestry-stacked — `gh pr edit <child> --base main` them before their parent merges, or merging the parent closes them. See the rule above Wave 1.

**`#237` ordering:** land `#237` **after** `#232`, `#253`, `#234` and `#267`. Its extraction of `reconcileConversationsCacheFromDisk()` collides with all four; landing it last costs one resolution instead of four (§3). `#266` follows `#237`.

**Executed 2026-08-01 and it works — one conflict instead of four**, but it arrives as one *compound*
resolution: `src/server.ts` ×3 plus `docs/BACKLOG.md` ×1, in which rows 5, 7 and 8 must all be
re-made at once, from the opposite side. `#237`'s extracted method as written is the
**pre-`#232`/`#253`** body — no freeze guard, and a hand-rolled `livePaths` Set instead of
`canonicalLivePathSet(metas)`. Taking its side wholesale reinstates the POSIX-invisible
Windows-only regression `CLAUDE.md` documents. Take `#237`'s *structure* and transplant `main`'s body.

#### Verifying a compound resolution — and the limit of the obvious check

The natural completion signal is a **body diff**: the extracted method must equal the inline block it
replaces, modulo the extraction itself, with every difference named and attributed. Do that — on the
real run it flagged exactly two differences, both legitimate (`#237`'s own
`refreshConversationCache` / `setCacheMetadata` additions, verified present in `a0bfa77` and absent
from `main`'s inline body).

**But a body diff is structurally blind to anything that *wrapped* the block rather than lived inside
it.** It compares what is IN the method to what was IN the block; a `withWarmup(...)` that used to
surround the block and now surrounds nothing is invisible to it. That is exactly what went wrong —
see §9.4 — and only `#234`'s test caught it.

**So pair the body diff with a construct count, before and after.** It is one command and it is the
whole finding:

```bash
git show origin/main:src/server.ts | grep -c 'withWarmup("conversation_refresh"'   # 2
grep -c 'withWarmup("conversation_refresh"' src/server.ts                          # 1  <- the bug
```

Count anything that **wraps** rather than lives inside: `withWarmup`, warm-up/permission guards,
`try`/`catch`, transaction or lock scopes, `trackCacheWrite`. A drop with no deliberate reason means
the extraction ate a wrapper. **Never read the body diff as sufficient on its own** — it is a check on
content, and an extraction's risk is in the context.

**Wave 3 — `#267`.** Only after wave 1+2. Its delta collapses from 75 files to ~8.

### Build the PR from its own commit. Do not strip its branch-wide diff.

**This supersedes two rules adopted earlier in the same run. Both were wrong, and both were wrong in
shape rather than in degree** — recorded as corrections, not refinements, because following either
one carefully still lands foreign content on `main`.

**Superseded rule 1 — "strip until it fails to compile."** Wrong shape. Compilation is not a
completion signal, so the procedure it defines is **an open-ended search with no completion
signal**: you remove what you can see, rebuild, and learn nothing about what remains. `#267`'s
residual shrank **75 files → 9 → 8 → 4 → 3**, and *each step was caught by a different mechanism,
the last by none*:

| Step | What came out | Belongs to | Caught by |
|---|---|---|---|
| 75 → 9 | the stale three-dot merge-base | — | measuring with `merge --squash` |
| 9 → 8 | three private methods + the `projectsDirs` option | `#237` | **compilation** |
| 8 → 4 | four doc files, 656 lines | Group D `eab26e3`, `489a450` | **chasing a `+188` variance** — nothing automated |
| 4 → 3 | `auto-reconcile without refresh=1` test block, 111 lines | `#237` | **CI tests only** — lint and build were green |
| 3 → the truth | `refreshConversationCache` block, 2 imports, a comment | `#237` (`a0bfa77`) | **nothing** |

The last row is the one that condemns the rule. That block **survived compilation, lint, a variance
chase, and a full local test suite**, and surfaced only because a *test carried the feature's name* —
`GET /api/conversations auto-reconcile without refresh=1` is `#237`'s title. Had `#237` named its
tests differently, ~20 lines of it would have landed on `main` under `#267`.

**Superseded rule 2 — "diff every resolved region against the integration branch, for every
conflict."** Wrong shape, and worse than useless on the case that mattered. The branch answers
*"what does this region look like once everything has landed"*, **never** *"whose content is this"*,
and it cannot distinguish them because **it contains every PR by construction**. On `#267`'s `h3` it
did not merely fail to help — **it argued for the wrong side**, endorsing `theirs` because the branch
does contain `refreshConversationCache` there. It is `#237`'s.

The branch is **a shape check on a resolution already attributed by provenance, and nothing more.**
It is still worth running for that; it is not an authority on attribution.

**What to do instead.** For any PR whose head sits on the integration branch, **identify the PR's own
commit and build from it**:

```bash
git checkout --detach origin/main
git cherry-pick <the PR's own commit>
```

Bounded and exact, with a definite answer, versus subtracting foreign material from a branch-wide
diff until nothing visible remains. Where a residual must still be attributed line by line, use
provenance rather than the compiler:

```bash
git log --format='%h %s' -S'<distinctive line>' origin/integration/missing-prs-2026-07-23 -- <file>
git log --format='%h %s' --diff-filter=A -1 refs/landing/pr/<N> -- <file>
```

**The same principle was reached independently by the tb-mobile landing the same night**, from the
opposite direction: its slice A cherry-picked the net end state rather than replaying 87 commits.
Both are **construct what you want, rather than remove what you do not** — and both were adopted only
after the subtractive version had already gone wrong once.

The reason to state it that way is that the compile-based form was tried first and is incomplete.
On the 2026-08-01 run, `#267` carried two distinct classes of foreign content:

| Foreign content | Traces to | Caught by |
|---|---|---|
| `reconcileConversationsCacheFromDisk`, `shouldAutoReconcileConversationList`, `projectsDirsForFreshnessCheck`, and the `projectsDirs` option on `shouldRefreshProjectsFromHdd` | `#237` | **strip-until-it-fails-to-compile** — worked |
| `docs/postmortems/2026-07-22-merge-all-open-prs-report.md`, `docs/runbooks/{2026-07-22-land-open-prs,README,_template}.md` — **656 lines** | Group D `eab26e3`, `489a450` | **nothing** — docs have no compile-time consequence |

The docs half surfaced only because the residual measured `+855` where §2 predicted `+667` and
someone chased the variance. **That variance is now closed, and its answer is the finding above:**
§2's `8 files / +667` was never `#267`'s residual either — it was `#267` plus roughly 660 lines of
`#237` and Group D. Both figures were measuring the same foreign content, in slightly different
amounts, which is why comparing them looked like a 28% discrepancy rather than a category error. **A criterion keyed on compilation is blind to every file that cannot
fail to compile** — docs, fixtures, schemas, workflow YAML, migrations that are not yet run.

**That list is observed, not anticipated.** The tb-mobile landing running in parallel on the same
night hit the identical blind spot from a different direction: its `fee27061` exists solely because
a replay **reverted `.github/workflows/test.yml` and `package.json`, and resurrected a file `main`
had deleted**. Workflow YAML, a dependency manifest, and a deletion — none of them capable of
failing a compile — and all three caught only because someone diffed against `main` by hand
afterwards. Two independent landings hitting the same class on the same night is the reason this is
written as a rule rather than a caution.

Two of the categories deserve more weight than the rest:

- **Workflow YAML.** Reverting it silently weakens **the gate everything downstream is verified
  by**. **Every check that would catch the revert is defined in the file that was reverted, so it
  does not go red — it goes green with less meaning, and stays that way for every PR after.** That
  is a categorically worse failure than a loud one, and no runbook in this repo says it anywhere.
  On this repo the concrete loss is the cross-OS Smoke matrix — the thing `#340` spent an entire PR
  establishing on `main`, and the only coverage `Smoke (windows-latest)` and `Smoke (macos-latest)`
  provide. tb-mobile's `fee27061` is a reverted `.github/workflows/test.yml` and nothing else
  caught it.
- **Unrun migrations.** A reverted or dropped migration is invisible to `tsc`, to biome, and to the
  test suite, and stays invisible **until the next boot against a real database** — by which point
  it is a production failure rather than a CI one. **This is a live instance in this landing, not a
  hypothetical:** `a60518c` carries `src/db/migrations/014_add_conversation_meta_file_path_index.sql`
  and §5 records it as the **sole source** of that file. It is a Group D carry scheduled for wave 5;
  drop it or revert it and every build, lint and test still passes, while the
  `conversation_meta.file_path` index simply never exists on any deployment.

Both share a property worth naming: **the damage is deferred past the point where anyone is still
looking at the landing.** Docs drift is embarrassing; these two are the ones that cost an incident,
and both transfer beyond this repo.

**`#267`'s residual is 3 files / +8 lines**, and the way to get it is not to strip at all — it is to
identify the PR's own commit and use it directly. §5 already records it: `6a853fd feat(api): emit
session_name in conversation detail meta`. Cherry-picking that onto `main` reproduces the PR exactly:

```
__tests__/contracts/mobile-contracts.test.ts | 5 +++++
contracts/mobile.schema.json                 | 1 +
src/server.ts                                | 2 ++
3 files changed, 8 insertions(+)
```

Two `session_name:` field emissions, one schema property, one contract assertion. That is the whole PR.

**§2's "8 files / +667" is therefore not `#267`'s residual — it is `#267` plus roughly 660 lines of
other PRs' work**, and the rehearsal landed all of it under `#267`'s number. Successive strips during
the real run went 75 files → 9 → 8 → 4 → 3, and each step removed content that had looked like part
of the PR:

| Stripped | Actually belongs to | Would have been caught by |
|---|---|---|
| three private methods + `projectsDirs` option | `#237` | compile |
| four doc files, 656 lines | Group D `eab26e3`, `489a450` | nothing — chased a `+188` variance |
| `auto-reconcile without refresh=1` test block, 111 lines | `#237` | **CI tests only** — passed lint and build |
| `refreshConversationCache` block + 2 imports + a comment, ~20 lines | `#237` (`a0bfa77`) | nothing — the oracle actively endorsed keeping it |

**The lesson is to start from the PR's own commit rather than from its diff against `main`.** For any
PR whose head sits on the integration branch (`#267`, `#297`, `#299`, `#304` — Correction 2), the
diff is the *branch's* content, and stripping foreign material out of it is an open-ended search with
no completion signal. Identifying the one commit is bounded and exact.

**Consequence for §5.** `eab26e3` and `489a450` are listed there as Group D **`carry`**, meaning
nothing else brings them in. That is wrong as stated: both are **inherited by `#267`**, so in a run
that lets `#267` land whole they arrive early and wave 5's picks of them are no-ops. A no-op
cherry-pick reads as "already handled" and gets skipped, which is how the row's verdict stops being
checked. Stripping them from `#267` puts them back on Group D's plate — whether they remain
correctly classified `carry` depends on whether wave 5 picks them cleanly, which this run will be
the **first to actually exercise**.

**Wave 4 — Groups B, C, F.** Cherry-pick, do not merge the PRs.

```bash
# Group B — one commit each; the branches exist but are deep stacks, use the tips only
4261160 (#271)   fea7dda (#273)   6f51543 (#274)   d11734c (#275)
# NOTE: #275 introduces a biome import-order error in __tests__/session-status-line.test.ts.
#       Group C's #281 is the fix. Land #281 immediately after, or lint is red in between.

# Group C — merge commits, no spine squashes; reach via origin/pr/<N>, in this order
#276 → #281 → #282 → #283 → #284 → #285 → #287
#       #276 lands the same import-order error; #281 clears it. Same caveat.

# Group F — real squash commits, cheap
6a01792 (#292)   9f85ec5 (#293)   03d2f11 (#294)   342c61c (#296)
```

**Wave 5 — Group D carries, BEFORE Group E** (correction 8):

```bash
90c1c07   # feature-flag registry — loadFeatureFlags, StreamerServer.featureFlags
20c02fc   # ServerConfig.skipStartupWarmup  (close #295, but carry this commit)
36db39d   # model/effort endpoints + their two test files
a60518c   # migration 014, conversation_meta.file_path index
13b5ff0   # docs/plans/claude-code-live-sessions-persistence-prompt.md
0007928   # test: bind ephemeral ports in codex-resume and cors-middleware
7ebcaee   # fix(claude-flags): remove --print-only flags (also corrects CLAUDE.md's security note)
996b0f3   # chore: ignore and untrack .remember  (+ scripts/lint-changed.sh guard)
9608196   # feat(codex): gate Codex systemPrompt injection behind a feature toggle
```

All eight were **measured**, not guessed: each was applied because a specific `tsc` error, failing test file, or Phase-2 diff entry pointed at it, and applying it removed that symptom. Carrying the last three took the Phase-2 residual from 19 files to 8.

**One cross-wave hazard, and it is the single most dangerous thing in this document.** Group C's `#283` widens `markReady()` to four arguments, so the two `handleQuiet` call sites must be updated when you land it. Do **not** hand-write `markReady(sessionId, session, "timeout-fallback", "quiet:timeout")` for the first one.

Later, in **wave 7**, Group E's **`db00041` (`#313`, `fix(pty): stop treating boot silence as readiness`)** replaces that entire call with `recheckReadyFromScreen()` and conflicts on `src/pty-manager.ts`. **Apply `#313` — it is not optional and it is not Group D — and resolve that conflict in `#313`'s favour**, i.e. take `handleQuiet` from the branch:

```bash
git checkout origin/integration/missing-prs-2026-07-23 -- src/pty-manager.ts   # then re-apply only #283's arity change if needed
```

If a blanket pick resolves it the other way, the commit still lands, `tsc` and biome still pass, and the bug `#313` fixes is silently back. This rehearsal made exactly that mistake and only caught it in the Phase-2 file diff.

**Wave 6 — Group G, the unrostered features** (§5):

```bash
32c2c34   # feat(search): pagination, filters, relevance, query timing
fe498bd   # feat(diagnostics): versioned diagnostics API
0f463ea 27efe97   # feat(backup): export/restore endpoints + metadata validation
```

**Wave 7 — Group E**, ascending, one at a time:

```bash
$G log --first-parent --no-merges --format='%h %s' --reverse main..origin/integration/missing-prs-2026-07-23 \
  | grep -E '\(#(30[1-9]|3[1-4][0-9])\)( \[skip-ci\])?$'
```

40 commits. In this rehearsal 28 applied clean and 11 needed a resolution. Exclude `#269` (`518ede9`, duplicate of `8b49ad7` already on `main`) and `#298` (`fad5d5f`, = `#297`).

**Wave 8 — `#297` and `#299` last.** They only apply after Groups C and E:

```bash
23e72ac   # (#297) permission-gate broadcast dedup
66fff5f   # (#299) per-session terminal_output seq
```

`#304` is never merged — `90c1c07` in wave 5 is its content; close it.

### The three remaining integration-headed PRs — take each from its own commit

`#297`, `#299` and `#304` are the rest of the set Correction 2 identifies: their heads are commits on
the integration branch, so **their diffs against `main` are the branch, not the PR**. `#267` cost four
rounds of stripping and two red CI runs before this was applied; these three do not need to repeat it.
SHAs resolved and measured on 2026-08-01 so the next session does not re-derive them:

| PR | Its own commit | Real size | Branch-wide diff (**do not use**) |
|---|---|---|---|
| `#297` | **`23e72ac`** `fix(server): dedup permission-gate broadcasts on unchanged repaints` | **3 files / +167** | 113 files / +13 646 |
| `#299` | **`66fff5f`** `fix(ws): stamp terminal_output/terminal_replay with a per-session seq` | **3 files / +127** | 114 files / +13 773 |
| `#304` | **`90c1c07`** `feat(config): add server feature-flag registry with boot-time resolution` | **15 files / +739** | 126 files / +15 036 |

`#297`'s commit also exists on the branch as `fad5d5f` (it arrived via cherry-pick PR `#298`); either
resolves to the same content, and `#298` is excluded from wave 7 for that reason.

**`#304` is closed, not merged** — `90c1c07` is carried in wave 5 as Group D. The other two are
cherry-picked in wave 8. In all three cases:

```bash
git checkout --detach origin/main
git cherry-pick <sha>          # never `git merge --squash refs/landing/pr/<N>`
```

The ratio is the point: for `#297` the branch-wide diff is **~82× the real change**, and every one of
those extra lines belongs to a PR with its own number.

**Per-group verification:**

```bash
npm run lint            # after EVERY squash — it is the only type-check you get here
npm test                # per group, on a SEPARATE frozen worktree (D9)
npm run build           # per group
# and the two sweeps a compiler cannot do for you:
diff <(grep -o 'app.route("[^"]*"' src/api/app.ts | sort) \
     <(git show origin/integration/missing-prs-2026-07-23:src/api/app.ts | grep -o 'app.route("[^"]*"' | sort)
git diff --name-status --diff-filter=A HEAD origin/integration/missing-prs-2026-07-23   # must end empty
```

**Do not** use `git cherry … | grep -c '^+'` as the finish line (correction 7).
**Do not** resolve conflicts file-by-file (D7).
**Do not** run `biome check --write` mid-sequence (D8).

### Classify every conflict before resolving it, and treat MIXED as an ordering signal

Read each conflict in `diff3` style (`merge.conflictStyle = diff3`, which shows the common ancestor between `|||||||` and `=======`) and classify it before deciding anything. In this landing every conflict fell into one of three shapes, and only one of them is a decision:

| Shape | `ours` | `base` | `theirs` | What it means | Resolution |
|---|---|---|---|---|---|
| **subtract-the-ancestor** | empty | non-empty | `base` + delta | the pick is out of branch order, and `base` is a sibling commit's content showing through | take `theirs` − `base`: this commit's own contribution, nothing else |
| **union at an empty base** | non-empty | empty | non-empty | a genuine both-added | keep both, ordered to match the integration branch |
| **MIXED** | — | — | — | neither of the above | **stop, and check the ordering first** |

**A MIXED classification is evidence that a prerequisite is missing at least as often as it is evidence of a real conflict. Check the ordering before reaching for judgement.**

Why this is worth a rule rather than a note. An out-of-order pick does not merely cost effort — **it manufactures a decision that does not exist.** `#304` is the worked example: cherry-picked onto `main` before Group F and `9608196`, it produced seventeen hunks across eleven files, three of them MIXED, each presenting as one mechanism versus a different mechanism that supersedes it, with `main` holding neither side. That reads exactly like a design decision. Resolved in that state it would have produced three hand-made resolutions and a recorded judgement call about a choice nobody ever made — and that record would then have been cited as precedent by whoever came next. With the prerequisites landed first, the same commit applies with **zero** conflicts.

**This is the counterweight to the stop rule.** Stopping to think is the right default, and an ordering error is precisely what exploits it: it presents as the signal the stop rule exists to catch. So before treating a MIXED hunk as a judgement call, ask what would have to be on `main` for it to be mechanical, and check whether that is a group you have not landed yet.

A **tree** conflict — a path that does not exist on your side at all — is the same signal in its clearest form, and worth reaching for deliberately when a group's conflicts look wrong. A content conflict is ambiguous; "this file is not here" has exactly one cause. `#304`'s `docs/env.example` conflict named Group F as the missing prerequisite with no analysis at all.

This generalises §8's own ordering rules (`#237` after its four editors; Group D before Group E). Those are not cost optimisations — they are the difference between a mechanical landing and a series of invented decisions.

**Expected end state:** ~98 commits on `main`, and `git diff --stat` against the branch showing only `#302`'s doc, `#223`'s lockfile/`package.json`, and small docs deltas. This rehearsal ended at 7 differing files; anything materially larger means a group was dropped, anything materially smaller means the drift in §6 was resolved better than it was here.


---

## 9. What §3 and §8 do not tell you

Written last, deliberately. §3 records the resolution that won; §8 records the order to use. Neither says which calls were close, which were reasoned rather than measured, or what was never checked at all. A colleague picking this up should know the following before trusting either section.

### 9.1 The single biggest gap: eleven Group-E commits were resolved by the blanket picker, and §3 names none of them

> ## ⚠ RE-DERIVE THE FILE COLUMN BELOW. DO NOT READ IT.
>
> **Measured against the real run: the "Files decided by a blanket per-file pick" column is wrong roughly two times in three.** Three entries have now been reviewed by hand, and two of the three had the wrong file recorded:
>
> | Entry | This table says | Actually |
> |---|---|---|
> | `#313` | `src/pty-manager.ts` | correct — and its answer was already known (§6) |
> | `#293` | `src/server.ts` | **`src/server.ts`, but one import hunk** — mechanical, and the entry reads as far more dangerous than it is |
> | `#296` | `src/server.ts` | **`src/api/app.ts`** — a different file, and a real defect (an orphaned `createDiagnosticsRoutes` import) |
>
> Both error directions are harmful and neither is safe to absorb. An entry that overstates (`#293`) spends a careful reviewer's attention on an import union. An entry that names the wrong file (`#296`) sends them to inspect `src/server.ts`, find nothing wrong, and conclude the entry is clear — while the actual defect sits in a file they were never pointed at. **The second failure is the dangerous one, because it converts a warning into a false all-clear.**
>
> The "seven of the thirteen decided `src/server.ts`" claim below inherits this and must not be quoted. `#296` was one of the seven and is not a `src/server.ts` entry at all.
>
> **For each of the ten remaining entries, derive the files from the commit rather than from this table:**
>
> ```bash
> git checkout --detach origin/main
> git cherry-pick <sha>                       # let it conflict
> git diff --name-only --diff-filter=U        # the real file list
> ```
>
> The **commit list** in the left column is sound — it came from the Group-E loop's own log and matches the run. It is the file attribution that decayed, because it was recorded from a resolver's output rather than re-measured. **The ten remaining entries are where this landing's residual risk lives, so the cost of re-deriving them is small against what they are guarding.**

§3's ledger covers Groups A/A′/B and the hand-resolved parts of C. It does **not** have a row for any Group-E conflict. Eleven of the forty Group-E commits conflicted and were resolved by the same per-file script whose defect §4 `D7` describes and whose worst outcome was `#313`. **`#313` is in this list — it is how that bug got in.** Every other entry carries the same risk and none was individually reviewed:

| Commit | PR | Files decided by a blanket per-file pick |
|---|---|---|
| `b50d16c` | `#309` | `src/api/types/api-deps.ts`, `src/server.ts` |
| `2ed1ba0` | `#311` | `CLAUDE.md`, `__tests__/feature-flags.test.ts`, `src/feature-flags.ts` |
| `5079256` | `#312` | `docs/2026-07-30-session-review-consolidation.md` |
| `db00041` | `#313` | `src/pty-manager.ts` — **known casualty, see §6** |
| `e4731c4` | `#319` | `src/server.ts` |
| `c81c914` | `#321` | `src/api/routes/diagnostics.routes.ts` |
| `bd8543e` | `#324` | `src/server.ts` |
| `091ba1d` | `#327` | `src/server.ts` |
| `a8cc014` | `#329` | `src/server.ts` |
| `80a2b40` | `#332` | `__tests__/ci-workflow.test.ts`, `docs/testing/cross-platform-ci.md` |
| `d2fd362` | `#334` | `LANDING-integration-to-main.md` |

Group F adds two more: `9f85ec5` (`#293`, `src/server.ts`) and `342c61c` (`#296`, `src/server.ts`).

~~**Seven** of the thirteen decided `src/server.ts`~~ — **superseded; see the warning at the top of this section.** This count was derived from the file column and inherits its error rate: `#296` was one of the seven and is not a `src/server.ts` entry at all. Re-derive the file list per commit; do not quote a count taken from the table.

**Treat all thirteen as unreviewed** — that part stands, and is now **ten**, with `#313`, `#293` and `#296` reviewed on the real run. `#313` proves the failure is silent under both `tsc` and biome, so re-running the suite is not sufficient to clear them; they need a hunk-level diff against the branch.

One caveat on that, learned from `#296`: whether a bad resolution here is *silent* depends on ordering, not on the resolution. `#296`'s orphaned import failed loudly with `TS2307` only because the module it referenced belongs to a group that had not landed; `D7`'s original casualty stayed green because its module already had. **So a green `tsc` on one of these is not evidence of a good resolution — it may only mean the owning group landed first.** Keep the route-parity sweep.

### 9.2 §8's recommendation to land `#237` last was never executed

§3 concludes that `#237`'s extraction of `reconcileConversationsCacheFromDisk()` collides with `#232`, `#253`, `#234` and `#267`, and §8 tells you to land `#237` *after* all four. **This rehearsal did the opposite** — it followed the runbook and landed `#237` third (`09126d3`, immediately after the two dependabot bumps), then paid the same three-way reconstruction four times.

The recommendation is **inferred from the four conflicts, not validated by a re-run.** It is well-founded — the four collisions are all against the pre-refactor body, so moving the refactor after them should collapse them to zero — but nobody has executed that order. If the real run adopts it and something unexpected falls out, this is why.

### 9.3 "Any order works" in wave 1 is wrong as written

§8's wave 1 says the nineteen independent PRs have no ancestors among the open set, so "any order works". Ancestry-freedom is not conflict-freedom, and this rehearsal disproved it three times: `#257`, `#258` and `#259` all conflicted on `docs/BACKLOG.md` purely because of the order they were landed in, and *which side is "ours"* depends on that order.

It is still safe, because the rule in §3 ("the fixing PR's status line beats `#257`'s status-snapshot line") is order-independent in outcome. But read the claim as "any order is *recoverable*", not "any order is clean". Landing `#257` — the status-snapshot doc — **last** among the wave removes the conflicts entirely, and is the better order.

### 9.4 Judgement calls where the ledger records only the winner

**`#234`'s `withWarmup` (ledger row 8, marked `J`) — runner-up never tested.** `#234` wraps `rescanForRefresh()` in `withWarmup("conversation_refresh", …)`. `#237` had moved that call into a method shared with the routine background path, where gating it would flip the server into `SERVER_WARMING_UP` on every JSONL append — which the integration branch documents as wrong. I dropped the wrap and kept `#234`'s `rejectIfWarmingUp(res)` at the handler entry, asserting that it delivers the same intent.

**RESOLVED 2026-08-01 — the assertion was wrong and the untried runner-up is correct.** This item is
retired, and the answer is the opposite of what was recorded above.

The real run landed `#237` after `#232`/`#253`/`#234`/`#267` per §8, implemented exactly the
resolution recorded here — extraction with no internal gate, relying on `rejectIfWarmingUp(res)` at
handler entry — and **`#234`'s own test failed**:

```
× returns conversation_refresh while an explicit conversation refresh is running
AssertionError: expected 200 to be 503
```

`rejectIfWarmingUp(res)` does **not** deliver the same intent. It rejects requests that arrive
*while* the server is warming up; it does not put the server *into* `conversation_refresh` for the
duration of an explicit `?refresh=1` rebuild, which is the state `#234` exists to report.

**The correct resolution is the runner-up: `withWarmup` on the `bustCache` branch only**, at the call
site rather than inside the extracted method — so an explicit refresh gates and the automatic
freshness path does not. 87/87 of `__tests__/server.test.ts` pass with it. The integration branch
independently shows the same structure (`await this.withWarmup("conversation_refresh", () =>
this.reconcileConversationsCacheFromDisk(…))`), though its version also carries `#271`'s
`onProgress` and `#266`'s `canServeStale`, so follow its shape and not its text.

**How the wrong side got argued for, recorded because the premise is the reusable part.** The case
made for the no-gate version was that it *"changes nothing about warm-up behaviour relative to what
is on `main` and green right now"* — `#234` landed the wrap at two call sites, so keeping both and
adding no internal gate should have been behaviour-preserving. **That premise was never checked, and
it was false:** one of the two wraps was *inside the very block `#237` extracts*, so the extraction
deleted it. `grep -c 'withWarmup("conversation_refresh"'` reads **2** on `main` and **1** after the
extraction. The argument was sound given its premise; nobody verified the premise.

**`#245`'s content inside `#267`'s squash — never verified.** §2 says dropping `#245` "does not remove its content" from `#267`/`#297`/`#299`/`#304`, because it is their ancestor. That follows from the ancestry, but I never inspected what `#267`'s squash actually carried of `#245`. The claim is sound in principle and unchecked in fact.

**`#267`'s mixed-side resolution — checked, and clean.** Row 10 takes the comment from *theirs* and the code from *ours* in the same file, which can leave a comment describing code that is not there. I checked this one afterwards: the comment ("the on-disk reconcile below … stays inside the freeze too") does match the retained code — `refreshConversationCache` sits inside the `else`. Recorded because it was a real risk, not because it went wrong.

**Group C's "fully contained" evidence is relative to the branch, not `main`.** The `git cherry … +0/−0` results in §5/§2 were measured against `origin/integration/missing-prs-2026-07-23`. That is the right question for "is this PR's content on the branch", but it says nothing about `main`, and it is not evidence that the PR can be closed.

### 9.5 Verification that was specified and never run

> ## ⚠ CORRECTED 2026-08-03 — TRUE OF THE REHEARSAL, FALSE OF CI, AND THE NOTE DID NOT SAY WHICH
>
> **The contract and e2e suites run in CI on every PR, across all three Node versions, and always have.**
> `.github/actions/run-ci/action.yml` runs bare `npx vitest run`, so what executes is whatever
> `vitest.config.ts`'s `include` matches — `["__tests__/**/*.test.ts"]`, a recursive glob that covers
> `__tests__/contracts/` and `__tests__/e2e/`. Verified from a CI job log rather than from the config:
> `contracts/mobile-contracts`, `contracts/desktop-contracts`, `contracts/shared-contracts` and
> `e2e/api-e2e` all appear in the output of a green `Test (Node 20)` job; a non-existent control file
> appears zero times. All 189 test files in the repo match the glob; none sit outside it.
>
> **What was true is narrower than what this note says.** The *scripts* `npm run test:contracts` and
> `npm run test:e2e` are invoked by no workflow, and were not run during the rehearsal, which executed
> things locally and ad hoc. Neither fact means the *files* went unexecuted.
>
> **The defect in the note is not the claim, it is the missing population.** "Never run at any point"
> does not say *by whom*, so a reader who arrives with CI in mind inherits a statement that was only ever
> about a local replay. That is how it survived: it was quoted forward six times in the 2026-08-02
> landing as "still never run in either stage", named as the highest-value remaining risk, and amplified
> by a reviewer whose own grep — `test:contracts` appears nowhere in `.github/` — was **correct** and
> answered a different question, because the glob runs the files whether or not the script is named.
>
> **The general form, for the next note of this shape:** a claim true of one population, inherited by a
> reader who applies it to another, is indistinguishable from a claim that is simply true. State the
> population, or the claim will be re-scoped by whoever reads it next.
>
> What survives: the wiring is **implicit**. Narrow the glob or add an `exclude` and both suites stop
> running silently while the scripts still exist and still pass by hand. `__tests__/ci-workflow.test.ts`
> now pins it, validated by narrowing the glob and by adding an exclude, red in both directions.

The runbook's Verification section asks for these on contract-touching or end-to-end PRs. **Neither script was invoked during this rehearsal:**

```bash
npm run test:contracts
npm run test:e2e
```

`#267` (`session_name`), `#299` (terminal `seq`) and `#282` (provider capabilities) all change the tb-mobile-facing contract, and `docs/compatibility/tb-mobile.md` was touched by several landed commits. Contract drift is the one risk class this rehearsal did nothing about.

Likewise, **the cross-platform smoke matrix was never exercised.** Everything here ran on macOS only. `#340` and `#333` exist precisely to make Windows and macOS failures visible, `#272` is a Windows updater fix, and `#332`/`#337` are Windows ConPTY work — none of it was tested. `__tests__/pty-host-survival.test.ts` is one of the two new failing files, and it is exactly the kind of thing the matrix is for.

### 9.6 Smaller things worth knowing

- **The `#223` TypeScript 7 bump was landed but never compiled under TypeScript 7** (§4 `D10`). It sits on the trunk influencing nothing, because `node_modules` held 6.0.3 throughout.
- **`__tests__/server.test.ts`'s +162-line residual (§6 row 4) was never diffed hunk-by-hunk.** It is attributed to `D7` on the strength of the pattern, not on an inspection of which tests are missing.
- **The final trunk was never booted.** `node dist/cli.cjs serve` was not run; the runbook's post-landing "confirm `main` runs" step and the tb-mobile pairing check are both untouched.
- **Group B's four PRs were recovered from their branch tips on the assumption that the tip is the whole PR.** `gh pr view` confirmed one commit each for `#271`/`#273`/`#274`, and for `#275` that only `d11734c` of its 33 commits is its own. That is measured, not assumed — but it depends on `gh`'s commit list for *closed* PRs being complete, which was not independently checked.
