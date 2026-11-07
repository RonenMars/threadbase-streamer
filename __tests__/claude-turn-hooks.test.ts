// Claude turn boundaries from hooks (#535, flag `claudeTurnHooks`).
//
// Fixtures are hook payloads captured from the interactive Claude Code 2.1.319
// CLI in a PTY, paths sanitized (`__tests__/fixtures/claude-hooks/2.1.319/`):
//   completed   — UserPromptSubmit, Stop
//   failed      — UserPromptSubmit, StopFailure (`--model` that does not exist)
//   interrupted — UserPromptSubmit only: Esc mid-turn fires no Stop
// Each payload is delivered by running the exact hook command the manager put
// in `--settings`, with the payload on stdin, as Claude does.
import { execFileSync, spawnSync } from "child_process";
import { EventEmitter } from "events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import * as nodePty from "node-pty";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { buildSettingsJson } from "../src/claude-flags";
import { tailHookFile } from "../src/claude-turn-hooks";
import { FEATURE_FLAGS } from "../src/feature-flags";
import { LiveSessionManager } from "../src/live-session-manager";
import { PTYManager } from "../src/pty-manager";
import { StreamerServer } from "../src/server";
import type { ManagedSession, SessionEvent } from "../src/types";

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

const FIXTURES = join(__dirname, "fixtures", "claude-hooks", "2.1.319");
const payloads = (name: string): string[] =>
  readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
const [UPS, STOP] = payloads("completed");
const [FAIL_UPS, STOP_FAILURE] = payloads("failed");
const [INTERRUPTED_UPS] = payloads("interrupted");
const promptId = (line: string): string => JSON.parse(line).prompt_id;

const CAP: { submitAt: number; chunks: [number, string][] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "turn-signals", "claude-2.1.280-turn.json"), "utf8"),
);
const SUBMIT_IDX = CAP.chunks.findIndex(([ms]) => ms >= CAP.submitAt);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The `--settings` blob of the most recent spawn. */
function lastSettings(): any {
  const args = vi.mocked(nodePty.spawn).mock.calls.at(-1)?.[1] as string[];
  return JSON.parse(args[args.indexOf("--settings") + 1]);
}

/** Run a hook command the way Claude does: payload on stdin, under sh. */
function runHook(command: string, input: string): string {
  return execFileSync("sh", ["-c", command], { input: `${input}\n` }).toString();
}

/** A hook-enabled Claude session, booted from a real capture to its first prompt. */
async function bootWaiting() {
  const changes: ManagedSession[] = [];
  const events: SessionEvent[] = [];
  const mgr = new PTYManager(
    {
      onStatusChange: (s) => changes.push({ ...s }),
      onSessionEvent: (_id, e) => events.push(e),
    },
    { claudeTurnHooks: true },
  );
  const session = await mgr.startFresh({ projectPath: "/tmp", projectName: "proj" });
  const command: string = lastSettings().hooks.UserPromptSubmit[0].hooks[0].command;
  const proc = (mgr as any).sessions.get(session.id).process;
  for (const [, d] of CAP.chunks.slice(0, SUBMIT_IDX)) proc._emit("data", d);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), { timeout: 2_000 });
  // Past QUIET_DETECT_MS: the boot's last quiet check has run, so the screen
  // backstop does not race the hook reports below (no chunks follow).
  await sleep(700);
  changes.length = 0;
  const hook = (...lines: string[]) => runHook(command, lines.join("\n"));
  const statuses = () => changes.map((c) => [c.status, c.statusSource]);
  return { mgr, id: session.id, changes, events, command, hook, statuses };
}

describe("claudeTurnHooks flag", () => {
  it("is registered, off by default, with a stable env name", () => {
    expect(FEATURE_FLAGS.claudeTurnHooks.default).toBe(false);
    expect(FEATURE_FLAGS.claudeTurnHooks.env).toBe("THREADBASE_FEATURE_CLAUDE_TURN_HOOKS");
  });

  it("spawns Claude with the unchanged settings blob while off", async () => {
    for (const mgr of [new PTYManager({}), new PTYManager({}, { claudeTurnHooks: false })]) {
      await mgr.startFresh({ projectPath: "/tmp", projectName: "proj" });
      expect(lastSettings()).toEqual(JSON.parse(buildSettingsJson("acceptEdits")));
      await mgr.start("6f1c3c5e-0000-4000-8000-000000000001", { projectPath: "/tmp" });
      expect(lastSettings()).toEqual(JSON.parse(buildSettingsJson("acceptEdits")));
      mgr.dispose();
    }
  });

  it("adds the three turn hooks to both spawn paths while on", async () => {
    const mgr = new PTYManager({}, { claudeTurnHooks: true });
    await mgr.start("6f1c3c5e-0000-4000-8000-000000000002", { projectPath: "/tmp" });
    expect(Object.keys(lastSettings().hooks).sort()).toEqual([
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    expect(lastSettings().spinnerTipsEnabled).toBe(false);
    mgr.dispose();
  });

  it("is handed from the server to the Claude runner", () => {
    const claudeRunner = (flags: { claudeTurnHooks: boolean }) => {
      const cacheDir = mkdtempSync(join(tmpdir(), "tb-flag-"));
      try {
        const server = new StreamerServer({
          codexRoots: [],
          scannerPersistent: false,
          port: 0,
          apiKey: "tb_test_key_for_claude_turn_hooks_flag",
          localNoAuth: false,
          verbose: false,
          disableDb: true,
          cacheDir,
          featureFlags: flags,
        });
        return (server as any).ptyManager.runners.get("claude-code");
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    };
    expect(claudeRunner({ claudeTurnHooks: true }).turnHooks).toBe(true);
    expect(claudeRunner({ claudeTurnHooks: false }).turnHooks).toBe(false);
    const viaManager = (new LiveSessionManager({}, { claudeTurnHooks: true }) as any).runners;
    expect(viaManager.get("claude-code").turnHooks).toBe(true);
  });
});

describe("tailHookFile", () => {
  it("holds a line read half-written until the rest of it lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-hook-tail-"));
    const file = join(dir, "s.jsonl");
    const got: unknown[] = [];
    const stop = tailHookFile(file, (batch) => got.push(...batch));
    try {
      appendFileSync(file, UPS.slice(0, 40));
      await sleep(400);
      expect(got).toEqual([]);
      appendFileSync(file, `${UPS.slice(40)}\n`);
      await vi.waitFor(() => expect(got).toEqual([JSON.parse(UPS)]));
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSettingsJson with a hooks file", () => {
  it("leaves the blob untouched without one", () => {
    expect(JSON.parse(buildSettingsJson("acceptEdits", undefined))).toEqual({
      spinnerTipsEnabled: false,
    });
  });

  it("appends each payload as one line, prints nothing, and never fails the turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-hook-cmd-'q"));
    try {
      const file = join(dir, "s.jsonl");
      const settings = JSON.parse(buildSettingsJson("acceptEdits", file));
      for (const event of ["UserPromptSubmit", "Stop", "StopFailure"]) {
        const command = settings.hooks[event][0].hooks[0].command;
        expect(settings.hooks[event][0].hooks[0].type).toBe("command");
        // Stdout of a UserPromptSubmit hook is added to Claude's context.
        expect(runHook(command, UPS)).toBe("");
      }
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      expect(lines).toEqual([UPS, UPS, UPS]);
      rmSync(dir, { recursive: true, force: true });
      const command = settings.hooks.Stop[0].hooks[0].command;
      // Directory gone (streamer died): exit 0 and silent, so Claude neither
      // blocks the prompt nor shows a hook error every turn.
      const gone = spawnSync("sh", ["-c", command], { input: `${STOP}\n`, encoding: "utf8" });
      expect([gone.status, gone.stdout, gone.stderr]).toEqual([0, "", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude turn boundaries from hooks", () => {
  it("does not re-announce a turn already observed as running", async () => {
    const { mgr, events, hook, statuses } = await bootWaiting();
    hook(UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    hook(UPS);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await sleep(300);
    expect(statuses()).toEqual([["running", "turn-signal"]]);
    mgr.dispose();
  });

  it("ending a turn clears the PTY path's open-turn state, as the transcript settle does", async () => {
    const { mgr, id, hook, statuses } = await bootWaiting();
    hook(UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    (mgr as any).turnOpen.set(id, "busy");
    (mgr as any).awaitingStart.set(id, Date.now());
    hook(STOP);
    await vi.waitFor(() => expect(statuses().at(-1)).toEqual(["waiting_input", "turn-signal"]));
    expect((mgr as any).turnOpen.has(id)).toBe(false);
    expect((mgr as any).awaitingStart.has(id)).toBe(false);
    mgr.dispose();
  });

  it("a completed turn: UserPromptSubmit opens it, Stop ends it, both observed", async () => {
    const { mgr, events, hook, statuses } = await bootWaiting();
    hook(UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    expect(events).toEqual([{ type: "turn_started", turnId: promptId(UPS) }]);

    hook(STOP);
    await vi.waitFor(() =>
      expect(statuses()).toEqual([
        ["running", "turn-signal"],
        ["waiting_input", "turn-signal"],
      ]),
    );
    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      turnId: promptId(STOP),
      status: "completed",
    });
    mgr.dispose();
  });

  it("confirms a running-by-construction input as observed", async () => {
    const { mgr, id, hook, statuses } = await bootWaiting();
    mgr.sendKeys(id, "\r");
    expect(statuses()).toEqual([["running", "user-input"]]);
    hook(UPS);
    await vi.waitFor(() =>
      expect(statuses()).toEqual([
        ["running", "user-input"],
        ["running", "turn-signal"],
      ]),
    );
    hook(STOP);
    await vi.waitFor(() => expect(statuses().at(-1)).toEqual(["waiting_input", "turn-signal"]));
    mgr.dispose();
  });

  it("a failed turn ends on StopFailure and carries the error", async () => {
    const { mgr, events, hook, statuses } = await bootWaiting();
    hook(FAIL_UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    hook(STOP_FAILURE);
    await vi.waitFor(() => expect(statuses().at(-1)).toEqual(["waiting_input", "turn-signal"]));
    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      turnId: promptId(STOP_FAILURE),
      status: "failed",
      error: "model_not_found",
    });
    mgr.dispose();
  });

  it("an interrupted turn sends no Stop, and no end is invented for it", async () => {
    const { mgr, events, hook, statuses } = await bootWaiting();
    hook(INTERRUPTED_UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    await sleep(800);
    expect(statuses()).toEqual([["running", "turn-signal"]]);
    expect(events).toEqual([{ type: "turn_started", turnId: promptId(INTERRUPTED_UPS) }]);
    mgr.dispose();
  });

  it("a Stop for another prompt does not end the open turn", async () => {
    const { mgr, events, hook, statuses } = await bootWaiting();
    hook(INTERRUPTED_UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    hook(STOP);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await sleep(300);
    expect(statuses()).toEqual([["running", "turn-signal"]]);
    mgr.dispose();
  });

  it("a Stop read after the next input was written does not end that input's turn", async () => {
    const { mgr, id, events, hook, statuses } = await bootWaiting();
    hook(UPS);
    await vi.waitFor(() => expect(statuses()).toEqual([["running", "turn-signal"]]));
    // The turn was already settled by another signal, and the user typed again
    // before the Stop line was read.
    const internal = mgr as any;
    internal.markReady(id, internal.sessions.get(id), "turn-signal", "test");
    expect(statuses().at(-1)?.[0]).toBe("waiting_input");
    mgr.sendKeys(id, "\r");
    expect(statuses().at(-1)).toEqual(["running", "user-input"]);
    hook(STOP);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await sleep(300);
    expect(statuses().at(-1)).toEqual(["running", "user-input"]);
    mgr.dispose();
  });

  it("a whole turn read in one batch does not reopen a session that already settled", async () => {
    const { mgr, events, hook, statuses } = await bootWaiting();
    hook(UPS, STOP);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    await sleep(300);
    expect(events.map((e) => e.type)).toEqual(["turn_started", "turn_completed"]);
    expect(statuses()).toEqual([]);
    mgr.dispose();
  });

  it("removes a session's hook file when it ends, and the directory on dispose", async () => {
    const { mgr, id, command, hook } = await bootWaiting();
    hook(UPS);
    const file = /'([^']+\.jsonl)'/.exec(command)?.[1] as string;
    expect(file).toContain(id);
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    mgr.putOnHold(id);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dirname(file))).toBe(true);
    mgr.dispose();
    expect(existsSync(dirname(file))).toBe(false);
  });
});
