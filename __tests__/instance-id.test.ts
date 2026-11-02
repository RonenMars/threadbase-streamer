import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  hostname: vi.fn<() => string>(),
  warn: vi.fn(),
  writeHook: { current: null as null | ((...a: unknown[]) => unknown) },
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  h.hostname.mockImplementation(actual.hostname);
  return { ...actual, hostname: h.hostname };
});
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) =>
      h.writeHook.current ? h.writeHook.current(...args) : actual.writeFileSync(...args),
  };
});
vi.mock("../src/logger", () => ({
  getLogger: () => ({ warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getInstanceId, instanceIdPath, resetInstanceIdWarning } from "../src/instance-id";
import { hostSocketPath } from "../src/pty-host/socket";

describe("getInstanceId", () => {
  let dir: string;
  let prevDir: string | undefined;
  let prevId: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-iid-"));
    prevDir = process.env.THREADBASE_CONFIG_DIR;
    prevId = process.env.THREADBASE_INSTANCE_ID;
    process.env.THREADBASE_CONFIG_DIR = dir;
    delete process.env.THREADBASE_INSTANCE_ID;
    h.hostname.mockReturnValue("host-a");
    h.warn.mockClear();
    h.writeHook.current = null;
    resetInstanceIdWarning();
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = prevDir;
    if (prevId === undefined) delete process.env.THREADBASE_INSTANCE_ID;
    else process.env.THREADBASE_INSTANCE_ID = prevId;
    rmSync(dir, { recursive: true, force: true });
  });

  it("env wins and is never persisted", () => {
    process.env.THREADBASE_INSTANCE_ID = "from-env";
    expect(getInstanceId()).toBe("from-env");
    expect(() => readFileSync(instanceIdPath())).toThrow();
  });

  it("env wins over an existing file", () => {
    writeFileSync(instanceIdPath(), "from-file");
    process.env.THREADBASE_INSTANCE_ID = "from-env";
    expect(getInstanceId()).toBe("from-env");
    expect(readFileSync(instanceIdPath(), "utf8")).toBe("from-file");
  });

  it("lives at <config dir>/instance-id and creates the dir when missing", () => {
    process.env.THREADBASE_CONFIG_DIR = join(dir, "nested", "cfg");
    expect(instanceIdPath()).toBe(join(dir, "nested", "cfg", "instance-id"));
    expect(getInstanceId()).toBe("host-a");
    expect(readFileSync(instanceIdPath(), "utf8")).toBe("host-a");
  });

  it("a stored id is returned without a write attempt (read-only config dir)", () => {
    writeFileSync(instanceIdPath(), "stored-id");
    h.writeHook.current = () => {
      throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    };
    expect(getInstanceId()).toBe("stored-id");
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("an empty env falls through to the file / seed", () => {
    process.env.THREADBASE_INSTANCE_ID = "";
    expect(getInstanceId()).toBe("host-a");
  });

  it("first call seeds the file with os.hostname() byte for byte", () => {
    expect(getInstanceId()).toBe("host-a");
    expect(readFileSync(instanceIdPath(), "utf8")).toBe("host-a");
  });

  it("returns the persisted value after the hostname changes", () => {
    expect(getInstanceId()).toBe("host-a");
    h.hostname.mockReturnValue("renamed-laptop");
    expect(getInstanceId()).toBe("host-a");
  });

  it("an existing file is returned as written, trimmed of surrounding whitespace", () => {
    writeFileSync(instanceIdPath(), "stored-id\n");
    expect(getInstanceId()).toBe("stored-id");
  });

  it("an empty file is treated as absent and never overwritten", () => {
    writeFileSync(instanceIdPath(), "");
    expect(getInstanceId()).toBe("host-a");
  });

  it("a blank hostname generates a random id and persists it", () => {
    h.hostname.mockReturnValue("");
    const id = getInstanceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    h.hostname.mockReturnValue("host-b");
    expect(getInstanceId()).toBe(id);
  });

  it("an unwritable config dir falls back to the effective value and logs once", () => {
    // A regular file where the directory should be: mkdir fails even as root.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    process.env.THREADBASE_CONFIG_DIR = join(blocker, "sub");
    expect(getInstanceId()).toBe("host-a");
    expect(getInstanceId()).toBe("host-a");
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it("a lost create race re-reads the winner's value", () => {
    h.writeHook.current = (...args) => {
      // The other process wins between our read and our create.
      h.writeHook.current = null;
      expect(args[2]).toMatchObject({ flag: "wx" });
      writeFileSync(args[0] as string, "winner");
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    };
    expect(getInstanceId()).toBe("winner");
    expect(readFileSync(instanceIdPath(), "utf8")).toBe("winner");
  });

  it("the pty-host socket path on an upgraded install equals the one the old build computed", () => {
    if (process.platform === "win32") return;
    const old = join(dir, "run", `pty-host-${h.hostname()}.sock`);
    expect(hostSocketPath(getInstanceId())).toBe(old);
    h.hostname.mockReturnValue("renamed-laptop");
    expect(hostSocketPath(getInstanceId())).toBe(old);
  });

  it("no source file reads THREADBASE_INSTANCE_ID or the hostname as an id outside the module", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const root = join(__dirname, "..");
    const hits = execFileSync(
      "/usr/bin/grep",
      ["-rnE", "env\\.THREADBASE_INSTANCE_ID", "src", "cli", "--include=*.ts"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter((l) => l && !l.startsWith("src/instance-id.ts:"));
    expect(hits).toEqual([]);
    for (const [file, needle] of [
      ["src/server.ts", /getInstanceId\(\)/g],
      ["src/db/config.ts", /getInstanceId\(\)/g],
      ["cli/prod.ts", /getInstanceId\(\)/g],
    ] as const) {
      expect(readFileSync(join(root, file), "utf8").match(needle)?.length ?? 0).toBeGreaterThan(0);
    }
    const server = readFileSync(join(root, "src/server.ts"), "utf8");
    expect(server.match(/getInstanceId\(\)/g)?.length).toBe(2);
    expect(server).not.toMatch(/instanceId:\s*process\.env/);
    expect(server).not.toMatch(/serverId = process\.env/);
  });
});
