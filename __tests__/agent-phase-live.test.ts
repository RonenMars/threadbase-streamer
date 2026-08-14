// Agent phase through a live (fake) PTY — the wiring that parseAgentPhase's own
// unit tests and the host-relay contract tests cannot reach: a real runner
// scraping a real rendered screen, firing onPhaseChange, and the server turning
// that into a stored field plus a scoped WS frame.
//
// This is the test class #541 listed as missing, and it is the one that matters:
// every failure mode here is silent. A runner that never calls parseAgentPhase
// typechecks, passes every other suite, and reports `subStatus: null` forever.

import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import type { Logger } from "../src/logger";
import { CODEX_CLI_PROVIDER } from "../src/providers";
import { PTYManager } from "../src/pty-manager";
import type { InternalSession } from "../src/pty-shared";
import type { AgentPhase } from "../src/types";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 31337,
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

// Captured Codex status bars. The bar is the last non-blank rendered line, so
// each chunk clears the screen first to model a real repaint.
const READY_BAR = "\x1b[2J\x1b[Hgpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…\r\n";
const WORKING_BAR = "\x1b[2J\x1b[Hgpt-5.5 medium · /path · gpt-5.5 · medium · Working\r\n";

type MockProc = { _emit: (event: string, data: string) => void };

// The scrape is async (it awaits a screen read, which awaits the xterm write
// queue). Give the microtask and the write callback a tick.
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// The runner's own record, for assertions that need the live object rather
// than the toPublicSession() copy getSession() hands back (e.g. mutating it to
// set up a transition).
function internalOf(runner: unknown, sessionId: string): InternalSession {
  const session = (runner as { sessions: Map<string, InternalSession> }).sessions.get(sessionId);
  if (!session) throw new Error(`no live session ${sessionId}`);
  return session;
}

function procOf(runner: unknown, sessionId: string): MockProc {
  return internalOf(runner, sessionId).process as unknown as MockProc;
}

function captureLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const record = (_msg: string, fields?: Record<string, unknown>) => {
    if (typeof fields?.event === "string") events.push(fields.event);
  };
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    log: (_l: unknown, msg: string, fields?: Record<string, unknown>) => record(msg, fields),
    pino: {} as Logger["pino"],
  } as Logger;
  return { logger, events };
}

describe("agent phase — Codex turn through a fake PTY", () => {
  it("reports working for the turn and clears it at Ready", async () => {
    const phases: (AgentPhase | null)[] = [];
    const runner = new CodexPtyRunner({ onPhaseChange: (_id, phase) => phases.push(phase) });
    try {
      const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const proc = procOf(runner, session.id);

      // Boot settles on Ready. Booting is not a turn: no phase is reported.
      proc._emit("data", READY_BAR);
      await settle();
      expect(runner.getSession(session.id)?.status).toBe("waiting_input");
      expect(phases).toEqual([]);

      runner.sendInput(session.id, "hello");
      expect(runner.getSession(session.id)?.status).toBe("running");
      await settle(80);

      proc._emit("data", WORKING_BAR);
      await settle();
      expect(phases).toEqual(["working"]);
      expect(internalOf(runner, session.id).subStatus).toBe("working");

      // Turn end. The phase clears exactly once, and the session is idle again.
      proc._emit("data", READY_BAR);
      await settle();
      expect(phases).toEqual(["working", null]);
      expect(runner.getSession(session.id)?.status).toBe("waiting_input");
      expect(internalOf(runner, session.id).subStatus).toBeNull();
    } finally {
      runner.dispose();
    }
  }, 15000);

  it("notifies once per change, not once per repaint", async () => {
    const phases: (AgentPhase | null)[] = [];
    const runner = new CodexPtyRunner({ onPhaseChange: (_id, phase) => phases.push(phase) });
    try {
      const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const proc = procOf(runner, session.id);
      proc._emit("data", READY_BAR);
      await settle();
      runner.sendInput(session.id, "hello");
      await settle(80);

      // A TUI repaints its status bar continuously. Without the change guard in
      // setPhase this fires a WS frame per chunk for the whole turn.
      for (let i = 0; i < 4; i++) {
        proc._emit("data", WORKING_BAR);
        await settle();
      }

      expect(phases).toEqual(["working"]);
    } finally {
      runner.dispose();
    }
  }, 15000);
});

describe("agent phase — setPhase / markReady", () => {
  // Both runners carry their own copy of this pair (they are deliberately
  // separate classes), so both are asserted rather than one standing in.
  const runners: Array<[string, () => PTYManager | CodexPtyRunner]> = [
    ["PTYManager", () => new PTYManager({})],
    ["CodexPtyRunner", () => new CodexPtyRunner({})],
  ];

  for (const [name, make] of runners) {
    it(`${name}: setPhase notifies on a change and swallows a repeat`, async () => {
      const phases: (AgentPhase | null)[] = [];
      const runner = make();
      (
        runner as unknown as { onPhaseChange: (id: string, p: AgentPhase | null) => void }
      ).onPhaseChange = (_id, phase) => phases.push(phase);
      try {
        const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
        const internal = internalOf(runner, session.id);
        const setPhase = (
          runner as unknown as {
            setPhase(id: string, s: InternalSession, p: AgentPhase | null): void;
          }
        ).setPhase.bind(runner);

        setPhase(session.id, internal, "working");
        setPhase(session.id, internal, "working");
        expect(phases).toEqual(["working"]);
        expect(internal.subStatus).toBe("working");

        // undefined and null are the same "no phase" on the wire — going from a
        // phase to null is a change, going from unset to null is not.
        setPhase(session.id, internal, null);
        expect(phases).toEqual(["working", null]);
        setPhase(session.id, internal, null);
        expect(phases).toEqual(["working", null]);
      } finally {
        runner.dispose();
      }
    }, 15000);

    it(`${name}: markReady clears the phase`, async () => {
      const phases: (AgentPhase | null)[] = [];
      const runner = make();
      (
        runner as unknown as { onPhaseChange: (id: string, p: AgentPhase | null) => void }
      ).onPhaseChange = (_id, phase) => phases.push(phase);
      try {
        const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
        const internal = internalOf(runner, session.id);
        internal.status = "running";
        internal.subStatus = "working";

        (
          runner as unknown as {
            markReady(id: string, s: InternalSession, src: string, reason: string): void;
          }
        ).markReady(session.id, internal, "quiet-fallback", "test");

        expect(internal.status).toBe("waiting_input");
        expect(internal.subStatus).toBeNull();
        expect(phases).toEqual([null]);
      } finally {
        runner.dispose();
      }
    }, 15000);

    // toPublicSession is what crosses the pty-host boundary, so this is the
    // only channel by which a streamer re-adopting a surviving host's sessions
    // mid-turn can learn the phase: no snapshot or replay event carries it, and
    // setPhase's change guard means the host will never re-emit it for the rest
    // of that turn. Dropping it here leaves the indicator dead until turn end.
    it(`${name}: toPublicSession carries the phase across the host boundary`, async () => {
      const runner = make();
      try {
        const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
        const internal = internalOf(runner, session.id);
        internal.subStatus = "working";

        expect(runner.getSession(session.id)?.subStatus).toBe("working");

        internal.subStatus = null;
        const cleared = runner.getSession(session.id);
        expect(cleared).not.toBeNull();
        expect("subStatus" in (cleared as object)).toBe(true);
        expect(cleared?.subStatus).toBeNull();
      } finally {
        runner.dispose();
      }
    }, 15000);
  }
});

describe("agent phase — the scrape pass stays non-fatal", () => {
  // The phase scrape rides the screen read that the gate/question detectors
  // already share, and both call sites swallow a rejection into a warn. If that
  // ever became fatal, an unhandled rejection would take out prompt detection
  // for the session — so the swallow is asserted, not assumed.
  it("logs a warn and keeps detecting on the chunk path", async () => {
    const { logger, events } = captureLogger();
    const mgr = new PTYManager({ logger });
    try {
      const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const proc = procOf(mgr, session.id);
      (mgr as unknown as { getOutputLines: () => Promise<string[]> }).getOutputLines = () =>
        Promise.reject(new Error("screen read exploded"));

      proc._emit("data", "Continue? [y/N] ");
      await settle();
      expect(events).toContain("pty.prompt_detect_failed");

      // Still live: the prompt marker on a later chunk settles the session.
      proc._emit("data", "╭\n");
      await settle();
      expect(mgr.getSession(session.id)?.status).toBe("waiting_input");
    } finally {
      mgr.dispose();
    }
  }, 15000);

  it("logs a warn on the quiet path too", async () => {
    const { logger, events } = captureLogger();
    const mgr = new PTYManager({ logger });
    try {
      const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const proc = procOf(mgr, session.id);
      (mgr as unknown as { getOutputLines: () => Promise<string[]> }).getOutputLines = () =>
        Promise.reject(new Error("screen read exploded"));

      // The chunk that arms the quiet checker also scrapes, so its own warn is
      // dropped first — otherwise this test would pass on the chunk path and
      // assert nothing about the second call site.
      proc._emit("data", "working on it");
      await settle();
      events.length = 0;

      // The quiet checker re-runs the same detection with no chunk behind it —
      // a second, separate call site with its own catch (QUIET_DETECT_MS 500ms).
      await settle(700);
      expect(events).toContain("pty.prompt_detect_failed");
      expect(mgr.getSession(session.id)).not.toBeNull();
    } finally {
      mgr.dispose();
    }
  }, 15000);
});

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const API_KEY = "tb_test_agent_phase";

describe("agent phase — server wiring", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "tb-phase-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-phase-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-phase-cache-"));
  });

  afterEach(() => {
    for (const d of [configDir, projectDir, cacheDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("stores the phase, broadcasts a scoped frame, and clears it when the PTY dies", async () => {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      browseRoot: projectDir,
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);

    const internals = server as unknown as {
      ptyManager: {
        runners: Map<string, CodexPtyRunner>;
        startFresh(opts: Record<string, unknown>): Promise<{ id: string }>;
        sendInput(id: string, input: string): number;
      };
      sessionStore: { addManaged(s: Record<string, unknown>): void };
      wsHub: { broadcastToClients(clients: unknown, msg: Record<string, unknown>): void };
    };
    const frames: Record<string, unknown>[] = [];
    const realBroadcast = internals.wsHub.broadcastToClients.bind(internals.wsHub);
    internals.wsHub.broadcastToClients = (clients, msg) => {
      frames.push(msg);
      realBroadcast(clients, msg);
    };

    try {
      // Spawned through the server's own manager (node-pty is mocked above) so
      // the whole path is exercised: runner scrape → onPhaseChange → store +
      // WS frame. Going via POST /start would add browse-root resolution, which
      // is async at startup and irrelevant here.
      const session = await internals.ptyManager.startFresh({
        projectPath: projectDir,
        projectName: "test",
        provider: CODEX_CLI_PROVIDER,
      });
      internals.sessionStore.addManaged(session);
      const runner = internals.ptyManager.runners.get(CODEX_CLI_PROVIDER);
      if (!runner) throw new Error("no codex runner registered");
      const proc = procOf(runner, session.id);

      proc._emit("data", READY_BAR);
      await settle();
      internals.ptyManager.sendInput(session.id, "hello");
      await settle(80);
      proc._emit("data", WORKING_BAR);
      await settle();

      const res = await fetch(`http://localhost:${port}/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.subStatus).toBe("working");

      const phaseFrame = frames.find((f) => f.type === "session_phase");
      expect(phaseFrame).toMatchObject({
        type: "session_phase",
        sessionId: session.id,
        phase: "working",
      });
      expect(typeof phaseFrame?.updatedAt).toBe("string");

      // The turn never reaches Ready — the process dies mid-flight, which is
      // what a crash, a `prod restart` or an exiting `codex` looks like. Only
      // markReady clears the phase in the runner, and handleExit reaches the
      // store as a status update carrying no phase, so nothing here re-reads
      // the screen: the session must not keep reporting a live phase.
      proc._emit("exit", { exitCode: 1 } as unknown as string);
      await settle();

      const after = await fetch(`http://localhost:${port}/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(after.status).toBe(200);
      const dead = (await after.json()) as Record<string, unknown>;
      expect(dead.status).toBe("idle");
      expect("subStatus" in dead).toBe(true);
      expect(dead.subStatus).toBeNull();
    } finally {
      await server.close();
    }
  }, 30000);
});
