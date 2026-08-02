import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { StreamerServer } from "../src/server";
import {
  AUTO_RESUME_MAX,
  AUTO_RESUME_STAGGER_MS,
  AUTO_RESUME_WINDOW_MS,
  autoResumeSkipReason,
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

  it("requires a shutdown status source", () => {
    expect(
      autoResumeSkipReason(mkRow({ status_source: "transition" }), {
        now: NOW,
        projectExists: exists,
      }),
    ).toBe("not_shutdown");
  });

  it("requires a running or waiting_input status at shutdown", () => {
    expect(
      autoResumeSkipReason(mkRow({ status: "idle" }), { now: NOW, projectExists: exists }),
    ).toBe("not_interrupted");
    expect(
      autoResumeSkipReason(mkRow({ status: "running" }), { now: NOW, projectExists: exists }),
    ).toBeNull();
    expect(
      autoResumeSkipReason(mkRow({ status: "waiting_input" }), {
        now: NOW,
        projectExists: exists,
      }),
    ).toBeNull();
  });

  it("requires a status update within the 15-minute window", () => {
    expect(
      autoResumeSkipReason(mkRow({ status_updated_at: NOW - AUTO_RESUME_WINDOW_MS - 1 }), {
        now: NOW,
        projectExists: exists,
      }),
    ).toBe("too_old");
    expect(
      autoResumeSkipReason(mkRow({ status_updated_at: NOW - AUTO_RESUME_WINDOW_MS }), {
        now: NOW,
        projectExists: exists,
      }),
    ).toBeNull();
  });

  it("requires the project directory to exist", () => {
    expect(autoResumeSkipReason(mkRow(), { now: NOW, projectExists: () => false })).toBe(
      "project_missing",
    );
  });

  it("requires a provider resume identity", () => {
    expect(
      autoResumeSkipReason(mkRow({ provider: "codex-cli", bound_conversation_id: null }), {
        now: NOW,
        projectExists: exists,
      }),
    ).toBe("resume_identity_missing");
    expect(
      autoResumeSkipReason(mkRow({ provider: "codex-cli", bound_conversation_id: "rollout-1" }), {
        now: NOW,
        projectExists: exists,
      }),
    ).toBeNull();
  });
});

type AutoResumeInternals = {
  autoResumePreviousSessions(rows: ManagedSessionRow[]): Promise<void>;
  resumeSession: ReturnType<typeof vi.fn>;
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
    server.resumeSession = vi.fn();

    await server.autoResumePreviousSessions([mkRow({ project_path: projectDir })]);

    expect(server.resumeSession).not.toHaveBeenCalled();
  });

  it("logs each ineligible row with its reason", async () => {
    const server = makePolicyServer(true, cacheDir);
    server.resumeSession = vi.fn();

    await server.autoResumePreviousSessions([
      mkRow({
        project_path: projectDir,
        status: "idle",
        status_updated_at: Date.now(),
      }),
    ]);

    expect(server.resumeSession).not.toHaveBeenCalled();
    expect(
      server.log.info.mock.calls.some(
        ([, fields]) =>
          fields?.event === "sessions.auto_resume_skipped" && fields?.reason === "not_interrupted",
      ),
    ).toBe(true);
  });

  it("caps concurrency at two, staggers starts, and leaves overflow for the user", async () => {
    vi.useFakeTimers();
    const server = makePolicyServer(true, cacheDir);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    server.resumeSession = vi.fn(
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

    const run = server.autoResumePreviousSessions(rows);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.resumeSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUTO_RESUME_STAGGER_MS - 1);
    expect(server.resumeSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.resumeSession).toHaveBeenCalledTimes(2);

    for (let expected = 3; expected <= AUTO_RESUME_MAX; expected++) {
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(AUTO_RESUME_STAGGER_MS - 1);
      expect(server.resumeSession).toHaveBeenCalledTimes(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.resumeSession).toHaveBeenCalledTimes(expected);
    }

    for (const release of releases.splice(0)) release();
    await run;

    expect(maxActive).toBe(2);
    expect(server.resumeSession).toHaveBeenCalledTimes(AUTO_RESUME_MAX);
    for (const [options] of server.resumeSession.mock.calls) {
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
    server.resumeSession = vi.fn().mockResolvedValue({
      ok: false,
      reason: "conversation_busy",
      detectedBy: ["jsonl_mtime"],
      lastActivityMs: 100,
      likelyOwner: "external",
    });

    await server.autoResumePreviousSessions([
      mkRow({ project_path: projectDir, status_updated_at: Date.now() }),
    ]);

    expect(server.resumeSession.mock.calls[0][0]).not.toHaveProperty("force");
    expect(
      server.log.info.mock.calls.some(
        ([, fields]) =>
          fields?.event === "sessions.auto_resume_skipped" &&
          fields?.reason === "conversation_busy",
      ),
    ).toBe(true);
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

  async function startServer(autoResumeOnBoot: boolean) {
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
});
