/**
 * A terminal Claude session can ask the streamer to take it over once the
 * current turn ends (`POST /api/sessions/:id/adopt-after-turn`, called by the
 * MCP `handoff_to_threadbase` tool). The request comes from inside the turn it
 * would end, so nothing may be killed before that turn is over, and every
 * refusal has to come back before the agent tells the user it is leaving.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
  readGitBranch: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/services/sessions/processSessionIds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/sessions/processSessionIds")>()),
  readClaudeSessionRegistry: vi.fn(),
}));

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 99999,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

import { spawn as nodePtySpawn } from "node-pty";
import { waitForTurnEnd } from "../src/api/handlers/sessions.handlers";
import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";
import { readClaudeSessionRegistry } from "../src/services/sessions/processSessionIds";

const ptySpawn = nodePtySpawn as unknown as ReturnType<typeof vi.fn>;
const registry = vi.mocked(readClaudeSessionRegistry);

const API_KEY = "tb_test_key_adopt_after_turn";
const CONV_ID = "bbbbbbbb-1111-4222-8333-444444444444";
const OTHER_ID = "cccccccc-1111-4222-8333-444444444444";
const PID = 999_998;

type Entry = { status?: string; statusUpdatedAt?: number };

describe("waitForTurnEnd", () => {
  const fast = { pollMs: 5, holdMs: 40, ceilingMs: 400 };

  function run(entries: () => Entry | null, isAlive = () => true) {
    return waitForTurnEnd({
      since: Date.now(),
      read: async () => entries(),
      isAlive,
      signal: new AbortController().signal,
      ...fast,
    });
  }

  it("fires once the entry reads idle after the request, held for the hold window", async () => {
    const since = Date.now();
    let reads = 0;
    const started = Date.now();
    const outcome = await waitForTurnEnd({
      since,
      read: async () =>
        ++reads < 4
          ? { status: "busy", statusUpdatedAt: since - 1 }
          : { status: "idle", statusUpdatedAt: since + 1 },
      isAlive: () => true,
      signal: new AbortController().signal,
      ...fast,
    });
    expect(outcome).toBe("idle");
    expect(Date.now() - started).toBeGreaterThanOrEqual(fast.holdMs);
  });

  it("ignores an idle written before the request", async () => {
    const since = Date.now();
    const outcome = await waitForTurnEnd({
      since,
      read: async () => ({ status: "idle", statusUpdatedAt: since - 1 }),
      isAlive: () => true,
      signal: new AbortController().signal,
      ...fast,
    });
    expect(outcome).toBe("turn_ceiling");
  });

  it("restarts the hold when the turn goes busy again", async () => {
    const since = Date.now();
    // idle for ~20 ms (half the hold), busy once, then idle for good.
    const flipAt = since + 20;
    let busyServed = false;
    let idleAgainAt = 0;
    const outcome = await waitForTurnEnd({
      since,
      read: async () => {
        if (Date.now() < flipAt) return { status: "idle", statusUpdatedAt: since + 1 };
        if (!busyServed) {
          busyServed = true;
          return { status: "busy", statusUpdatedAt: since + 2 };
        }
        idleAgainAt ||= Date.now();
        return { status: "idle", statusUpdatedAt: since + 3 };
      },
      isAlive: () => true,
      signal: new AbortController().signal,
      ...fast,
    });
    expect(outcome).toBe("idle");
    expect(busyServed).toBe(true);
    expect(Date.now() - idleAgainAt).toBeGreaterThanOrEqual(fast.holdMs);
  });

  it("keeps waiting while a question card has the status at waiting (dropped by the parser)", async () => {
    // The parser drops `waiting`, so the entry arrives with no status at all.
    const since = Date.now();
    const outcome = await waitForTurnEnd({
      since,
      read: async () => ({}),
      isAlive: () => true,
      signal: new AbortController().signal,
      ...fast,
    });
    expect(outcome).toBe("turn_ceiling");
  });

  it("reports owner_gone when the process exits before the turn ends", async () => {
    expect(
      await run(
        () => ({ status: "busy", statusUpdatedAt: Date.now() }),
        () => false,
      ),
    ).toBe("owner_gone");
  });

  it("stops at once when aborted", async () => {
    const abort = new AbortController();
    const pending = waitForTurnEnd({
      since: Date.now(),
      read: async () => ({ status: "busy" }),
      isAlive: () => true,
      signal: abort.signal,
      pollMs: 60_000,
    });
    abort.abort();
    expect(await pending).toBe("aborted");
  });
});

describe("POST /api/sessions/:id/adopt-after-turn", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;
  let projectCwd: string;

  beforeEach(async () => {
    ptySpawn.mockClear();
    registry.mockReset();

    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-adopt-after-turn-"));
    const configDir = join(tmpBase, "profile");
    mkdirSync(join(configDir, "projects"), { recursive: true });
    projectCwd = join(tmpBase, "project");
    mkdirSync(projectCwd, { recursive: true });

    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "cache"),
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(0);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function discover(projectPath = projectCwd) {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([
      {
        pid: PID,
        provider: "claude-code",
        projectPath,
        projectName: "project",
        branch: "",
        conversationId: CONV_ID,
        startedAt: new Date(),
      },
    ] as never);
  }

  function entry(over: Partial<{ sessionId: string; status?: string; statusUpdatedAt?: number }>) {
    return {
      pid: PID,
      sessionId: CONV_ID,
      status: "busy",
      statusUpdatedAt: Date.now(),
      ...over,
    } as never;
  }

  // Alive until a real signal is sent, then gone — what lets adopt's
  // kill-then-wait complete while the turn waiter still sees a live owner.
  function killableOwner() {
    let killed = false;
    const spy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: unknown) => {
      if (signal === 0) {
        if (killed) throw new Error("ESRCH");
        return true;
      }
      killed = true;
      return true;
    }) as never);
    return { spy, killed: () => killed };
  }

  function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/sessions/${CONV_ID}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  async function expectRefusal(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code?: string }).code).toBe(code);
  }

  it("schedules, answers 202, and adopts only after the turn ends", async () => {
    discover();
    const owner = killableOwner();
    let turnOver = false;
    registry.mockImplementation(async () =>
      turnOver
        ? entry({ status: "idle", statusUpdatedAt: Date.now() })
        : entry({ status: "busy", statusUpdatedAt: Date.now() }),
    );

    const res = await post("adopt-after-turn", { pid: PID });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      scheduled: true,
      sessionId: CONV_ID,
      ceilingMs: 600_000,
    });

    // A repeat call while pending is the same answer and leaves one job.
    const again = await post("adopt-after-turn", { pid: PID });
    expect(again.status).toBe(202);

    // Still mid-turn: nothing killed, nothing spawned.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(owner.killed()).toBe(false);
    expect(ptySpawn).not.toHaveBeenCalled();

    turnOver = true;
    await vi.waitFor(() => expect(ptySpawn).toHaveBeenCalledTimes(1), {
      timeout: 6_000,
      interval: 100,
    });
    expect(owner.killed()).toBe(true);
    expect(String(ptySpawn.mock.calls[0][0]).toLowerCase()).toContain("claude");
  }, 15_000);

  it("refuses a pid whose registry entry names another session", async () => {
    discover();
    const owner = killableOwner();
    registry.mockResolvedValue(entry({ sessionId: OTHER_ID }));
    await expectRefusal(
      await post("adopt-after-turn", { pid: PID }),
      400,
      "HANDOFF_SESSION_MISMATCH",
    );
    expect(owner.spy).not.toHaveBeenCalled();
  });

  it("refuses when discovery attributes the session to a different pid", async () => {
    discover();
    registry.mockResolvedValue(entry({ pid: PID + 1 } as never));
    await expectRefusal(
      await post("adopt-after-turn", { pid: PID + 1 }),
      400,
      "HANDOFF_SESSION_MISMATCH",
    );
  });

  it("refuses when the registry has no entry for the pid", async () => {
    discover();
    registry.mockResolvedValue(null);
    await expectRefusal(
      await post("adopt-after-turn", { pid: PID }),
      400,
      "HANDOFF_SESSION_MISMATCH",
    );
  });

  it("refuses an entry without turn state", async () => {
    discover();
    registry.mockResolvedValue(entry({ status: undefined, statusUpdatedAt: undefined }));
    await expectRefusal(await post("adopt-after-turn", { pid: PID }), 409, "HANDOFF_NO_TURN_STATE");
  });

  it("refuses a session the streamer already manages", async () => {
    discover();
    registry.mockResolvedValue(entry({}));
    const store = (server as unknown as { sessionStore: { ownsConversation: () => boolean } })
      .sessionStore;
    vi.spyOn(store, "ownsConversation").mockReturnValue(true);
    await expectRefusal(
      await post("adopt-after-turn", { pid: PID }),
      409,
      "HANDOFF_ALREADY_MANAGED",
    );
  });

  it("passes adopt's missing-project refusal through before scheduling", async () => {
    discover(join(tmpBase, "deleted-project"));
    const owner = killableOwner();
    registry.mockResolvedValue(entry({}));
    await expectRefusal(
      await post("adopt-after-turn", { pid: PID }),
      400,
      "ADOPT_PROJECT_PATH_MISSING",
    );
    expect(owner.spy).not.toHaveBeenCalled();
  });

  it("gives a code to the 404 for a session discovery has no row for", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([] as never);
    registry.mockResolvedValue(entry({}));
    await expectRefusal(
      await post("adopt-after-turn", { pid: PID }),
      404,
      "HANDOFF_NOT_DISCOVERED",
    );
  });

  it("rejects a missing or malformed pid", async () => {
    await expectRefusal(await post("adopt-after-turn", {}), 400, "HANDOFF_INVALID_PID");
    await expectRefusal(await post("adopt-after-turn", { pid: "12" }), 400, "HANDOFF_INVALID_PID");
  });
});

// Characterization: the adopt core was extracted from `handleAdopt`, whose
// responses must not change.
describe("POST /api/sessions/:id/adopt — responses unchanged", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;

  beforeEach(async () => {
    ptySpawn.mockClear();
    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-adopt-char-"));
    const configDir = join(tmpBase, "profile");
    mkdirSync(join(configDir, "projects"), { recursive: true });
    mkdirSync(join(tmpBase, "project"), { recursive: true });
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "cache"),
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(0);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const adopt = () =>
    fetch(`${baseUrl}/api/sessions/${CONV_ID}/adopt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

  it("answers 201 with only the session id", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([
      {
        pid: PID,
        provider: "claude-code",
        projectPath: join(tmpBase, "project"),
        projectName: "project",
        branch: "",
        conversationId: CONV_ID,
        startedAt: new Date(),
      },
    ] as never);
    vi.spyOn(process, "kill").mockImplementation(((_p: number, s?: unknown) => {
      if (s === 0) throw new Error("ESRCH");
      return true;
    }) as never);
    const res = await adopt();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sessionId: CONV_ID });
  });

  it("answers the bare 404 body for an undiscovered session", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([] as never);
    const res = await adopt();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Discovered session not found" });
  });

  it("answers 409 ADOPT_KILL_TIMEOUT when the owner outlives SIGTERM", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([
      {
        pid: PID,
        provider: "claude-code",
        projectPath: join(tmpBase, "project"),
        projectName: "project",
        branch: "",
        conversationId: CONV_ID,
        startedAt: new Date(),
      },
    ] as never);
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const res = await adopt();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "The existing process did not exit; not starting a second agent on this conversation",
      code: "ADOPT_KILL_TIMEOUT",
      pid: PID,
    });
    expect(ptySpawn).not.toHaveBeenCalled();
  }, 15_000);
});
