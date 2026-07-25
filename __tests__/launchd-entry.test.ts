import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lifecycle/marker");
vi.mock("../src/lifecycle/process-liveness");

import { decideShimAction, loadApnsKeyIntoEnv } from "../cli/launchd-entry";
import { clearMarker, readMarker } from "../src/lifecycle/marker";
import { isPidAlive } from "../src/lifecycle/process-liveness";

const mockReadMarker = vi.mocked(readMarker);
const mockIsPidAlive = vi.mocked(isPidAlive);
const mockClearMarker = vi.mocked(clearMarker);

const MARKER = {
  devPid: 1234,
  port: 8766,
  repoToplevel: "/tmp/repo",
  suspendedAt: new Date().toISOString(),
  userHeld: false,
  shimVersion: 1 as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

describe("decideShimAction", () => {
  it("executes when no marker exists", () => {
    mockReadMarker.mockReturnValue(null);
    expect(decideShimAction()).toEqual({ kind: "exec" });
  });

  it("exits when dev PID is alive and not userHeld", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: false });
    mockIsPidAlive.mockReturnValue(true);
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "dev-alive" });
  });

  it("exits when dev PID is alive and userHeld", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: true });
    mockIsPidAlive.mockReturnValue(true);
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "user-held" });
  });

  it("auto-restores when dev PID is dead (userHeld=false)", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: false });
    mockIsPidAlive.mockReturnValue(false);
    expect(decideShimAction()).toEqual({ kind: "exec", reason: "crash-recovery" });
    expect(mockClearMarker).toHaveBeenCalledOnce();
  });

  it("auto-restores when dev PID is dead even if userHeld=true (stale marker)", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: true });
    mockIsPidAlive.mockReturnValue(false);
    expect(decideShimAction()).toEqual({ kind: "exec", reason: "crash-recovery" });
    expect(mockClearMarker).toHaveBeenCalledOnce();
  });
});

describe("loadApnsKeyIntoEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-apns-key-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const PEM = "-----BEGIN PRIVATE KEY-----\nMIGTdummy\n-----END PRIVATE KEY-----";

  it("loads the key file into the env for the spawned server", () => {
    const keyPath = join(dir, "AuthKey_TEST12345.p8");
    writeFileSync(keyPath, `${PEM}\n`);
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, keyPath);

    expect(env.APNS_KEY).toBe(PEM);
  });

  // An operator overriding per-invocation must win over the file on disk.
  it("does not overwrite an APNS_KEY already in the environment", () => {
    const keyPath = join(dir, "AuthKey_TEST12345.p8");
    writeFileSync(keyPath, PEM);
    const env: NodeJS.ProcessEnv = { APNS_KEY: "explicit-override" };

    loadApnsKeyIntoEnv(env, keyPath);

    expect(env.APNS_KEY).toBe("explicit-override");
  });

  // Live Activity push is optional: a missing credential must not stop the
  // server from starting.
  it("is a no-op when the key file is absent", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadApnsKeyIntoEnv(env, join(dir, "missing.p8"))).not.toThrow();
    expect(env.APNS_KEY).toBeUndefined();
  });

  // An empty file looks installed but would fail signing with an opaque APNs
  // error, so it must not be loaded as if it were a key.
  it("ignores an empty key file", () => {
    const keyPath = join(dir, "AuthKey_EMPTY.p8");
    writeFileSync(keyPath, "   \n");
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, keyPath);

    expect(env.APNS_KEY).toBeUndefined();
  });

  it("does not throw when the key file is unreadable", () => {
    const env: NodeJS.ProcessEnv = {};
    // A directory at the key path fails the read rather than the existsSync.
    expect(() => loadApnsKeyIntoEnv(env, dir)).not.toThrow();
    expect(env.APNS_KEY).toBeUndefined();
  });
});
