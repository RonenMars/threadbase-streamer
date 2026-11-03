import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(__dirname, "..", "scripts", "check-native-abi.mjs");
const req = createRequire(import.meta.url);
// The package's `exports` hides lib/binding.js, so reach it through the entry file.
const REAL_BINARY = req(
  join(dirname(req.resolve("better-sqlite3")), "binding.js"),
).getPrebuildPath() as string;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tb-abi-guard-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Bytes that no loader accepts: dlopen throws, which is all the guard keys on.
const GARBAGE = "not a native module";

function place(pkgDir: string, rel: string, good: boolean): string {
  const file = join(root, pkgDir, rel);
  mkdirSync(dirname(file), { recursive: true });
  if (good) copyFileSync(REAL_BINARY, file);
  else writeFileSync(file, GARBAGE);
  return file;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
}

const TOP = "node_modules/better-sqlite3";
const NESTED = "node_modules/@threadbase-sh/scanner/node_modules/better-sqlite3";
const LEGACY = "build/Release/better_sqlite3.node";

describe("scripts/check-native-abi.mjs", () => {
  it("has a real binary to borrow (positive control for every case below)", () => {
    expect(REAL_BINARY).toBeTruthy();
  });

  it("passes when no better-sqlite3 binary exists at all", () => {
    expect(run().status).toBe(0);
  });

  it("passes when the top-level and a nested copy both load", () => {
    place(TOP, LEGACY, true);
    place(NESTED, LEGACY, true);
    expect(run().status).toBe(0);
  });

  it("fails and names the path when only a nested scoped copy is broken", () => {
    place(TOP, LEGACY, true);
    const bad = place(NESTED, LEGACY, false);
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(bad);
  });

  it("fails when a nested copy under an unscoped package is broken", () => {
    place(TOP, LEGACY, true);
    place("node_modules/some-dep/node_modules/better-sqlite3", LEGACY, false);
    expect(run().status).toBe(1);
  });

  it("probes the prebuilds layout, not only build/Release", () => {
    const prebuild = REAL_BINARY.slice(REAL_BINARY.indexOf("prebuilds"));
    place(TOP, prebuild, false);
    expect(run().status).toBe(1);
  });

  it("downgrades to a notice under --warn", () => {
    place(NESTED, LEGACY, false);
    expect(run("--warn").status).toBe(0);
  });
});
