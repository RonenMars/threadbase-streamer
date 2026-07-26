import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lifecycle/marker");
vi.mock("../src/lifecycle/process-liveness");

import {
  decideShimAction,
  findApnsKeyFile,
  loadApnsKeyIntoEnv,
  loadInstallDirEnv,
} from "../cli/launchd-entry";
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

  it("discovers the key by pattern and loads it into the env", () => {
    writeFileSync(join(dir, "AuthKey_ABCDE12345.p8"), `${PEM}\n`);
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY).toBe(PEM);
  });

  // The whole point of globbing: a rotated key is a drop-in, and the id travels
  // with it so the JWT cannot claim an id that does not match the signing key.
  it("derives the key id from the filename", () => {
    writeFileSync(join(dir, "AuthKey_ZZ99YY88XX.p8"), PEM);
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY_ID).toBe("ZZ99YY88XX");
  });

  it("finds a rotated key under a different id without a code change", () => {
    writeFileSync(join(dir, "AuthKey_ROTATED123.p8"), PEM);
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY).toBe(PEM);
    expect(env.APNS_KEY_ID).toBe("ROTATED123");
  });

  // An operator overriding per-invocation must win over the file on disk.
  it("does not overwrite an APNS_KEY already in the environment", () => {
    writeFileSync(join(dir, "AuthKey_ABCDE12345.p8"), PEM);
    const env: NodeJS.ProcessEnv = { APNS_KEY: "explicit-override" };

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY).toBe("explicit-override");
  });

  it("does not overwrite an explicit APNS_KEY_ID", () => {
    writeFileSync(join(dir, "AuthKey_ABCDE12345.p8"), PEM);
    const env: NodeJS.ProcessEnv = { APNS_KEY_ID: "MANUALKEY1" };

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY_ID).toBe("MANUALKEY1");
  });

  // Live Activity push is optional: a missing credential must not stop the
  // server from starting.
  it("is a no-op when no key file is present", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadApnsKeyIntoEnv(env, dir)).not.toThrow();
    expect(env.APNS_KEY).toBeUndefined();
  });

  it("ignores files that are not APNs auth keys", () => {
    writeFileSync(join(dir, "server.yaml"), "api_key: tb_x");
    writeFileSync(join(dir, "notes.p8.txt"), PEM);
    writeFileSync(join(dir, "AuthKey_short.p8"), PEM);
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY).toBeUndefined();
  });

  // An empty file looks installed but would fail signing with an opaque APNs
  // error, so it must not be loaded as if it were a key.
  it("ignores an empty key file", () => {
    writeFileSync(join(dir, "AuthKey_EMPTY12345.p8"), "   \n");
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY).toBeUndefined();
  });

  it("does not throw when the install dir does not exist", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadApnsKeyIntoEnv(env, join(dir, "nope"))).not.toThrow();
    expect(env.APNS_KEY).toBeUndefined();
  });

  // Two keys is ambiguous; picking the newest is a choice that must be stable
  // rather than filesystem-order dependent.
  it("prefers the newest key when several are installed", () => {
    const older = join(dir, "AuthKey_OLDKEY1234.p8");
    const newer = join(dir, "AuthKey_NEWKEY5678.p8");
    writeFileSync(older, `${PEM}-old`);
    writeFileSync(newer, `${PEM}-new`);
    utimesSync(older, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    utimesSync(newer, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const env: NodeJS.ProcessEnv = {};

    loadApnsKeyIntoEnv(env, dir);

    expect(env.APNS_KEY_ID).toBe("NEWKEY5678");
  });
});

describe("findApnsKeyFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-apns-find-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the path and id for an installed key", () => {
    writeFileSync(join(dir, "AuthKey_FAKEKEY123.p8"), "pem");

    expect(findApnsKeyFile(dir)).toEqual({
      path: join(dir, "AuthKey_FAKEKEY123.p8"),
      keyId: "FAKEKEY123",
    });
  });

  it("returns null when nothing matches", () => {
    expect(findApnsKeyFile(dir)).toBeNull();
  });
});

describe("loadInstallDirEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-envfile-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The gap this closes: dotenv/config in cli/index.ts reads .env from cwd,
  // which is / under launchd, so a supervised instance never sees it.
  it("loads KEY=value lines from the install dir", () => {
    writeFileSync(join(dir, ".env"), "APNS_TEAM_ID=TEAM123456\nAPNS_BUNDLE_ID=com.example.app\n");
    const env: NodeJS.ProcessEnv = {};

    loadInstallDirEnv(env, dir);

    expect(env.APNS_TEAM_ID).toBe("TEAM123456");
    expect(env.APNS_BUNDLE_ID).toBe("com.example.app");
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(join(dir, ".env"), "# a comment\n\n  \nAPNS_TEAM_ID=T1\n");
    const env: NodeJS.ProcessEnv = {};

    loadInstallDirEnv(env, dir);

    expect(env.APNS_TEAM_ID).toBe("T1");
    expect(Object.keys(env)).toEqual(["APNS_TEAM_ID"]);
  });

  // An explicit export must beat the file, matching dotenv's own precedence.
  it("does not override an already-set variable", () => {
    writeFileSync(join(dir, ".env"), "APNS_TEAM_ID=FROMFILE\n");
    const env: NodeJS.ProcessEnv = { APNS_TEAM_ID: "FROMSHELL" };

    loadInstallDirEnv(env, dir);

    expect(env.APNS_TEAM_ID).toBe("FROMSHELL");
  });

  it("strips one layer of matching quotes", () => {
    writeFileSync(join(dir, ".env"), `A="quoted value"\nB='single'\nC=bare\n`);
    const env: NodeJS.ProcessEnv = {};

    loadInstallDirEnv(env, dir);

    expect(env.A).toBe("quoted value");
    expect(env.B).toBe("single");
    expect(env.C).toBe("bare");
  });

  it("keeps '=' inside a value", () => {
    writeFileSync(join(dir, ".env"), "TOKEN=abc=def==\n");
    const env: NodeJS.ProcessEnv = {};

    loadInstallDirEnv(env, dir);

    expect(env.TOKEN).toBe("abc=def==");
  });

  it("skips malformed lines without throwing", () => {
    writeFileSync(join(dir, ".env"), "no_equals_here\n=novalue\nGOOD=yes\n");
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadInstallDirEnv(env, dir)).not.toThrow();
    expect(env.GOOD).toBe("yes");
  });

  // A missing .env is the ordinary state and must not be an error.
  it("is a no-op when no .env exists", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadInstallDirEnv(env, dir)).not.toThrow();
    expect(Object.keys(env)).toEqual([]);
  });
});
