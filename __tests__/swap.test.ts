import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpRoot = "";

vi.mock("../src/updater/paths", () => {
  return {
    get THREADBASE_ROOT() {
      return tmpRoot;
    },
    get RELEASES_DIR() {
      return join(tmpRoot, "releases");
    },
    get CURRENT_SYMLINK() {
      return join(tmpRoot, "current");
    },
    get DOWNLOAD_DIR() {
      return join(tmpRoot, "releases", ".tmp");
    },
    releaseDir(version: string) {
      return join(tmpRoot, "releases", version);
    },
    downloadPath(version: string, filename: string) {
      return join(tmpRoot, "releases", ".tmp", `${version}-${filename}`);
    },
  };
});

import { ensureReleasesDir, pruneOldReleases, swapCurrent } from "../src/updater/swap";

function makeRelease(version: string): void {
  const dir = join(tmpRoot, "releases", version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
}

// A release laid out the way unpackTarball + stampVersionTxt leave it: a dist/
// with the CLI bundle and (unless suppressed) the staged version sidecar. The
// dist/cli.cjs matters on Windows, where swapCurrent copies it out to cli.js.
function makeStagedRelease(version: string, opts: { sidecar?: string | null } = {}): void {
  const dir = join(tmpRoot, "releases", version);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "dist", "cli.cjs"), "#!/usr/bin/env node\n");
  if (opts.sidecar !== null) {
    writeFileSync(join(dir, "dist", "version.txt"), opts.sidecar ?? `${version}+update\n`);
  }
}

describe("swap / prune (POSIX symlink path)", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tb-swap-"));
    ensureReleasesDir();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("swapCurrent flips the symlink atomically", () => {
    makeRelease("1.0.0");
    makeRelease("1.1.0");

    swapCurrent("1.0.0");
    const link1 = join(tmpRoot, "current");
    expect(lstatSync(link1).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link1)).toBe(join(tmpRoot, "releases", "1.0.0"));

    swapCurrent("1.1.0");
    expect(readlinkSync(link1)).toBe(join(tmpRoot, "releases", "1.1.0"));
  });

  it("publishes the staged sidecar to $INSTALL_DIR/version.txt", () => {
    makeStagedRelease("1.1.0");
    swapCurrent("1.1.0");
    expect(readFileSync(join(tmpRoot, "version.txt"), "utf8")).toBe("1.1.0+update\n");
  });

  // Regression: swapCurrent used to repoint cli.js without republishing
  // version.txt, so getVersion() kept reporting the previously activated build
  // and every subsequent `update --check` reinstalled the same release.
  it("overwrites a stale version.txt left by an earlier activate", () => {
    writeFileSync(join(tmpRoot, "version.txt"), "1.0.0+deploy\n");
    makeStagedRelease("1.1.0");
    swapCurrent("1.1.0");
    expect(readFileSync(join(tmpRoot, "version.txt"), "utf8")).toBe("1.1.0+update\n");
  });

  it("stamps the activated version when the release ships no sidecar", () => {
    makeStagedRelease("1.1.0", { sidecar: null });
    swapCurrent("1.1.0");
    expect(readFileSync(join(tmpRoot, "version.txt"), "utf8")).toBe("1.1.0+update\n");
  });

  it("keeps a sidecar shipped inside the tarball authoritative", () => {
    makeStagedRelease("1.1.0", { sidecar: "1.1.0+ci\n" });
    swapCurrent("1.1.0");
    expect(readFileSync(join(tmpRoot, "version.txt"), "utf8")).toBe("1.1.0+ci\n");
  });

  it("pruneOldReleases keeps the most recent N plus the active one", () => {
    makeRelease("1.0.0");
    makeRelease("1.1.0");
    makeRelease("1.2.0");
    makeRelease("1.3.0");

    const pruned = pruneOldReleases("1.2.0", 2);
    expect(pruned.sort()).toEqual(["1.0.0", "1.1.0"]);

    const remaining = readdirSync(join(tmpRoot, "releases")).sort();
    expect(remaining).toEqual(["1.2.0", "1.3.0"]);
  });

  it("pruneOldReleases keeps the active version even when it would otherwise be pruned", () => {
    makeRelease("1.0.0");
    makeRelease("1.1.0");
    makeRelease("1.2.0");
    makeRelease("1.3.0");

    // active is 1.0.0 (oldest), keep=2 → top 2 are {1.3.0, 1.2.0} + active {1.0.0}
    const pruned = pruneOldReleases("1.0.0", 2).sort();
    expect(pruned).toEqual(["1.1.0"]);

    const remaining = readdirSync(join(tmpRoot, "releases")).sort();
    expect(remaining).toEqual(["1.0.0", "1.2.0", "1.3.0"]);
  });

  it("pruneOldReleases is a no-op when nothing to prune", () => {
    makeRelease("1.0.0");
    makeRelease("1.1.0");
    expect(pruneOldReleases("1.1.0", 2)).toEqual([]);
  });

  it("pruneOldReleases ignores non-semver directories", () => {
    makeRelease("1.0.0");
    mkdirSync(join(tmpRoot, "releases", ".tmp"), { recursive: true });
    mkdirSync(join(tmpRoot, "releases", "garbage"), { recursive: true });
    expect(pruneOldReleases("1.0.0", 2)).toEqual([]);
    expect(existsSync(join(tmpRoot, "releases", "garbage"))).toBe(true);
  });
});
