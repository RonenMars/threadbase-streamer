import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideShimAction } from "../../cli/launchd-entry";
import { writeMarker } from "../../src/lifecycle/marker";

describe("decideShimAction", () => {
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
