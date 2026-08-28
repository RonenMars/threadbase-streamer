import { beforeEach } from "vitest";
import { FEATURE_FLAG_LIST } from "../../src/feature-flags";

/**
 * Run every test file against the registry defaults, whatever the shell says.
 *
 * Env is the highest real precedence rung in `resolveFeatureFlags`, above the
 * `ServerConfig.featureFlags` (CLI) rung the tests use — so a
 * `THREADBASE_FEATURE_*` exported in a developer's shell silently overrides
 * what a test explicitly asked for. `THREADBASE_FEATURE_PTY_HOST=1` is the
 * expensive case: it makes every one of the ~50 files that boot a
 * StreamerServer reach `connectOrSpawnHost`, spawn a detached child against the
 * real `~/.threadbase/run/` socket, and block for the 5s host-ready timeout
 * before falling back — and it flips the assertion in the one test that pins
 * the flag *off*.
 *
 * Clearing the whole registry rather than that one var: the leak is a property
 * of the precedence chain, not of `ptyHost`, so a flag added later is covered
 * without anyone remembering this file exists. Three test files already
 * hand-rolled this delete for their own flag (e2ee-capability,
 * push-capability, live-activity-flag) — those stay as harmless local belt to
 * this braces.
 *
 * Re-asserted in a beforeEach for the same reason as isolate-runtime-db.ts: at
 * least one file swaps `process.env` for a snapshot object wholesale, which
 * would restore anything deleted only once at module scope. Tests that set a
 * flag var deliberately do it inside the test body, which runs after this hook.
 */
function clearFeatureFlagEnv(): void {
  for (const flag of FEATURE_FLAG_LIST) delete process.env[flag.env];
}

clearFeatureFlagEnv();
beforeEach(clearFeatureFlagEnv);
