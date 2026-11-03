import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateConfig } from "../src/schemas/updateConfig.schema";
import type { ReleaseManifest } from "../src/updater/manifest";
import { platformKey } from "../src/updater/manifest";

// Everything the installer writes goes under a temp root, never ~/.threadbase.
const { root } = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "tb-install-tarball-")) };
});

vi.mock("../src/updater/paths", () => {
  const { join } = require("node:path") as typeof import("node:path");
  const DOWNLOAD_DIR = join(root, "releases", ".tmp");
  return {
    THREADBASE_ROOT: root,
    RELEASES_DIR: join(root, "releases"),
    CURRENT_SYMLINK: join(root, "current"),
    DOWNLOAD_DIR,
    releaseDir: (v: string) => join(root, "releases", v),
    downloadPath: (v: string, f: string) => join(DOWNLOAD_DIR, `${v}-${f}`),
  };
});

const cfg: UpdateConfig = {
  auto_update: true,
  channel: "stable",
  allow: ["patch", "minor"],
  poll_interval_minutes: 60,
  defer_if_active_sessions: false,
  github_repo: "owner/repo",
  webhook_secret: null,
};

const filename = `threadbase-streamer-1.0.1-${platformKey()}.tgz`;

const release = {
  version: "1.0.1",
  tagName: "v1.0.1",
  prerelease: false,
  htmlUrl: "https://example/r/v1.0.1",
  publishedAt: "2026-01-01T00:00:00Z",
  assets: [
    { name: "manifest.json", browserDownloadUrl: "https://example/manifest.json", size: 100 },
    { name: filename, browserDownloadUrl: "https://example/tarball.tgz", size: 1000 },
  ],
};

const manifest: ReleaseManifest = {
  version: "1.0.1",
  schemaVersion: 1,
  artifacts: {
    [platformKey()]: { filename, sha256: "a".repeat(64), size: 1000 },
  },
};

vi.mock("../src/updater/github-releases", () => ({
  fetchLatestRelease: vi.fn(async () => release),
  fetchReleaseByTag: vi.fn(async () => release),
}));

// The download mock writes the file the real one would leave on disk.
vi.mock("../src/updater/download", () => ({
  fetchManifest: vi.fn(async () => manifest),
  downloadAndVerify: vi.fn(async ({ targetPath }: { targetPath: string }) => {
    const { writeFileSync: write } = require("node:fs") as typeof import("node:fs");
    write(targetPath, "tarball");
    return { path: targetPath, bytes: 7 };
  }),
}));

vi.mock("../src/updater/unpack", () => ({ unpackTarball: vi.fn(async () => undefined) }));
vi.mock("../src/updater/stamp-version", () => ({ stampVersionTxt: vi.fn() }));
vi.mock("../src/updater/swap", () => ({
  ensureReleasesDir: vi.fn(),
  swapCurrent: vi.fn(),
  pruneOldReleases: vi.fn(() => []),
}));
vi.mock("../src/updater/restart", () => ({
  restartService: vi.fn(async () => ({ method: "launchctl", stdout: "", stderr: "" })),
  stopService: vi.fn(async () => ({ method: "noop", stdout: "", stderr: "" })),
}));
vi.mock("../src/updater/restart-health", () => ({
  waitForRestartHealth: vi.fn(async () => undefined),
}));
vi.mock("../src/updater/active-sessions", () => ({
  countActiveSessions: vi.fn(async () => ({ kind: "count", count: 0 })),
}));
vi.mock("../src/updater/brew-detect", () => ({ isBrewInstall: vi.fn(() => false) }));
vi.mock("../src/updater/update-log", () => ({ appendUpdateLog: vi.fn() }));

import { runInstall } from "../src/updater/install";
import { unpackTarball } from "../src/updater/unpack";

const downloadDir = join(root, "releases", ".tmp");
const tarball = join(downloadDir, `1.0.1-${filename}`);
const olderTarball = join(downloadDir, "1.0.0-threadbase-streamer-1.0.0-other.tgz");

describe("runInstall tarball cleanup (#872)", () => {
  beforeEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(olderTarball, "older");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("deletes the tarball it downloaded once the install succeeds", async () => {
    const r = await runInstall({ currentVersion: "1.0.0", config: cfg });
    expect(r.kind).toBe("installed");
    expect(existsSync(tarball)).toBe(false);
  });

  it("leaves other files in the download dir alone", async () => {
    await runInstall({ currentVersion: "1.0.0", config: cfg });
    expect(existsSync(olderTarball)).toBe(true);
  });

  it("keeps the tarball when unpacking fails", async () => {
    vi.mocked(unpackTarball).mockRejectedValueOnce(new Error("disk full"));
    await expect(runInstall({ currentVersion: "1.0.0", config: cfg })).rejects.toThrow("disk full");
    expect(existsSync(tarball)).toBe(true);
  });
});
