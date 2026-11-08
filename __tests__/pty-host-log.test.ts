// The pty-host runs with no terminal and no supervisor, so its own log file is
// the only record of why it reaped or lost a session (#512).

import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node-pty", () => {
  const procs: any[] = [];
  return {
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      const proc = {
        pid: 41000 + procs.length,
        onData: (cb: (d: string) => void) => ee.on("data", cb),
        onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
        write: vi.fn(),
        kill: vi.fn(),
        _emit: ee.emit.bind(ee),
      };
      procs.push(proc);
      return proc;
    }),
  };
});

const { HOST_IDLE_AFTER_MS, SessionHost } = await import("../src/pty-host/host");
const { connectToHost, hostSocketPath, listenForStreamers } = await import(
  "../src/pty-host/socket"
);
const { RemoteSessionRunner } = await import("../src/pty-host/remote-session-runner");
const { spawnDetachedHost } = await import("../src/pty-host/spawn-host");
const { ptyHostLogPath } = await import("../src/lifecycle/constants");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function withEnv(key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  cleanups.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

describe("pty-host log file", () => {
  it("receives what the detached host prints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-host-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    withEnv("THREADBASE_INSTALL_DIR", dir);
    const entry = join(dir, "fake-entry.js");
    writeFileSync(entry, 'console.log("host says hi"); console.error("host says oops");');

    spawnDetachedHost(join(dir, "s.sock"), entry);

    expect(ptyHostLogPath()).toBe(join(dir, "logs", "pty-host.log"));
    await vi.waitFor(() => {
      expect(existsSync(ptyHostLogPath())).toBe(true);
      const text = readFileSync(ptyHostLogPath(), "utf8");
      expect(text).toContain("host says hi");
      expect(text).toContain("host says oops");
    });
  });

  it("still starts the host when the log cannot be opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-host-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // A file where the logs directory should be: mkdir/open fails.
    writeFileSync(join(dir, "logs"), "not a directory");
    withEnv("THREADBASE_INSTALL_DIR", dir);
    const marker = join(dir, "ran");
    const entry = join(dir, "fake-entry.js");
    writeFileSync(entry, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);

    spawnDetachedHost(join(dir, "s.sock"), entry);

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
  });
});

describe("pty-host events reach the log", () => {
  function capture() {
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const record = (msg: string, fields?: Record<string, unknown>) => {
      lines.push({ msg, fields });
    };
    const logger: any = {
      debug: () => {},
      info: record,
      warn: record,
      error: record,
      log: (_l: string, m: string, f?: Record<string, unknown>) => record(m, f),
      pino: {},
    };
    return { lines, logger, events: () => lines.map((l) => l.fields?.event) };
  }

  async function startHost(options: ConstructorParameters<typeof SessionHost>[0]) {
    const configDir = mkdtempSync(join(tmpdir(), "tbh-"));
    withEnv("THREADBASE_CONFIG_DIR", configDir);
    const socketPath = hostSocketPath(`l${Math.random().toString(36).slice(2, 8)}`);
    const host = new SessionHost({ idleSweepMs: 1_000_000, orphanSweepMs: 1_000_000, ...options });
    const server = await listenForStreamers(socketPath, {
      onConnection: (transport) => host.accept(transport),
    });
    cleanups.push(() => {
      host.dispose();
      server.close();
    });
    const runner = await RemoteSessionRunner.connect(await connectToHost(socketPath), {});
    cleanups.push(() => runner.dispose());
    return { host, runner };
  }

  async function lastProc() {
    const pty = await import("node-pty");
    return (pty.spawn as any).mock.results.at(-1)?.value;
  }

  it("logs an agent process exit with the session id", async () => {
    const { logger, lines } = capture();
    const { runner } = await startHost({ logger });
    await runner.start("gone", { projectPath: tmpdir(), projectName: "p" });
    (await lastProc())._emit("exit", { exitCode: 0 });

    await vi.waitFor(() =>
      expect(lines.find((l) => l.fields?.event === "pty_host.session_exit")?.fields).toMatchObject({
        sessionId: "gone",
      }),
    );
  });

  it("logs one session_exit with reason shutdown when the streamer stops the agent", async () => {
    const { logger, lines } = capture();
    const { runner } = await startHost({ logger });
    await runner.start("held", { projectPath: tmpdir(), projectName: "p" });

    runner.putOnHold("held");
    // putOnHold drops the session before the child exits, so the late exit is
    // the second report the host must not turn into a second line.
    await vi.waitFor(() =>
      expect(lines.filter((l) => l.fields?.event === "pty_host.session_exit")).toHaveLength(1),
    );
    (await lastProc())._emit("exit", { exitCode: 0 });
    await new Promise((r) => setTimeout(r, 50));

    const exits = lines.filter((l) => l.fields?.event === "pty_host.session_exit");
    expect(exits).toHaveLength(1);
    expect(exits[0].fields).toMatchObject({ sessionId: "held", reason: "shutdown" });
    expect(typeof exits[0].fields?.ranMs).toBe("number");
  });

  it("logs reason process-exit when the agent exits on its own", async () => {
    const { logger, lines } = capture();
    const { runner } = await startHost({ logger });
    await runner.start("own", { projectPath: tmpdir(), projectName: "p" });
    (await lastProc())._emit("exit", { exitCode: 0 });
    await vi.waitFor(() =>
      expect(lines.find((l) => l.fields?.event === "pty_host.session_exit")?.fields).toMatchObject({
        sessionId: "own",
        reason: "process-exit",
      }),
    );
  });

  it("logs an idle reap", async () => {
    const { logger, lines } = capture();
    const { host, runner } = await startHost({ logger });
    await runner.start("stale", { projectPath: tmpdir(), projectName: "p" });
    (await lastProc())._emit("data", "╭\n");
    await vi.waitFor(() => expect(runner.getSession("stale")?.status).toBe("waiting_input"));

    host.reapIdle(Date.now() + HOST_IDLE_AFTER_MS + 1);

    expect(lines.find((l) => l.fields?.event === "pty_host.idle_reap")?.fields).toMatchObject({
      sessionId: "stale",
    });
  });

  it("logs an orphan reap", async () => {
    const { logger, events } = capture();
    const { host } = await startHost({ logger, heartbeatTimeoutMs: 100 });
    // An empty host that was never told it is referenced and has no lease is
    // reaped once a known-empty registry heartbeat has expired.
    (host as any).lastRegistryHeartbeat = {
      registryState: "known",
      referencedSessionIds: [],
      at: Date.now() - 1000,
    };
    (host as any).heartbeatLeases.clear();
    expect(host.reapOrphan(Date.now())).toBe(true);
    expect(events()).toContain("pty_host.orphan_reap");
  });
});
