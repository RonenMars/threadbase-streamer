import { existsSync, readFileSync } from "fs";
import { join } from "path";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";

/**
 * CI workflow invariants (C10).
 * See docs/testing/cross-platform-ci.md.
 *
 * These pin decisions that are easy to undo accidentally while editing YAML,
 * and whose breakage is silent: CI stays green while covering less than it
 * appears to.
 */

const WORKFLOW = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("CI triggers", () => {
  // Task branches are developed against and merged into integration/**. When
  // the workflow only triggered on main, PRs against an integration branch ran
  // NO ci at all — lint, types, and tests never executed, while the Snyk check
  // still reported green and read as "CI passed".
  it("runs on pull requests targeting integration branches", () => {
    expect(WORKFLOW).toMatch(/pull_request:[\s\S]*?branches:.*integration/);
  });

  it("still runs on main", () => {
    expect(WORKFLOW).toMatch(/pull_request:[\s\S]*?branches:.*main/);
  });
});

describe("cross-platform smoke", () => {
  it("covers macOS and Windows", () => {
    expect(WORKFLOW).toContain("macos-latest");
    expect(WORKFLOW).toContain("windows-latest");
  });

  // A missing prebuild or ABI mismatch yields a server that starts fine and
  // fails the moment anyone opens a session — the failure a Linux-only matrix
  // can never catch.
  it("verifies the native addon actually loads", () => {
    expect(WORKFLOW).toMatch(/require\('node-pty'\)/);
  });

  it("qualifies the pty-host transport and Windows ConPTY lifetime", () => {
    expect(PACKAGE.scripts["test:smoke"]).toContain("__tests__/pty-host-process.test.ts");
    expect(PACKAGE.scripts["test:smoke"]).toContain("__tests__/pty-host-windows.test.ts");
  });

  // Promoted once the expanded pty-host set cleared its documented threshold.
  // Pinned rather than left implicit because the advisory state is exactly how
  // a real Windows regression once reported itself as a passing check: with
  // continue-on-error set, a red job still rolls up green and merges unnoticed.
  it("does not let a platform regression report as a passing check", () => {
    const smoke = WORKFLOW.slice(
      WORKFLOW.indexOf("  smoke:"),
      WORKFLOW.indexOf("  test:", WORKFLOW.indexOf("  smoke:")),
    );
    expect(smoke).not.toMatch(/continue-on-error:\s*true/);
  });

  // One platform failing must not cancel the other; both results are wanted.
  it("does not fail fast across the platform matrix", () => {
    const smoke = WORKFLOW.slice(WORKFLOW.indexOf("  smoke:"));
    expect(smoke).toMatch(/fail-fast:\s*false/);
  });

  // run-ci caches node_modules with no OS component, so reusing it here would
  // restore Linux node-pty binaries onto Windows and "pass" while testing
  // nothing real.
  it("installs directly rather than reusing the OS-agnostic cache", () => {
    const smoke = WORKFLOW.slice(
      WORKFLOW.indexOf("  smoke:"),
      WORKFLOW.indexOf("  test:", WORKFLOW.indexOf("  smoke:")),
    );
    expect(smoke).toContain("npm ci");
    expect(smoke).not.toContain("uses: ./.github/actions/run-ci");
  });
});

describe("run-ci cache key", () => {
  // Documents the constraint that forces the smoke job to install directly.
  // If an OS component is ever added to this key, the smoke job can be
  // simplified to reuse the action — and this test should be updated then.
  it("has no OS component, which is why smoke installs its own deps", () => {
    const action = readFileSync(
      join(__dirname, "..", ".github", "actions", "run-ci", "action.yml"),
      "utf8",
    );
    const key = action.match(/key:\s*(node-modules-[^\n]*)/)?.[1] ?? "";

    expect(key).toBeTruthy();
    expect(key).not.toMatch(/runner\.os|matrix\.os/);
  });
});

// CI runs bare `npx vitest run` (.github/actions/run-ci/action.yml), so what
// executes is whatever vitest.config.ts's `include` matches — NOT what
// package.json names. `test:contracts` and `test:e2e` exist as scripts and no
// workflow invokes either; those directories run only because the include glob
// is recursive.
//
// That makes the wiring real but implicit, and silently breakable: narrow the
// glob to `__tests__/*.test.ts`, or add an `exclude`, and the contract and e2e
// suites stop running while both scripts still exist and still pass by hand.
// A suite nothing runs does not merely fail to catch things — it produces false
// confidence in anyone who cites a green adjacent job.
describe("test discovery covers the nested suites", () => {
  const config = readFileSync(join(__dirname, "..", "vitest.config.ts"), "utf8");
  const include = [...config.matchAll(/include:\s*\[([^\]]+)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]),
  );

  it("declares at least one include pattern", () => {
    expect(include.length).toBeGreaterThan(0);
  });

  it.each([
    ["__tests__/contracts/mobile-contracts.test.ts"],
    ["__tests__/contracts/desktop-contracts.test.ts"],
    ["__tests__/contracts/shared-contracts.test.ts"],
    ["__tests__/e2e/api-e2e.test.ts"],
  ])("runs %s under the default vitest invocation", (file) => {
    expect(existsSync(join(__dirname, "..", file))).toBe(true);
    expect(include.some((pattern) => picomatch(pattern)(file))).toBe(true);
  });

  it("has no exclude that could remove them", () => {
    expect(config).not.toMatch(/^\s*exclude:/m);
  });
});
