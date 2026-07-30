// PATCH /api/sessions/:id/model and /effort — retarget a LIVE session by typing
// Claude's `/model` / `/effort` slash command into its PTY.
//
// The interesting behavior is entirely in the guards and the exact bytes written:
// there is no CLI or IPC channel for this, so a wrong byte sequence silently
// types garbage into a user's live session instead of failing loudly.

import { mkdtempSync, rmSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";

// Emits Claude's prompt marker AND a line containing Codex's "Ready" text, so
// both runners reach readiness immediately and neither test waits on a fallback
// timer. Each process is pushed to a global so a test can assert what was
// written to it, and drive its exit.
vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  const procs: Record<string, unknown>[] = [];
  (globalThis as unknown as { __mockPtyProcs: unknown[] }).__mockPtyProcs = procs;
  function makeMockProcess() {
    const ee = new EventEmitter();
    setImmediate(() => {
      ee.emit("data", "╭\n");
      ee.emit("data", "gpt-5.5 medium · /tmp · medium · Ready · Wo…\r\n");
    });
    const proc = {
      pid: 4242 + procs.length,
      ee,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
    procs.push(proc);
    return proc;
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

type MockProc = {
  ee: { emit(event: string, arg: unknown): void };
  write: { mock: { calls: unknown[][] } };
};

function mockProcs(): MockProc[] {
  return (globalThis as unknown as { __mockPtyProcs: MockProc[] }).__mockPtyProcs;
}

function lastProc(): MockProc {
  const procs = mockProcs();
  return procs[procs.length - 1];
}

/** Everything written to the newest PTY, concatenated. */
function written(proc: MockProc): string {
  return proc.write.mock.calls.map((c) => String(c[0])).join("");
}

// Bind an ephemeral port and read the real one back off `server.port`. Probing
// for a free port up front and releasing it is a TOCTOU race — test files run in
// parallel, so another server can claim it between close() and our listen(),
// which is a flaky EADDRINUSE. Same idiom as server.test.ts.
const EPHEMERAL_PORT = 0;

const API_KEY = "tb_test_session_settings";

type Internals = {
  ptyManager: {
    startFresh(opts: Record<string, unknown>): Promise<{ id: string }>;
    getSession(id: string): { status: string } | null;
    sendKeys(id: string, keys: string): void;
  };
  sessionStore: { addManaged(s: Record<string, unknown>): void };
};

describe("PATCH /api/sessions/:id/{model,effort}", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;
  let server: { close(): Promise<void>; port: number } | undefined;
  let port: number;
  let internals: Internals;
  let threadbaseDir: string;
  let configDirBefore: string | undefined;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "tb-setting-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-setting-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-setting-cache-"));
    // MUST be isolated: setClaudeFlagsConfig persists to server.yaml in this
    // directory, and the default is the developer's real ~/.threadbase.
    threadbaseDir = mkdtempSync(join(tmpdir(), "tb-setting-home-"));
    configDirBefore = process.env.THREADBASE_CONFIG_DIR;
    process.env.THREADBASE_CONFIG_DIR = threadbaseDir;
    mockProcs().length = 0;

    const { StreamerServer } = await import("../src/server");
    const s = new StreamerServer({
      port: EPHEMERAL_PORT,
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
    await s.listen(EPHEMERAL_PORT);
    port = s.port;
    server = s;
    internals = s as unknown as Internals;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (configDirBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = configDirBefore;
    for (const d of [configDir, projectDir, cacheDir, threadbaseDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /** Spawn a genuinely live session through the server's own manager. */
  async function startSession(provider?: string): Promise<string> {
    const session = await internals.ptyManager.startFresh({
      projectPath: projectDir,
      ...(provider ? { provider } : {}),
    });
    internals.sessionStore.addManaged(session as unknown as Record<string, unknown>);
    return session.id;
  }

  async function waitForStatus(id: string, status: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (internals.ptyManager.getSession(id)?.status === status) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `session ${id} never reached ${status} (last: ${internals.ptyManager.getSession(id)?.status})`,
    );
  }

  function patch(id: string, setting: "model" | "effort", body: unknown) {
    return fetch(`http://localhost:${port}/api/sessions/${id}/${setting}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("404s for an unknown session", async () => {
    const res = await patch("does-not-exist", "model", { model: "opus" });
    expect(res.status).toBe(404);
  });

  it("types /model <value> into the live PTY and answers 202", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    const res = await patch(id, "model", { model: "opus" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id, model: "opus" });
    // Exact bytes matter: a missing \r leaves the command sitting unsubmitted in
    // the composer, which looks like a no-op to the user.
    expect(written(proc)).toBe("/model opus\r");
  }, 30000);

  it("types /effort <value> into the live PTY and answers 202", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    const res = await patch(id, "effort", { effort: "xhigh" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id, effort: "xhigh" });
    expect(written(proc)).toBe("/effort xhigh\r");
  }, 30000);

  it("accepts a full model name, not just an alias", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    expect((await patch(id, "model", { model: "claude-opus-4-5" })).status).toBe(202);
    expect(written(proc)).toBe("/model claude-opus-4-5\r");
  }, 30000);

  it("rejects an off-registry effort level", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    const res = await patch(id, "effort", { effort: "turbo" });
    expect(res.status).toBe(400);
    expect(written(proc)).toBe("");
  }, 30000);

  // The security case. The value is written as raw bytes into a live terminal,
  // so a \r would end the slash command and run the remainder as a second,
  // caller-chosen command. It must be rejected, never escaped or truncated.
  it("rejects a model name carrying a carriage return without writing anything", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    const res = await patch(id, "model", { model: "opus\r/exit" });
    expect(res.status).toBe(400);
    expect(written(proc)).toBe("");
  }, 30000);

  it("rejects a model name with whitespace or a missing value", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");

    expect((await patch(id, "model", { model: "opus --dangerously" })).status).toBe(400);
    expect((await patch(id, "model", {})).status).toBe(400);
    expect((await patch(id, "model", { model: 5 })).status).toBe(400);
    expect(written(lastProc())).toBe("");
  }, 30000);

  // Mid-turn the composer isn't accepting a slash command, so the injection
  // would be swallowed. sendKeys itself only rejects `idle`, hence this guard.
  it("409s SESSION_BUSY while the session is mid-turn", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    // Real state machine: writing input flips waiting_input → running.
    internals.ptyManager.sendKeys(id, "hello\r");
    await waitForStatus(id, "running");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    const res = await patch(id, "model", { model: "opus" });
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: "SESSION_BUSY" });
    expect(written(proc)).toBe("");
  }, 30000);

  // putOnHold() and handleExit() both DELETE the session from the runner's map,
  // so a held session is absent there rather than present-with-status-idle. It's
  // still in the registry, which is what separates this 409 from a 404 — and the
  // grace timer puts mobile's sessions here routinely.
  it("409s SESSION_IDLE once the PTY is gone but the session is still known", async () => {
    const id = await startSession();
    await waitForStatus(id, "waiting_input");
    const proc = lastProc();
    proc.ee.emit("exit", { exitCode: 0 });
    // The runner drops it synchronously on exit; poll until that's visible.
    for (let i = 0; i < 100 && internals.ptyManager.getSession(id); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(internals.ptyManager.getSession(id)).toBeNull();

    const res = await patch(id, "effort", { effort: "high" });
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: "SESSION_IDLE" });
    expect(written(proc)).not.toContain("/effort");
  }, 30000);

  // `/effort` is a Claude Code command; Codex's TUI has no equivalent, so
  // typing it there would put stray text in the user's composer.
  it("501s for a non-Claude provider", async () => {
    const id = await startSession("codex-cli");
    const proc = lastProc();
    proc.write.mock.calls.length = 0;

    const res = await patch(id, "effort", { effort: "high" });
    expect(res.status).toBe(501);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      code: "UNSUPPORTED_PROVIDER",
    });
    expect(written(proc)).toBe("");
  }, 30000);

  // The server-DEFAULT half of this feature: model/effort are claude-flags, so
  // PUT /api/config/claude-flags is the whole control surface — no new endpoint.
  //
  // This is also the regression lock on the permissionMode fix. Before it, all
  // three spawn sites passed the boot-time default and ignored the configured
  // flag, so setting any of these through the API was a silent no-op that no
  // test caught (the round-trip assertions passed because persistence worked).
  describe("configured claude-flags reach the next spawn", () => {
    it("uses the flag values over the boot defaults", async () => {
      const put = await fetch(`http://localhost:${port}/api/config/claude-flags`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { model: "claude-opus-4-5", effort: "max", permissionMode: "plan" },
        }),
      });
      expect(put.status).toBe(200);

      const spawnMock = mockSpawn as unknown as ReturnType<typeof vi.fn>;
      spawnMock.mock.calls.length = 0;
      // MUST go through the endpoint, not ptyManager.startFresh() directly:
      // spawnFlagOverrides() is applied by the handler, so a direct call would
      // fall back to pty-manager's own "sonnet"/"low" defaults and pass while
      // the wiring under test is broken. `path: ""` resolves to the browse root.
      const start = await fetch(`http://localhost:${port}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "" }),
      });
      expect([200, 202]).toContain(start.status);

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-5");
      expect(args[args.indexOf("--effort") + 1]).toBe("max");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
      // Still exactly one of each — the allowlist must not re-emit them.
      for (const flag of ["--model", "--effort", "--permission-mode"]) {
        expect(args.filter((a) => a === flag)).toHaveLength(1);
      }
    }, 30000);
  });
});
