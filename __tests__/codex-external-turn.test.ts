import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { conversationToResumableSession } from "../src/api/handlers/http-helpers";
import { resolveSessionIds, type SessionIdResolvers } from "../src/process-discovery";
import { CODEX_TURN_STALE_MS, CodexTurnTracker } from "../src/services/sessions/codexTurnState";
import { SessionStore } from "../src/session-store";
import type { DiscoveredProcess } from "../src/types";

const ROOT = "01a1eda7-98f8-7202-960a-8a83b5335c82";
const ROOT2 = "01a1eda7-98f8-7202-960a-8a83b5335c99";
const CHILD = "01a1eda7-98f8-7202-960a-8a83b5335c11";
const ROLLOUT_ID = "019a0000-1111-4222-8333-444455556666";
const T0 = "2026-11-18T07:55:46.387Z";
const T1 = "2026-11-18T07:57:10.000Z";

// Shapes captured from codex-cli 0.171.0 rollouts (ids replaced).
function started(turnId: string, root = turnId, at = T0): string {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId, root_turn_id: root, started_at: 1 },
  });
}
function ended(kind: "task_complete" | "turn_aborted", turnId: string, root = turnId, at = T1) {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: kind, turn_id: turnId, root_turn_id: root },
  });
}
const message = JSON.stringify({
  timestamp: T0,
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-turn-"));
  file = join(dir, `rollout-2026-11-18T07-55-46-${ROLLOUT_ID}.jsonl`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(...lines: string[]) {
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
}

describe("CodexTurnTracker", () => {
  it("reads an unmatched root start as busy, dated by the start", async () => {
    write(message, started(ROOT));
    const t = await new CodexTurnTracker().read(file);
    expect(t.state).toBe("busy");
    expect(t.updatedAt.toISOString()).toBe(T0);
  });

  it("reads a start paired with task_complete as idle, dated by the end", async () => {
    write(started(ROOT), ended("task_complete", ROOT));
    const t = await new CodexTurnTracker().read(file);
    expect(t.state).toBe("idle");
    expect(t.updatedAt.toISOString()).toBe(T1);
  });

  it("reads a start paired with turn_aborted (interrupt) as idle", async () => {
    write(started(ROOT), ended("turn_aborted", ROOT));
    expect((await new CodexTurnTracker().read(file)).state).toBe("idle");
  });

  it("ignores a subagent's end while the root turn runs", async () => {
    write(started(ROOT), started(CHILD, ROOT), ended("task_complete", CHILD, ROOT));
    expect((await new CodexTurnTracker().read(file)).state).toBe("busy");
  });

  it("ignores a subagent's start after the root turn ended", async () => {
    write(started(ROOT), ended("task_complete", ROOT), started(CHILD, ROOT));
    expect((await new CodexTurnTracker().read(file)).state).toBe("idle");
  });

  it("is unknown with no turn lines, no file, or two open starts", async () => {
    const tracker = new CodexTurnTracker();
    write(message);
    expect((await tracker.read(file)).state).toBe("unknown");
    expect((await tracker.read(join(dir, "missing.jsonl"))).state).toBe("unknown");
    write(started(ROOT), started(ROOT2));
    expect((await new CodexTurnTracker().read(file)).state).toBe("unknown");
  });

  it("is unknown, never idle, when a started rollout goes silent past the ceiling", async () => {
    write(started(ROOT));
    const t = await new CodexTurnTracker().read(file, Date.now() + CODEX_TURN_STALE_MS + 1000);
    expect(t.state).toBe("unknown");
  });

  it("clears busy when an end is appended between reads", async () => {
    const tracker = new CodexTurnTracker();
    write(started(ROOT));
    expect((await tracker.read(file)).state).toBe("busy");
    appendFileSync(file, `${ended("task_complete", ROOT)}\n`);
    expect((await tracker.read(file)).state).toBe("idle");
  });

  it("does not count a line still being written", async () => {
    const tracker = new CodexTurnTracker();
    const end = ended("task_complete", ROOT);
    write(started(ROOT));
    appendFileSync(file, end.slice(0, 20));
    expect((await tracker.read(file)).state).toBe("busy");
    appendFileSync(file, `${end.slice(20)}\n`);
    expect((await tracker.read(file)).state).toBe("idle");
  });

  it("drops a start cut short by a crash once a later turn ends", async () => {
    write(started(ROOT), started(ROOT2, ROOT2, T1), ended("task_complete", ROOT2));
    expect((await new CodexTurnTracker().read(file)).state).toBe("idle");
  });

  it("rereads a rollout that shrank instead of keeping its old busy", async () => {
    const tracker = new CodexTurnTracker();
    write(message, message, started(ROOT));
    expect((await tracker.read(file)).state).toBe("busy");
    write(message);
    expect((await tracker.read(file)).state).toBe("unknown");
  });
});

describe("resolveSessionIds for an external Codex process", () => {
  const proc: DiscoveredProcess = {
    pid: 777,
    provider: "codex-cli",
    projectPath: "/tmp/p",
    projectName: "p",
    branch: "main",
    conversationId: null,
    startedAt: new Date(),
  };
  const resolvers = (codex: SessionIdResolvers["codex"]): SessionIdResolvers => ({
    claude: async () => null,
    codex,
    codexTurn: (p) => new CodexTurnTracker().read(p),
    teammate: async () => null,
  });

  it("reads the turn from the rollout the pid holds open", async () => {
    write(started(ROOT));
    const [out] = await resolveSessionIds(
      [proc],
      new Map(),
      resolvers(async () => ({ id: ROLLOUT_ID, path: file })),
    );
    expect(out.conversationId).toBe(ROLLOUT_ID);
    expect(out.turnState?.state).toBe("busy");
    expect(out.turnState?.observedAt).toBeInstanceOf(Date);
  });

  it("reports unknown when no rollout can be matched to the pid", async () => {
    const [out] = await resolveSessionIds(
      [proc],
      new Map(),
      resolvers(async () => null),
    );
    expect(out.turnState?.state).toBe("unknown");
  });
});

describe("externalTurn on the wire for Codex", () => {
  const busyAt = new Date(T0);
  const observedAt = new Date(T1);
  const codexProc: DiscoveredProcess = {
    pid: 777,
    provider: "codex-cli",
    projectPath: "/tmp/p",
    projectName: "p",
    branch: "main",
    conversationId: ROLLOUT_ID,
    startedAt: new Date(T0),
    turnState: { state: "busy", updatedAt: busyAt, observedAt },
  };

  it("reports busy as inferred codex-rollout evidence, leaving status, ownership and id alone", () => {
    const store = new SessionStore();
    store.setDiscovered([codexProc]);
    const resp = store.get(ROLLOUT_ID, new Set());
    expect(resp).toMatchObject({
      id: ROLLOUT_ID,
      status: "idle",
      ownership: "external",
      processLiveness: "alive",
      hasOpenPrompt: false,
      externalTurn: {
        state: "busy",
        updatedAt: T0,
        observedAt: T1,
        source: "codex-rollout",
        confidence: "inferred",
      },
    });
  });

  it("replaces a busy with the next observation, and drops the row when the owner exits", () => {
    const store = new SessionStore();
    store.setDiscovered([codexProc]);
    store.setDiscovered([
      { ...codexProc, turnState: { state: "unknown", updatedAt: observedAt, observedAt } },
    ]);
    expect(store.get(ROLLOUT_ID, new Set())?.externalTurn?.state).toBe("unknown");
    store.setDiscovered([]);
    expect(store.get(ROLLOUT_ID, new Set())).toBeNull();
  });

  it("clears externalTurn explicitly on the row a merging client sees next", () => {
    // The historical row that replaces an exited external session.
    const row = conversationToResumableSession({
      id: ROLLOUT_ID,
      provider: "codex-cli",
      projectPath: "/tmp/p",
      projectName: "p",
      lastActivity: T1,
      messageCount: 2,
    } as Parameters<typeof conversationToResumableSession>[0]);
    expect(row.externalTurn).toBeNull();
    // A merge of old busy with the new row must not keep busy.
    expect({ externalTurn: { state: "busy" }, ...row }.externalTurn).toBeNull();
  });

  it("never sets externalTurn on a session this streamer manages", () => {
    const store = new SessionStore();
    store.addManaged({
      id: ROLLOUT_ID,
      provider: "codex-cli",
      projectPath: "/tmp/p",
      projectName: "p",
      branch: "main",
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      promptCount: 1,
      lastOutput: "",
    } as Parameters<SessionStore["addManaged"]>[0]);
    store.setDiscovered([codexProc]);
    const resp = store.get(ROLLOUT_ID, new Set([ROLLOUT_ID]));
    expect(resp?.ownership).toBe("managed");
    expect(resp?.status).toBe("running");
    expect(resp?.externalTurn).toBeNull();
  });
});
