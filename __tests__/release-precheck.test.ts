import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Validates scripts/release-precheck.mjs: it must reproduce semantic-release's
// commit-analysis decision (fix→patch, feat→minor, breaking→major, chore/docs→none)
// using .releaserc.json's rules, WITHOUT any npm token in the environment.

const SCRIPT = join(__dirname, "..", "scripts", "release-precheck.mjs");
const RELEASERC = join(__dirname, "..", ".releaserc.json");
const NODE_MODULES = join(__dirname, "..", "node_modules");

let repo: string;

function git(args: string[]) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function commit(message: string) {
  writeFileSync(join(repo, `f-${Date.now()}-${Math.random()}`), "x");
  git(["add", "-A"]);
  git(["commit", "-m", message]);
}

/** Run the precheck script inside the temp repo with a scrubbed env. */
function runPrecheck(extraEnv: Record<string, string | undefined> = {}) {
  const outFile = join(repo, "gh_output");
  writeFileSync(outFile, "");
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_OUTPUT: outFile,
    // Prove no npm auth is needed.
    NPM_TOKEN: undefined,
    NODE_AUTH_TOKEN: undefined,
    ...extraEnv,
  };
  // Run the copy under <repo>/scripts/ so repoRoot ('..') resolves to <repo>,
  // matching the real layout (scripts/release-precheck.mjs).
  const stdout = execFileSync("node", [join(repo, "scripts", "release-precheck.mjs")], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { stdout, outputs };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "precheck-"));
  git(["init", "-q", "-b", "main"]);
  // Mirror the real layout: <repo>/.releaserc.json, <repo>/scripts/release-precheck.mjs,
  // <repo>/node_modules. The script computes repoRoot as its parent's parent
  // ('scripts/..') and reads .releaserc.json + resolves @semantic-release/* from there.
  cpSync(RELEASERC, join(repo, ".releaserc.json"));
  execFileSync("mkdir", ["-p", join(repo, "scripts")]);
  cpSync(SCRIPT, join(repo, "scripts", "release-precheck.mjs"));
  execFileSync("ln", ["-s", NODE_MODULES, join(repo, "node_modules")]);
  commit("chore: initial");
  git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

it("fix: commit → patch release (1.0.1)", () => {
  commit("fix: a bug");
  const { outputs } = runPrecheck();
  expect(outputs.should_release).toBe("true");
  expect(outputs.next_version).toBe("1.0.1");
});

it("feat: commit → minor release (1.1.0)", () => {
  commit("feat: a feature");
  const { outputs } = runPrecheck();
  expect(outputs.should_release).toBe("true");
  expect(outputs.next_version).toBe("1.1.0");
});

it("breaking change → major release (2.0.0)", () => {
  commit("feat!: drop old API\n\nBREAKING CHANGE: gone");
  const { outputs } = runPrecheck();
  expect(outputs.should_release).toBe("true");
  expect(outputs.next_version).toBe("2.0.0");
});

it("chore/docs only → no release", () => {
  commit("chore: tidy");
  commit("docs: readme");
  const { outputs } = runPrecheck();
  expect(outputs.should_release).toBe("false");
  expect(outputs.next_version).toBe("");
});

it("works with no NPM_TOKEN / NODE_AUTH_TOKEN in env", () => {
  commit("fix: still decides without npm auth");
  const { stdout, outputs } = runPrecheck({
    NPM_TOKEN: undefined,
    NODE_AUTH_TOKEN: undefined,
  });
  expect(outputs.should_release).toBe("true");
  expect(stdout).toContain("Would release v1.0.1");
});
