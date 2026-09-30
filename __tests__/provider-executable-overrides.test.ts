import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { spawn } from "node-pty";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { LiveSessionManager } from "../src/live-session-manager";
import type { ProviderName } from "../src/providers";

vi.unmock("../src/platform");
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const events = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => events.on("data", cb),
      onExit: (cb: (event: { exitCode: number }) => void) => events.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }),
}));

const providers = [
  ["claude-code", "claude_executable", "resolveClaudeExe"],
  ["codex-cli", "codex_executable", "resolveCodexExe"],
  ["cursor", "cursor_executable", "resolveCursorExe"],
] as const;

let root: string;
let manager: LiveSessionManager | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(spawn).mockClear();
  root = mkdtempSync(join(tmpdir(), "tb-provider-executable-"));
  vi.stubEnv("THREADBASE_CONFIG_DIR", root);
});

afterEach(() => {
  manager?.dispose();
  manager = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function configure(key: string, value: string): void {
  writeFileSync(join(root, "server.yaml"), `${key}: ${value}\n`);
}

async function start(provider: ProviderName, resume = false): Promise<void> {
  const { LiveSessionManager } = await import("../src/live-session-manager");
  manager ??= new LiveSessionManager();
  const options = { provider, projectPath: root, branch: "main" };
  if (resume) await manager.start("test-session", options);
  else await manager.startFresh(options);
}

it.each(providers)(
  "uses the %s override for discovery and fresh/resumed sessions",
  async (provider, key, resolver) => {
    configure(key, process.execPath);
    const platform = await import("../src/platform");
    expect(platform[resolver]()).toBe(process.execPath);
    expect(platform.locateProviderExe(provider)).toBe(process.execPath);

    await start(provider);
    await start(provider, true);
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const [exe] of vi.mocked(spawn).mock.calls) expect(exe).toBe(process.execPath);
  },
);

it.each(providers)("refuses an invalid %s override before spawning", async (provider, key) => {
  configure(key, join(root, "missing-cli"));
  await expect(start(provider)).rejects.toMatchObject({
    statusCode: 503,
    code: "PROVIDER_EXECUTABLE_INVALID",
    message: expect.stringContaining(key),
  });
  expect(spawn).not.toHaveBeenCalled();
});

it.each(["", "agent", "./agent", "~/bin/agent"])(
  "rejects a non-absolute override %j without consuming the next config line",
  async (value) => {
    writeFileSync(join(root, "server.yaml"), `cursor_executable: ${value}\nbrowse_root: ${root}\n`);
    await expect(start("cursor")).rejects.toMatchObject({
      code: "PROVIDER_EXECUTABLE_INVALID",
      message: expect.stringContaining("cursor_executable"),
    });
    expect(spawn).not.toHaveBeenCalled();
  },
);

it("rejects a directory as an executable", async () => {
  configure("cursor_executable", root);
  await expect(start("cursor")).rejects.toMatchObject({ code: "PROVIDER_EXECUTABLE_INVALID" });
});

it.skipIf(process.platform === "win32")("rejects a non-executable file", async () => {
  const exe = join(root, "agent");
  writeFileSync(exe, "#!/bin/sh\n", { mode: 0o644 });
  configure("cursor_executable", exe);
  await expect(start("cursor")).rejects.toMatchObject({ code: "PROVIDER_EXECUTABLE_INVALID" });
});

it.each(["plain", "single", "double"])(
  "keeps spaces in a %s executable path as part of argv[0]",
  async (format) => {
    const dir = join(root, "Agent Tools");
    mkdirSync(dir);
    const exe = join(dir, process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent");
    writeFileSync(exe, "", { mode: 0o755 });
    configure(
      "cursor_executable",
      format === "double" ? JSON.stringify(exe) : format === "single" ? `'${exe}'` : exe,
    );
    await start("cursor");
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe(exe);
  },
);

it("does not interpret arguments as part of an executable override", async () => {
  configure("cursor_executable", `${process.execPath} --version`);
  await expect(start("cursor")).rejects.toMatchObject({ code: "PROVIDER_EXECUTABLE_INVALID" });
  expect(spawn).not.toHaveBeenCalled();
});

it("reports an invalid override in provider health without disabling other providers", async () => {
  writeFileSync(
    join(root, "server.yaml"),
    `cursor_executable: ${join(root, "missing")}\nclaude_executable: ${process.execPath}\n`,
  );
  const { providerHealth } = await import("../src/services/providers/providerHealth");
  expect(await providerHealth("cursor")).toMatchObject({
    available: false,
    warnings: [
      {
        code: "provider_executable_invalid",
        message: expect.stringContaining("cursor_executable"),
      },
    ],
  });
  expect(await providerHealth("claude-code")).toMatchObject({ available: true });
});

it("keeps a resolved override until its cache is refreshed", async () => {
  configure("cursor_executable", process.execPath);
  const { resolveCursorExe, clearCursorExeCache } = await import("../src/platform");
  expect(resolveCursorExe()).toBe(process.execPath);
  configure("cursor_executable", join(root, "missing"));
  expect(resolveCursorExe()).toBe(process.execPath);
  clearCursorExeCache();
  expect(() => resolveCursorExe()).toThrow(/cursor_executable/);
});

it("reports an invalid override from diagnostics without a filesystem path", async () => {
  writeFileSync(join(root, "server.yaml"), `cursor_executable: ${join(root, "missing")}\n`);
  const { createDiagnosticsRoutes } = await import("../src/api/routes/diagnostics.routes");
  const app = createDiagnosticsRoutes({
    cacheMonitor: () => null,
    managedSessionsRepo: () => null,
    sessionVerdicts: () => new Map(),
  } as never);
  const body = (await (await app.request("/")).json()) as {
    checks: Array<{ id: string; status: string; remediation: string; summary: string }>;
  };
  const cursor = body.checks.find((check) => check.id === "provider:cursor");
  expect(cursor).toMatchObject({
    status: "failed",
    remediation: "PROVIDER_EXECUTABLE_INVALID",
    summary: expect.stringContaining("cursor_executable"),
  });
  expect(cursor?.summary).not.toContain(root);
});

it("refreshes a cached override when a streamer subscribes to the pty host", async () => {
  configure("cursor_executable", process.execPath);
  const { resolveCursorExe } = await import("../src/platform");
  expect(resolveCursorExe()).toBe(process.execPath);
  configure("cursor_executable", join(root, "missing"));
  expect(resolveCursorExe()).toBe(process.execPath);

  const { SessionHost } = await import("../src/pty-host/host");
  const { encodeMessage } = await import("../src/pty-host/protocol");
  const host = new SessionHost({ idleSweepMs: 60_000, orphanSweepMs: 60_000 });
  let onLine: (chunk: string) => void = () => {};
  const dispose = host.accept({
    send: () => {},
    onLine: (handler) => {
      onLine = handler;
    },
    onClose: () => {},
    close: () => {},
  });
  try {
    onLine(encodeMessage({ id: 1, type: "subscribe" }));
    await vi.waitFor(() => {
      expect(() => resolveCursorExe()).toThrow(/cursor_executable/);
    });
  } finally {
    dispose();
    host.dispose();
  }
});

it("prefers cursor-agent even when another provider owns agent earlier on PATH", async () => {
  const grokDir = join(root, "grok");
  const cursorDir = join(root, "cursor");
  mkdirSync(grokDir);
  mkdirSync(cursorDir);
  const suffix = process.platform === "win32" ? ".cmd" : "";
  writeFileSync(join(grokDir, `agent${suffix}`), "", { mode: 0o755 });
  const cursor = join(cursorDir, `cursor-agent${suffix}`);
  writeFileSync(cursor, "", { mode: 0o755 });
  vi.stubEnv("PATH", [grokDir, cursorDir, process.env.PATH].join(delimiter));
  await start("cursor");
  // where.exe expands an 8.3 temp path; both forms name the same file.
  expect(realpathSync(vi.mocked(spawn).mock.calls[0][0])).toBe(realpathSync(cursor));
});
