import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDevPlan } from "../../src/lifecycle/dev-takeover";

describe("resolveDevPlan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "takeover-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("no conflict → use requested port", async () => {
    const plan = await resolveDevPlan({
      requestedPort: 9999,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => false,
      portInUse: () => false,
      prompt: vi.fn(),
      findFreePort: vi.fn(),
    });
    expect(plan).toEqual({ kind: "use-port", port: 9999 });
  });

  it("--replace-prod flag wins over everything", async () => {
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: true,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt: vi.fn(),
      findFreePort: vi.fn(),
    });
    expect(plan).toEqual({ kind: "replace-prod", port: 8766 });
  });

  it("conflict + no remembered pref → calls prompt", async () => {
    const prompt = vi.fn().mockResolvedValue({ choice: "use-port", port: 9001, remember: false });
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: () => 9001,
    });
    expect(prompt).toHaveBeenCalled();
    expect(plan).toEqual({ kind: "use-port", port: 9001 });
  });

  it("conflict + remembered 'use-port' pref → honours silently", async () => {
    const { writePrefForRepo } = await import("../../src/lifecycle/prefs");
    writePrefForRepo("/repo/a", { choice: "use-port", port: 9123 });

    const prompt = vi.fn();
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: vi.fn(),
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(plan).toEqual({ kind: "use-port", port: 9123 });
  });

  it("--forget clears the repo pref and re-prompts", async () => {
    const { writePrefForRepo, getPrefForRepo } = await import("../../src/lifecycle/prefs");
    writePrefForRepo("/repo/a", { choice: "use-port", port: 9123 });

    const prompt = vi.fn().mockResolvedValue({ choice: "replace-prod", remember: false });
    await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: true,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: vi.fn(),
    });
    expect(prompt).toHaveBeenCalled();
    expect(getPrefForRepo("/repo/a")).toBeNull(); // forgotten before prompt
  });

  it("prompt remember=true persists the choice", async () => {
    const prompt = vi.fn().mockResolvedValue({ choice: "use-port", port: 9001, remember: true });
    await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: () => 9001,
    });
    const { getPrefForRepo } = await import("../../src/lifecycle/prefs");
    expect(getPrefForRepo("/repo/a")).toMatchObject({ choice: "use-port", port: 9001 });
  });

  it("conflict + null repo (not in git) → still prompts but cannot remember", async () => {
    const prompt = vi.fn().mockResolvedValue({ choice: "use-port", port: 9001, remember: true });
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: null,
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: () => 9001,
    });
    expect(plan).toEqual({ kind: "use-port", port: 9001 });
    // No repo path → nothing to persist; verify prefs file was not created.
    const { existsSync } = await import("node:fs");
    const { prefsPath } = await import("../../src/lifecycle/constants");
    expect(existsSync(prefsPath())).toBe(false);
  });
});
