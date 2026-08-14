/**
 * Codex active-writer resume collisions (2026-08-09 incident).
 *
 * Codex enforces a single-writer lock per rollout and only reports it AFTER
 * `codex resume` starts. The streamer used to answer 201, then the PTY printed
 * "already has an active writer (code -32600)" and went idle with no structured
 * failure — mobile sat on a pending screen until its 20s fallback.
 *
 * Covered here: the runner-level detection + teardown (fix 1), the pre-flight
 * open-file collision response (fix 2), and `POST /api/sessions/:id/fork`
 * (fix 3).
 */
import { EventEmitter } from "events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import {
  CODEX_ACTIVE_WRITER_CODE,
  CODEX_ACTIVE_WRITER_RE,
} from "../src/services/questions/codexScreen";
import type { CodexRolloutOwner } from "../src/services/sessions/codexRolloutOwner";
import type { ManagedSession } from "../src/types";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 54321,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// What the pre-flight probe finds, per test. Mocked at the module boundary so
// the server path can be exercised without a real `lsof` or a real Codex.
const preflightOwner: { value: CodexRolloutOwner | null } = { value: null };
vi.mock("../src/services/sessions/codexRolloutOwner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/sessions/codexRolloutOwner")>();
  return { ...actual, findRolloutOwner: vi.fn(async () => preflightOwner.value) };
});

// Codex's refusal, verbatim from the incident log.
const ACTIVE_WRITER_TEXT = "already has an active writer (code -32600)";
const READY_STATUS_BAR = "\x1b[2J\x1b[Hgpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…\r\n";

const API_KEY = "tb_test_codex_active_writer";
const CODEX_SESSION_ID = "019fe355-2773-7950-8d17-f45f47feff4c";
const FIXTURE = join(__dirname, "fixtures", "codex-rollout.jsonl");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Shrink the post-spawn handshake window: these tests feed the mock PTY the
// moment it is spawned, so the production 4s allowance is pure dead time on a
// box already slow to boot a server under full-suite load.
// Each HTTP case boots a whole StreamerServer, measured at 5s+ before the first
// request on a box under full-suite load — the default 15s is a coin flip there.
vi.setConfig({ testTimeout: 60_000 });

beforeAll(() => {
  process.env.THREADBASE_CODEX_STARTUP_TIMEOUT_MS = "1500";
});
afterAll(() => {
  delete process.env.THREADBASE_CODEX_STARTUP_TIMEOUT_MS;
});

describe("CodexPtyRunner — writer-lock detection", () => {
  async function spawnAndFail(chunks: string[]) {
    const events: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const runner = new CodexPtyRunner({
      onStatusChange: (s) => events.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await runner.start(CODEX_SESSION_ID, { projectPath: "/tmp/proj" });
    const proc = (runner as any).sessions.get(session.id).process;
    for (const chunk of chunks) proc._emit("data", chunk);
    await tick();
    return { runner, events, ready, proc };
  }

  it("fails the startup when Codex reports the active writer", async () => {
    const { runner, events, ready, proc } = await spawnAndFail([
      `\x1b[2J\x1b[H${ACTIVE_WRITER_TEXT}\r\n`,
    ]);

    const last = events.at(-1);
    expect(last?.status).toBe("idle");
    expect(last?.failureCode).toBe(CODEX_ACTIVE_WRITER_CODE);
    expect(last?.failureReason).toMatch(/already open in another client/);
    // A failed startup is never "ready": no session_ready may reach a client.
    expect(ready).toEqual([]);
    expect(proc.kill).toHaveBeenCalled();

    // No residue: runner map, pending-ready set, queue, timers, quiet-checker.
    expect(runner.hasSession(CODEX_SESSION_ID)).toBe(false);
    expect((runner as any).pendingReady.size).toBe(0);
    expect((runner as any).queuedInputs.size).toBe(0);
    expect((runner as any).readyFallbackTimers.size).toBe(0);
    expect((runner as any).quietCheckers.size).toBe(0);
    runner.dispose();
  });

  it("detects the error when it arrives split across PTY chunks", async () => {
    // The raw chunks contain no matching substring on their own — detection
    // runs against the rendered screen, which is the point.
    const first = `\x1b[2J\x1b[Halready has an active `;
    const second = "writer (code -32600)\r\n";
    expect(CODEX_ACTIVE_WRITER_RE.test(first)).toBe(false);
    expect(CODEX_ACTIVE_WRITER_RE.test(second)).toBe(true); // carries the code half

    const { runner, events } = await spawnAndFail([first, "wri", "ter (code ", "-326", "00)\r\n"]);
    expect(events.at(-1)?.failureCode).toBe(CODEX_ACTIVE_WRITER_CODE);
    runner.dispose();
  });

  it("positive control: a normal boot still becomes ready and stays alive", async () => {
    const { runner, events, ready } = await spawnAndFail([READY_STATUS_BAR]);
    expect(events.at(-1)?.status).toBe("waiting_input");
    expect(events.at(-1)?.failureCode).toBeUndefined();
    expect(ready).toHaveLength(1);
    expect(runner.hasSession(CODEX_SESSION_ID)).toBe(true);
    runner.dispose();
  });

  it("spawns `codex fork <id>` for a fork, leaving the source id untouched", async () => {
    const nodePty = await import("node-pty");
    const spawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
    spawn.mockClear();

    const runner = new CodexPtyRunner();
    const forked = await runner.startFork({
      forkFromId: CODEX_SESSION_ID,
      projectPath: "/tmp/proj",
    });

    expect(spawn.mock.calls[0][1]).toEqual([
      "fork",
      CODEX_SESSION_ID,
      "--cd",
      "/tmp/proj",
      "--no-alt-screen",
    ]);
    // The fork is a NEW conversation: it must not reuse the source's id.
    expect(forked.id).not.toBe(CODEX_SESSION_ID);
    expect(forked.provider).toBe("codex-cli");
    runner.dispose();
  });
});

describe("Codex active-writer over HTTP", () => {
  let codexRoot: string;
  let liveCwd: string;
  let rolloutPath: string;
  let ptySpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    preflightOwner.value = null;
    const nodePty = await import("node-pty");
    ptySpawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
    ptySpawn.mockClear();

    liveCwd = mkdtempSync(join(tmpdir(), "tb-codex-writer-cwd-"));
    codexRoot = mkdtempSync(join(tmpdir(), "tb-codex-writer-root-"));
    const dateDir = join(codexRoot, "2026", "08", "09");
    mkdirSync(dateDir, { recursive: true });
    rolloutPath = join(dateDir, `rollout-2026-08-09T00-43-56-${CODEX_SESSION_ID}.jsonl`);
    copyFileSync(FIXTURE, rolloutPath);
    const lines = readFileSync(rolloutPath, "utf8").split("\n");
    const meta = JSON.parse(lines[0]);
    meta.payload.id = CODEX_SESSION_ID;
    meta.payload.session_id = CODEX_SESSION_ID;
    meta.payload.cwd = liveCwd;
    lines[0] = JSON.stringify(meta);
    writeFileSync(rolloutPath, lines.join("\n"));
  });

  async function startServer(name: string) {
    const { StreamerServer } = await import("../src/server");
    process.env.TB_SCANNER_DB = join(codexRoot, `${name}.db`);
    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), `tb-codex-writer-${name}-`)),
      scanProfiles: [],
      codexRoots: [codexRoot],
    });
    await server.listen(0, { awaitReady: true });
    return server;
  }

  function post(server: any, path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${server.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
  }

  // Feed the mock PTY once the request under test has spawned it.
  async function driveSpawnedPty(chunks: string[]): Promise<boolean> {
    for (let i = 0; i < 200 && ptySpawn.mock.results.length === 0; i++) await tick(10);
    const proc = ptySpawn.mock.results.at(-1)?.value;
    if (!proc) return false;
    for (const chunk of chunks) proc._emit("data", chunk);
    return true;
  }

  it("answers a structured 409 when the pre-flight finds the rollout held open", async () => {
    preflightOwner.value = { pid: 9935, command: "codex", source: "terminal" };
    const server = await startServer("preflight");
    try {
      const res = await post(server, "/api/sessions/resume", { sessionId: CODEX_SESSION_ID });
      expect(res.status).toBe(409);
      const body = await res.json();
      // Old mobile builds switch on `code`; everything else is additive.
      expect(body.code).toBe("CONVERSATION_BUSY");
      expect(body.reasonCode).toBe("CODEX_SESSION_ACTIVE");
      expect(body.provider).toBe("codex-cli");
      expect(body.detectedBy).toEqual(["file_handle"]);
      expect(body.likelyOwner).toBe("external");
      expect(body.canForce).toBe(false);
      expect(body.canTakeOver).toBe(false);
      expect(body.canFork).toBe(true);
      expect(body.ownerPid).toBe(9935);
      expect(body.ownerSource).toBe("terminal");
      // Refused before spawning: the collision costs no process at all.
      expect(ptySpawn.mock.calls.length).toBe(0);
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });

  it("does not let force bypass Codex's writer lock", async () => {
    preflightOwner.value = { pid: 9935, command: "codex", source: "terminal" };
    const server = await startServer("force");
    try {
      const res = await post(server, "/api/sessions/resume", {
        sessionId: CODEX_SESSION_ID,
        force: true,
      });
      // force only ever bypassed OUR heuristic — Codex enforces this one itself,
      // so forcing past it would spawn a PTY that is refused anyway.
      expect(res.status).toBe(409);
      expect((await res.json()).canForce).toBe(false);
      expect(ptySpawn.mock.calls.length).toBe(0);
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });

  it("answers 409, not 201, when Codex reports the writer lock after spawn", async () => {
    const server = await startServer("handshake");
    try {
      const pending = post(server, "/api/sessions/resume", { sessionId: CODEX_SESSION_ID });
      const drove = await driveSpawnedPty([`\x1b[2J\x1b[H${ACTIVE_WRITER_TEXT}\r\n`]);
      expect(drove).toBe(true);

      const res = await pending;
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("CONVERSATION_BUSY");
      expect(body.reasonCode).toBe("CODEX_SESSION_ACTIVE");
      expect(body.canFork).toBe(true);

      // Nothing survives a failed start: the session list is not polluted with
      // a dead session mobile would render as resumable.
      const list = await fetch(`http://localhost:${server.port}/api/sessions`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const sessions = (await list.json()).sessions ?? [];
      expect(
        sessions.some((s: any) => s.id === CODEX_SESSION_ID && s.ownership === "managed"),
      ).toBe(false);
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });

  it("forks into a new session without touching the source rollout", async () => {
    const server = await startServer("fork");
    const before = readFileSync(rolloutPath, "utf8");
    try {
      const pending = post(server, `/api/sessions/${CODEX_SESSION_ID}/fork`, {});
      const drove = await driveSpawnedPty([READY_STATUS_BAR]);
      expect(drove).toBe(true);

      const res = await pending;
      expect(res.status).toBe(201);
      const body = await res.json();
      // Distinct identities: the fork is a second conversation, and the source
      // keeps its own owner and its own id.
      expect(body.id).not.toBe(CODEX_SESSION_ID);
      expect(body.forkedFromConversationId).toBe(CODEX_SESSION_ID);
      expect(body.resumedFromConversationId).toBeUndefined();
      expect(body.provider).toBe("codex-cli");

      const [exe, args] = ptySpawn.mock.calls[0];
      expect(exe).toMatch(/codex/);
      expect(args).toEqual(["fork", CODEX_SESSION_ID, "--cd", liveCwd, "--no-alt-screen"]);

      // The other client's rollout is untouched — no kill, no write, no resume.
      expect(readFileSync(rolloutPath, "utf8")).toBe(before);
      const proc = ptySpawn.mock.results.at(-1)?.value;
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });

  it("refuses to fork a Claude conversation instead of silently resuming it", async () => {
    const server = await startServer("unsupported");
    try {
      // A conversation id that resolves to nothing Codex-shaped.
      const res = await post(server, "/api/sessions/deadbeef-0000-4000-8000-000000000000/fork", {});
      expect([404, 501]).toContain(res.status);
      expect(ptySpawn.mock.calls.length).toBe(0);
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });
});
