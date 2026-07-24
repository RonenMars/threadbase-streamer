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
2. Runs `npm run test:smoke` — the platform-sensitive subset: path canonicalization, date handling, schema validation, version parsing.
3. Verifies `require('node-pty')` succeeds.

Step 3 is the one a Linux-only matrix can never catch: an ABI mismatch or a missing prebuild produces a server that starts fine and then fails the moment anyone opens a session.

### Why not the full suite on every platform

Most of the suite is platform-independent, and running all of it three times would triple CI wall-clock for coverage that mostly repeats. The smoke subset targets what genuinely differs.

**This is a deliberate ceiling.** Platform-specific bugs outside the smoke subset — a Windows-only path bug in the offset index, say — are still not covered. Widen `test:smoke` when a class of failure proves it needs to be there, rather than pre-emptively.

### Why it does not reuse the `run-ci` action

`run-ci` caches `node_modules` with a key of `node-modules-v4-node<version>-<lockfile hash>` — **no OS component**. Reusing it on Windows would happily restore a Linux `node_modules`, including Linux `node-pty` binaries, and the job would then "pass" while testing nothing real. The smoke job installs directly instead.

### Why it is `continue-on-error` for now

The job is informational while the platforms are qualified. A genuine cross-platform failure should surface loudly without blocking every merge before the baseline is known green — the alternative is a red check everyone learns to ignore, which is worse than no check.

**Flip it to required** once it has run green for a sustained period. Track that decision here rather than leaving it implicit; a permanently advisory check is a check that does not exist.

## What is still not covered

Stated plainly so this doc is not mistaken for a completeness claim:

- **Provider-fixture CI.** C2 added versioned fixtures under `__tests__/fixtures/providers/<provider>/<version>/` and a regression test asserting zero unknown events. They run in the normal suite, not against a matrix of installed provider versions — nothing verifies behaviour against a *newly released* provider until someone captures a fixture for it.
- **Migration validation.** There is no job that applies migrations to a database from an older release and asserts the result. Migrations are additive so far, which is why this has not bitten.
- **WebSocket replay and runtime-restart tests.** Both exist as unit and integration tests; neither runs against a real long-lived server in CI.
- **Windows PTY behaviour.** The smoke job proves the addon *loads*. It does not spawn a session — ConPTY teardown semantics differ from POSIX (see the durable-session-runtime ADR), and asserting them needs a real interactive process.
- **Performance regression.** Nothing tracks query timing or scan duration over time. `/api/search` now returns `tookMs`, which is the raw material for it.

## When a platform-specific failure appears

1. **Reproduce the narrow thing first.** The smoke subset is small; run the single failing test locally on that platform before assuming the platform is at fault.
2. **Check the native addon before the logic.** `node -e "require('node-pty')"` fails loudly on an ABI mismatch and is by far the most common cause. `scripts/check-native-abi.mjs` covers the same ground locally.
3. **Do not fix by loosening the assertion.** A path test that passes on both platforms only because it stopped checking separators has removed the coverage rather than earned it.
4. **Widen `test:smoke` when the class recurs.** One Windows path bug is a bug; three are a signal that the subset is drawn too narrowly.
