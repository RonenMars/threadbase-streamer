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

## What the cross-platform job does

`smoke` runs on `macos-latest` and `windows-latest`:

1. Installs dependencies **with** lifecycle scripts, so the native addon actually builds or fetches its prebuild for that platform.
2. Runs `npm test` — the **whole** suite, the same command the Linux `Test` jobs run.
3. Verifies `require('node-pty')` succeeds.

Step 3 is the one a Linux-only matrix can never catch: an ABI mismatch or a missing prebuild produces a server that starts fine and then fails the moment anyone opens a session.

**The job is still named `Smoke (…)` and no longer runs a smoke subset.** That is deliberate: both context names are required checks in ruleset `17561930`, and a required context that no workflow emits is never reported and never satisfied — renaming the job makes every PR permanently unmergeable. That has happened here once already (see the warning further down). The misnomer is the cheaper of the two problems.

## Windows PTY-host qualification

Observed on `windows-latest` on 2026-08-01:

- The PTY-host protocol completed status, output, disconnect, and reconnect round trips over a real Windows named pipe.
- A detached Node host spawned a real PowerShell ConPTY, remained alive after its launcher exited, and captured all 12 output beats plus the completion marker emitted afterward.
- A second listener on the live named pipe was rejected with Windows' native `EADDRINUSE` error instead of the POSIX preflight wording.

This proves that moving ConPTY ownership into the detached host buys continuity across the streamer-process exit boundary on Windows.

It does not prove a full `tb-streamer prod restart` through Task Scheduler, provider-specific Claude or Codex behaviour, or terminal replay from a real provider session on Windows; those claims remain assumed until an end-to-end Windows service test observes them.

### Why the full suite, since 2026-08-11

It used to be a curated allowlist of eight files, on the reasoning that most of the suite is platform-independent and running it three times would triple CI wall-clock. Both halves of that turned out to be wrong in the ways that mattered.

**The allowlist made "not covered" the default.** Every test written after it was excluded from macOS and Windows unless someone remembered to add the file by hand, and nothing told an author they were supposed to. That is not a ceiling anyone chose per-file; it is a ceiling that moved on its own every time the suite grew. Two independent incidents in one week came out of it:

- **[#523](https://github.com/RonenMars/threadbase-streamer/pull/523)** randomized a pty-host instance id, pushing the POSIX unix-socket path to 106 bytes against macOS's 104-byte `sun_path` limit. Five tests in `__tests__/pty-host-survival.test.ts` failed with `listen EINVAL`. The PR reached `MERGEABLE`/`CLEAN` with all 12 checks green and merged as `9f28397`. Two of the three `pty-host` files were on the allowlist; the one that broke was not, and nothing about that split was principled.
- **`docs/ROADMAP.md`** claimed `Smoke (windows-latest)` covered the Windows log-redirection assertions in `__tests__/deploy-windows-script.test.ts`. It did not — that file was not on the list either. A false assurance, written down and believed.

**And it was not buying wall-clock.** Measured on 2026-08-11 against run `31461926905`:

| | allowlist | full suite | run critical path |
|---|---|---|---|
| macOS | ends t+108s | ends ~t+184s | **289s** |
| Windows | ends t+149s | ends ~t+246s | **289s** |

The critical path is owned by `Warm cache (Node 20)` (208s) feeding `Test (Node 24)`. Both platform jobs finished inside that slack before the change and still do after it, so **run wall-clock is unchanged**. The repo is public, so macOS's 10× and Windows's 2× runner multipliers bill nothing either. The saving was imaginary; the cost was two real bugs.

### What stays out, and how

A test that genuinely cannot run on a platform guards **itself**, in its own file:

```ts
describe.skipIf(process.platform === "win32")("POSIX socket paths", () => { … });
```

Eighteen test files already do this. The property that matters is that exclusion is visible to the person writing the test, at the moment they write it — not recorded in a central list they have no reason to open. There is no list to forget, so a newly-added test is covered on every platform by default.

`__tests__/ci-workflow.test.ts` pins this: it asserts the platform job's `run:` steps contain `npm test` and name no individual test file. Narrowing back to a subset is a test failure, not a quiet YAML edit.

`npm run test:precommit` — the old eight-file set, renamed off "smoke" so the two cannot be confused again — still exists for the pre-commit hook, where local speed is the whole point. **It is not a coverage boundary and nothing in CI runs it.**

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

`Build` was added on 2026-08-01 and is producible on `main`, so it is safe.

### ⚠️ A required check must exist in the **target branch's** workflow

**Learned the hard way, 2026-08-01.** `Smoke (macos-latest)` and `Smoke (windows-latest)` were added to the ruleset the same day — and **every pull request to `main` immediately became permanently unmergeable**.

The cause: the `smoke` job lives only on `integration/missing-prs-2026-07-23`. `main`'s `.github/workflows/ci.yml` has no such job, so `main` can produce `Gate`, `Setup`, `Warm cache`, `Lint`, `Build` and `Test (…)` and nothing else. A required context that no workflow on the target branch emits is never reported, is never satisfied, and blocks the merge forever. Both contexts had to be removed again.

The mistake was verifying the job existed in the *integration* checkout and assuming `main` matched. It did not — `main` is ~250 commits behind, and the smoke job is part of what has not landed.

**Before adding any context to the ruleset, confirm the target branch produces it:**

```bash
G=/opt/homebrew/bin/git
# every job NAME main's workflow can emit
$G show origin/main:.github/workflows/ci.yml | /usr/bin/grep -E '^    name:'
```

A matrix job emits one context per leg with the placeholder expanded — `Smoke (macos-latest)`, not `Smoke (${{ matrix.os }})`. **Never require the un-expanded template name**: GitHub's "Add checks" picker offers it, no run ever reports it, and the effect is the same permanent block.

**Correct order:** land the job on `main` first, confirm it reports on a real PR, then add the context. That is what [PR #340](https://github.com/RonenMars/threadbase-streamer/pull/340) does for the smoke job; once it merges, both Smoke contexts become safe to require.

Worth doing deliberately even then: `strict: true` means every added context also forces a rebase whenever the base moves, so each one costs churn. The two Smoke contexts are better added after the expanded set has a longer green streak, since the ConPTY probe is the one plausible flake source and a blocking flake is the failure mode this whole section exists to avoid.

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

1. **Reproduce the narrow thing first.** Run the single failing test locally on that platform before assuming the platform is at fault.
2. **Check the native addon before the logic.** `node -e "require('node-pty')"` fails loudly on an ABI mismatch and is by far the most common cause. `scripts/check-native-abi.mjs` covers the same ground locally.
3. **Do not fix by loosening the assertion.** A path test that passes on both platforms only because it stopped checking separators has removed the coverage rather than earned it.
4. **Do not reach for an exclusion.** There is no allowlist to fall off any more, and re-introducing one fails `__tests__/ci-workflow.test.ts`. If a test truly cannot run on a platform, guard that test in its own file with `describe.skipIf(process.platform === …)` and say why in a comment.
5. **A green board is not evidence when the box is dirty.** A developer machine with a supervised streamer on port 8766 and a populated `~/.threadbase` fails ~8 files on timeouts that a clean runner passes. Baseline against clean `main` before attributing a failure to your change, and prefer a throwaway CI branch over local reasoning about "clean".

### Windows: `fs.realpathSync` keeps 8.3 short names

The first defect the widened job found, and worth knowing before writing the next path assertion.

`fs.realpathSync` is a JS implementation that resolves symlinks but **preserves** 8.3 short names, so on a GitHub Windows runner `os.tmpdir()` stays `C:\Users\RUNNER~1\AppData\Local\Temp\…`. `fs/promises.realpath` and `fs.realpathSync.native` are libuv-backed and **expand** them to `C:\Users\runneradmin\…`.

`src/server.ts:727` canonicalizes the browse root with the promises form, so a test that built its expectation with plain `realpathSync` compared a short path against a long one and failed — on Windows only, and invisibly everywhere else. Seven cases in `__tests__/server.test.ts` did exactly that, and the allowlist had hidden it since the file was written.

**Match the variant the product uses.** The fix is `realpathSync.native`, not a looser assertion; on POSIX the two behave identically, so nothing about Linux or macOS coverage changes.
