import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach } from "vitest";

/**
 * Give every test file its own session-registry database.
 *
 * Runs before each test file (vitest `setupFiles`). Without it, any test that
 * constructs a StreamerServer without pinning a runtime DB path resolves it to
 * the developer's real `~/.threadbase/runtime.db` and writes session rows into
 * it — and, because the suite runs single-fork, several concurrently-alive
 * servers would share that one SQLite file and leak rows between unrelated
 * tests.
 *
 * THREADBASE_RUNTIME_DB rather than THREADBASE_CONFIG_DIR: several auth tests
 * sandbox the config directory by overriding HOME/USERPROFILE, and
 * THREADBASE_CONFIG_DIR outranks homedir() — setting it here would defeat their
 * sandbox and redirect their writes into this one.
 *
 * Re-asserted in a beforeEach, not just at module scope: the suite is
 * single-fork and at least one test file swaps `process.env` for a snapshot
 * object wholesale (__tests__/db/config.test.ts), which drops a value set only
 * once per file. The hook runs after any such juggling, so no test can reach
 * the real home directory.
 */
const RUNTIME_DB = join(mkdtempSync(join(tmpdir(), "tb-test-runtime-")), "runtime.db");

process.env.THREADBASE_RUNTIME_DB = RUNTIME_DB;
beforeEach(() => {
  process.env.THREADBASE_RUNTIME_DB = RUNTIME_DB;
});
