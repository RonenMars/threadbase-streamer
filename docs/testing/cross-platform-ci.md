# Cross-platform CI and compatibility coverage

What CI actually verifies, what it does not, and what to do when a platform-specific failure appears.

---

## The gap this closes

Every CI job ran on `ubuntu-latest`. The repo, meanwhile:

- ships deploy scripts for macOS (`deploy.sh`), Linux (`deploy-linux.sh`), and Windows (`deploy.ps1`),
- has Windows-specific process discovery (`wmic` / CIM in `src/process-discovery.ts`) that no Linux run exercises,
- canonicalizes paths across separators (`src/utils/canonicalizeProjectPath.ts`),
- depends on **node-pty**, a native addon whose prebuilt binaries differ per platform and per Node ABI.

A regression in any of those was invisible to a Linux-only matrix until a user hit it.

## What the smoke job does

`smoke` runs on `macos-latest` and `windows-latest`:

1. Installs dependencies **with** lifecycle scripts, so the native addon actually builds or fetches its prebuild for that platform.
2. Runs `npm run test:smoke` — the platform-sensitive subset, including the real PTY-host socket/named-pipe suite and a Windows-only ConPTY lifetime probe.
3. Verifies `require('node-pty')` succeeds.

Step 3 is the one a Linux-only matrix can never catch: an ABI mismatch or a missing prebuild produces a server that starts fine and then fails the moment anyone opens a session.

## Windows PTY-host qualification

Observed on `windows-latest` on 2026-08-01:

- The PTY-host protocol completed status, output, disconnect, and reconnect round trips over a real Windows named pipe.
- A detached Node host spawned a real PowerShell ConPTY, remained alive after its launcher exited, and captured all 12 output beats plus the completion marker emitted afterward.
- A second listener on the live named pipe was rejected with Windows' native `EADDRINUSE` error instead of the POSIX preflight wording.

This proves that moving ConPTY ownership into the detached host buys continuity across the streamer-process exit boundary on Windows.

It does not prove a full `tb-streamer prod restart` through Task Scheduler, provider-specific Claude or Codex behaviour, or terminal replay from a real provider session on Windows; those claims remain assumed until an end-to-end Windows service test observes them.

### Why not the full suite on every platform

Most of the suite is platform-independent, and running all of it three times would triple CI wall-clock for coverage that mostly repeats. The smoke subset targets what genuinely differs.

**This is a deliberate ceiling.** Platform-specific bugs outside the smoke subset — a Windows-only path bug in the offset index, say — are still not covered. Widen `test:smoke` when a class of failure proves it needs to be there, rather than pre-emptively.

### Why it does not reuse the `run-ci` action

`run-ci` caches `node_modules` with a key of `node-modules-v4-node<version>-<lockfile hash>` — **no OS component**. Reusing it on Windows would happily restore a Linux `node_modules`, including Linux `node-pty` binaries, and the job would then "pass" while testing nothing real. The smoke job installs directly instead.

### Why it is no longer `continue-on-error`

**The advisory state was not harmless.** With `continue-on-error: true`, a failing job still rolls up as a *successful* check, so the PR reads `CLEAN` and merges with nothing objecting. That is not hypothetical: during #332 the Windows job went red on a genuine portability defect and was caught only because someone opened the runner log by hand. A check that cannot make a PR unstable is not a check.

#### The evidence that settled it

PR #332 expanded `test:smoke` with the real PTY-host socket/named-pipe suite and the Windows-only ConPTY lifetime probe. That expanded set has now run six times:

| | macOS | Windows |
|---|---|---|
| Clean runs | **5/5** | **5/6** |

The single Windows miss was the [initial #332 run](https://github.com/RonenMars/threadbase-streamer/actions/runs/30692355135), and it was a **true positive**: the named-pipe transport surfaced native `EADDRINUSE` while the test assumed the POSIX `already listening` shape. Every run after the fix has been clean on both platforms.

The timing-sensitive ConPTY lifetime probe — the one most likely to flake, at ~5.4 s against a 20 s timeout on a shared runner — passed even in that red run. So there was never evidence that the new tests are flaky, and no reason to split them into a separate informational job.

#### Decision: promoted, 2026-08-01

The documented threshold was five clean runs per platform. Both have reached it, so `continue-on-error` is removed and `__tests__/ci-workflow.test.ts` now asserts its *absence*, so returning to the advisory state has to be a deliberate edit rather than a quiet one.

**What promotion actually buys, and what it does not.** A red smoke job now turns the PR `UNSTABLE` instead of `CLEAN`, so a human or an agent following the "wait for green" convention sees the regression. It does not yet *block* the merge.

`main` **is** protected — by a ruleset (`main protection`, id `17561930`), not by classic branch protection, which is why `GET /repos/:owner/:repo/branches/main/protection` answers `404 Branch not protected` and should not be trusted here. The ruleset requires a pull request (0 approvals), enforces linear history, forbids force-push and deletion, and requires these checks with `strict: true`:

`Gate` · `Setup` · `Lint` · `Test (Node 20)` · `Test (Node 22)` · `Test (Node 24)`

**`Smoke (macos-latest)` and `Smoke (windows-latest)` are not on that list** — nor is `Build`. That, not the absence of protection, is why a red smoke job still merges. Closing it is one edit to the existing ruleset (Settings → Rules → `main protection` → Require status checks), not a new configuration.

Worth doing deliberately rather than immediately: `strict: true` means every added context also forces a rebase whenever the base moves, so each one costs churn. `Build` is the easy call — fast, deterministic, and it catches emit-only breakage `Lint` misses. The two Smoke contexts are better added after the expanded set has a longer green streak, since the ConPTY probe is the one plausible flake source and a blocking flake is the failure mode this whole section exists to avoid.

**The larger gap is not on `main` at all.** The ruleset covers `refs/heads/main` only. Day-to-day work lands on `integration/missing-prs-2026-07-23`, which has no protection of any kind — no required checks, no linear history, no force-push guard. Mirroring the ruleset onto `refs/heads/integration/**` would close it, but the better answer is the one `LANDING-integration-to-main.md` argues for: land the work on `main` and stop maintaining a parallel unguarded trunk.

This also means the usual objection to promoting early — a flaky gate that people learn to ignore — carries little weight here. The cost of a false red is someone reading a job log; the cost of staying advisory is another regression merging silently.

If the ConPTY probe does start flaking on a loaded runner, the fix is the split-job option considered above: keep the timing-sensitive probe advisory and leave the rest required. Do not reach for a blanket `continue-on-error` again.

## What is still not covered

Stated plainly so this doc is not mistaken for a completeness claim:

- **Provider-fixture CI.** C2 added versioned fixtures under `__tests__/fixtures/providers/<provider>/<version>/` and a regression test asserting zero unknown events. They run in the normal suite, not against a matrix of installed provider versions — nothing verifies behaviour against a *newly released* provider until someone captures a fixture for it.
- **Migration validation.** There is no job that applies migrations to a database from an older release and asserts the result. Migrations are additive so far, which is why this has not bitten.
- **WebSocket replay and runtime-restart tests.** Both exist as unit and integration tests; neither runs against a real long-lived server in CI.
- **Windows production restart.** The smoke job qualifies real ConPTY host lifetime and named-pipe reconnect, but it does not launch Claude or Codex or invoke Task Scheduler.
- **Performance regression.** Nothing tracks query timing or scan duration over time. `/api/search` now returns `tookMs`, which is the raw material for it.

## When a platform-specific failure appears

1. **Reproduce the narrow thing first.** The smoke subset is small; run the single failing test locally on that platform before assuming the platform is at fault.
2. **Check the native addon before the logic.** `node -e "require('node-pty')"` fails loudly on an ABI mismatch and is by far the most common cause. `scripts/check-native-abi.mjs` covers the same ground locally.
3. **Do not fix by loosening the assertion.** A path test that passes on both platforms only because it stopped checking separators has removed the coverage rather than earned it.
4. **Widen `test:smoke` when the class recurs.** One Windows path bug is a bug; three are a signal that the subset is drawn too narrowly.
