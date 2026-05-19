import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateConfig } from "../src/schemas/updateConfig.schema";
import type { ReleaseManifest } from "../src/updater/manifest";
import { platformKey } from "../src/updater/manifest";

const cfg: UpdateConfig = {
  auto_update: true,
  channel: "stable",
  allow: ["patch", "minor"],
  poll_interval_minutes: 60,
  defer_if_active_sessions: true,
  github_repo: "owner/repo",
  webhook_secret: null,
};

const release = {
  version: "1.0.1",
  tagName: "v1.0.1",
  prerelease: false,
  htmlUrl: "https://example/r/v1.0.1",
  publishedAt: "2026-01-01T00:00:00Z",
  assets: [
    { name: "manifest.json", browserDownloadUrl: "https://example/manifest.json", size: 100 },
    {
      name: `threadbase-streamer-1.0.1-${platformKey()}.tgz`,
      browserDownloadUrl: "https://example/tarball.tgz",
      size: 1000,
    },
    // win32-x64 tarball — used by the Windows-only swap-ordering test below
    // when process.platform is temporarily flipped to "win32".
    {
      name: "threadbase-streamer-1.0.1-win32-x64.tgz",
      browserDownloadUrl: "https://example/tarball-win.tgz",
      size: 1000,
    },
  ],
};

const manifest: ReleaseManifest = {
  version: "1.0.1",
  schemaVersion: 1,
  artifacts: {
    [platformKey()]: {
      filename: `threadbase-streamer-1.0.1-${platformKey()}.tgz`,
      sha256: "a".repeat(64),
      size: 1000,
    },
    "win32-x64": {
      filename: "threadbase-streamer-1.0.1-win32-x64.tgz",
      sha256: "b".repeat(64),
      size: 1000,
    },
  },
};

vi.mock("../src/updater/github-releases", () => ({
  fetchLatestRelease: vi.fn(async () => release),
  fetchReleaseByTag: vi.fn(async () => release),
}));

vi.mock("../src/updater/download", () => ({
  fetchManifest: vi.fn(async () => manifest),
  downloadAndVerify: vi.fn(async () => ({ path: "/tmp/x.tgz", bytes: 1000 })),
}));

vi.mock("../src/updater/unpack", () => ({
  unpackTarball: vi.fn(async () => undefined),
}));

vi.mock("../src/updater/swap", () => ({
  ensureReleasesDir: vi.fn(),
  swapCurrent: vi.fn(),
  pruneOldReleases: vi.fn(() => ["0.9.0"]),
}));

vi.mock("../src/updater/restart", () => ({
  restartService: vi.fn(async () => ({ method: "launchctl", stdout: "", stderr: "" })),
  stopService: vi.fn(async () => ({ method: "noop", stdout: "", stderr: "" })),
}));

vi.mock("../src/updater/active-sessions", () => ({
  countActiveSessions: vi.fn(async () => 0),
}));

import { countActiveSessions } from "../src/updater/active-sessions";
import { downloadAndVerify, fetchManifest } from "../src/updater/download";
import { runInstall } from "../src/updater/install";
import { restartService, stopService } from "../src/updater/restart";
import { ensureReleasesDir, pruneOldReleases, swapCurrent } from "../src/updater/swap";
import { unpackTarball } from "../src/updater/unpack";

describe("runInstall orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no-op when current is already latest", async () => {
    const r = await runInstall({ currentVersion: "1.0.1", config: cfg });
    expect(r.kind).toBe("no-op");
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(swapCurrent).not.toHaveBeenCalled();
  });

  it("dry-run returns tarball URL without installing", async () => {
    const r = await runInstall({ currentVersion: "1.0.0", config: cfg, dryRun: true });
    expect(r.kind).toBe("dry-run");
    if (r.kind === "dry-run") expect(r.tarballUrl).toBe("https://example/tarball.tgz");
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(swapCurrent).not.toHaveBeenCalled();
  });

  it("defers when active sessions are running", async () => {
    vi.mocked(countActiveSessions).mockResolvedValueOnce(2);
    const r = await runInstall({
      currentVersion: "1.0.0",
      config: cfg,
      runningServer: { port: 3456, apiKey: "tb_x" },
    });
    expect(r.kind).toBe("deferred");
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(swapCurrent).not.toHaveBeenCalled();
  });

  it("--force skips the active-session check", async () => {
    vi.mocked(countActiveSessions).mockResolvedValueOnce(2);
    const r = await runInstall({
      currentVersion: "1.0.0",
      config: cfg,
      force: true,
      runningServer: { port: 3456, apiKey: "tb_x" },
    });
    expect(r.kind).toBe("installed");
    expect(countActiveSessions).not.toHaveBeenCalled();
  });

  it("end-to-end install runs steps in the correct order", async () => {
    const r = await runInstall({ currentVersion: "1.0.0", config: cfg });
    expect(r.kind).toBe("installed");
    if (r.kind === "installed") {
      expect(r.previous).toBe("1.0.0");
      expect(r.installed).toBe("1.0.1");
      expect(r.pruned).toEqual(["0.9.0"]);
      expect(r.restart.method).toBe("launchctl");
    }

    // Order: fetchManifest → downloadAndVerify → unpackTarball → ensureReleasesDir+swap → prune → restart
    const fetchOrder = vi.mocked(fetchManifest).mock.invocationCallOrder[0];
    const downloadOrder = vi.mocked(downloadAndVerify).mock.invocationCallOrder[0];
    const unpackOrder = vi.mocked(unpackTarball).mock.invocationCallOrder[0];
    const ensureOrder = vi.mocked(ensureReleasesDir).mock.invocationCallOrder[0];
    const swapOrder = vi.mocked(swapCurrent).mock.invocationCallOrder[0];
    const pruneOrder = vi.mocked(pruneOldReleases).mock.invocationCallOrder[0];
    const restartOrder = vi.mocked(restartService).mock.invocationCallOrder[0];

    expect(fetchOrder).toBeLessThan(downloadOrder);
    expect(downloadOrder).toBeLessThan(unpackOrder);
    expect(unpackOrder).toBeLessThan(swapOrder);
    expect(ensureOrder).toBeLessThan(swapOrder);
    expect(swapOrder).toBeLessThan(pruneOrder);
    expect(pruneOrder).toBeLessThan(restartOrder);
  });

  it("returns installed result with a 'failed' restart method when restart throws", async () => {
    vi.mocked(restartService).mockRejectedValueOnce(new Error("launchctl not found"));
    const r = await runInstall({ currentVersion: "1.0.0", config: cfg });
    expect(r.kind).toBe("installed");
    if (r.kind === "installed") {
      expect(r.restart.method).toMatch(/^failed:/);
    }
  });

  it("uses --version pin instead of latest", async () => {
    const r = await runInstall({ currentVersion: "1.0.0", config: cfg, pinnedVersion: "1.0.1" });
    expect(r.kind).toBe("installed");
  });

  it("on Windows, stops the service before swapCurrent so the file replace can win against open handles", async () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "x64" });
    try {
      const r = await runInstall({ currentVersion: "1.0.0", config: cfg });
      expect(r.kind).toBe("installed");
      expect(stopService).toHaveBeenCalled();
      const stopOrder = vi.mocked(stopService).mock.invocationCallOrder[0];
      const swapOrder = vi.mocked(swapCurrent).mock.invocationCallOrder[0];
      expect(stopOrder).toBeLessThan(swapOrder);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      Object.defineProperty(process, "arch", { value: originalArch });
    }
  });

  it("on macOS/Linux, does NOT call stopService (atomic symlink swap doesn't need it)", async () => {
    const r = await runInstall({ currentVersion: "1.0.0", config: cfg });
    expect(r.kind).toBe("installed");
    expect(stopService).not.toHaveBeenCalled();
  });
});
