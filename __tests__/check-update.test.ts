import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateConfig } from "../src/schemas/updateConfig.schema";
import { checkForUpdate } from "../src/updater/check-update";

const baseConfig: UpdateConfig = {
  auto_update: false,
  channel: "stable",
  allow: ["patch", "minor"],
  poll_interval_minutes: 60,
  defer_if_active_sessions: true,
  github_repo: "owner/repo",
  webhook_secret: null,
};

function mockLatest(tagName: string, prerelease = false): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          tag_name: tagName,
          name: tagName,
          prerelease,
          draft: false,
          html_url: `https://example/releases/${tagName}`,
          published_at: "2026-01-01T00:00:00Z",
        }),
      } as Response),
    ),
  );
}

describe("checkForUpdate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports up-to-date when current matches latest", async () => {
    mockLatest("v1.4.2");
    const r = await checkForUpdate({ currentVersion: "1.4.2", config: baseConfig });
    expect(r.wouldInstall).toBe(false);
    expect(r.reason).toMatch(/up to date/i);
  });

  it("would install a patch bump in the default allow list", async () => {
    mockLatest("v1.4.3");
    const r = await checkForUpdate({ currentVersion: "1.4.2", config: baseConfig });
    expect(r.diff).toBe("patch");
    expect(r.wouldInstall).toBe(true);
  });

  it("would install a minor bump in the default allow list", async () => {
    mockLatest("v1.5.0");
    const r = await checkForUpdate({ currentVersion: "1.4.2", config: baseConfig });
    expect(r.diff).toBe("minor");
    expect(r.wouldInstall).toBe(true);
  });

  it("blocks a major bump without --allow-major", async () => {
    mockLatest("v2.0.0");
    const r = await checkForUpdate({ currentVersion: "1.4.2", config: baseConfig });
    expect(r.diff).toBe("major");
    expect(r.wouldInstall).toBe(false);
    expect(r.reason).toMatch(/allow-major/);
  });

  it("permits a major bump with --allow-major", async () => {
    mockLatest("v2.0.0");
    const r = await checkForUpdate({
      currentVersion: "1.4.2",
      config: baseConfig,
      allowMajor: true,
    });
    expect(r.wouldInstall).toBe(true);
  });

  it("blocks a minor bump when allow list excludes minor", async () => {
    mockLatest("v1.5.0");
    const r = await checkForUpdate({
      currentVersion: "1.4.2",
      config: { ...baseConfig, allow: ["patch"] },
    });
    expect(r.wouldInstall).toBe(false);
    expect(r.reason).toMatch(/not in allow list/);
  });

  it("strips tsup build metadata from the current version", async () => {
    mockLatest("v1.4.2");
    const r = await checkForUpdate({
      currentVersion: "1.4.2+abc1234-dirty",
      config: baseConfig,
    });
    expect(r.wouldInstall).toBe(false);
    expect(r.reason).toMatch(/up to date/i);
  });

  it("treats a current-newer-than-latest as no-op", async () => {
    mockLatest("v1.4.0");
    const r = await checkForUpdate({ currentVersion: "1.4.2", config: baseConfig });
    expect(r.wouldInstall).toBe(false);
    expect(r.reason).toMatch(/newer/i);
  });

  it("returns null latest when there is no release for the channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({}),
        } as Response),
      ),
    );
    const r = await checkForUpdate({ currentVersion: "1.4.2", config: baseConfig });
    expect(r.latest).toBeNull();
    expect(r.wouldInstall).toBe(false);
  });
});
