// JSONL end-of-turn signals (#1048). They supplement the PTY turn signals: a
// transcript line settles a still-`running` turn only when the PTY path has not,
// and never one that started after the line was written.
//
// Fixtures are raw lines copied from real transcripts (codex 0.160 rollouts,
// Claude Code 2.1.282); see the notes in each file's first test.
import { EventEmitter } from "events";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import { LiveSessionManager } from "../src/live-session-manager";
import { PTYManager } from "../src/pty-manager";
import { StreamerServer, TURN_SILENCE_CEILING_MS } from "../src/server";
import { transcriptTurnEndAt } from "../src/services/sessions/transcriptTurnEnd";
import type { ManagedSession } from "../src/types";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const fixture = (name: string): string[] =>
  readFileSync(join(__dirname, "fixtures", "transcript-turn-end", name), "utf8")
    .split("\n")
    .filter(Boolean);

// Codex: [0] task_complete (root), [1] turn_aborted, [2] task_complete of a subagent turn.
// The subagent line has `last_agent_message` set to null; every other byte is as written.
const CODEX = fixture("codex-0.160-turn-end.jsonl");
// Claude: one `system` / `turn_duration` line, `cwd` replaced with a placeholder.
const CLAUDE = fixture("claude-2.1.282-turn-end.jsonl");

const at = (iso: string) => Date.parse(iso);

describe("transcriptTurnEndAt", () => {
  it("reads task_complete and turn_aborted off a Codex rollout", () => {
    expect(transcriptTurnEndAt("codex-cli", [CODEX[0]])).toBe(at("2026-10-28T15:25:13.010Z"));
    expect(transcriptTurnEndAt("codex-cli", [CODEX[1]])).toBe(at("2026-10-24T11:03:27.606Z"));
  });

  it("ignores a Codex subagent turn (turn_id differs from root_turn_id)", () => {
    expect(transcriptTurnEndAt("codex-cli", [CODEX[2]])).toBeNull();
  });

  it("reads turn_duration off a Claude transcript", () => {
    expect(transcriptTurnEndAt("claude-code", CLAUDE)).toBe(at("2026-09-25T22:56:36.018Z"));
  });

  it("ignores a Claude sidechain turn_duration", () => {
    const side = CLAUDE[0].replace('"isSidechain":false', '"isSidechain":true');
    expect(transcriptTurnEndAt("claude-code", [side])).toBeNull();
  });

  it("does not cross providers", () => {
    expect(transcriptTurnEndAt("claude-code", CODEX)).toBeNull();
    expect(transcriptTurnEndAt("codex-cli", CLAUDE)).toBeNull();
  });

  it("returns the latest end in a batch and survives junk lines", () => {
    expect(transcriptTurnEndAt("codex-cli", ["not json", "{}", CODEX[1], CODEX[0]])).toBe(
      at("2026-10-28T15:25:13.010Z"),
    );
  });
});

type Settler = {
  startFresh(o: { projectPath: string; projectName: string }): Promise<ManagedSession>;
  settleFromTranscript(id: string, lines: string[]): void;
  dispose(): void;
};

// Put the session in `running` as sendInput leaves it, with the running state
// stamped at `since`.
function makeRunning(runner: Settler, id: string, since: string) {
  const s = (runner as any).sessions.get(id);
  s.status = "running";
  s.statusSource = "user-input";
  s.statusUpdatedAt = new Date(since);
  return s;
}

describe.each([
  [
    "codex-cli",
    () => new CodexPtyRunner({}),
    CODEX[0],
    "2026-10-28T15:25:00.000Z",
    (r: any, id: string) => r.turnBusy.add(id),
    (r: any, id: string) => r.turnBusy.has(id),
  ],
  [
    "claude-code",
    () => new PTYManager({}),
    CLAUDE[0],
    "2026-09-25T22:56:00.000Z",
    (r: any, id: string) => r.turnOpen.set(id, "working"),
    (r: any, id: string) => r.turnOpen.has(id),
  ],
] as const)("%s settleFromTranscript", (_name, make, line, since, openTurn, turnOpen) => {
  let runner: Settler;
  let id: string;
  const changes: ManagedSession[] = [];
  beforeEach(async () => {
    changes.length = 0;
    const r = make();
    (r as any).onStatusChange = (s: ManagedSession) => changes.push({ ...s });
    runner = r as unknown as Settler;
    id = (await runner.startFresh({ projectPath: "/tmp", projectName: "p" })).id;
  });
  afterEach(() => runner.dispose());

  it("settles a running turn as a turn-signal", () => {
    const s = makeRunning(runner, id, since);
    runner.settleFromTranscript(id, [line]);
    expect(s.status).toBe("waiting_input");
    expect(s.statusSource).toBe("turn-signal");
  });

  it("closes the runner's own turn state so a later PTY signal has nothing to repeat", () => {
    makeRunning(runner, id, since);
    openTurn(runner, id);
    (runner as any).awaitingStart.set(id, Date.now());
    runner.settleFromTranscript(id, [line]);
    expect(turnOpen(runner, id)).toBe(false);
    expect((runner as any).awaitingStart.has(id)).toBe(false);
  });

  it("settles once: a repeat of the same line does not publish again", () => {
    makeRunning(runner, id, since);
    runner.settleFromTranscript(id, [line]);
    const n = changes.length;
    runner.settleFromTranscript(id, [line]);
    expect(changes.length).toBe(n);
  });

  it("leaves a turn the PTY already settled alone (no flip, no second publish)", () => {
    const s = makeRunning(runner, id, since);
    s.status = "waiting_input";
    s.statusSource = "prompt-marker";
    runner.settleFromTranscript(id, [line]);
    expect(s.statusSource).toBe("prompt-marker");
    expect(changes).toHaveLength(0);
  });

  it("ignores a line written before the current turn started", () => {
    const s = makeRunning(runner, id, "2099-01-01T00:00:00.000Z");
    runner.settleFromTranscript(id, [line]);
    expect(s.status).toBe("running");
  });

  it("ignores a batch with no end-of-turn line", () => {
    const s = makeRunning(runner, id, since);
    runner.settleFromTranscript(id, ['{"type":"assistant"}']);
    expect(s.status).toBe("running");
  });
});

describe("Codex turn_aborted", () => {
  it("settles a running turn too", async () => {
    const runner = new CodexPtyRunner({});
    const id = (await runner.startFresh({ projectPath: "/tmp", projectName: "p" })).id;
    const s = makeRunning(runner as unknown as Settler, id, "2026-10-24T11:03:00.000Z");
    runner.settleFromTranscript(id, [CODEX[1]]);
    expect(s.status).toBe("waiting_input");
    runner.dispose();
  });
});

describe("LiveSessionManager.settleFromTranscript", () => {
  it("reaches only the runner that owns the session, and tolerates an unknown one", () => {
    const mgr = new LiveSessionManager({});
    const runners = (mgr as any).runners as Map<string, any>;
    const owner = runners.get("codex-cli");
    const other = runners.get("claude-code");
    vi.spyOn(owner, "hasSession").mockReturnValue(true);
    const ownerSpy = vi.spyOn(owner, "settleFromTranscript").mockImplementation(() => {});
    const otherSpy = vi.spyOn(other, "settleFromTranscript").mockImplementation(() => {});
    mgr.settleFromTranscript("s1", [CODEX[0]]);
    expect(ownerSpy).toHaveBeenCalledWith("s1", [CODEX[0]]);
    expect(otherSpy).not.toHaveBeenCalled();
    vi.spyOn(owner, "hasSession").mockReturnValue(false);
    expect(() => mgr.settleFromTranscript("gone", [CODEX[0]])).not.toThrow();
    mgr.dispose();
  });
});

describe("server wiring and silence ceiling", () => {
  let cacheDir: string;
  let scanDir: string;
  let server: StreamerServer;
  const warns: { message: string; meta: Record<string, any> }[] = [];

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "turn-end-cache-"));
    scanDir = mkdtempSync(join(tmpdir(), "turn-end-scan-"));
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_test_turn_end",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [{ id: "test", label: "Test", configDir: scanDir, enabled: true, emoji: "T" }],
      codexRoots: [],
      scannerPersistent: false,
    });
    warns.length = 0;
    (server as any).log.warn = (message: string, meta: Record<string, any>) =>
      warns.push({ message, meta });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  });

  it("hands a managed session's new transcript lines to the runner and counts them as activity", () => {
    const spy = vi
      .spyOn((server as any).ptyManager, "settleFromTranscript")
      .mockImplementation(() => {});
    (server as any).sessionFileMap.set("s1", "/t/s1.jsonl");
    (server as any).fileWatcher.onNewLines("/t/s1.jsonl", [CODEX[0]]);
    expect(spy).toHaveBeenCalledWith("s1", [CODEX[0]]);
    expect((server as any).lastAgentChunkAt.get("s1")).toBeGreaterThan(Date.now() - 5_000);
  });

  it("does not call the runner for a file no session owns", () => {
    const spy = vi
      .spyOn((server as any).ptyManager, "settleFromTranscript")
      .mockImplementation(() => {});
    (server as any).fileWatcher.onNewLines("/t/other.jsonl", [CODEX[0]]);
    expect(spy).not.toHaveBeenCalled();
  });

  describe("ceiling", () => {
    const T0 = 1_800_000_000_000;
    const running = (over: Record<string, unknown> = {}) =>
      ({
        id: "run-1",
        provider: "codex-cli",
        status: "running",
        projectPath: "/tmp",
        projectName: "p",
        promptCount: 1,
        startedAt: new Date(T0),
        statusUpdatedAt: new Date(T0),
        lastActivityAt: new Date(T0),
        ...over,
      }) as any;
    const sweep = (now: number, sessions = [running()]) => {
      vi.spyOn((server as any).ptyManager, "listSessions").mockReturnValue(sessions);
      const hold = vi.spyOn((server as any).ptyManager, "putOnHold").mockImplementation(() => {});
      const reaped = (server as any).reapIdleSessions(now);
      return { hold, reaped };
    };
    const ceilingWarns = () => warns.filter((w) => w.meta.event === "pty.turn_ceiling");

    it("is 30 minutes", () => {
      expect(TURN_SILENCE_CEILING_MS).toBe(30 * 60_000);
    });

    it("stays quiet just under the ceiling", () => {
      sweep(T0 + TURN_SILENCE_CEILING_MS - 1);
      expect(ceilingWarns()).toHaveLength(0);
    });

    it("warns at the ceiling with session, provider and silence, and changes nothing", () => {
      const s = running();
      const { hold, reaped } = sweep(T0 + TURN_SILENCE_CEILING_MS, [s]);
      expect(ceilingWarns()).toHaveLength(1);
      expect(ceilingWarns()[0].meta).toMatchObject({
        sessionId: "run-1",
        provider: "codex-cli",
        silentMs: TURN_SILENCE_CEILING_MS,
      });
      expect(s.status).toBe("running");
      expect(hold).not.toHaveBeenCalled();
      expect(reaped).toEqual([]);
    });

    it("warns once per turn, not on every sweep", () => {
      const s = running();
      sweep(T0 + TURN_SILENCE_CEILING_MS, [s]);
      sweep(T0 + TURN_SILENCE_CEILING_MS + 300_000, [s]);
      sweep(T0 + TURN_SILENCE_CEILING_MS + 600_000, [s]);
      expect(ceilingWarns()).toHaveLength(1);
    });

    it("warns again for the next turn", () => {
      sweep(T0 + TURN_SILENCE_CEILING_MS);
      const next = T0 + 2 * TURN_SILENCE_CEILING_MS;
      sweep(next + TURN_SILENCE_CEILING_MS, [
        running({
          statusUpdatedAt: new Date(next),
          lastActivityAt: new Date(next),
        }),
      ]);
      expect(ceilingWarns()).toHaveLength(2);
    });

    it("measures silence from the latest output chunk", () => {
      (server as any).lastAgentChunkAt.set("run-1", T0 + 20 * 60_000);
      sweep(T0 + TURN_SILENCE_CEILING_MS);
      expect(ceilingWarns()).toHaveLength(0);
    });

    it("measures silence from the latest user input too", () => {
      sweep(T0 + TURN_SILENCE_CEILING_MS, [
        running({ lastActivityAt: new Date(T0 + 20 * 60_000) }),
      ]);
      expect(ceilingWarns()).toHaveLength(0);
    });

    it("never warns for a settled session", () => {
      sweep(T0 + TURN_SILENCE_CEILING_MS * 2, [running({ status: "waiting_input" })]);
      expect(ceilingWarns()).toHaveLength(0);
    });
  });
});
