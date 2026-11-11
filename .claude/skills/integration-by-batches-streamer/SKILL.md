---
name: integration-by-batches-streamer
description: The tb-streamer half of landing open PRs in QA-gated batches: the QA targets (this machine or the demo Fly app), the gate commands, the subsystem seams, and how a PR lands here (release-commit wait, hooksPath rebase, check matrix). Use together with the shared `threadbase-skills:integration-by-batches` when the user says "batch the open PRs", "integrate in batches", "group the PRs and QA each group", or "bulk process the PRs" in this repo.
---

# Integration by batches (tb-streamer)

Read the shared `threadbase-skills:integration-by-batches` first (install: [docs/agents/tooling.md](../../../docs/agents/tooling.md)). It holds the hard rules, the step order, the plan and log files, the grouping questions, the QA-findings checklist and the report format. This file states only what differs in this repo; where it is stricter, follow it.

Reuse `integration-branch` for the mechanics: `~/dotfiles/ai-tools/claude/skills/integration-branch/SKILL.md`.

Never push to `main`, never merge a PR unasked, never delete a branch unasked. `CLAUDE.md` ("Merging PRs", "Never push to main") stays canonical.

## Rules that differ from the shared core

- **The integration branch never reaches `origin`, and neither does a tag.** Both QA targets deploy from the batch worktree. Prove it before every report: `git ls-remote --heads origin "integration/*" | wc -l` → `0`.
- **The repo is public.** No real hostname, tunnel host, token or LAN address in a plan, log excerpt, fixture or PR comment (`CLAUDE.md` "This repository is public").

## What differs from mobile

| | tb-mobile | tb-streamer |
|---|---|---|
| QA artifact | a signed build on a device, via `qa.yml` + a pushed test tag | the batch worktree deployed **locally** (`local-deploy`) or to the **demo Fly app** (`npm run deploy:fly`); no tag |
| "Affects the binary?" | decides if a device QA build is needed | decides if **mobile QA** is needed: does it change the wire contract, a status/event, or PTY/session behaviour? If not, CI alone |
| Release | per-deploy | semantic-release on every `feat:`/`fix:` merge, 1–3 min after the squash |
| Gate | shard manifests, pods | `npm run lint && npm test`, on the Node in `.nvmrc`; prod Fly is never a QA target |

## Step 0 — extra reads

- **A `DIRTY` PR means CI never ran** (only Snyk reports when the merge ref is missing): count check names, not conclusions.
- **Stacked PRs** (base is another PR's branch) are a forced order — A before B. They also refuse `gh pr merge`; use `gh stack merge <pr>`.
- **Read tb-mobile's open PRs too** (`gh pr list --repo RonenMars/threadbase-mobile`). Pair by the **endpoint or field actually called** (`rg` `../tb-mobile/services/api-client.ts`), never by feature name.
- **Existing worktrees are other sessions' work.** `git worktree list` before cutting anything; many open PRs already have one under `../tb-streamer-worktrees/`. Reuse a PR's worktree for read-only inspection, never edit it.

## Step 1 — streamer seams

Subsystem seams that held in this repo: PTY/turn detection per provider (`pty-manager.ts`, `codex-pty-runner.ts`, `cursor-pty-runner.ts`, copilot), session lifecycle/persistence (`session-store.ts`, `db/runtime-store.ts`), API routes/auth (`api/`), conversation cache/watcher, relay, lifecycle/deploy scripts, docs.

- **Provider runners are the dangerous overlap.** `pty-manager.ts` and the Codex/Cursor/Copilot runners deliberately duplicate helpers; a PR touching one often needs the sibling. Check before splitting.
- **Two storage PRs in one bulk:** runtime-store migrations are numbered files tracked by *filename*, so either order works, but the second to merge needs a rebase of `__tests__/runtime-store.test.ts`. Never add device columns to `011`.
- **Docs-only PRs skip CI by their diff** (`.github/ci-skip-paths.txt`); no title tag is needed or read.
- **`@types/*` bumps that rename imported types and test-runner majors get their own batch,** alone and last (`docs/troubleshooting.md`). Dependabot lockfile-only bumps can share one.
- **Does anything change behaviour a phone or the menubar can see?** If not, CI only — no mobile QA.

## Step 3 — building the batch

- Worktree path: `../tb-streamer-worktrees/int-<date>-bN`. **`npm ci` in the worktree** (a symlinked or inherited `node_modules` breaks vitest resolution).
- **Use the Node in `.nvmrc`** (`better-sqlite3` ABI mismatches fail unrelated to the change).
- **Run vitest to a file, in full** (`> out.txt 2>&1`); `| tail` hides the failure list. Do not parallelize the suite: tests boot real servers and starve each other. Triage by failure kind and check the host's load first.
- **A negative test needs a seen failure.** A `.toBe(false)` that has never gone red proves nothing.
- **`git pull` does not refresh `node_modules`.** After a dependency-affecting rebase, `npm ls --depth=0` and `npm ci`.

## Step 4 — validate

`npm run lint && npm test` on the baseline and on the batch; compare the **delta**. Add `npm run build` for anything touching `src/db/migrations`, `runtime-migrations` or tsup externals, and `npm run check` for the wider gate. A docs/tooling batch is validated by CI plus one local run of its own tooling (e.g. the link checker).

Open the plan with the decisions the user must answer: drafts, which phone/mobile build to QA with, which QA target, and whether replacing the local prod service is acceptable (Step 5).

## Step 5 — deploy to QA, then STOP

QA is the batch build running as the server a phone talks to. **Ask which target**, never assume:

| Target | Command (from the batch worktree) | Use for | Cost |
|---|---|---|---|
| **This machine** | the `local-deploy` skill (`npm run deploy`) | anything touching real providers, PTY, gates, push, the cache, migrations | replaces the local prod service and **kills live sessions**; migrations run on real `~/.threadbase/` data |
| **Demo Fly** | `npm run deploy:fly` (demo is the default) | API, auth, routes, pairing, relay, mobile degrade-paths, docs | none locally; stub + seed data, **no real agent CLI** |

- **Never `--prod` on Fly.** `threadbase` is the always-on production app; QA does not go there.
- **Demo builds the `demo` Docker stage** (stub + seed). It cannot show Claude/Codex/Cursor/Copilot screen behaviour — a PTY/turn/gate PR must be QA'd on this machine with the real CLI; say which CLI version, and record unverified providers as unverified.
- **Fly deploys what is in the worktree** (`fly deploy --remote-only`), so run it from the batch worktree, on a clean tree (the script refuses a dirty one; don't reach for `--force`). The demo app is shared: a deploy replaces whatever the last one put there, so say so if someone else may be using it. It sleeps when idle, so the first request cold-starts.
- **Local deploy checklist (`local-deploy` skill):** count live sessions and tell the user before deploying; say the batch's migrations will run against real data; after the batch is approved and landed, redeploy `main` so prod is not left on an integration build.
- **A QA deploy is a plain deploy from a clean tree.** `--force`, `--skip-tests` or a `/healthz` reporting `dirty: true` means the build is not what will merge (shared hard rule 10); fix the tree, then deploy. Never `--clear-logs`: the logs are the QA evidence. After a deploy, confirm the launchd service is loaded and the sessions that were live came back.
- **QA is not development.** A defect found in QA becomes its own PR for a later batch (shared Step 6); this batch's scope stays as frozen. One QA run in October grew four new PRs and six redeploys before its first merge.
- **Reaching the phone:** local goes through the user's usual tunnel/LAN, demo through its Fly URL. Don't print hostnames, API keys or device tokens into the report — say "the usual tunnel" / "the demo app". Demo secrets are covered in `docs/guides/fly.md`; never print them.
- **Pin the build to the batch** in the log: target, tip SHA, deployed version (`/healthz` `version`), deploy time, worktree, and one `qa_head` line per PR (shared Step 5). Answer "what is deployed?" from `/healthz` and that log row, not from memory.

### Pairing with a mobile bulk

- A pair is **server half + client half behind a capability flag** (`GET /api/info` reports `savedItems`, `recentDirs`; `/api/providers` health reports `capabilities.multiDirectory`). Mobile is inert until the flag appears, so the server half can land first without a visible change.
- **Compatibility is advisory, not a gate.** *Additive* (new optional field/endpoint/event) → no check. *Rename, removal, changed status vocabulary* → `rg -n "<identifier>" ../tb-mobile/{services,hooks,stores,components,types}`, **report file:line and whether the call site is in a shipped build, then proceed.** Statuses that must not be reused with new meaning: `running`, `waiting_input`, `completed`, `failed`, `on_hold`, `idle`.
- **Mobile can scrape the screen itself.** A card on the phone does not prove the streamer sent one; grep the broadcast log before crediting a PR.

### Cross-repo batch alignment

Run Step 0 on both repos, then cut streamer and mobile batches so every pair (matched by the endpoint or field actually called) sits in matching batches. List each pair in the plan: streamer PR, mobile PR, the call that links them, which side lands first. If a mobile batch needs a streamer PR from a later batch, pull that PR forward or defer the mobile PR; say which. The checkpoint report names both builds: streamer target, tip SHA, version, and the mobile tag/run id. Record both squash SHAs in one log row. A streamer batch with no mobile counterpart needs no phone QA beyond what Step 1 says; state "no counterpart" in the plan.

## Step 6 — streamer additions to QA findings

**Fixtures from raw bytes, not a printed view.** A blank-stripped print became a fixture and shipped an inert detector; generate from the raw capture and pin its shape.

## Step 7 — landing here

`main` is protected with strict status checks, and a `feat:`/`fix:` merge moves the trunk twice (the squash plus `chore(release)`). Land each PR with the shared `land-pr.sh`, one at a time in plan order, from the PR's worktree, on the Node in `.nvmrc`:

```bash
LAND_REBASE_ARGS=--ignore-date <skill-dir>/land-pr.sh <pr> --log <log> \
  --min-checks 9 --after <previous PR's squash sha> --test "npm ci && npm run lint && npm test"
```

- `--min-checks 9` is the matrix: Gate, Setup, Lint, Build, Test ×3, both Smoke. A `DIRTY` PR reports Snyk alone, which the count refuses.
- `--after` waits for the release commit that the previous `feat:`/`fix:` squash triggers (1–3 min). Rebasing before it lands burns a second CI cycle.
- `--ignore-date` keeps commit dates current.
- `core.hooksPath=scripts/git-hooks` rebases again on push, so the SHA GitHub holds differs from the local one. The script reads GitHub's head and compares patches, not SHAs.
- Stacked PRs (`gh stack`): retarget children before the parent lands (the script refuses with `CHILDREN`). A child whose base already squash-merged needs `git rebase --onto origin/main <old-base-sha>` first.
- **Issue status updates.** Each landed PR traceable to an issue ends with the issue closed or commented (`CLAUDE.md` "Issue status updates"). `Closes #N` in a body is a closing keyword even when negated ("does not close #N" still closes it); use a bare reference when it must stay open.
- After the last PR: verify `main` is green, then redeploy `main` to whichever QA target ran the batch. This is part of landing, not an optional extra.

The dependabot trap applies, and `land-pr.sh` returns `HELD` on it. In October a deploy carried grpc 1.14.6 while its PR had moved to 1.14.7, and it merged anyway. That kind of mismatch is a hold.

## Step 9 — cleanup

Most of `../tb-streamer-worktrees/` belongs to other sessions; remove only what this run created. Also verify neither the local service nor the demo app is left running an integration build: `/healthz` `version` is a release and `dirty` is false.

## Traps that recurred

| Trap | Guard |
|---|---|
| "Never push the branch" vs needing something to QA | deploy from the worktree (local or `deploy:fly`); nothing is pushed |
| Every PR already `BEHIND` before any merge | budget one rebase + CI cycle per PR, after the release commit |
| `git` and `grep` are shell functions | call `/opt/homebrew/bin/git`, run multi-item logic as a `bash` script |
| Local QA deploy replaces prod and kills live sessions | count, tell the user, redeploy `main` after |
| Demo Fly used to QA provider behaviour | it is stub + seed; use the local deploy |
| `npm run deploy:fly -- --prod` for QA | never |
| A 1Password SSH signer waiting overnight stalled landing for ~11 h | `land-pr.sh --preflight` before leaving a landing run |
| Windows Smoke red on `main` for a day, unreported | the shared CI-red line in every status |
