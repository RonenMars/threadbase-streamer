// Phase 6c: a streamer restart reconnects to the process that kept the PTY
// master fd alive, without respawning or duplicating its sessions.

import { EventEmitter, once } from "events";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import type { Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { discoverClaudeProcesses } from "../src/process-discovery";
import { SessionHost } from "../src/pty-host/host";
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
const INSTANCE_ID = "s8";

type RegistrySeed = ManagedSession & { boundConversationId?: string };

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
    projectDir = join(rootDir, "project");
    mkdirSync(projectDir);
    cacheDir = join(rootDir, "cache");
    runtimeDbPath = join(rootDir, "runtime.db");
    previousConfigDir = process.env.THREADBASE_CONFIG_DIR;
    previousInstanceId = process.env.THREADBASE_INSTANCE_ID;
    process.env.THREADBASE_CONFIG_DIR = rootDir;
    process.env.THREADBASE_INSTANCE_ID = INSTANCE_ID;
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
    const socketPath = hostSocketPath(INSTANCE_ID);
    socketServer = await listenForStreamers(socketPath, {
      onConnection: (transport) => host?.accept(transport) ?? (() => {}),
    });
    return RemoteSessionRunner.connect(await connectToHost(socketPath));
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
      await connectToHost(hostSocketPath(INSTANCE_ID)),
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
});
