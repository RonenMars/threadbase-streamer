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

  // THE load-bearing assertion in this file. The platform jobs used to run a
  // hand-curated list of eight files, which made "not covered on
  // macOS/Windows" the default for every test added afterwards — the author
  // got no signal they were meant to enrol. #523 shipped a macOS-breaking
  // socket-path overflow through a fully green board that way, and a Windows
  // 8.3 short-path bug in server.test.ts sat undetected for the same reason.
  //
  // Running the whole suite is what makes a new test covered by default, so
  // narrowing it back to a subset has to be a test failure rather than a
  // quiet YAML edit. This also subsumes the old explicit assertion that the
  // pty-host socket/named-pipe and ConPTY-lifetime files run cross-platform:
  // they do, because everything does.
  it("runs the whole suite on macOS and Windows, not a curated subset", () => {
    const smoke = WORKFLOW.slice(
      WORKFLOW.indexOf("  smoke:"),
      WORKFLOW.indexOf("  test:", WORKFLOW.indexOf("  smoke:")),
    );
    const commands = [...smoke.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());

    expect(commands).toContain("npm test");
    // No step may name individual test files — that is the allowlist returning.
    expect(commands.filter((c) => c.includes("__tests__/"))).toEqual([]);
  });

  // Running the whole suite is not enough on its own if it runs under a Node
  // the project does not use. The job hardcoded `node-version: 22` while
  // .nvmrc pinned v24.15.0, and libuv tightened AF_UNIX sun_path enforcement
  // between the two — #523's 114-byte socket path raises EINVAL on Node 24 and
  // binds silently on Node 22. Since the Node-24 legs of `Test` are
  // ubuntu-only, macOS x Node 24 was covered by nothing.
  //
  // The workflow pins the major literally, so this compares it against .nvmrc
  // rather than trusting it: the two drifting apart is the actual defect, and
  // a literal pin cannot notice that on its own.
  //
  // macOS must track .nvmrc, since that is the leg that catches the sun_path
  // class. Windows is deliberately held at 22 — Node 24 kills six vitest fork
  // workers there — so it is asserted separately rather than left free, and
  // raising it is then a visible edit here rather than a silent one.
  it("runs the macOS leg on the Node major .nvmrc pins", () => {
    const smoke = WORKFLOW.slice(
      WORKFLOW.indexOf("  smoke:"),
      WORKFLOW.indexOf("  test:", WORKFLOW.indexOf("  smoke:")),
    );
    const nvmrcMajor = readFileSync(join(__dirname, "..", ".nvmrc"), "utf8")
      .trim()
      .replace(/^v/, "")
      .split(".")[0];

    expect(nvmrcMajor).toMatch(/^\d+$/);
    expect(smoke).toMatch(new RegExp(`os:\\s*macos-latest\\s*\\n\\s*node:\\s*${nvmrcMajor}\\b`));
    expect(smoke).toMatch(/os:\s*windows-latest\s*\n\s*node:\s*22\b/);
    // The step must read the matrix rather than reintroduce a single hardcode.
    expect(smoke).toMatch(/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/);
  });

  // The fast subset still exists for the pre-commit hook, where local speed is
  // the point. It must not be what CI treats as platform coverage; the
  // rename off "smoke" is what keeps the two from being confused again.
  it("keeps the fast subset local-only", () => {
    expect(PACKAGE.scripts["test:precommit"]).toBeTruthy();
    expect(PACKAGE.scripts).not.toHaveProperty("test:smoke");
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
