import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGitToplevel } from "../../src/lifecycle/repo";

describe("getGitToplevel", () => {
  it("returns null when cwd is not in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-test-"));
    try {
      expect(getGitToplevel(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the toplevel path inside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const sub = join(dir, "sub", "deep");
      mkdirSync(sub, { recursive: true });
      const expected = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sub })
        .toString()
        .trim();
      expect(getGitToplevel(sub)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
