---
name: integration-by-batches
description: Group tb-streamer's open PRs into medium-sized, independently testable batches, build one local integration branch per batch, validate it, deploy it for QA (this machine or the demo Fly app), STOP for explicit QA approval, then land that batch's PRs one at a time (rebase + squash) before starting the next batch. Use when the user says "batch the open PRs", "integrate in batches", "group the PRs and QA each group", "bulk process the PRs", or when one big integration branch would make a QA failure impossible to attribute. Sibling of `integration-branch` (one branch, all PRs); this one trades breadth for attribution.
---

# Integration by batches (tb-streamer)

`integration-branch` merges *every* PR into one branch. When QA finds a defect in that branch you cannot
say which PR caused it. This skill cuts the open PRs into **batches of related PRs**, QAs each batch alone,
and lands it before the next one starts. Origin: a 24-PR, 8-batch run on tb-mobile (2026-10-03 → 10-08);
this is the streamer's version of it, and it differs where the streamer differs (see "What differs from mobile").

Reuse `integration-branch` for the mechanics it already proves (worktree, push guard, per-PR rebase +
`merge --no-ff`, sweeps, cleanup). This file only states what differs and what the batched run taught.
Read it first: `~/dotfiles/ai-tools/claude/skills/integration-branch/SKILL.md`.

Never push to `main`, never merge a PR unasked, never delete a branch unasked. The repo rules in
`CLAUDE.md` ("Merging PRs", "Never push to main") stay canonical.

## Hard rules

1. **Nothing merges to `main` before that batch's explicit QA approval.** Not a green CI, not a quiet user.
2. **One batch at a time.** Do not build, run or merge batch N+1 until batch N is approved *and* landed.
3. **Never combine unrelated PRs to lower the batch count.** A batch is a unit of attribution.
4. **Never decide a product question silently.** Conflicts that are an either/or about behaviour (J-calls)
   stop the run and are put to the user with the options.
5. **The integration branch never reaches `origin`.** Both QA targets deploy from the batch worktree, so unlike
   mobile there is no reason to push a branch or a tag. Prove it before every report:
   `git ls-remote --heads origin "integration/*" | wc -l` → `0`.
6. **Never commit the plan or the log.** They are working notes. Keep them outside any repo.
7. **Preserve each PR's own history.** Land PRs individually; the batch branch is a test artifact only.
8. **Evidence over assumption.** Repo, CI and test output decide. Say "not verified" when it is not.
9. **The repo is public.** No real hostname, tunnel host, token or LAN address in a plan, log excerpt, fixture
   or PR comment (`CLAUDE.md` "This repository is public").

## What differs from mobile

| | tb-mobile | tb-streamer |
|---|---|---|
| QA artifact | a signed build on a device, via `qa.yml` + a pushed test tag | the batch worktree deployed **locally** (`local-deploy`) or to the **demo Fly app** (`npm run deploy:fly`); no tag |
| "Affects the binary?" | decides if a device QA build is needed | decides if **mobile QA** is needed: does it change the wire contract, a status/event, or PTY/session behaviour? If not, CI alone |
| Release | per-deploy | semantic-release on every `feat:`/`fix:` merge, 1–3 min after the squash |
| Gate | shard manifests, pods | `npm run lint && npm test`, on the Node in `.nvmrc`; prod Fly is never a QA target |

## Step 0 — Read the world, in both repos

```bash
git fetch origin --prune && git rev-parse --short origin/main        # state this SHA
gh pr list --state open --json number,title,headRefName,baseRefName,isDraft,headRefOid
```

- **Per-PR, never bulk:** a list query returns `mergeable: UNKNOWN` for almost every row. Run
  `gh pr view <n> --json mergeable,mergeStateStatus,isDraft` per PR.
  `gh api repos/<o>/<r>/pulls/<n> --jq .mergeable_state` forces the recompute.
- **A `DIRTY` PR means CI never ran** (only Snyk reports when the merge ref is missing): count check names,
  not conclusions.
- **Stacked PRs** (base is another PR's branch) are a forced order — A before B. They also refuse
  `gh pr merge`; use `gh stack merge <pr>`.
- **Read tb-mobile's open PRs too** (`gh pr list --repo RonenMars/threadbase-mobile`). A cross-repo dependency
  is often declared on *one* side ("Land this streamer PR first"). Pair by the **endpoint or field actually
  called** (`rg` `../tb-mobile/services/api-client.ts`), never by feature name.
- Capture each PR's file set: `gh pr diff <n> --name-only`. Overlaps drive the grouping.
- **Existing worktrees are other sessions' work.** `git worktree list` before cutting anything; many open PRs
  already have one under `../tb-streamer-worktrees/`. Reuse the PR's worktree for read-only inspection, never
  edit it.
- **Re-scan before acting.** A plan older than a day is a hypothesis.

## Step 1 — Group

Group by **subsystem + shared files**, then check each group against four questions:

| Question | If "no" |
|---|---|
| Can one QA pass of one flow (start, resume, a question card, a push) cover the whole batch? | split it |
| Do the PRs share files (so rebasing separately costs the same conflicts)? | they probably belong together |
| Would a failure be attributable to a PR or a small pair? | split it |
| Does anything in it change behaviour a phone or the menubar can see? | if not, it needs CI only — no mobile QA |

Subsystem seams that held in this repo: PTY/turn detection per provider (`pty-manager.ts`,
`codex-pty-runner.ts`, `cursor-pty-runner.ts`, copilot), session lifecycle/persistence (`session-store.ts`,
`db/runtime-store.ts`), API routes/auth (`api/`), conversation cache/watcher, relay, lifecycle/deploy scripts,
docs.

Rules of thumb:

- **Forced pairs:** two PRs rewriting the same runner and its tests cannot be separated across batches
  without one going `DIRTY`. Keep them together, and keep them *out of* a larger batch if their conflict is a
  product question — it should fail in a 2-PR batch, not a 6-PR one.
- **Provider runners are the dangerous overlap.** `pty-manager.ts` and the Codex/Cursor/Copilot runners
  deliberately duplicate helpers; a PR touching one often needs the sibling. Check before splitting.
- **Two storage PRs in one bulk:** runtime-store migrations are numbered files tracked by *filename*, so either
  order works, but the second to merge needs a rebase of `__tests__/runtime-store.test.ts`. Never add device
  columns to `011`.
- **A "docs/tooling" batch is legitimate** even when the PRs are unrelated, if none affects behaviour and the
  files are disjoint. Docs-only PR titles carry `[skip-ci]`.
- **Dependency bumps:** `@types/*` bumps that rename imported types and test-runner majors get their own batch,
  alone and last (`docs/troubleshooting.md`). Dependabot lockfile-only bumps can share one.
- **Order batches:** behaviour first (conflict-dense PRs go stale fastest), docs/tooling next, deps last.
- **Drafts are the user's call.** List them and ask. A draft cannot be squash-merged; that stop is the author's.
- **Hold, don't merge, any PR with an unresolved security finding.** Report it; don't repair someone's PR
  without approval of the exact diff, and rebuild the batch without it.

## Step 2 — Write the plan, then wait

Write `<date>-batched-qa-plan.md` **outside any repo** with: the PR table (PR, title, subsystem, key files),
the overlap list, the ordering constraints, one block per batch (**goal · PRs in order · why together · order
rationale · QA scenarios · risks**), the execution table (batch, PRs, mobile QA?, cross-repo dependency,
blocking?), and the stop-and-ask list. Open with the decisions the user must answer (drafts, which phone/mobile
build to QA with, which QA target, and whether replacing the local prod service is acceptable — see Step 5). **Send it and stop.** A local rehearsal is
neither a QA deploy nor a merge and may start early; deploying may not.

Keep a second file, the **engineering log** (`<date>-batched-qa-log.md`): §1 artifacts (every worktree,
branch, ref, with created/removed), §2 baseline, §3 scope, §4 order/constraints, §5 timestamped actions,
§6 per-PR records (head before → rebased to → tip after), §7 conflicts (M mechanical / J judgment), §8
sweeps, §9 obstacles & numbered findings, §10 checkpoints, §11 decisions (who, why). Append after every
action; obstacles are the first thing memory loses. Concise facts, no chain-of-thought.

## Step 3 — Build the batch (local)

Per `integration-branch`: fresh worktree **at an absolute path outside the repo**
(`../tb-streamer-worktrees/int-<date>-bN`), `git fetch` immediately before the cut, push guard armed
(`branch.<b>.pushRemote=no_push_integration_branch`), **`npm ci` in the worktree** (a symlinked or inherited
`node_modules` breaks vitest resolution), **baseline on untouched `main` first**, PR heads fetched to
`refs/integration/pr/<n>`, each PR rebased onto the tip then `merge --no-ff`, one at a time.

- **Use the Node in `.nvmrc`** (`better-sqlite3` ABI mismatches fail unrelated to the change).
- **A clean three-way merge is the case that produces wrong code silently.** Hand-read the composed result
  for any file touched by 2+ PRs (is each PR's addition *defined and wired*?). Log "checked, clean".
- **Suite counts:** reconcile new test files with `git diff --name-status` (`A` files).
- **Run vitest to a file, in full** (`> out.txt 2>&1`); `| tail` hides the failure list. Do not parallelize
  the suite: tests boot real servers and starve each other. Confirm any failure alone (`npx vitest run <file>`)
  before classifying: passes alone = load artifact, fails alone = real. Triage by failure kind and check the
  host's load first.
- **A negative test needs a seen failure.** A `.toBe(false)` that has never gone red proves nothing.
- **Re-verify head SHAs** of every PR before each (re)build; a moved head invalidates that PR's record only.
- **`git pull` does not refresh `node_modules`.** After a dependency-affecting rebase, `npm ls --depth=0` and
  `npm ci`.

## Step 4 — Validate

`npm run lint && npm test` on the baseline and on the batch; compare the **delta**, not the absolute. Add
`npm run build` for anything touching `src/db/migrations`, `runtime-migrations` or tsup externals, and
`npm run check` for the wider gate. A docs/tooling batch is validated by CI plus one local run of its own tooling
(e.g. the link checker).

## Step 5 — Deploy to QA, then STOP

QA is the batch build running as the server a phone talks to. **Ask which target**, never assume:

| Target | Command (from the batch worktree) | Use for | Cost |
|---|---|---|---|
| **This machine** | the `local-deploy` skill (`npm run deploy`) | anything touching real providers, PTY, gates, push, the cache, migrations | replaces the local prod service and **kills live sessions**; migrations run on real `~/.threadbase/` data |
| **Demo Fly** | `npm run deploy:fly` (demo is the default) | API, auth, routes, pairing, relay, mobile degrade-paths, docs | none locally; stub + seed data, **no real agent CLI** |

- **Never `--prod` on Fly.** `threadbase` is the always-on production app; QA does not go there.
- **Demo builds the `demo` Docker stage** (stub + seed). It cannot show Claude/Codex/Cursor/Copilot screen
  behaviour — a PTY/turn/gate PR must be QA'd on this machine with the real CLI; say which CLI version, and
  record unverified providers as unverified.
- **Fly deploys what is in the worktree** (`fly deploy --remote-only`), so run it from the batch worktree, on a
  clean tree (the script refuses a dirty one; don't reach for `--force` to get around it). The demo app is shared:
  a deploy replaces whatever the last one put there, so say so if someone else may be using it. It sleeps when
  idle, so the first request cold-starts.
- **Local deploy checklist (`local-deploy` skill):** count live sessions and tell the user before deploying;
  say the batch's migrations will run against real data; after the batch is approved and landed, redeploy `main`
  so prod is not left on an integration build.
- **Reaching the phone:** local goes through the user's usual tunnel/LAN, demo through its Fly URL. Don't print
  hostnames, API keys or device tokens into the report (the repo is public) — say "the usual tunnel" / "the demo
  app". Demo secrets are covered in `docs/guides/fly.md`; never print them.
- **Pin the build to the batch** in the log: target, tip SHA, deployed version (`/healthz` `version`),
  deploy time, worktree. At the start of every QA conversation re-establish *which build is running* before
  reading any result as a verdict on the batch.
- **A pair is satisfied by a binary, not a merge.** The mobile half is QA'd against a streamer deployed from the
  server PR's branch; ask what is running before declaring a batch blocked.
- Report: batch, target, tip SHA, version, PRs, what to test (the plan's scenarios), caveats. **Stop and wait.**

### Pairing with a mobile bulk

- A pair is **server half + client half behind a capability flag** (`GET /api/info` reports `savedItems`,
  `recentDirs`; `/api/providers` health reports `capabilities.multiDirectory`). Mobile is inert until the flag
  appears, so the server half can land first without a visible change.
- **Compatibility is advisory, not a gate.** *Additive* (new optional field/endpoint/event) → no check.
  *Rename, removal, changed status vocabulary* → `rg -n "<identifier>" ../tb-mobile/{services,hooks,stores,components,types}`,
  **report file:line and whether the call site is in a shipped build, then proceed.** A hit is information, never
  a reason to block or rewrite the PR. Statuses that must not be reused with new meaning: `running`,
  `waiting_input`, `completed`, `failed`, `on_hold`, `idle`.
- **QA the pair both ways** — new client on old server, old client on new server. For paired fixes, QA the
  **degrade-gracefully half first, against the unfixed counterpart**; against the fixed one the symptom is gone
  before the guard runs. Land the server half afterwards.
- **Mobile can scrape the screen itself.** A card on the phone does not prove the streamer sent one; grep the
  broadcast log before crediting a PR.

## Step 6 — Handling QA findings

1. **Is the code path in the batch's file set?** `git diff --name-only <main>..<batch>` before accepting a
   finding against a batch.
2. **Cheap proof a defect predates the batch:** `git log <deployedSha>..<head> -- <paths>` and `git diff` over
   the same paths both empty → it is on `main`, not the batch.
3. A genuine `main` defect becomes its **own PR**, not a patch inside the batch. Trace it to `file:line`; fix
   the **root cause** where all callers route.
4. **Mutation-check every guard test:** revert the fix, confirm red, restore. A test that cannot fail is
   deleted. Test at the layer where the mechanism lives.
5. **A shared mock that degrades every dependency uniformly removes the asymmetry a bug lives in.** Model the
   healthy case explicitly.
6. **Fixtures from raw bytes, not a printed view.** A blank-stripped print became a fixture and shipped an inert
   detector; generate from the raw capture and pin its shape.
7. QA failure → nothing merges; diagnose, update the integration branch, rebuild, rerun.

## Step 7 — Land the batch (only on explicit approval)

`main` is protected with strict status checks: **every merge makes every remaining PR `BEHIND`**, and a
`feat:`/`fix:` merge moves the trunk twice (the squash plus `chore(release)`). Per PR, in plan order, one at a
time:

1. Confirm `OPEN`, not draft, and that the head SHA equals the recorded one (a moved head is **held**).
2. **Wait for the previous merge's `chore(release): x.y.z [skip ci]` commit** on `origin/main` (1–3 min; poll
   `git fetch` + `git log origin/main -3`) — rebasing before it lands burns a second CI cycle. Then rebase onto
   current `origin/main` in the PR's own worktree, re-run the PR's own tests, push with
   `--force-with-lease=refs/heads/<b>:<old-sha>` and an explicit refspec. Commit dates must be current
   (`rebase --ignore-date`) and a pushed PR branch needs the user's confirm.
3. **`core.hooksPath=scripts/git-hooks` rebases onto `origin/main` on push**, so SHAs come back different.
   Verify content with `git diff <base> <head> | git patch-id --stable`, not SHA equality. A branch stacked on
   another PR needs `git rebase --onto origin/main <old-base-sha>` once its base has squash-merged.
4. **Wait and merge in ONE loop iteration:** poll `gh pr checks <n> --json name,bucket` until **0 pending** and
   the full matrix is present (a queued check has a null conclusion *and* null state — unknown counts as
   pending; Gate, Setup, Lint, Build, Test ×3, both Smoke), refuse on any fail/cancel, read
   `gh api repos/<o>/<r>/pulls/<n> --jq .mergeable_state`, and if `behind` exit `STALE` (rebase again) — else
   `gh pr merge <n> --squash [--match-head-commit <sha>]` immediately. A green `security/snyk` alone is not a
   passing suite. Re-run a flaky red **once**, then stop.
5. **Verify the merge, not the exit code:** `gh pr view <n> --json state,mergedAt` and
   `gh api .../pulls/<n> --jq '"merged=\(.merged) \(.merge_commit_sha)"'`. `gh pr merge` can print
   `failed to run git` and have merged anyway, or not.
6. **Squash defeats ancestry checks.** `--is-ancestor <branch>` reads "unmerged" for every landed branch; test
   content with `git diff --numstat origin/main <branch>`.
7. **Branch delete:** the repo auto-deletes merged heads, so `--delete-branch` errors afterwards (harmless).
   Gate any manual delete on `gh pr view <n> --json state` = `MERGED` — deleting after a *refused* merge
   **closes the open PR**. Check `gh pr list --state open --json number,baseRefName` for PRs based on the branch
   first; deleting a base closes its children.
8. **Issue status updates.** Each landed PR traceable to an issue ends with the issue closed or commented
   (`CLAUDE.md` "Issue status updates"). `Closes #N` in a body is a closing keyword even when negated
   ("does not close #N" still closes it) — use a bare reference when it must stay open.
9. Stop and report (don't retry blindly) on: red CI, a conflict with no recorded resolution, a moved head, a
   step hanging past ~4 minutes, any unexpected error.
10. After the last PR: verify `main` is green, redeploy `main` to whichever QA target ran the batch, then clean up (Step 9).

For a pair, land in the order the pair rule says and record both PR numbers, squash SHAs and the running QA
build in one log row. The dependabot trap: after `main` moves, a bot may rewrite its branch and retarget a
newer/major version. Compare head, net changed lines and version strings; **hold** on any difference.

## Step 8 — Next batch

Re-fetch `main`, **re-scan open PRs in both repos**, re-validate the next batch's plan (new PRs may now contend
for its files — cost of delay compounds), rebuild it on the new `main`, repeat from Step 3.

## Step 9 — Cleanup (list first, approval, then delete)

Inventory from log §1 + `git worktree list`: worktrees, local integration/scratch branches,
`refs/integration/pr/*`, untracked docs (ask). Exclude any worktree with uncommitted/unpushed work and any this
run did not create — most of `../tb-streamer-worktrees/` belongs to other sessions. `git worktree remove`
(never `rm -rf`), `git branch -D` only for approved branches, `git update-ref -d`, `git worktree prune`. Verify
`git ls-remote --heads origin "integration/*"` → `0`, and that neither the local service nor the demo app is left running an integration build (redeploy `main` to whichever you used).

## Traps that recurred

| Trap | Guard |
|---|---|
| "Never push the branch" vs needing something to QA | deploy from the worktree (local or `deploy:fly`); nothing is pushed |
| Bulk `mergeable` → `UNKNOWN` | per-PR query; REST API forces recompute |
| Every PR already `BEHIND` before any merge | budget one rebase + CI cycle per PR, after the release commit |
| `gh` exit status ≠ merge landed | read PR state |
| Squash commit is tautologically an ancestor | content diff, not `--is-ancestor` |
| zsh does not word-split unquoted vars; `git` and `grep` are shell functions | run multi-item logic as a `bash` script, call `/opt/homebrew/bin/git` |
| Local QA deploy replaces prod and kills live sessions | count, tell the user, redeploy `main` after |
| Demo Fly used to QA provider behaviour | it is stub + seed; use the local deploy |
| `npm run deploy:fly -- --prod` for QA | never |
| Re-keying a plan by PR number across days | PR numbers are stable; heads and `main` are not — re-scan |

## Report format (every checkpoint)

Batch · QA target · integration tip SHA · deployed version · PRs in order · lint/test delta vs baseline · what to
test · caveats/holds · **the decision needed from the user, stated plainly**. Link PRs as full URLs.
