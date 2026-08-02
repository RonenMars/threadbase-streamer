import { readFileSync } from "fs";
import { join } from "path";
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
