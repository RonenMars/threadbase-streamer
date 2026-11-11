import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/ci-skip-gate.sh decides whether ci.yml's Gate lets every required job
 * skip its heavy step. A wrong `skip=true` reports untested code as green, so
 * each case runs the real script against a scratch git repo carrying the real
 * skip-list, and the docs-only case is the positive control: without it, every
 * `skip=false` below would also pass against a gate that never skips.
 */

const REPO = resolve(import.meta.dirname, "..");
const SKIP_LIST = ".github/ci-skip-paths.txt";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

/** A repo with one base commit; returns its root and the base sha. */
function scratchRepo(skipList: string | null = readFileSync(join(REPO, SKIP_LIST), "utf8")) {
  const root = mkdtempSync(join(tmpdir(), "ci-gate-"));
  roots.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "base\n");
  if (skipList !== null) {
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, SKIP_LIST), skipList);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function change(root: string, files: string[]) {
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), `${f}\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change [skip-ci]");
}

function gate(root: string, base: string): string {
  const out = join(root, "gh-output");
  writeFileSync(out, "");
  const r = spawnSync("bash", [join(REPO, "scripts/ci-skip-gate.sh"), base], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: out },
  });
  expect(r.status).toBe(0);
  return readFileSync(out, "utf8").trim();
}

describe.skipIf(process.platform === "win32")("ci-skip-gate.sh", () => {
  it("skips when every change is docs (positive control)", () => {
    const { root, base } = scratchRepo();
    change(root, ["docs/guide.md", "CLAUDE.md", ".claude/skills/x/SKILL.md"]);
    expect(gate(root, base)).toBe("skip=true");
  });

  it("runs when any change is outside the skip-list, whatever the commit message says", () => {
    const { root, base } = scratchRepo();
    change(root, ["docs/guide.md", "src/server.ts"]);
    expect(gate(root, base)).toBe("skip=false");
  });

  it("runs for a nested .md outside docs/ and the agent dirs (fixtures)", () => {
    const { root, base } = scratchRepo();
    change(root, ["__tests__/fixtures/a.md"]);
    expect(gate(root, base)).toBe("skip=false");
  });

  it("runs for a path nobody listed", () => {
    const { root, base } = scratchRepo();
    change(root, [".npmrc"]);
    expect(gate(root, base)).toBe("skip=false");
  });

  it("runs when the skip-list has only comments and blank lines", () => {
    const { root, base } = scratchRepo("# nothing\n\n   \n");
    change(root, ["docs/guide.md"]);
    expect(gate(root, base)).toBe("skip=false");
  });

  it("runs when the skip-list is missing", () => {
    const { root, base } = scratchRepo(null);
    change(root, ["docs/guide.md"]);
    expect(gate(root, base)).toBe("skip=false");
  });

  it("runs with no base, an all-zero base, or an unknown base", () => {
    const { root } = scratchRepo();
    change(root, ["docs/guide.md"]);
    expect(gate(root, "")).toBe("skip=false");
    expect(gate(root, "0".repeat(40))).toBe("skip=false");
    expect(gate(root, "deadbeef")).toBe("skip=false");
  });
});
