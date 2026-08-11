import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { ConversationCache } from "../src/conversation-cache";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { StreamerServer } from "../src/server";
import {
  AUTO_RESUME_MAX,
  AUTO_RESUME_STAGGER_MS,
  AUTO_RESUME_WINDOW_MS,
  autoResumeSkipReason,
  planAutoResume,
} from "../src/services/sessions/autoResumeOnBoot";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  return {
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("data", "╭\n"));
      return {
        pid: 99999,
        onData: (cb: (data: string) => void) => ee.on("data", cb),
        onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
        write: vi.fn(),
        kill: vi.fn(),
      };
    }),
  };
});

const NOW = new Date("2026-07-31T12:00:00Z").getTime();
const API_KEY = "tb_test_auto_resume_on_boot";

function mkRow(over: Partial<ManagedSessionRow> = {}): ManagedSessionRow {
  return {
    session_id: "aaaaaaaa-1111-4222-8333-444444444444",
    provider: "claude-code",
    pid: 4242,
    cmdline: "claude --resume aaaaaaaa-1111-4222-8333-444444444444",
    project_path: "/repo",
    project_name: "repo",
    branch: "main",
    status: "running",
    status_source: "shutdown",
    status_updated_at: NOW - 60_000,
    started_at: NOW - 3_600_000,
    completed_at: NOW - 60_000,
    last_activity_at: NOW - 120_000,
    prompt_count: 7,
    session_name: "interrupted work",
    project_id: "proj-1",
    bound_conversation_id: null,
    resumed_from_conversation_id: null,
    failure_reason: null,
    streamer_instance_id: "previous-run",
    ...over,
  };
}

describe("auto-resume eligibility", () => {
  const exists = () => true;
  const historyExists = () => true;

  it("requires a shutdown status source", () => {
    expect(
      autoResumeSkipReason(mkRow({ status_source: "transition" }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBe("not_shutdown");
  });

  it("requires a running or waiting_input status at shutdown", () => {
    expect(
      autoResumeSkipReason(mkRow({ status: "idle" }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBe("not_interrupted");
    expect(
      autoResumeSkipReason(mkRow({ status: "running" }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBeNull();
    expect(
      autoResumeSkipReason(mkRow({ status: "waiting_input" }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBeNull();
  });

  it("requires a status update within the 15-minute window", () => {
    expect(
      autoResumeSkipReason(mkRow({ status_updated_at: NOW - AUTO_RESUME_WINDOW_MS - 1 }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBe("too_old");
    expect(
      autoResumeSkipReason(mkRow({ status_updated_at: NOW - AUTO_RESUME_WINDOW_MS }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBeNull();
  });

  it("requires the project directory to exist", () => {
    expect(
      autoResumeSkipReason(mkRow(), {
        now: NOW,
        projectExists: () => false,
        historyExists,
      }),
    ).toBe("project_missing");
  });

  it("requires a provider resume identity", () => {
    expect(
      autoResumeSkipReason(mkRow({ provider: "codex-cli", bound_conversation_id: null }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBe("resume_identity_missing");
    expect(
      autoResumeSkipReason(mkRow({ provider: "codex-cli", bound_conversation_id: "rollout-1" }), {
        now: NOW,
        projectExists: exists,
        historyExists,
      }),
    ).toBeNull();
  });

  it("requires provider history", () => {
    expect(
      autoResumeSkipReason(mkRow(), {
        now: NOW,
        projectExists: exists,
        historyExists: () => false,
      }),
    ).toBe("history_missing");
  });

  it("skips missing history before applying the per-boot ceiling", () => {
    const rows = Array.from({ length: AUTO_RESUME_MAX + 1 }, (_, i) =>
      mkRow({ session_id: `aaaaaaaa-1111-4222-8333-${String(i).padStart(12, "0")}` }),
    );
    const plan = planAutoResume(rows, {
      now: NOW,
      projectExists: exists,
      historyExists: (row) => row.session_id !== rows[0].session_id,
    });

    expect(plan.skipped).toEqual([{ row: rows[0], reason: "history_missing" }]);
    expect(plan.attempts).toEqual(rows.slice(1));
    expect(plan.overflow).toEqual([]);
  });
});

type AutoResumeInternals = {
  registryBoot: {
    autoResumePreviousSessions(rows: ManagedSessionRow[]): Promise<void>;
  };
  sessionHandlers: {
    resumeSession: ReturnType<typeof vi.fn>;
  };
  // Stays on StreamerServer: SessionRegistryBoot reaches it through a
  // late-binding dep thunk, so stubbing it here is still observed.
  resolveConversationTarget: ReturnType<typeof vi.fn>;
  log: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
};

function makePolicyServer(enabled: boolean, cacheDir: string): AutoResumeInternals {
  const server = new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    disableDb: true,
    skipStartupWarmup: true,
    cacheDir,
    scanProfiles: [],
    scannerPersistent: false,
    codexRoots: [],
    autoResumeOnBoot: enabled,
  }) as unknown as AutoResumeInternals;
  server.log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  server.resolveConversationTarget = vi.fn().mockResolvedValue({ ok: true });
  return server;
}

describe("auto-resume orchestration", () => {
  let projectDir: string;
  let cacheDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-policy-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-policy-cache-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("does nothing when the preference is false", async () => {
    const server = makePolicyServer(false, cacheDir);
    server.sessionHandlers.resumeSession = vi.fn();

    await server.registryBoot.autoResumePreviousSessions([mkRow({ project_path: projectDir })]);

    expect(server.sessionHandlers.resumeSession).not.toHaveBeenCalled();
  });

  it("summarizes ineligible rows at info and keeps per-row reasons at debug", async () => {
    const server = makePolicyServer(true, cacheDir);
    server.sessionHandlers.resumeSession = vi.fn();

    await server.registryBoot.autoResumePreviousSessions([
      mkRow({
        project_path: projectDir,
        status: "idle",
        status_updated_at: Date.now(),
      }),
      mkRow({
        session_id: "aaaaaaaa-1111-4222-8333-555555555555",
        project_path: projectDir,
        status_source: "transition",
        status_updated_at: Date.now(),
      }),
    ]);

    expect(server.sessionHandlers.resumeSession).not.toHaveBeenCalled();
    const infoLogs = server.log.info.mock.calls.filter(
      ([, fields]) => fields?.event === "sessions.auto_resume_skipped",
    );
    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0][1]).toMatchObject({
      skipped: 2,
      skippedBy: { not_interrupted: 1, not_shutdown: 1 },
    });
    expect(server.log.debug.mock.calls.map(([, fields]) => fields?.reason)).toEqual(
      expect.arrayContaining(["not_interrupted", "not_shutdown"]),
    );
  });

  it("caps concurrency at two, staggers starts, and leaves overflow for the user", async () => {
    vi.useFakeTimers();
    const server = makePolicyServer(true, cacheDir);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    server.sessionHandlers.resumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active--;
            resolve({ ok: true, alreadyRunning: false, session: null, response: null });
          });
        }),
    );
    const rows = Array.from({ length: AUTO_RESUME_MAX + 1 }, (_, i) =>
      mkRow({
        session_id: `aaaaaaaa-1111-4222-8333-${String(i).padStart(12, "0")}`,
        project_path: projectDir,
        status_updated_at: Date.now(),
      }),
    );

    const run = server.registryBoot.autoResumePreviousSessions(rows);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUTO_RESUME_STAGGER_MS - 1);
    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(2);

    for (let expected = 3; expected <= AUTO_RESUME_MAX; expected++) {
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(AUTO_RESUME_STAGGER_MS - 1);
      expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(expected);
    }

    for (const release of releases.splice(0)) release();
    await run;

    expect(maxActive).toBe(2);
    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(AUTO_RESUME_MAX);
    for (const [options] of server.sessionHandlers.resumeSession.mock.calls) {
      expect(options).not.toHaveProperty("force");
    }
    expect(
      server.log.info.mock.calls.some(
        ([, fields]) =>
          fields?.event === "sessions.auto_resume_skipped" && fields?.reason === "ceiling_reached",
      ),
    ).toBe(true);
  });

  it("logs a busy conversation as skipped instead of forcing it", async () => {
    const server = makePolicyServer(true, cacheDir);
    server.sessionHandlers.resumeSession = vi.fn().mockResolvedValue({
      ok: false,
      reason: "conversation_busy",
      detectedBy: ["jsonl_mtime"],
      lastActivityMs: 100,
      likelyOwner: "external",
    });

    await server.registryBoot.autoResumePreviousSessions([
      mkRow({ project_path: projectDir, status_updated_at: Date.now() }),
    ]);

    expect(server.sessionHandlers.resumeSession.mock.calls[0][0]).not.toHaveProperty("force");
    expect(
      server.log.info.mock.calls.some(
        ([, fields]) =>
          fields?.event === "sessions.auto_resume_skipped" &&
          fields?.reason === "conversation_busy",
      ),
    ).toBe(true);
  });

  it("caps provider-history preflight concurrency at two while preserving input order", async () => {
    const server = makePolicyServer(true, cacheDir);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    server.resolveConversationTarget = vi.fn(
      () =>
        new Promise((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active--;
            resolve({ ok: true });
          });
        }),
    );
    server.sessionHandlers.resumeSession = vi.fn().mockResolvedValue({
      ok: true,
      alreadyRunning: false,
      session: null,
      response: null,
    });
    const rows = Array.from({ length: 3 }, (_, i) =>
      mkRow({
        session_id: `aaaaaaaa-1111-4222-8333-${String(i).padStart(12, "0")}`,
        project_path: projectDir,
        status_updated_at: Date.now(),
      }),
    );

    const run = server.registryBoot.autoResumePreviousSessions(rows);
    while (
      server.resolveConversationTarget.mock.calls.length < rows.length ||
      releases.length > 0
    ) {
      releases.shift()?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run;

    expect(maxActive).toBe(2);
    expect(server.resolveConversationTarget.mock.calls.map(([sessionId]) => sessionId)).toEqual(
      rows.map((row) => row.session_id),
    );
  });

  it("skips actual missing history before attempts without consuming capacity", async () => {
    const server = makePolicyServer(true, cacheDir);
    const rows = Array.from({ length: AUTO_RESUME_MAX + 1 }, (_, i) =>
      mkRow({
        session_id: `aaaaaaaa-1111-4222-8333-${String(i).padStart(12, "0")}`,
        project_path: projectDir,
        status_updated_at: Date.now(),
      }),
    );
    server.resolveConversationTarget = vi.fn((sessionId: string) =>
      Promise.resolve(
        sessionId === rows[0].session_id
          ? { ok: false, reason: "history_file_missing" }
          : { ok: true },
      ),
    );
    server.sessionHandlers.resumeSession = vi.fn().mockResolvedValue({
      ok: true,
      alreadyRunning: false,
      session: null,
      response: null,
    });

    await server.registryBoot.autoResumePreviousSessions(rows);

    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(AUTO_RESUME_MAX);
    expect(server.sessionHandlers.resumeSession.mock.calls.map(([options]) => options.sessionId)).toEqual(
      rows.slice(1).map((row) => row.session_id),
    );
    expect(
      server.log.debug.mock.calls.some(
        ([, fields]) =>
          fields?.event === "sessions.auto_resume_skipped" && fields?.reason === "history_missing",
      ),
    ).toBe(true);
    expect(
      server.log.info.mock.calls.find(
        ([, fields]) => fields?.event === "sessions.auto_resume_completed",
      )?.[1],
    ).toMatchObject({ attempted: AUTO_RESUME_MAX, failed: 0 });
  });

  it("leaves no_project_path for normal resume handling", async () => {
    const server = makePolicyServer(true, cacheDir);
    server.resolveConversationTarget = vi.fn().mockResolvedValue({
      ok: false,
      reason: "no_project_path",
    });
    server.sessionHandlers.resumeSession = vi.fn().mockResolvedValue({ ok: false, reason: "no_project_path" });

    await server.registryBoot.autoResumePreviousSessions([
      mkRow({ project_path: projectDir, status_updated_at: Date.now() }),
    ]);

    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(1);
    expect(
      server.log.debug.mock.calls.some(([, fields]) => fields?.reason === "history_missing"),
    ).toBe(false);
  });

  it("contains a rejected history lookup and continues later eligible work", async () => {
    const server = makePolicyServer(true, cacheDir);
    const rows = [
      mkRow({ project_path: projectDir, status_updated_at: Date.now() }),
      mkRow({
        session_id: "aaaaaaaa-1111-4222-8333-555555555555",
        project_path: projectDir,
        status_updated_at: Date.now(),
      }),
    ];
    server.resolveConversationTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("history lookup failed"))
      .mockResolvedValue({ ok: true });
    server.sessionHandlers.resumeSession = vi.fn().mockResolvedValue({
      ok: true,
      alreadyRunning: false,
      session: null,
      response: null,
    });

    await server.registryBoot.autoResumePreviousSessions(rows);

    expect(server.sessionHandlers.resumeSession).toHaveBeenCalledTimes(2);
    expect(server.sessionHandlers.resumeSession.mock.calls.map(([options]) => options.sessionId)).toEqual(
      rows.map((row) => row.session_id),
    );
  });
});

describe("boot auto-resume integration", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;
  let runtimeDir: string;
  let runtimeDbPath: string;
  let sessionId: string;

  beforeEach(() => {
    vi.mocked(mockSpawn).mockClear();
    configDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-cache-"));
    runtimeDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-runtime-"));
    runtimeDbPath = join(runtimeDir, "runtime.db");
    sessionId = "bbbbbbbb-1111-4222-8333-444444444444";

    const encoded = projectDir.replace(/[/\\:.]/g, "-");
    const jsonlDir = join(configDir, "projects", encoded);
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      join(jsonlDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ sessionId, cwd: projectDir, type: "user", message: "hi" })}\n`,
    );

    const store = RuntimeStore.open(runtimeDbPath);
    const repo = new ManagedSessionsRepository(store.getDatabase());
    repo.recordSpawn({
      session: {
        id: sessionId,
        provider: "claude-code",
        projectPath: projectDir,
        projectName: "repo",
        branch: "main",
        status: "running",
        startedAt: new Date(Date.now() - 60_000),
        completedAt: null,
        promptCount: 1,
        lastOutput: "",
      },
      pid: 999_999,
      cmdline: `claude --resume ${sessionId}`,
      streamerInstanceId: "previous-run",
    });
    repo.recordStatus(sessionId, "running", "shutdown", {
      completedAt: new Date(),
      promptCount: 1,
    });
    store.close();
  });

  afterEach(() => {
    for (const dir of [configDir, projectDir, cacheDir, runtimeDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startServer(
    autoResumeOnBoot: boolean,
    beforeListen?: (server: StreamerServer) => void,
  ) {
    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      disableDb: true,
      skipStartupWarmup: true,
      cacheDir,
      runtimeDbPath,
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "test" }],
      scannerPersistent: false,
      codexRoots: [],
      autoResumeOnBoot,
    });
    beforeListen?.(server);
    await server.listen(0, { awaitReady: true });
    return server;
  }

  async function waitForSession(server: StreamerServer, ownership: string) {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`http://localhost:${server.port}/api/sessions`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const sessions = (await response.json()) as Array<{
        id: string;
        ownership?: string;
        ptyAttached: boolean;
      }>;
      const session = sessions.find((item) => item.id === sessionId);
      if (session?.ownership === ownership) return session;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  it("leaves the Phase 1 historical stub unchanged when disabled", async () => {
    const server = await startServer(false);
    try {
      const session = await waitForSession(server, "historical");
      expect(session?.ptyAttached).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("runs after rehydration and replaces an eligible stub with a live session", async () => {
    const server = await startServer(true);
    try {
      const session = await waitForSession(server, "managed");
      expect(session?.ptyAttached).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("resolves persisted Codex history during cold boot before scanner warm-up", async () => {
    const codexRoot = mkdtempSync(join(tmpdir(), "tb-auto-resume-codex-"));
    const rolloutId = "cccccccc-1111-4222-8333-444444444444";
    const rolloutDir = join(codexRoot, "2026", "08", "11");
    const rolloutPath = join(rolloutDir, `rollout-2026-08-11T08-00-00-${rolloutId}.jsonl`);
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: { id: rolloutId, cwd: projectDir, timestamp: new Date().toISOString() },
      })}\n`,
    );

    const store = RuntimeStore.open(runtimeDbPath);
    const repo = new ManagedSessionsRepository(store.getDatabase());
    repo.delete(sessionId);
    repo.recordSpawn({
      session: {
        id: sessionId,
        provider: "codex-cli",
        projectPath: projectDir,
        projectName: "repo",
        branch: "main",
        status: "running",
        startedAt: new Date(Date.now() - 60_000),
        completedAt: null,
        promptCount: 1,
        lastOutput: "",
        boundConversationId: rolloutId,
      },
      pid: 999_999,
      cmdline: `codex resume ${rolloutId}`,
      streamerInstanceId: "previous-run",
    });
    repo.recordStatus(sessionId, "running", "shutdown", {
      completedAt: new Date(),
      promptCount: 1,
    });
    store.close();

    const cache = ConversationCache.open(join(cacheDir, "cache.db"));
    cache.upsertFromScannerMeta([
      {
        id: rolloutId,
        sessionId: rolloutId,
        filePath: rolloutPath,
        projectPath: projectDir,
        projectName: "repo",
        sessionName: "Codex interrupted work",
        provider: "codex-cli",
        messageCount: 0,
        timestamp: new Date().toISOString(),
      } as never,
    ]);
    cache.close();

    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      disableDb: true,
      skipStartupWarmup: true,
      cacheDir,
      runtimeDbPath,
      scannerPersistent: false,
      codexRoots: [],
      autoResumeOnBoot: false,
    });

    try {
      await server.listen(0, { awaitReady: true });
      await expect((server as any).resolveConversationTarget(sessionId)).resolves.toMatchObject({
        ok: true,
        historyId: rolloutId,
        historyPath: rolloutPath,
        projectPath: projectDir,
        provider: "codex-cli",
      });
    } finally {
      await server.close();
      rmSync(codexRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("broadcasts the complete session list to a client connected before auto-resume", async () => {
    let releaseReconcile!: (value: []) => void;
    const reconcileGate = new Promise<[]>((resolve) => {
      releaseReconcile = resolve;
    });
    const server = await startServer(true, (instance) => {
      (instance as any).registryBoot.reconcilePreviousSessions = vi
        .fn()
        .mockReturnValue(reconcileGate);
    });
    const ws = new WebSocket(`ws://localhost:${server.port}/ws?key=${API_KEY}`);

    try {
      const resumedList = new Promise<Array<{ id: string; ownership?: string }>>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for auto-resume session_list")),
            10_000,
          );
          ws.on("message", (data) => {
            const message = JSON.parse(data.toString()) as {
              type: string;
              sessions?: Array<{ id: string; ownership?: string }>;
            };
            if (
              message.type === "session_list" &&
              message.sessions?.some(
                (session) => session.id === sessionId && session.ownership === "managed",
              )
            ) {
              clearTimeout(timeout);
              resolve(message.sessions);
            }
          });
        },
      );

      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      releaseReconcile([]);

      const sessions = await resumedList;
      expect(sessions.filter((session) => session.id === sessionId)).toHaveLength(1);
    } finally {
      ws.terminate();
      await server.close();
    }
  }, 30_000);
});
