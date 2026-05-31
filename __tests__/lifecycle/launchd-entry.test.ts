import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideShimAction } from "../../cli/launchd-entry";
import { writeMarker } from "../../src/lifecycle/marker";

// These cases exercise the shim's marker-driven decision tree, which only
// runs on darwin — on every other platform the shim short-circuits to
// `platform-mismatch` before reading the marker. The non-darwin behaviour
// is covered by the second describe block below (which fakes process.platform).
describe.runIf(process.platform === "darwin")("decideShimAction", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shim-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("absent marker → exec", () => {
    expect(decideShimAction()).toEqual({ kind: "exec" });
  });

  it("userHeld=true → exit", () => {
    writeMarker({
      devPid: 1,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: true,
      shimVersion: 1,
    });
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "user-held" });
  });

  it("dev pid alive (current process) → exit", () => {
    writeMarker({
      devPid: process.pid,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    });
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "dev-alive" });
  });

  it("dev pid dead → clear marker + exec (auto-restore)", async () => {
    writeMarker({
      devPid: 999999,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    });
    const action = decideShimAction();
    expect(action).toEqual({ kind: "exec", reason: "crash-recovery" });
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).toBeNull();
  });
});

describe("decideShimAction on non-darwin", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns exit (with platform-mismatch reason) on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const action = decideShimAction();
    expect(action).toEqual({ kind: "exit", reason: "platform-mismatch" });
  });
});
