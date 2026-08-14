import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * npm 12 blocks dependency install scripts unless `allowScripts` names the
 * package. Both of our native modules build from source via that mechanism, and
 * a blocked build fails *silently*: `npm install` exits 0, prints a warning
 * among many, and leaves the package with no `.node` binary.
 *
 * The consequence is not subtle. `node-pty` unbuilt means the streamer cannot
 * spawn a single session — every start fails at import — on a machine where
 * nothing about the install looked wrong. Observed 2026-08-12 on npm 12.0.2:
 * `node-pty` was missing from this map, `npm install` and `npm rebuild` both
 * skipped its `node-gyp rebuild`, and only a direct node-gyp invocation
 * produced the binary.
 *
 * So this guards the manifest rather than the build: an entry disappearing here
 * is a broken install for everyone on npm 12, and no other test would notice.
 */

/** Runtime deps that compile a native addon during install. */
const NATIVE_DEPS = ["better-sqlite3", "node-pty"];

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  allowScripts?: Record<string, boolean>;
};

describe("allowScripts covers every native dependency", () => {
  it.each(NATIVE_DEPS)("%s is still a runtime dependency", (name) => {
    // Paired with the check below so the two cannot drift: dropping the
    // dependency should drop its allowScripts entry, not orphan it.
    expect(Object.keys(pkg.dependencies)).toContain(name);
  });

  it.each(NATIVE_DEPS)("%s is allow-listed so its build actually runs", (name) => {
    expect(pkg.allowScripts?.[name]).toBe(true);
  });
});
