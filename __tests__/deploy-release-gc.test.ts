import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// #871: the release GC removed old `cli.<sha>.cjs` bundles but never their
// `.version` sidecars. Each script's GC block is cut out of the real file and run
// against a temp releases dir, never ~/.threadbase.
const root = resolve(import.meta.dirname, "..");
const KEEP = 5;
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

/** 7 bundles (a..g, a oldest), each with a sidecar, plus two sidecars whose bundle is long gone. */
function makeReleases(): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-gc-"));
  "abcdefg".split("").forEach((sha, i) => {
    const bundle = join(dir, `cli.${sha}.cjs`);
    writeFileSync(bundle, "");
    writeFileSync(`${bundle}.version`, `1.0.0+${sha}\n`);
    const t = new Date(2026, 0, 1 + i);
    utimesSync(bundle, t, t);
  });
  writeFileSync(join(dir, "cli.old1.cjs.version"), "1.0.0+old1\n");
  writeFileSync(join(dir, "cli.old2.cjs.version"), "1.0.0+old2\n");
  return dir;
}

const survivors = ["c", "d", "e", "f", "g"];
const expectedFiles = survivors.flatMap((s) => [`cli.${s}.cjs`, `cli.${s}.cjs.version`]).sort();

describe.each(["deploy.sh", "deploy-linux.sh"])("%s release GC", (scriptName) => {
  it("collects a bundle's .version sidecar with it and keeps the paired ones", () => {
    if (process.platform === "win32") return;
    const script = readFileSync(join(root, "scripts", scriptName), "utf8");
    const start = script.indexOf('  ls -td "$RELEASES_DIR"/cli.*/');
    const end = script.indexOf("  # Install (or refresh)", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const releases = makeReleases();
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -eu
KEEP_RELEASES=${KEEP}
RELEASES_DIR="$TEST_RELEASES"
gc() {
  local active_release="$RELEASES_DIR/cli.g.cjs"
${script.slice(start, end)}
}
gc`,
        ],
        { env: { ...process.env, TEST_RELEASES: releases }, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(releases).sort()).toEqual(expectedFiles);
      expect(readFileSync(join(releases, "cli.c.cjs.version"), "utf8")).toBe("1.0.0+c\n");
    } finally {
      rmSync(releases, { recursive: true, force: true });
    }
  });
});

describe("deploy.ps1 release GC", () => {
  it.skipIf(!hasPwsh)(
    "collects a bundle's .version sidecar with it and keeps the paired ones",
    () => {
      const script = readFileSync(join(root, "scripts", "deploy.ps1"), "utf8");
      const start = script.indexOf('    Write-Log "garbage-collecting old releases');
      const end = script.indexOf("    # Install (or refresh)", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const releases = makeReleases();
      const work = mkdtempSync(join(tmpdir(), "tb-gc-ps-"));
      try {
        const file = join(work, "gc.ps1");
        writeFileSync(
          file,
          `function Write-Log($m) {}
$releasesDir = $env:TEST_RELEASES
$keepReleases = ${KEEP}
${script.slice(start, end)}`,
        );
        mkdirSync(releases, { recursive: true });
        const result = spawnSync("pwsh", ["-NoProfile", "-File", file], {
          env: { ...process.env, TEST_RELEASES: releases },
          encoding: "utf8",
        });
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(readdirSync(releases).sort()).toEqual(expectedFiles);
        expect(readFileSync(join(releases, "cli.c.cjs.version"), "utf8")).toBe("1.0.0+c\n");
      } finally {
        rmSync(releases, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
