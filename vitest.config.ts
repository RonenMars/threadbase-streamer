import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const sha = git("rev-parse", "--short", "HEAD") || "unknown";
const version = `${pkg.version}+${sha}-test`;
const testTimeout = process.platform === "win32" ? 900_000 : 45_000;
// One serial case, measured: macOS after #894 — Smoke (macos-latest) failed 8
// of 29 runs (28%) vs 2 of 66 (3%) serial, always on paint-time / fs.watch
// waits (codex-active-writer, pty-live-question-close, pty-shell-prompt-
// detection, transcript-watch-deadline, codex-multi-choice-transport). Four
// workers plus thousands of watch handles recreate the BIND_BUDGET flakes.
// Windows × Node 24 used to be serial too (fork workers died with "Worker
// exited unexpectedly"); on Node 24.22.1 it passes parallel, see #530.
// - Not a free speed-up elsewhere: 10 forks on a 10-core box took 1144s vs
//   1259s serial (-9%) but failed 45 tests vs 15, because most files boot a
//   real StreamerServer (SQLite + chokidar) and starve each other
//   (pair-endpoints: 860s, 9/9 failing, tests at 174s under a 15s timeout).
//   If you want the suite faster, lower maxForks to 4-6; raising it is worse.
// See docs/testing/cross-platform-ci.md.
const fileParallelism = process.platform !== "darwin";

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  test: {
    globals: true,
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["__tests__/setup/global-cache-open.ts"],
    setupFiles: [
      // FIRST: three src modules resolve homedir() once at module scope, so the
      // sandbox has to exist before any later setup file imports src/.
      "__tests__/setup/sandbox-home.ts",
      "__tests__/setup/silence-logs.ts",
      "__tests__/setup/isolate-runtime-db.ts",
      "__tests__/setup/neutral-feature-flags.ts",
      "__tests__/setup/isolate-scanner-index.ts",
      "__tests__/setup/provider-installed.ts",
    ],
    pool: "forks",
    fileParallelism,
    // GitHub-hosted runners are 4 vCPU. Linux keeps this cap; macOS is serial
    // (fileParallelism above) so the cap is unused there. Oversubscribing a
    // laptop's extra cores recreates the watch-pressure flakes the BIND_BUDGET
    // comments describe.
    maxWorkers: 4,
    hookTimeout: 30_000,
    testTimeout,
  },
});
