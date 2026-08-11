// Phase 6c: a streamer restart reconnects to the process that kept the PTY
// master fd alive, without respawning or duplicating its sessions.

import { EventEmitter, once } from "events";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import type { Server } from "net";
import { tmpdir } from "os";
import { basename, join } from "path";
import WebSocket from "ws";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import type { LiveSessionManager } from "../src/live-session-manager";
import { discoverClaudeProcesses } from "../src/process-discovery";
import { SessionHost } from "../src/pty-host/host";
import {
  encodeMessage,
  type HostRequest,
  type HostTransport,
  PTY_HOST_PROTOCOL_VERSION,
  type StatusResult,
} from "../src/pty-host/protocol";
import { RemoteSessionRunner } from "../src/pty-host/remote-session-runner";
import { connectToHost, hostSocketPath, listenForStreamers } from "../src/pty-host/socket";
import * as hostSpawner from "../src/pty-host/spawn-host";
import { StreamerServer } from "../src/server";
import type { DiscoveredProcess, ManagedSession, SessionResponse, WSMessage } from "../src/types";

const mockPtys: Array<{
  pid: number;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emit: EventEmitter["emit"];
}> = [];

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const events = new EventEmitter();
    const proc = {
      pid: 41000 + mockPtys.length,
      onData: (cb: (data: string) => void) => events.on("data", cb),
      onExit: (cb: (event: { exitCode: number }) => void) => events.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      emit: events.emit.bind(events),
    };
    mockPtys.push(proc);
    return proc;
  }),
}));

vi.mock("../src/process-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-discovery")>();
  return { ...actual, discoverClaudeProcesses: vi.fn(async () => []) };
});

const API_KEY = "tb_0123456789abcdef0123456789abcdef";
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
let instanceId: string;

type RegistrySeed = ManagedSession & { boundConversationId?: string };

function statusTransport(status: StatusResult, onShutdown: () => void = () => {}): HostTransport {
  let onLine: (line: string) => void = () => {};
  let onClose: () => void = () => {};
  let closed = false;
  return {
    send(line) {
      const request = JSON.parse(line) as HostRequest & { type: string };
      queueMicrotask(() => {
        if (request.type === "status") {
          onLine(encodeMessage({ id: request.id, ok: true, result: status }));
        } else if (request.type === "subscribe") {
          onLine(encodeMessage({ id: request.id, ok: true, result: {} }));
        } else if (request.type === "input-history") {
          onLine(encodeMessage({ id: request.id, ok: true, result: { history: [] } }));
        } else if (request.type === "heartbeat") {
          onLine(encodeMessage({ id: request.id, ok: true, result: {} }));
        } else if (request.type === "shutdown-host") {
          onLine(encodeMessage({ id: request.id, ok: true, result: {} }));
          onShutdown();
        } else {
          onLine(encodeMessage({ id: request.id, ok: false, error: "unexpected request" }));
        }
      });
    },
    onLine(handler) {
      onLine = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      if (closed) return;
      closed = true;
      onClose();
    },
  };
}

describe("pty-host reconnect on boot", () => {
  let rootDir: string;
  let projectDir: string;
  let cacheDir: string;
  let runtimeDbPath: string;
  let previousConfigDir: string | undefined;
  let previousInstanceId: string | undefined;
  let host: SessionHost | null;
  let socketServer: Server | null;
  let server: StreamerServer | null;
  let client: WebSocket | null;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "tph-"));
    // Per-test, because the Windows named pipe is NOT scoped by
    // THREADBASE_CONFIG_DIR: a shared id makes a pipe the previous test has not
    // finished releasing collide with this one's listen(). Reuse mkdtemp's
    // suffix rather than minting a new random — it is already unique, and it is
    // short. A longer id pushes the POSIX socket path (config dir +
    // /run/pty-host-<id>.sock) past the 104-byte sun_path limit on macOS, where
    // os.tmpdir() alone is 48 chars, and every listen() fails with EINVAL.
    instanceId = basename(rootDir);
    projectDir = join(rootDir, "project");
    mkdirSync(projectDir);
    cacheDir = join(rootDir, "cache");
    runtimeDbPath = join(rootDir, "runtime.db");
    previousConfigDir = process.env.THREADBASE_CONFIG_DIR;
    previousInstanceId = process.env.THREADBASE_INSTANCE_ID;
    process.env.THREADBASE_CONFIG_DIR = rootDir;
    process.env.THREADBASE_INSTANCE_ID = instanceId;
    host = null;
    socketServer = null;
    server = null;
    client = null;
    mockPtys.length = 0;
    vi.mocked(discoverClaudeProcesses).mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    client?.close();
    if (server) await server.close();
    host?.dispose();
    socketServer?.close();
    if (previousConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = previousConfigDir;
    if (previousInstanceId === undefined) delete process.env.THREADBASE_INSTANCE_ID;
    else process.env.THREADBASE_INSTANCE_ID = previousInstanceId;
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function startHost(): Promise<RemoteSessionRunner> {
    host = new SessionHost({ idleSweepMs: 1_000_000 });
    const socketPath = hostSocketPath(instanceId);
    socketServer = await listenForStreamers(socketPath, {
      onConnection: (transport) => host?.accept(transport) ?? (() => {}),
    });
    return RemoteSessionRunner.connect(await connectToHost(socketPath));
  }

  async function closeSocketServer(): Promise<void> {
    const current = socketServer;
    socketServer = null;
    if (!current) return;
    await new Promise<void>((resolve, reject) => {
      current.close((err) => (err ? reject(err) : resolve()));
    });
  }

  function seedRegistry(sessions: RegistrySeed[]): void {
    const store = RuntimeStore.open(runtimeDbPath);
    try {
      const repo = new ManagedSessionsRepository(store.getDatabase());
      sessions.forEach((session, index) => {
        repo.recordSpawn({
          session,
          pid: mockPtys[index]?.pid ?? null,
          cmdline: session.provider === "codex-cli" ? session.projectPath : session.id,
          streamerInstanceId: "previous-streamer",
        });
        if (session.boundConversationId) {
          repo.recordBinding(session.id, session.boundConversationId);
        }
      });
    } finally {
      store.close();
    }
  }

  async function startStreamer(featureFlags: Record<string, boolean>): Promise<StreamerServer> {
    const next = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      disableDb: true,
      cacheDir,
      runtimeDbPath,
      scanProfiles: [{ id: "test", label: "Test", configDir: rootDir, enabled: true, emoji: "T" }],
      scannerPersistent: false,
      codexRoots: [],
      skipStartupWarmup: true,
      featureFlags,
    });
    await next.listen(0, { awaitReady: true });
    return next;
  }

  async function listSessions(current: StreamerServer, suffix = ""): Promise<SessionResponse[]> {
    const res = await fetch(`http://127.0.0.1:${current.port}/api/sessions${suffix}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionResponse[] | { sessions: SessionResponse[] };
    return Array.isArray(body) ? body : body.sessions;
  }

  function registryRow(id: string): ManagedSessionRow | null {
    const store = RuntimeStore.open(runtimeDbPath);
    try {
      return new ManagedSessionsRepository(store.getDatabase()).get(id);
    } finally {
      store.close();
    }
  }

  it("re-adopts host sessions once, preserves replay, and leaves the host alive on close", async () => {
    const first = await startHost();
    const claude = await first.start(CLAUDE_ID, {
      projectPath: projectDir,
      projectName: "project",
    });
    const codex = await first.startFresh({
      provider: "codex-cli",
      projectPath: projectDir,
      projectName: "project",
    });
    mockPtys[0].emit("data", "old\r\n\u001b[2Jhost-screen\r\n❯ ");
    await vi.waitFor(() => expect(first.getSession(CLAUDE_ID)?.status).toBe("waiting_input"));
    first.sendInput(CLAUDE_ID, "remember this input");
    await vi.waitFor(() =>
      expect(first.getInputHistory(CLAUDE_ID).map((message) => message.text)).toContain(
        "remember this input",
      ),
    );
    mockPtys[0].emit("data", "\r\nhost-screen\r\n❯ ");
    await vi.waitFor(() => expect(first.getSession(CLAUDE_ID)?.status).toBe("waiting_input"));

    const codexBinding = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    seedRegistry([claude, { ...codex, boundConversationId: codexBinding }]);
    const spawnCount = mockPtys.length;
    const claudePid = mockPtys[0].pid;
    const codexPid = mockPtys[1].pid;
    first.dispose();

    const discovered: DiscoveredProcess[] = [
      {
        pid: claudePid,
        projectPath: projectDir,
        projectName: "project",
        branch: "",
        conversationId: CLAUDE_ID,
        startedAt: new Date(),
      },
      {
        pid: codexPid,
        projectPath: projectDir,
        projectName: "project",
        branch: "",
        conversationId: null,
        startedAt: new Date(),
      },
      {
        pid: 49999,
        projectPath: projectDir,
        projectName: "external",
        branch: "",
        conversationId: "99999999-8888-4777-8666-555555555555",
        startedAt: new Date(),
      },
    ];
    vi.mocked(discoverClaudeProcesses).mockResolvedValue(discovered);

    server = await startStreamer({ ptyHost: true });

    for (const suffix of ["", "?limit=50"]) {
      const rows = await listSessions(server, suffix);
      expect(rows.filter((row) => row.id === CLAUDE_ID)).toHaveLength(1);
      expect(rows.filter((row) => row.id === codex.id)).toHaveLength(1);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      expect(rows.find((row) => row.id === CLAUDE_ID)).toMatchObject({
        provider: "claude-code",
        ownership: "managed",
        ptyAttached: true,
        lifecycle: "attached",
        lifecycleSource: "reconcile",
      });
      expect(rows.find((row) => row.id === codex.id)).toMatchObject({
        conversationId: codex.id,
        provider: "codex-cli",
        boundConversationId: codexBinding,
        ownership: "managed",
        ptyAttached: true,
        lifecycle: "attached",
        lifecycleSource: "reconcile",
      });
      expect(rows.find((row) => row.id === discovered[2].conversationId)).toMatchObject({
        ownership: "external",
        ptyAttached: false,
      });
    }
    expect(mockPtys).toHaveLength(spawnCount);

    client = new WebSocket(`ws://127.0.0.1:${server.port}/ws?key=${API_KEY}`);
    const messages: WSMessage[] = [];
    client.on("message", (data) => messages.push(JSON.parse(String(data)) as WSMessage));
    await once(client, "open");
    client.send(JSON.stringify({ type: "subscribe_session", sessionId: CLAUDE_ID }));
    await vi.waitFor(() => {
      const replay = messages.find(
        (message) => message.type === "terminal_replay" && message.sessionId === CLAUDE_ID,
      );
      expect(replay).toBeDefined();
      if (replay?.type !== "terminal_replay") return;
      expect(replay.lines.join("\n")).toContain("host-screen");
      expect(replay.lines.join("\n")).not.toContain("old");
      expect(replay.userMessages?.map((message) => message.text)).toContain("remember this input");
    });
    client.close();
    client = null;

    const internals = server as unknown as { reapIdleSessions: (now: number) => string[] };
    expect(internals.reapIdleSessions(Date.now() + 30 * 24 * 60 * 60 * 1000)).toEqual([]);

    await server.close();
    server = null;
    expect(registryRow(CLAUDE_ID)?.completed_at).toBeNull();

    const afterRestart = await RemoteSessionRunner.connect(
      await connectToHost(hostSocketPath(instanceId)),
    );
    expect(afterRestart.hasSession(CLAUDE_ID)).toBe(true);
    expect(afterRestart.hasSession(codex.id)).toBe(true);
    afterRestart.dispose();
  }, 30_000);

  it("falls back to one historical stub when a reboot leaves no hosted session", async () => {
    const first = await startHost();
    const session = await first.start(CLAUDE_ID, {
      projectPath: projectDir,
      projectName: "project",
    });
    seedRegistry([session]);
    first.dispose();
    host?.dispose();
    await closeSocketServer();
    // Nothing is listening now, so the real connectOrSpawnHost would spawn a
    // detached node process and poll it for the full 5s ready timeout before
    // giving up — under vitest that child is argv[1] of the pool worker, i.e. an
    // orphan nothing reaps. Rejecting is the same end state (no host attached)
    // without either cost.
    vi.spyOn(hostSpawner, "connectOrSpawnHost").mockRejectedValue(
      new Error("pty-host did not accept a connection"),
    );

    const store = RuntimeStore.open(runtimeDbPath);
    try {
      store
        .getDatabase()
        .prepare("UPDATE managed_sessions SET boot_token = ? WHERE session_id = ?")
        .run("previous-machine-boot", CLAUDE_ID);
    } finally {
      store.close();
    }

    server = await startStreamer({ ptyHost: true });
    let rows: SessionResponse[] = [];
    await vi.waitFor(async () => {
      rows = await listSessions(server as StreamerServer);
      expect(rows.some((row) => row.id === CLAUDE_ID)).toBe(true);
    });

    expect(rows.filter((row) => row.id === CLAUDE_ID)).toHaveLength(1);
    expect(rows.find((row) => row.id === CLAUDE_ID)).toMatchObject({
      ownership: "historical",
      ptyAttached: false,
      lifecycle: "resumable",
      lifecycleSource: "reconcile",
    });
  });

  it("does not contact an existing host while the flag is off", async () => {
    const first = await startHost();
    await first.start(CLAUDE_ID, { projectPath: projectDir, projectName: "project" });
    first.dispose();
    const connect = vi.spyOn(hostSpawner, "connectOrSpawnHost");

    server = await startStreamer({ ptyHost: false, sessionRehydration: false });

    expect(connect).not.toHaveBeenCalled();
    expect((await listSessions(server)).map((row) => row.id)).not.toContain(CLAUDE_ID);
  });

  it("boots on in-process PTYs when the host cannot be attached", async () => {
    // The flag is experimental and default-off, so it must never be the one
    // subsystem that can stop the streamer from starting. Every other optional
    // subsystem here — runtime store, cache, reconciliation — logs and carries
    // on; this one used to reject out of listen() with nothing catching it.
    const connect = vi
      .spyOn(hostSpawner, "connectOrSpawnHost")
      .mockRejectedValue(new Error("pty-host did not accept a connection"));

    server = await startStreamer({ ptyHost: true, sessionRehydration: false });

    expect(connect).toHaveBeenCalled();
    // Serving requests at all is the assertion: listen() resolved despite the
    // rejection instead of taking the process down with it.
    expect(Array.isArray(await listSessions(server))).toBe(true);

    // Fell back rather than half-attaching: the in-process runners are still
    // the live ones, so a spawn works and is owned locally.
    const ptyManager = (server as unknown as { ptyManager: LiveSessionManager }).ptyManager;
    const started = await ptyManager.startFresh({
      projectPath: projectDir,
      projectName: "project",
    });
    expect(ptyManager.isRemote()).toBe(false);
    expect(ptyManager.hasSession(started.id)).toBe(true);
  });

  it("replaces an incompatible host before adopting sessions", async () => {
    const adoptedId = "22222222-3333-4444-8555-666666666666";
    let incompatibleStopped = false;
    const incompatible = statusTransport(
      { protocolVersion: PTY_HOST_PROTOCOL_VERSION + 1, sessions: [] },
      () => {
        incompatibleStopped = true;
        incompatible.close();
      },
    );
    const compatible = statusTransport({
      protocolVersion: PTY_HOST_PROTOCOL_VERSION,
      sessions: [
        {
          pid: 45678,
          session: {
            id: adoptedId,
            provider: "claude-code",
            projectPath: projectDir,
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          },
        },
      ],
    });
    vi.spyOn(hostSpawner, "connectOrSpawnHost")
      .mockResolvedValueOnce(incompatible)
      .mockResolvedValueOnce(compatible);

    server = await startStreamer({ ptyHost: true, sessionRehydration: false });

    expect(incompatibleStopped).toBe(true);
    expect((await listSessions(server)).find((row) => row.id === adoptedId)).toMatchObject({
      ownership: "managed",
      ptyAttached: true,
      lifecycle: "attached",
      lifecycleSource: "reconcile",
    });
  });

  it("reports a known empty registry so the disconnected host can reap", async () => {
    await startHost();
    server = await startStreamer({ ptyHost: true, sessionRehydration: false });

    await server.close();
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host?.reapOrphan(Date.now() + 60 * 60 * 1000)).toBe(true);
  });

  it("reports unknown registry state when runtime.db cannot open", async () => {
    await startHost();
    runtimeDbPath = projectDir;
    server = await startStreamer({ ptyHost: true, sessionRehydration: false });

    await server.close();
    server = null;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host?.reapOrphan(Date.now() + 60 * 60 * 1000)).toBe(false);
  });
});
