# Prompt — stop Windows smoke regressions merging silently

Paste everything below the line into a fresh session.

---

Make a Windows regression in the `smoke` CI job impossible to merge without someone noticing. Repo: `/Users/ronenmars/dev/ai-tools/tb-streamer`. Read `AGENTS.md` and `CLAUDE.md` first — their conventions are binding.

## The problem

`.github/workflows/ci.yml`, the `smoke` job:

```yaml
    # Informational while the platforms are being qualified: a genuine
    # cross-platform failure should surface loudly without blocking every merge
    # before the baseline is known green. Flip to required once it has proven
    # stable — tracked in docs/testing/cross-platform-ci.md.
    continue-on-error: true
```

That comment describes a deliberate, temporary state, and the condition it names has now been met: PR #332 (plan Phase 6e) added real Windows coverage — a named-pipe transport suite and a ConPTY lifetime probe — and qualified it against `windows-latest`.

The cost of leaving it: a red Windows job still reports the *check* as successful, so `mergeStateStatus` stays `CLEAN` and a genuine regression merges with nothing objecting. This is not hypothetical — during #332 the Windows job went red on a real defect (a POSIX-only guard in `listenForStreamers` surfacing a raw `EADDRINUSE`), and only a deliberate read of the runner log caught it.

## Facts already established — do not re-derive

- The full suite (`Test (Node 20/22/24)`) runs on **ubuntu-latest only**. `smoke` is the *only* macOS and Windows coverage.
- **`main` has no branch protection** (`gh api repos/RonenMars/threadbase-streamer/branches/main/protection` → `Branch not protected`). There are no required status checks on any branch. So removing `continue-on-error` changes **visibility**, not enforcement: the job turns the PR `UNSTABLE` instead of `CLEAN`, which is enough for a workflow that waits for `CLEAN` before merging, but it does not *block* anything.
- Recent history over the last 12 CI runs: **11 success, 1 failure** on `Smoke (windows-latest)` — and that one failure was a true positive, not a flake.

## The judgement call this needs — do not skip it

That 11/12 is misleading on its own, and this is the crux of the task.

Most of those passing runs predate #332, when `test:smoke` was six fast, pure, platform-independent files. #332 added `__tests__/pty-host-process.test.ts` and `__tests__/pty-host-windows.test.ts`, which bind real sockets and named pipes, spawn a detached process, and poll a file for ~5.4 s with a 20 s timeout. Those have **roughly one run of Windows history**.

So do not simply delete the line. Instead:

1. **Measure the new smoke set specifically.** Look at `Smoke (windows-latest)` and `Smoke (macos-latest)` only for runs *after* the pty-host tests entered `test:smoke`. Report the actual counts. If there are fewer than ~5 clean runs on each platform, say so plainly and recommend waiting rather than flipping on a sample of one.
2. **Then choose, and justify it in the PR:**
   - *Flip it* — remove `continue-on-error`, if the new set looks stable.
   - *Split it* — keep one informational job for the timing-sensitive pty-host tests and promote the stable subset, if the evidence says the new tests are the flaky part. A partial gate that people trust beats a full gate they learn to ignore.
   - *Wait* — leave it and record what evidence would settle it. This is a legitimate outcome; say so if that is what the data supports.

Whichever you pick, the deciding factor is: **a gate that flakes gets ignored, and an ignored gate is worse than an honest informational job.** Do not optimise for looking strict.

## Also required

- **Update `docs/testing/cross-platform-ci.md`.** It explicitly tracks this decision ("Flip to required once it has proven stable — tracked in …"), so leaving it stale would strand the reasoning. Record what was measured, what was decided, and why.
- **Update the `smoke` job comment** in `ci.yml` to describe the new state rather than the old intent.
- **Add an assertion in `__tests__/ci-workflow.test.ts`** pinning whatever you decide. That file already asserts the platform matrix and `fail-fast: false`; there is currently **no** assertion covering `continue-on-error`, which is why this drifted unnoticed. Pin it so a future edit has to be deliberate.
- **Mention branch protection in the PR description** as the remaining gap: without required status checks on `main`, this is a strong signal rather than a hard block. Configuring that is a repo-admin action — flag it, do not attempt it.

## Working agreement

- Base on `integration/missing-prs-2026-07-23` and target it with `gh pr create --base integration/missing-prs-2026-07-23`. Fetch first; the tip moves.
- Work in your own git worktree under `~/dev/ai-tools/tb-streamer-worktrees/`, never the repo root.
- Show the staged diff and the proposed commit message, and wait for approval before committing.
- Conventional-commit title. No AI attribution anywhere. One sentence per line in all GitHub-bound prose.
- Do not comment on or review any GitHub PR or issue — report findings in your reply.
- Verify with `npm run lint && npm test` under the Node in `.nvmrc` (v24.15.0): `source ~/.nvm/nvm.sh && nvm use`.
- Use `/usr/bin/grep` and `/opt/homebrew/bin/git` — the plain ones are unreliable in this environment's subshells.
- **The local suite degrades under sustained load.** Known flakes, all 15 s timeouts, all passing in isolation: `cors-middleware` ×2, `codex-resume` ×1–2; under load `pair-endpoints`, `watch-for-jsonl`, `webhook-update` and `discovery-cache` join them. Re-run a failing file in isolation before concluding anything.
