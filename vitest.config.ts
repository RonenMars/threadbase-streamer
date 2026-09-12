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
// Windows Node 24 kills vitest fork workers ("Worker exited unexpectedly") —
// 0 failures, 6 unhandled errors, measured on runs 011122a and 72a6272. CI
// pins Windows smoke to Node 22, so that job still parallelizes. See
// docs/testing/cross-platform-ci.md.
const nodeMajor = Number.parseInt(process.versions.node, 10);
const fileParallelism = !(process.platform === "win32" && nodeMajor >= 24);

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  test: {
    globals: true,
    include: ["__tests__/**/*.test.ts"],
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
    // GitHub-hosted runners are 4 vCPU; this suite also opens many fs.watch
    // handles (JSONL, PTY), so oversubscribing a laptop's extra cores just
    // recreates the watch-pressure flakes the BIND_BUDGET comments describe.
    maxWorkers: 4,
    hookTimeout: 30_000,
    testTimeout,
  },
});
