import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { conversationToResumableSession } from "../src/api/handlers/http-helpers";
import { resolveSessionIds, type SessionIdResolvers } from "../src/process-discovery";
import { codexPaneScreen } from "../src/services/sessions/codexPaneScreen";
import {
  CODEX_TURN_STALE_MS,
  type CodexTurnState,
  CodexTurnTracker,
  combineCodexTurn,
  readCodexScreen,
} from "../src/services/sessions/codexTurnState";
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
  const resolvers = (
    codex: SessionIdResolvers["codex"],
    codexScreen: SessionIdResolvers["codexScreen"] = async () => null,
  ): SessionIdResolvers => ({
    claude: async () => null,
    codex,
    codexTurn: (p) => new CodexTurnTracker().read(p),
    codexScreen,
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

  it("reports an approval on the pane as waiting while the rollout says busy", async () => {
    write(started(ROOT));
    const [out] = await resolveSessionIds(
      [proc],
      new Map(),
      resolvers(
        async () => ({ id: ROLLOUT_ID, path: file }),
        async () => APPROVAL_SCREEN,
      ),
    );
    expect(out.turnState).toMatchObject({ state: "waiting", source: "codex-screen" });
  });
});

// The footer of a codex-cli 0.171.0 tmux capture (path and model replaced):
// the status bar is the second-to-last row, a shortcuts hint sits under it.
const READY_SCREEN = [
  "• Done.",
  "",
  "› Ask Codex to do anything",
  "  gpt low · ~/dev/app · main · No changes · Ready · Full Access · never · Context 60% left",
  "  ← for agents · ? for shortcuts      ⚠ 5 warnings",
  "",
];
const WORKING_SCREEN = [
  "• Working (12s • esc to interrupt)",
  "",
  "› Ask Codex to do anything",
  "  gpt low · ~/dev/app · main · Full Access · never · Context 60% left",
  "  ← for agents · ? for shortcuts",
];
const USAGE_LIMIT_SCREEN = [
  "■ You've hit your usage limit. Try again at 3:00 PM.",
  "",
  "› Ask Codex to do anything",
  "  gpt low · ~/dev/app · main · Full Access",
];
const APPROVAL_SCREEN = [
  "E X E C",
  "Environment: local",
  "Reason: Run the focused test suite",
  "$ npx vitest run",
  "› 1. Yes",
  "  2. No",
  "Press Enter to confirm",
];

describe("readCodexScreen", () => {
  it("reads Ready on the status bar above the hint row as idle", () => {
    expect(readCodexScreen(READY_SCREEN)).toBe("idle");
  });

  it("reads the turn timer as busy", () => {
    expect(readCodexScreen(WORKING_SCREEN)).toBe("busy");
  });

  it("reads a picker menu as waiting", () => {
    expect(readCodexScreen(["  Choose a model", "› 1. Fast", "  2. Thorough"])).toBe("waiting");
  });

  it("reads a usage-limit stop as waiting", () => {
    expect(readCodexScreen(USAGE_LIMIT_SCREEN)).toBe("waiting");
  });

  it("reads a command approval card as waiting", () => {
    expect(readCodexScreen(APPROVAL_SCREEN)).toBe("waiting");
  });

  it("does not read Ready from transcript text above the footer", () => {
    expect(
      readCodexScreen([
        "The server is Ready now.",
        "",
        "› ",
        "  gpt low · main",
        "  ? for shortcuts",
      ]),
    ).toBeNull();
  });

  it("does not read a numbered list in the transcript as a picker when Ready", () => {
    expect(readCodexScreen(["› 1. First", "  2. Second", "", ...READY_SCREEN])).toBe("idle");
  });
});

describe("combineCodexTurn", () => {
  const at = new Date(T0);
  const seen = new Date(T1);
  const rollout = (state: CodexTurnState["state"]): CodexTurnState => ({
    state,
    updatedAt: at,
    observedAt: seen,
  });

  it("keeps the rollout reading when there is no screen", () => {
    expect(combineCodexTurn(rollout("busy"), null)).toEqual(rollout("busy"));
  });

  it("lets an approval card override a rollout busy, dated by the observation", () => {
    expect(combineCodexTurn(rollout("busy"), APPROVAL_SCREEN)).toEqual({
      state: "waiting",
      updatedAt: seen,
      observedAt: seen,
      source: "codex-screen",
    });
  });

  it("lets the turn timer override a rollout idle", () => {
    expect(combineCodexTurn(rollout("idle"), WORKING_SCREEN).state).toBe("busy");
  });

  it("fills an unknown rollout from a Ready footer", () => {
    expect(combineCodexTurn(rollout("unknown"), READY_SCREEN)).toMatchObject({
      state: "idle",
      source: "codex-screen",
    });
  });

  it("never ends a rollout busy on a Ready footer alone", () => {
    expect(combineCodexTurn(rollout("busy"), READY_SCREEN)).toEqual(rollout("busy"));
  });

  it("keeps the rollout's busy, dated by its start, when the timer agrees", () => {
    expect(combineCodexTurn(rollout("busy"), WORKING_SCREEN)).toEqual(rollout("busy"));
  });

  it("keeps the rollout's date when both agree", () => {
    expect(combineCodexTurn(rollout("idle"), READY_SCREEN)).toEqual(rollout("idle"));
  });
});

describe("codexPaneScreen", () => {
  const fake =
    (out: Record<string, string>) =>
    async (bin: string, args: string[]): Promise<string> => {
      const key = bin === "ps" ? "ps" : args[0];
      if (!(key in out)) throw new Error(`unexpected ${bin} ${args[0]}`);
      return out[key];
    };

  it("captures the one pane on the pid's terminal, read-only", async () => {
    const calls: string[] = [];
    const run = async (bin: string, args: string[]) => {
      calls.push(`${bin} ${args[0]}`);
      return fake({
        ps: "ttys073\n",
        "list-panes": "/dev/ttys001 %1\n/dev/ttys073 %7\n",
        "capture-pane": "a\nb",
      })(bin, args);
    };
    expect(await codexPaneScreen(1, { run, platform: "darwin" })).toEqual(["a", "b"]);
    expect(calls).toEqual(["ps -o", "tmux list-panes", "tmux capture-pane"]);
  });

  it("is null outside tmux, with no tmux server, on no terminal, and on Windows", async () => {
    const noMatch = fake({ ps: "ttys073", "list-panes": "/dev/ttys001 %1" });
    expect(await codexPaneScreen(1, { run: noMatch, platform: "darwin" })).toBeNull();
    const noServer = fake({ ps: "ttys073" });
    expect(await codexPaneScreen(1, { run: noServer, platform: "darwin" })).toBeNull();
    const noTty = fake({ ps: "??" });
    expect(await codexPaneScreen(1, { run: noTty, platform: "darwin" })).toBeNull();
    expect(await codexPaneScreen(1, { run: fake({}), platform: "win32" })).toBeNull();
    const twoPanes = fake({
      ps: "ttys073",
      "list-panes": "/dev/ttys073 %1\n/dev/ttys073 %2",
      "capture-pane": "a",
    });
    expect(await codexPaneScreen(1, { run: twoPanes, platform: "darwin" })).toBeNull();
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

  it("labels a reading the screen decided as codex-screen", () => {
    const store = new SessionStore();
    store.setDiscovered([
      {
        ...codexProc,
        turnState: { state: "waiting", updatedAt: observedAt, observedAt, source: "codex-screen" },
      },
    ]);
    expect(store.get(ROLLOUT_ID, new Set())?.externalTurn).toMatchObject({
      state: "waiting",
      source: "codex-screen",
      confidence: "inferred",
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
