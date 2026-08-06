import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureDemoProjectDirs,
  extractDemoCwds,
  listJsonlFiles,
} from "../src/docker/ensureDemoProjectDirs";

const SCRIPT = join(__dirname, "..", "dist", "ensure-demo-project-dirs.cjs");
const FIXTURE_ROOT = join(__dirname, "..", "demo-data", ".claude", "projects");

describe("extractDemoCwds", () => {
  it("reads the unique cwd values from the demo-data corpus", () => {
    const cwds = extractDemoCwds(FIXTURE_ROOT);
    expect(cwds).toEqual([
      "/home/demo/projects/experiments",
      "/home/demo/projects/personal-website",
      "/home/demo/projects/threadbase-mobile",
    ]);
  });

  it("lists the three seeded jsonl files", () => {
    expect(listJsonlFiles(FIXTURE_ROOT)).toHaveLength(3);
  });

  it("returns [] for a missing root", () => {
    expect(extractDemoCwds(join(tmpdir(), "no-such-tb-demo-root"))).toEqual([]);
  });
});

describe("ensureDemoProjectDirs", () => {
  let workDir: string;
  let projectsRoot: string;
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-ensure-dirs-"));
    projectsRoot = join(workDir, "projects");
    projectA = join(workDir, "cwd-a");
    projectB = join(workDir, "cwd-b");
    mkdirSync(join(projectsRoot, "sess"), { recursive: true });
    writeFileSync(
      join(projectsRoot, "sess", "one.jsonl"),
      [
        JSON.stringify({ type: "user", cwd: projectA }),
        JSON.stringify({ type: "assistant", cwd: projectA }),
        JSON.stringify({ type: "user", cwd: projectB }),
        "{not json",
        JSON.stringify({ type: "user" }),
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("creates every unique absolute cwd and skips junk lines", () => {
    const created = ensureDemoProjectDirs(projectsRoot);
    expect(created).toEqual([projectA, projectB].sort());
    expect(existsSync(projectA)).toBe(true);
    expect(existsSync(projectB)).toBe(true);
  });
});

describe.skipIf(!existsSync(SCRIPT))("ensure-demo-project-dirs.cjs (script entry)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-ensure-cli-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("prints created paths and exits 0", () => {
    const projectsRoot = join(workDir, "projects");
    const cwd = join(workDir, "proj");
    mkdirSync(projectsRoot, { recursive: true });
    writeFileSync(join(projectsRoot, "x.jsonl"), `${JSON.stringify({ cwd })}\n`);

    const stdout = execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, DEMO_PROJECTS_ROOT: projectsRoot },
    });
    expect(stdout.trim()).toBe(cwd);
    expect(existsSync(cwd)).toBe(true);
  });
});
