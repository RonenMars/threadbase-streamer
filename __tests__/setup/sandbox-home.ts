import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach } from "vitest";

/**
 * Point `homedir()` at an empty sandbox for every test file.
 *
 * Two ServerConfig defaults resolve from the home directory, and both of them
 * attach a test server to the developer's real corpus:
 *
 *   - `codexRoots` defaults to `~/.codex/sessions`
 *   - `scanProfiles` unset OR EMPTY falls back to `~/.claude/projects`
 *     (`ScannerManager.projectsDirs()` — an empty array is not isolation)
 *
 * `listen()` then walks both roots and ConversationWatcher takes roughly one
 * OS watch handle per transcript under them; `close()` awaits the in-flight
 * scan and tears every handle down. Measured 2026-09-08 against this machine's
 * corpus (1153 Claude transcripts, 679 Codex rollouts), one listen/close cycle
 * on a default-config server: listen 7.9-37.9s, close 6.3-9.5s standalone, and
 * 15.0-27.2s for close() under full-suite load. vitest's `hookTimeout` is
 * 30_000, so that is a wall-clock race, and it surfaced as "Hook timed out in
 * 30000ms" attributed to whichever test happened to be running — plus a unit
 * test reading real user data. Against the empty sandbox the same cycle is
 * listen 9-26ms, close 2-4ms, and the full suite goes 1193s to 260s.
 *
 * A sandbox rather than a shared `{ codexRoots: [], scannerPersistent: false }`
 * constant every file must remember to spread: the default is what is wrong,
 * so a test file written tomorrow that pins nothing is isolated too.
 *
 * FIRST in vitest's `setupFiles` deliberately. Three production modules read
 * `homedir()` once at module scope (`updater/paths.ts`,
 * `config/update-config.ts`, `services/conversations/shouldRefreshProjectsFromHdd.ts`),
 * so the sandbox has to exist before any later setup file imports `src/`.
 *
 * `.claude/projects` and `.codex/sessions` are pre-created empty so the roots
 * exist-but-are-empty, as they are on a real machine, rather than exercising
 * a missing-directory branch no production install hits.
 *
 * Both HOME and USERPROFILE: `os.homedir()` reads USERPROFILE on Windows and
 * ignores HOME.
 *
 * Re-asserted in a beforeEach for the same reason as isolate-runtime-db.ts —
 * at least one file swaps `process.env` for a snapshot object wholesale. A
 * setup file's hooks are registered before the test file's, so the handful of
 * tests that sandbox HOME themselves (auth-set-key, findjsonlpath-profile-
 * scoping, …) still run last and still win.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "tb-test-home-"));
mkdirSync(join(SANDBOX_HOME, ".claude", "projects"), { recursive: true });
mkdirSync(join(SANDBOX_HOME, ".codex", "sessions"), { recursive: true });

const REAL_HOME = homedir();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

/**
 * The developer's real home, published for the ONE assertion that needs it:
 * security-hardening.test.ts proves the suite never wrote to the live
 * ~/.threadbase/server.yaml (which would desync a running prod streamer and
 * 401 every client until restart). Sandboxing homedir() would otherwise make
 * that guard silently skip its existsSync() and stop checking anything.
 * Read-only. Nothing else may resolve a path from it.
 */
process.env.TB_TEST_REAL_HOME = REAL_HOME;

function useSandboxHome(): void {
  process.env.HOME = SANDBOX_HOME;
  process.env.USERPROFILE = SANDBOX_HOME;
}

useSandboxHome();
beforeEach(useSandboxHome);

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
});
