import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUpdateConfig } from "../src/config/update-config";

describe("loadUpdateConfig", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-update-"));
    path = join(dir, "update.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file is missing", () => {
    expect(loadUpdateConfig({ path })).toBeNull();
  });

  it("applies defaults when only github_repo is provided", () => {
    writeFileSync(path, "github_repo: owner/repo\n");
    const cfg = loadUpdateConfig({ path });
    expect(cfg).toEqual({
      auto_update: false,
      channel: "stable",
      allow: ["patch", "minor"],
      poll_interval_minutes: 1440,
      defer_if_active_sessions: true,
      github_repo: "owner/repo",
      webhook_secret: null,
    });
  });

  it("parses a fully-populated file", () => {
    writeFileSync(
      path,
      [
        "auto_update: true",
        "channel: next",
        "allow:",
        "  - patch",
        "  - minor",
        "  - major",
        "poll_interval_minutes: 15",
        "defer_if_active_sessions: false",
        "github_repo: RonenMars/tb-streamer",
        "webhook_secret: abc123",
      ].join("\n"),
    );
    const cfg = loadUpdateConfig({ path });
    expect(cfg).toMatchObject({
      auto_update: true,
      channel: "next",
      allow: ["patch", "minor", "major"],
      poll_interval_minutes: 15,
      defer_if_active_sessions: false,
      github_repo: "RonenMars/tb-streamer",
      webhook_secret: "abc123",
    });
  });

  it("throws when github_repo is missing", () => {
    writeFileSync(path, "auto_update: true\n");
    expect(() => loadUpdateConfig({ path })).toThrow();
  });

  it("throws on malformed github_repo", () => {
    writeFileSync(path, "github_repo: not-a-slash-separated-name\n");
    expect(() => loadUpdateConfig({ path })).toThrow();
  });

  it("throws on unknown fields (strict mode)", () => {
    writeFileSync(path, "github_repo: owner/repo\nunknown_field: 1\n");
    expect(() => loadUpdateConfig({ path })).toThrow();
  });

  it("throws when the file is empty", () => {
    writeFileSync(path, "");
    expect(() => loadUpdateConfig({ path })).toThrow(/empty/);
  });
});
