/**
 * POST /api/sessions/:id/handoff — stop the streamer's copy of a live session
 * and resume it in tmux. tmux and the config file are mocked; the agent's pid
 * is a real child process so the SIGINT → SIGKILL wait is the real one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
  readGitBranch: vi.fn().mockResolvedValue(""),
}));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../src/handoff/config", async (orig) => ({
  ...(await orig<typeof import("../src/handoff/config")>()),
  readHandoffConfig: vi.fn(),
}));
vi.mock("../src/handoff/tmux", async (orig) => ({
  ...(await orig<typeof import("../src/handoff/tmux")>()),
  openTmuxWindow: vi.fn(),
}));
vi.mock("../src/platform", async (orig) => ({
  ...(await orig<typeof import("../src/platform")>()),
  locateProviderExe: vi.fn(),
}));

import { HANDOFF_TIMING } from "../src/api/handlers/sessions.handlers";
import { readHandoffConfig } from "../src/handoff/config";
import { openTmuxWindow } from "../src/handoff/tmux";
import { LiveSessionManager } from "../src/live-session-manager";
import { locateProviderExe } from "../src/platform";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_handoff_route";
const SID = "7e1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const TMUX = "/opt/fake/tmux";

// Handoff is macOS-only (the config reader refuses other platforms). On Windows
// a SIGINT always terminates, so the SIGKILL path can't be reached, and open
// files make the tmp-dir cleanup fail with EPERM.
describe.skipIf(process.platform === "win32")("POST /api/sessions/:id/handoff", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;
  let child: ChildProcess | null = null;
  let held = false;
  const saved = { ...HANDOFF_TIMING };

  beforeEach(async () => {
    Object.assign(HANDOFF_TIMING, { graceMs: 300, killMs: 500, settleMs: 0 });
    held = false;
    vi.mocked(readHandoffConfig).mockReturnValue({ enabled: true, tmuxPath: TMUX });
    vi.mocked(openTmuxWindow).mockReset().mockResolvedValue("%1");
    vi.mocked(locateProviderExe).mockReturnValue("/usr/local/bin/claude");
    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-handoff-"));
    const configDir = join(tmpBase, "profile");
    mkdirSync(join(configDir, "projects"), { recursive: true });
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
    Object.assign(HANDOFF_TIMING, saved);
    vi.restoreAllMocks();
    child?.kill("SIGKILL");
    child = null;
    await server.close();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  /** A live session backed by a real process; `ignoreSigint` forces the SIGKILL path. */
  async function liveSession(
    over: Record<string, unknown> = {},
    { ignoreSigint = false, pid }: { ignoreSigint?: boolean; pid?: number | null } = {},
  ) {
    child = spawn(
      process.execPath,
      [
        "-e",
        `${ignoreSigint ? "process.on('SIGINT',()=>{});" : ""}console.log("ready");setInterval(()=>{},1000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    // Wait for the handler to be installed, or a SIGINT can beat it.
    await new Promise((resolve) => child?.stdout?.once("data", resolve));
    const session = {
      id: SID,
      provider: "claude-code",
      status: "running",
      projectPath: "/work/my-app",
      projectName: "my-app",
      branch: "",
      promptCount: 1,
      startedAt: new Date(),
      completedAt: null,
      lastOutput: "",
      model: "opus",
      ...over,
    };
    vi.spyOn(LiveSessionManager.prototype, "getSession").mockImplementation(((id: string) =>
      id === SID && !held ? session : null) as never);
    vi.spyOn(LiveSessionManager.prototype, "getPid").mockImplementation(() =>
      pid === undefined ? (child?.pid ?? null) : pid,
    );
    const hold = vi
      .spyOn(LiveSessionManager.prototype, "putOnHold")
      .mockImplementation((_id, signal) => {
        held = true;
        child?.kill(signal);
      });
    return { session, hold };
  }

  const handoff = () =>
    fetch(`${baseUrl}/api/sessions/${SID}/handoff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

  it("stops the session and opens it in tmux with the resume argv and spawn env", async () => {
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const { hold } = await liveSession();
      // A discovery during the stop wait caches a list without the tmux agent.
      vi.mocked(openTmuxWindow).mockImplementation(async () => {
        (server as any).discoveryCache = { entries: [], fetchedAt: Date.now() };
        return "%1";
      });
      const res = await handoff();
      expect(res.status).toBe(200);
      expect((server as any).discoveryCache).toBeNull();
      expect(await res.json()).toEqual({
        status: "handed_off",
        tmuxSession: "threadbase",
        window: "my-app-7e1d2c",
        attachCommand: "tmux attach -t threadbase",
      });
      expect(hold).toHaveBeenCalledTimes(1);
      expect(hold).toHaveBeenCalledWith(SID, "SIGINT");
      const [path, opts] = vi.mocked(openTmuxWindow).mock.calls[0];
      expect(path).toBe(TMUX);
      expect(opts.cwd).toBe("/work/my-app");
      // No registry row: Claude resumes by the session id.
      expect(opts.argv.slice(0, 5)).toEqual([
        "/usr/local/bin/claude",
        "--resume",
        SID,
        "--model",
        "opus",
      ]);
      expect(opts.argv).not.toContain("--settings");
      expect(opts.env.CLAUDECODE).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });

  it("escalates to SIGKILL when the agent ignores SIGINT", async () => {
    await liveSession({}, { ignoreSigint: true });
    const kill = vi.spyOn(process, "kill");
    const res = await handoff();
    expect(res.status).toBe(200);
    expect(kill).toHaveBeenCalledWith(child?.pid, "SIGKILL");
  });

  it("409 HANDOFF_KILL_TIMEOUT when the pid survives SIGKILL; tmux never runs", async () => {
    await liveSession({}, { ignoreSigint: true });
    const pid = child?.pid;
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((p: number, sig?: string | number) =>
      p === pid ? true : realKill(p, sig)) as never);
    const res = await handoff();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "HANDOFF_KILL_TIMEOUT", pid });
    expect(openTmuxWindow).not.toHaveBeenCalled();
  });

  it("500 HANDOFF_LAUNCH_FAILED when tmux fails; the stop still drops the discovery cache", async () => {
    await liveSession();
    (server as any).discoveryCache = { entries: [], fetchedAt: Date.now() };
    vi.mocked(openTmuxWindow).mockRejectedValue(new Error("pane gone"));
    const res = await handoff();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "HANDOFF_LAUNCH_FAILED" });
    expect((server as any).discoveryCache).toBeNull();
  });

  describe("refuses before stopping", () => {
    const cases: [string, () => unknown, number, string | undefined][] = [
      [
        "not configured",
        async () => {
          await liveSession();
          vi.mocked(readHandoffConfig).mockReturnValue(null);
        },
        409,
        "HANDOFF_NOT_CONFIGURED",
      ],
      ["unknown session", () => {}, 404, undefined],
      ["idle session", () => liveSession({ status: "idle" }), 409, "NOT_LIVE"],
      ["no prompt yet", () => liveSession({ promptCount: 0 }), 409, "NOTHING_TO_RESUME"],
      ["unbound codex", () => liveSession({ provider: "codex-cli" }), 409, "NOTHING_TO_RESUME"],
      ["no pid", () => liveSession({}, { pid: null }), 409, "NO_PID"],
      [
        "agent missing",
        async () => {
          await liveSession();
          vi.mocked(locateProviderExe).mockReturnValue(null);
        },
        409,
        "AGENT_NOT_FOUND",
      ],
    ];
    it.each(cases)("%s", async (_name, setup, status, code) => {
      await setup();
      const hold = vi.spyOn(LiveSessionManager.prototype, "putOnHold");
      const res = await handoff();
      expect(res.status).toBe(status);
      if (code) expect((await res.json()).code).toBe(code);
      expect(hold).not.toHaveBeenCalled();
      expect(openTmuxWindow).not.toHaveBeenCalled();
    });
  });

  it("a codex session bound only live resumes by its live bound id", async () => {
    await liveSession({ provider: "codex-cli" });
    vi.mocked(locateProviderExe).mockReturnValue("/usr/local/bin/codex");
    vi.spyOn((server as any).sessionStore, "getManaged").mockReturnValue({
      id: SID,
      provider: "codex-cli",
      boundConversationId: "rollout-42",
      promptCount: 1,
    });
    const res = await handoff();
    expect(res.status).toBe(200);
    expect(vi.mocked(openTmuxWindow).mock.calls[0][1].argv.slice(0, 3)).toEqual([
      "/usr/local/bin/codex",
      "resume",
      "rollout-42",
    ]);
  });

  it("a copilot session with no registry row resumes by its session id", async () => {
    await liveSession({ provider: "copilot" });
    vi.mocked(locateProviderExe).mockReturnValue("/usr/local/bin/copilot");
    const res = await handoff();
    expect(res.status).toBe(200);
    expect(vi.mocked(openTmuxWindow).mock.calls[0][1].argv.slice(0, 4)).toEqual([
      "/usr/local/bin/copilot",
      "-C",
      "/work/my-app",
      `--resume=${SID}`,
    ]);
  });

  describe("cursor", () => {
    const cursorRow = { session_id: SID, provider: "cursor", bound_conversation_id: null };
    const cursorArgv = () => vi.mocked(openTmuxWindow).mock.calls[0][1].argv;
    beforeEach(() => vi.mocked(locateProviderExe).mockReturnValue("/usr/local/bin/agent"));
    afterEach(() => {
      (server as any).managedSessionsRepo = null;
      (server as any).cache = null;
    });

    it.each([
      ["without", null],
      ["with", cursorRow],
    ])("a fresh unbound session %s a registry row is refused before the stop", async (_w, row) => {
      const { hold } = await liveSession({ provider: "cursor" });
      (server as any).managedSessionsRepo = { get: () => row };
      const res = await handoff();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("NOTHING_TO_RESUME");
      expect(hold).not.toHaveBeenCalled();
      expect(openTmuxWindow).not.toHaveBeenCalled();
    });

    it("a live-bound session resumes by its bound chat id", async () => {
      await liveSession({ provider: "cursor" });
      vi.spyOn((server as any).sessionStore, "getManaged").mockReturnValue({
        id: SID,
        provider: "cursor",
        boundConversationId: "chat-9",
        promptCount: 1,
      });
      expect((await handoff()).status).toBe(200);
      expect(cursorArgv()).toContain("--resume=chat-9");
    });

    it("a resumed historical chat the cache knows resumes by its session id", async () => {
      await liveSession({ provider: "cursor" });
      (server as any).cache = {
        hasConversation: (id: string) => id === SID,
        getMetaById: () => null,
      };
      expect((await handoff()).status).toBe(200);
      expect(cursorArgv()).toContain(`--resume=${SID}`);
    });
  });

  it("a concurrent second request does not stop the session twice", async () => {
    const { hold } = await liveSession();
    const [a, b] = await Promise.all([handoff(), handoff()]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(openTmuxWindow).toHaveBeenCalledTimes(1);
  });

  it("/api/info advertises handoff only when the config reader allows it", async () => {
    const info = async () =>
      (
        await fetch(`${baseUrl}/api/info`, { headers: { Authorization: `Bearer ${API_KEY}` } })
      ).json();
    expect((await info()).handoff).toEqual({ openTerminal: false });
    vi.mocked(readHandoffConfig).mockReturnValue(null);
    expect((await info()).handoff).toBeUndefined();
  });
});
