// Phase 6b: the host process that owns the PTYs.
//
// Driven over a REAL unix socket / named pipe rather than an in-memory pair.
// The in-memory transport in pty-host-protocol.test.ts already covers the
// runner's logic; what is only testable over a real socket is the part that
// actually bites — chunk boundaries, a peer disconnecting mid-flight, and
// whether sessions survive that disconnect.

import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node-pty", () => {
  const procs: any[] = [];
  return {
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      const proc = {
        pid: 40000 + procs.length,
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
const { RemoteSessionRunner } = await import("../src/pty-host/remote-session-runner");
const { connectToHost, hostSocketPath, listenForStreamers } = await import(
  "../src/pty-host/socket"
);

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A host listening on a real socket in a throwaway config dir. */
async function startHost(instanceId = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`) {
  const configDir = mkdtempSync(join(tmpdir(), "tb-pty-host-"));
  const previous = process.env.THREADBASE_CONFIG_DIR;
  process.env.THREADBASE_CONFIG_DIR = configDir;

  const socketPath = hostSocketPath(instanceId);
  const host = new SessionHost({ idleSweepMs: 1_000_000 });
  const server = await listenForStreamers(socketPath, {
    onConnection: (transport) => host.accept(transport),
  });

  cleanups.push(() => {
    host.dispose();
    server.close();
    if (previous === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = previous;
  });

  return { host, server, socketPath };
}

async function connectRunner(socketPath: string, options = {}) {
  const transport = await connectToHost(socketPath);
  const runner = await RemoteSessionRunner.connect(transport, options);
  cleanups.push(() => runner.dispose());
  return runner;
}

describe("hostSocketPath", () => {
  it("scopes the endpoint by instance id", () => {
    expect(hostSocketPath("alpha")).not.toBe(hostSocketPath("beta"));
    expect(hostSocketPath("alpha")).toContain("alpha");
  });

  it("uses a named pipe on Windows and a config-dir socket elsewhere", () => {
    // Named pipes are not filesystem paths, so the config dir has nothing to
    // say about them — asserted per-platform rather than assuming parity.
    if (process.platform === "win32") {
      expect(hostSocketPath("x")).toMatch(/^\\\\\.\\pipe\\/);
    } else {
      expect(hostSocketPath("x")).toMatch(/\.sock$/);
      expect(hostSocketPath("x")).toContain("run");
    }
  });
});

describe("SessionHost over a real socket", () => {
  it("answers status with the protocol version and no sessions", async () => {
    const { socketPath } = await startHost();
    const runner = await connectRunner(socketPath);

    // connect() awaits status, so an empty mirror here means the round trip
    // actually completed rather than defaulting.
    expect(runner.listSessions()).toEqual([]);
  });

  it("spawns a session and reports its pid back through the mirror", async () => {
    const { socketPath } = await startHost();
    const runner = await connectRunner(socketPath);

    const session = await runner.start("sess-1", { projectPath: tmpdir(), projectName: "p" });

    expect(session.id).toBe("sess-1");
    expect(runner.hasSession("sess-1")).toBe(true);
    // recordSessionSpawn needs this immediately; a null costs the next boot its
    // ability to probe whether the agent outlived us.
    expect(runner.getPid("sess-1")).toBeGreaterThan(0);
  });

  it("streams output events to a subscribed streamer", async () => {
    const { host, socketPath } = await startHost();
    const chunks: string[] = [];
    const runner = await connectRunner(socketPath, {
      onOutput: (_id: string, data: string) => chunks.push(data),
    });

    await runner.start("sess-1", { projectPath: tmpdir(), projectName: "p" });
    expect(host.sessionCount()).toBe(1);
    const pty = await import("node-pty");
    const proc = (pty.spawn as any).mock.results.at(-1)?.value;
    proc._emit("data", "hello from the agent");

    await vi.waitFor(() => expect(chunks.join("")).toContain("hello from the agent"));
    expect(runner.getOutput("sess-1")).toContain("hello from the agent");
  });

  it("reassembles a request split across socket writes", async () => {
    // The failure this prevents only appears under load: "one write is one
    // message" holds right up until a burst makes it false.
    const { socketPath } = await startHost();
    const transport = await connectToHost(socketPath);
    const lines: string[] = [];
    transport.onLine((chunk) => lines.push(chunk));

    transport.send('{"id":1,"type":"stat');
    await new Promise((r) => setTimeout(r, 20));
    transport.send('us"}\n');

    await vi.waitFor(() => expect(lines.join("")).toContain('"ok":true'));
    transport.close();
  });

  it("answers a failing request instead of going silent", async () => {
    const { socketPath } = await startHost();
    const runner = await connectRunner(socketPath);

    // A dropped response leaves the caller's promise pending forever, which is
    // a hung session start rather than an error it can report.
    await expect(runner.getOutputLines("no-such-session", 10)).rejects.toThrow(/not found/i);
  });

  it("keeps its sessions when the streamer disconnects", async () => {
    // The entire reason the host exists.
    const { host, socketPath } = await startHost();
    const runner = await connectRunner(socketPath);
    await runner.start("survivor", { projectPath: tmpdir(), projectName: "p" });
    expect(host.sessionCount()).toBe(1);

    runner.dispose();
    await new Promise((r) => setTimeout(r, 50));

    expect(host.sessionCount()).toBe(1);
  });

  it("hands a reconnecting streamer the sessions it already holds", async () => {
    const { socketPath } = await startHost();
    const first = await connectRunner(socketPath);
    await first.start("survivor", { projectPath: tmpdir(), projectName: "p" });
    first.dispose();
    await new Promise((r) => setTimeout(r, 50));

    const second = await connectRunner(socketPath);

    // This is what a streamer restart looks like from the host's side.
    expect(second.hasSession("survivor")).toBe(true);
    expect(second.getPid("survivor")).toBeGreaterThan(0);
  });

  it("refuses to start a second host on the same endpoint", async () => {
    // Deleting a live host's socket would strand every session it holds, so a
    // stale-socket cleanup must first prove nothing answers.
    const { socketPath } = await startHost();

    await expect(listenForStreamers(socketPath, { onConnection: () => () => {} })).rejects.toThrow(
      /already listening/,
    );
  });
});

describe("SessionHost idle reaper", () => {
  it("releases a settled session past the threshold, and tells subscribers", async () => {
    // It runs HERE, not in the streamer: an abandoned host with no reaper keeps
    // every agent alive forever.
    const { host, socketPath } = await startHost();
    const runner = await connectRunner(socketPath);
    await runner.start("stale", { projectPath: tmpdir(), projectName: "p" });

    // Settle it: the prompt marker is what takes a session out of `running`,
    // and only a settled session is eligible.
    const pty = await import("node-pty");
    const proc = (pty.spawn as any).mock.results.at(-1)?.value;
    proc._emit("data", "╭\n");
    await vi.waitFor(() => expect(runner.getSession("stale")?.status).toBe("waiting_input"));

    expect(host.reapIdle(Date.now() + HOST_IDLE_AFTER_MS + 1)).toEqual(["stale"]);
    expect(host.sessionCount()).toBe(0);

    // The streamer must learn the PTY is gone, or its mirror keeps offering a
    // session nothing is behind.
    await vi.waitFor(() => expect(runner.hasSession("stale")).toBe(false));
  });

  it("never touches a running session, however long the turn", async () => {
    const host = new SessionHost({ idleSweepMs: 1_000_000, idleAfterMs: 0 });
    cleanups.push(() => host.dispose());
    const transport = { send() {}, onLine() {}, onClose() {}, close() {} };
    host.accept(transport);

    await (host as any).runner.start("busy", { projectPath: tmpdir(), projectName: "p" });
    // Status is `running` straight out of spawn — with idleAfterMs 0, only the
    // running check can be what spares it.
    expect(host.reapIdle(Date.now() + 1_000_000)).toEqual([]);
    expect(host.sessionCount()).toBe(1);
  });
});
