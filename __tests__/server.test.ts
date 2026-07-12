import { ConversationScanner } from "@threadbase-sh/scanner";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import { ConversationCache } from "../src/conversation-cache";
import { PTYManager } from "../src/pty-manager";
import { StreamerServer } from "../src/server";

const FIXTURE_PROFILES = [
  {
    id: "test",
    label: "Test",
    configDir: join(__dirname, "./fixtures/contract-projects"),
    enabled: true,
    emoji: "🧪",
  },
];

// Use a random available port for each test
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

const API_KEY = "tb_test_key_for_integration_tests";

describe("StreamerServer", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let cacheDir: string;

  beforeEach(async () => {
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-server-test-"));
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: FIXTURE_PROFILES,
    });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
  });

  describe("authentication", () => {
    it("rejects requests without auth", async () => {
      const res = await fetch(`${baseUrl}/api/info`);
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong key", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: "Bearer wrong_key" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts requests with correct bearer token", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
    });

    it("accepts auth via query param", async () => {
      const res = await fetch(`${baseUrl}/api/info?key=${API_KEY}`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/info", () => {
    it("returns server info", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("machineName");
      expect(body).toHaveProperty("platform");
    });
  });

  describe("GET /api/sessions", () => {
    it("returns empty session list initially (legacy plain array)", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns the paginated envelope when ?limit is set", async () => {
      const res = await fetch(`${baseUrl}/api/sessions?limit=10`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(false);
      expect(body).toHaveProperty("sessions");
      expect(body).toHaveProperty("nextCursor");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.sessions)).toBe(true);
      // total reflects whatever the OS-level discovery turns up in the test
      // env; we just assert it's a non-negative integer and the envelope
      // shape is correct.
      expect(typeof body.total).toBe("number");
      expect(body.total).toBeGreaterThanOrEqual(0);
    });

    it("uses the envelope when only ?sortBy is set", async () => {
      const res = await fetch(`${baseUrl}/api/sessions?sortBy=projectName`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("sessions");
    });

    it("rejects an unknown sortBy with 400", async () => {
      const res = await fetch(`${baseUrl}/api/sessions?sortBy=bogus`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/sortBy/);
    });

    it("rejects a malformed cursor with 400", async () => {
      const res = await fetch(`${baseUrl}/api/sessions?cursor=garbage!!!`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/cursor/i);
    });

    it("rejects a limit outside 1..500 with 400", async () => {
      const tooBig = await fetch(`${baseUrl}/api/sessions?limit=9999`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(tooBig.status).toBe(400);

      const tooSmall = await fetch(`${baseUrl}/api/sessions?limit=0`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(tooSmall.status).toBe(400);
    });

    it("rejects an unknown status entry with 400", async () => {
      const res = await fetch(`${baseUrl}/api/sessions?status=running,bogus`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns 404 for nonexistent session", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(404);
    });

    it("falls back to conversation cache and returns a resumable shape for known conversation ids", async () => {
      // Older mobile builds tap recents rows via /sessions/:id even though
      // those are conversation UUIDs. The fallback prevents a 404.
      // Warm the cache by hitting /api/conversations (it runs the scanner).
      const conversationsRes = await fetch(`${baseUrl}/api/conversations?refresh=1`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      }).then((r) => r.json());
      expect(conversationsRes.conversations.length).toBeGreaterThan(0);
      const conversationId = conversationsRes.conversations[0].id;

      const res = await fetch(`${baseUrl}/api/sessions/${conversationId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(conversationId);
      expect(body.type).toBe("conversation");
      expect(body.status).toBe("on_hold");
    });
  });

  describe("POST /api/sessions/:id/input", () => {
    it("returns 400 for nonexistent session", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent/input`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sessions/start provider", () => {
    let browseRoot: string;
    let previousBrowseRootEnv: string | undefined;

    beforeEach(async () => {
      await server.close();
      browseRoot = mkdtempSync(join(tmpdir(), "threadbase-browse-test-"));
      mkdirSync(join(browseRoot, "project"));
      previousBrowseRootEnv = process.env.THREADBASE_BROWSE_ROOT;
      process.env.THREADBASE_BROWSE_ROOT = browseRoot;
      server = new StreamerServer({
        port,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir,
        browseRoot,
        scanProfiles: FIXTURE_PROFILES,
      });
      await server.listen(port);
    });

    afterEach(() => {
      if (previousBrowseRootEnv === undefined) {
        delete process.env.THREADBASE_BROWSE_ROOT;
      } else {
        process.env.THREADBASE_BROWSE_ROOT = previousBrowseRootEnv;
      }
      rmSync(browseRoot, { recursive: true, force: true });
    });

    it("defaults missing provider to claude-code", async () => {
      const sessionId = "039fd3ce-ad78-4980-b441-1cfa05edaec7";
      const startFreshSpy = vi
        .spyOn(PTYManager.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (server as any).sessionStatusBus.emit(`status:${sessionId}`, "waiting_input");
          });
          return {
            id: sessionId,
            provider: "claude-code",
            projectPath: join(browseRoot, "project"),
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });

      const res = await fetch(`${baseUrl}/api/sessions/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "project" }),
      });

      expect(res.status).toBe(200);
      expect(startFreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude-code",
          projectPath: realpathSync(join(browseRoot, "project")),
        }),
      );

      startFreshSpy.mockRestore();
    });

    it("rejects invalid providers before starting a PTY", async () => {
      const startFreshSpy = vi.spyOn(PTYManager.prototype, "startFresh");

      const res = await fetch(`${baseUrl}/api/sessions/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "project", provider: "other-cli" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid provider");
      expect(startFreshSpy).not.toHaveBeenCalled();

      startFreshSpy.mockRestore();
    });

    it("starts a codex-cli live session via the Codex runner", async () => {
      const sessionId = "049fd3ce-ad78-4980-b441-1cfa05edaec8";
      const claudeStartFreshSpy = vi.spyOn(PTYManager.prototype, "startFresh");
      const codexStartFreshSpy = vi
        .spyOn(CodexPtyRunner.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (server as any).sessionStatusBus.emit(`status:${sessionId}`, "waiting_input");
          });
          return {
            id: sessionId,
            provider: "codex-cli",
            projectPath: join(browseRoot, "project"),
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });

      const res = await fetch(`${baseUrl}/api/sessions/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.id).toBe(sessionId);
      expect(codexStartFreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "codex-cli",
          projectPath: realpathSync(join(browseRoot, "project")),
        }),
      );
      expect(claudeStartFreshSpy).not.toHaveBeenCalled();

      claudeStartFreshSpy.mockRestore();
      codexStartFreshSpy.mockRestore();
    });
  });

  describe("Codex rollout-file binding", () => {
    let browseRoot: string;
    let codexRoot: string;
    let boundServer: StreamerServer;
    let boundPort: number;
    let boundBaseUrl: string;
    let previousBrowseRootEnv: string | undefined;

    beforeEach(async () => {
      boundPort = await getRandomPort();
      boundBaseUrl = `http://localhost:${boundPort}`;
      browseRoot = mkdtempSync(join(tmpdir(), "threadbase-browse-test-"));
      mkdirSync(join(browseRoot, "project"));
      codexRoot = mkdtempSync(join(tmpdir(), "threadbase-codex-root-"));
      previousBrowseRootEnv = process.env.THREADBASE_BROWSE_ROOT;
      process.env.THREADBASE_BROWSE_ROOT = browseRoot;
      boundServer = new StreamerServer({
        port: boundPort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-server-test-")),
        browseRoot,
        scanProfiles: FIXTURE_PROFILES,
        codexRoots: [codexRoot],
      });
      await boundServer.listen(boundPort);
    });

    afterEach(async () => {
      await boundServer.close();
      if (previousBrowseRootEnv === undefined) {
        delete process.env.THREADBASE_BROWSE_ROOT;
      } else {
        process.env.THREADBASE_BROWSE_ROOT = previousBrowseRootEnv;
      }
      rmSync(browseRoot, { recursive: true, force: true });
      rmSync(codexRoot, { recursive: true, force: true });
    });

    function writeRolloutFixture(codexSessionId: string, cwd: string, createdAt?: Date): void {
      const now = new Date();
      // The rollout lives in today's date-nested dir (that's what the poller
      // scans), but its session_meta timestamp can be back-dated to simulate a
      // stale same-cwd rollout from an earlier run.
      const created = createdAt ?? now;
      const dateDir = join(
        codexRoot,
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      );
      mkdirSync(dateDir, { recursive: true });
      const sessionMeta = {
        timestamp: created.toISOString(),
        type: "session_meta",
        payload: {
          id: codexSessionId,
          session_id: codexSessionId,
          cwd,
          timestamp: created.toISOString(),
        },
      };
      writeFileSync(
        join(dateDir, `rollout-2026-01-01T00-00-00-${codexSessionId}.jsonl`),
        `${JSON.stringify(sessionMeta)}\n`,
      );
    }

    it("binds a matching-cwd rollout file to boundConversationId, leaving id/conversationId unchanged", async () => {
      const liveSessionId = "059fd3ce-ad78-4980-b441-1cfa05edaec9";
      const codexSessionId = "codex-persisted-id-abc123";
      const projectPath = realpathSync(join(browseRoot, "project"));

      const codexStartFreshSpy = vi
        .spyOn(CodexPtyRunner.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (boundServer as any).sessionStatusBus.emit(`status:${liveSessionId}`, "waiting_input");
          });
          return {
            id: liveSessionId,
            provider: "codex-cli",
            projectPath,
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });
      vi.spyOn(CodexPtyRunner.prototype, "hasSession").mockReturnValue(true);

      writeRolloutFixture(codexSessionId, projectPath);

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);

      // watchForCodexRollout's first synchronous tryWire() call already runs
      // inline before handleStartSession returns, so no poll wait is needed
      // for this fixture (file exists before start is called).
      const detailRes = await fetch(`${boundBaseUrl}/api/sessions/${liveSessionId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const detail = await detailRes.json();

      expect(detail.id).toBe(liveSessionId);
      expect(detail.conversationId).toBe(liveSessionId);
      expect(detail.boundConversationId).toBe(codexSessionId);

      codexStartFreshSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it("ignores a rollout file whose cwd does not match the session's projectPath", async () => {
      const liveSessionId = "069fd3ce-ad78-4980-b441-1cfa05edaeca";
      const projectPath = realpathSync(join(browseRoot, "project"));

      const codexStartFreshSpy = vi
        .spyOn(CodexPtyRunner.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (boundServer as any).sessionStatusBus.emit(`status:${liveSessionId}`, "waiting_input");
          });
          return {
            id: liveSessionId,
            provider: "codex-cli",
            projectPath,
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });
      vi.spyOn(CodexPtyRunner.prototype, "hasSession").mockReturnValue(true);

      writeRolloutFixture("unrelated-session-id", "/some/other/unrelated/path");

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);

      const detailRes = await fetch(`${boundBaseUrl}/api/sessions/${liveSessionId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const detail = await detailRes.json();

      expect(detail.boundConversationId).toBeUndefined();

      codexStartFreshSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it("ignores a stale same-cwd rollout created before the session started", async () => {
      const liveSessionId = "079fd3ce-ad78-4980-b441-1cfa05edaecb";
      const projectPath = realpathSync(join(browseRoot, "project"));

      const codexStartFreshSpy = vi
        .spyOn(CodexPtyRunner.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (boundServer as any).sessionStatusBus.emit(`status:${liveSessionId}`, "waiting_input");
          });
          return {
            id: liveSessionId,
            provider: "codex-cli",
            projectPath,
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });
      vi.spyOn(CodexPtyRunner.prototype, "hasSession").mockReturnValue(true);

      // Same cwd, but written a full minute before this session started.
      writeRolloutFixture("stale-codex-id", projectPath, new Date(Date.now() - 60_000));

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);

      const detailRes = await fetch(`${boundBaseUrl}/api/sessions/${liveSessionId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const detail = await detailRes.json();

      expect(detail.boundConversationId).toBeUndefined();

      codexStartFreshSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it("does not bind a codex id already bound to another live session", async () => {
      const liveSessionId = "089fd3ce-ad78-4980-b441-1cfa05edaecc";
      const otherSessionId = "099fd3ce-ad78-4980-b441-1cfa05edaecd";
      const codexSessionId = "shared-codex-id";
      const projectPath = realpathSync(join(browseRoot, "project"));

      // Another live session already owns this codex id.
      (boundServer as any).sessionStore.addManaged({
        id: otherSessionId,
        provider: "codex-cli",
        projectPath,
        projectName: "project",
        branch: "",
        status: "running",
        startedAt: new Date(),
        completedAt: null,
        promptCount: 0,
        lastOutput: "",
        boundConversationId: codexSessionId,
      });

      const codexStartFreshSpy = vi
        .spyOn(CodexPtyRunner.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (boundServer as any).sessionStatusBus.emit(`status:${liveSessionId}`, "waiting_input");
          });
          return {
            id: liveSessionId,
            provider: "codex-cli",
            projectPath,
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });
      vi.spyOn(CodexPtyRunner.prototype, "hasSession").mockReturnValue(true);

      writeRolloutFixture(codexSessionId, projectPath);

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);

      const detailRes = await fetch(`${boundBaseUrl}/api/sessions/${liveSessionId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const detail = await detailRes.json();

      expect(detail.boundConversationId).toBeUndefined();

      codexStartFreshSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it("wires the bound rollout into the live path: replays lines and broadcasts session_update", async () => {
      const liveSessionId = "0a9fd3ce-ad78-4980-b441-1cfa05edaece";
      const codexSessionId = "codex-live-wire-id";
      const projectPath = realpathSync(join(browseRoot, "project"));

      const codexStartFreshSpy = vi
        .spyOn(CodexPtyRunner.prototype, "startFresh")
        .mockImplementationOnce(async () => {
          setImmediate(() => {
            (boundServer as any).sessionStatusBus.emit(`status:${liveSessionId}`, "waiting_input");
          });
          return {
            id: liveSessionId,
            provider: "codex-cli",
            projectPath,
            projectName: "project",
            branch: "",
            status: "running",
            startedAt: new Date(),
            completedAt: null,
            promptCount: 0,
            lastOutput: "",
          };
        });
      vi.spyOn(CodexPtyRunner.prototype, "hasSession").mockReturnValue(true);

      // Connect a WS client before starting so it receives the replay + update.
      const events: any[] = [];
      const ws = new WebSocket(`ws://localhost:${boundPort}/ws?key=${API_KEY}`);
      ws.on("message", (d) => {
        try {
          events.push(JSON.parse(d.toString()));
        } catch {
          /* ignore non-JSON */
        }
      });
      await new Promise<void>((r) => ws.on("open", () => r()));

      writeRolloutFixture(codexSessionId, projectPath);

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);

      // tryWire() runs synchronously during start: it replays the existing
      // session_meta line (conversation_event) and broadcasts session_update
      // carrying the freshly-bound conversation id.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const gotEvent = events.some(
          (e) => e.type === "conversation_event" && e.sessionId === liveSessionId,
        );
        const gotUpdate = events.some(
          (e) => e.type === "session_update" && e.session?.boundConversationId === codexSessionId,
        );
        if (gotEvent && gotUpdate) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(
        events.some((e) => e.type === "conversation_event" && e.sessionId === liveSessionId),
      ).toBe(true);
      expect(
        events.some(
          (e) => e.type === "session_update" && e.session?.boundConversationId === codexSessionId,
        ),
      ).toBe(true);

      ws.close();
      codexStartFreshSpy.mockRestore();
      vi.restoreAllMocks();
    });
  });

  describe("POST /api/sessions/:id/cancel", () => {
    it("returns 400 for nonexistent session", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sessions/:id/stop", () => {
    it("returns 404 for unknown session", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent-stop/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    it("returns already_idle when session status is idle", async () => {
      const getSessionSpy = vi.spyOn(PTYManager.prototype, "getSession").mockReturnValueOnce({
        id: "idle-sess",
        status: "idle",
        projectPath: "/tmp",
        projectName: "test",
        branch: "",
        promptCount: 0,
        startedAt: new Date(),
        completedAt: new Date(),
        lastOutput: "",
      } as any);

      const res = await fetch(`${baseUrl}/api/sessions/idle-sess/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "already_idle", sessionId: "idle-sess" });

      getSessionSpy.mockRestore();
    });

    it("streams stopping→stopped for a running session", async () => {
      const sessionId = "running-sess-stop";

      const getSessionSpy = vi.spyOn(PTYManager.prototype, "getSession").mockReturnValueOnce({
        id: sessionId,
        status: "running",
        projectPath: "/tmp",
        projectName: "test",
        branch: "",
        promptCount: 0,
        startedAt: new Date(),
        completedAt: null,
        lastOutput: "",
      } as any);

      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementationOnce(() => {
        setImmediate(() => {
          (server as any).sessionStatusBus.emit(`status:${sessionId}`, "idle");
        });
      });

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("ndjson");

      const text = await res.text();
      const lines = text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines[0]).toEqual({ event: "stopping", sessionId });
      expect(lines[1]).toEqual({ event: "stopped", sessionId });
      expect(holdSpy).toHaveBeenCalledWith(sessionId);

      holdSpy.mockRestore();
      getSessionSpy.mockRestore();
    });
  });

  describe("grace timer", () => {
    // Drive the private startGraceTimer directly with a short delay and spy on
    // the PTY/session accessors to assert it never holds a running session.
    const SID = "grace-sess";
    const mkSession = (status: string) =>
      ({
        id: SID,
        status,
        projectPath: "/tmp",
        projectName: "test",
        branch: "",
        promptCount: 0,
        startedAt: new Date(),
        completedAt: null,
        lastOutput: "",
      }) as any;

    it("does NOT hold a running session, and re-arms the timer", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn((server as any).sessionStore, "get").mockReturnValue(mkSession("running"));
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});
      const armSpy = vi.spyOn(server as any, "startGraceTimer");

      (server as any).startGraceTimer(SID, 10);
      await new Promise((r) => setTimeout(r, 40));

      expect(holdSpy).not.toHaveBeenCalled();
      // re-armed: startGraceTimer called again (beyond the initial invocation)
      expect(armSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      // stop the re-armed timer so it doesn't fire after restore
      const t = (server as any).ptyGraceTimers.get(SID);
      if (t) clearTimeout(t);
      vi.restoreAllMocks();
    });

    it("holds a waiting_input session when the grace timer fires", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn((server as any).sessionStore, "get").mockReturnValue(mkSession("waiting_input"));
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});

      (server as any).startGraceTimer(SID, 10);
      await new Promise((r) => setTimeout(r, 40));

      expect(holdSpy).toHaveBeenCalledWith(SID);
      vi.restoreAllMocks();
    });
  });

  describe("GET /api/sessions/:id/output", () => {
    it("returns empty output for an untracked session id", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent/output`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ output: "" });
    });
  });

  describe("GET /api/conversations", () => {
    it("returns paginated conversation list", async () => {
      const res = await fetch(`${baseUrl}/api/conversations?limit=10&offset=0`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty("conversations");
      expect(body).toHaveProperty("hasMore");
      expect(body).toHaveProperty("offset");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.conversations)).toBe(true);
    });
  });

  describe("GET /api/search", () => {
    it("returns 400 when query is missing", async () => {
      const res = await fetch(`${baseUrl}/api/search`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(400);
    });

    it("returns results for a query", async () => {
      const res = await fetch(`${baseUrl}/api/search?q=test`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty("conversations");
      expect(Array.isArray(body.conversations)).toBe(true);
    });
  });

  describe("CORS", () => {
    it("returns CORS headers for an allowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Origin: "http://localhost:8081",
        },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    });

    it("returns no CORS headers for a disallowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Origin: "https://evil.example.com",
        },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("handles OPTIONS preflight from an allowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:8081" },
      });
      expect(res.status).toBe(204);
    });

    it("rejects OPTIONS preflight from a disallowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/sessions/recents", () => {
    it("returns 200 with sessions array and total field when authenticated", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/recents`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty("sessions");
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body).toHaveProperty("total");
      expect(typeof body.total).toBe("number");
    });

    it("returns 401 without auth", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/recents`);
      expect(res.status).toBe(401);
    });

    it("respects limit query param", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/recents?limit=1`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.sessions.length).toBeLessThanOrEqual(1);
    });

    it("tags items with type=conversation so mobile can route taps correctly", async () => {
      // Warm the cache via /api/conversations so recents has data to return.
      await fetch(`${baseUrl}/api/conversations?refresh=1`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const res = await fetch(`${baseUrl}/api/sessions/recents`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sessions.length).toBeGreaterThan(0);
      // Items come from ConversationCache, not SessionStore — must be flagged.
      for (const item of body.sessions) {
        expect(item.type).toBe("conversation");
      }
    });
  });

  describe("GET /api/projects/popular", () => {
    it("returns 200 with projects array and total", async () => {
      const res = await fetch(`${baseUrl}/api/projects/popular`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.projects)).toBe(true);
      expect(typeof body.total).toBe("number");
    });

    it("returns 401 without auth", async () => {
      const res = await fetch(`${baseUrl}/api/projects/popular`);
      expect(res.status).toBe(401);
    });

    it("respects limit query param", async () => {
      const res = await fetch(`${baseUrl}/api/projects/popular?limit=5`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.projects.length).toBeLessThanOrEqual(5);
    });

    it("each project has path, name, sessionCount when projects are present", async () => {
      const res = await fetch(`${baseUrl}/api/projects/popular`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = (await res.json()) as any;
      for (const p of body.projects) {
        expect(typeof p.path).toBe("string");
        expect(typeof p.name).toBe("string");
        expect(typeof p.sessionCount).toBe("number");
      }
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`${baseUrl}/api/nonexistent`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/conversations/:id cache tail fallback", () => {
    it("serves the cached tail with ?msg_limit=80 when the JSONL is gone", async () => {
      const missingId = "9eb354af-bbd5-4499-9ebe-084e9cc2c2dd";
      const ghostJsonl = join(cacheDir, `${missingId}.jsonl`); // path that does not exist
      const cache = ConversationCache.open(join(cacheDir, "cache.db"), 10);
      cache.updateFromLine(
        ghostJsonl,
        JSON.stringify({
          role: "user",
          timestamp: "2026-05-20T20:00:00.000Z",
          message: { content: [{ type: "text", text: "hello from the cache" }] },
        }),
      );
      cache.close();

      const res = await fetch(`${baseUrl}/api/conversations/${missingId}?msg_limit=80`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        meta: { id: string };
        messages: Array<{ role: string; text: string }>;
      };
      expect(body.meta.id).toBe(missingId);
      expect(body.messages.length).toBeGreaterThan(0);
      expect(body.messages[0].text).toContain("hello from the cache");
    });

    it("prunes the ghost cache row when scanner + tail both come up empty", async () => {
      const ghostId = "deadbeef-1111-2222-3333-444455556666";
      const ghostJsonl = join(cacheDir, `${ghostId}.jsonl`); // no file, no tail data
      const cache = ConversationCache.open(join(cacheDir, "cache.db"), 10);
      cache.upsertFromScannerMeta([
        {
          id: ghostId,
          sessionId: ghostId,
          filePath: ghostJsonl,
          projectPath: "/no/such/project",
          projectName: "ghost",
          title: "ghost",
          model: null,
          account: null,
          gitBranch: null,
          messageCount: 0,
          timestamp: "2026-05-20T20:00:00.000Z",
          firstMessage: null,
          lastMessage: null,
          preview: null,
        },
      ] as any);
      expect(cache.hasConversation(ghostId)).toBe(true);
      cache.close();

      const res = await fetch(`${baseUrl}/api/conversations/${ghostId}?msg_limit=80`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(404);

      // Reopen the cache and verify the row was pruned by the failing request.
      const reopened = ConversationCache.open(join(cacheDir, "cache.db"), 10);
      expect(reopened.hasConversation(ghostId)).toBe(false);
      reopened.close();
    });
  });

  describe("localNoAuth mode", () => {
    let localServer: StreamerServer;
    let localPort: number;

    beforeEach(async () => {
      localPort = await getRandomPort();
      localServer = new StreamerServer({
        port: localPort,
        apiKey: API_KEY,
        localNoAuth: true,
        verbose: false,
        scanProfiles: FIXTURE_PROFILES,
      });
      await localServer.listen(localPort);
    });

    afterEach(async () => {
      await localServer.close();
    });

    it("allows unauthenticated localhost requests", async () => {
      const res = await fetch(`http://localhost:${localPort}/api/info`);
      expect(res.status).toBe(200);
    });
  });

  // Regression tests for "Unhandled 'error' event" crashes (ECONNRESET from
  // peers RST'ing the TCP connection mid-handshake). The server must NOT
  // emit an unhandled 'error' that would crash the host process.
  describe("socket resilience", () => {
    it("survives a malformed HTTP request (clientError)", async () => {
      const net = await import("node:net");
      // Send obviously-broken raw bytes; the Node http parser emits
      // 'clientError'. We then verify the server is still serving.
      await new Promise<void>((resolve) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
          sock.write("\x00\x01\x02 not http at all\r\n\r\n");
        });
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
        // Don't reject on timeout — the assertion below is what matters.
        // The clientError handler may keep the socket open until our 400
        // response fully flushes; that's fine, we just need the server
        // not to crash.
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 500);
      });
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
    });

    it("survives an aborted WebSocket upgrade handshake", async () => {
      const net = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
          // Start a WS upgrade then immediately destroy() with RST. This
          // is the exact race condition that caused the production crash:
          // the @hono/node-ws upgrade handler awaits app.request() while
          // the underlying socket dies under it.
          sock.write(
            "GET /ws?key=does_not_matter HTTP/1.1\r\n" +
              "Host: localhost\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\n\r\n",
          );
          sock.destroy();
        });
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
        setTimeout(() => reject(new Error("client socket never closed")), 2000);
      });
      // Give the server a tick to process the upgrade attempt.
      await new Promise((r) => setTimeout(r, 200));
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
    });
  });

  // Regression for the "resume shows a different last message" report: the
  // scanner memoizes its index + parsed conversations for the server's
  // lifetime, so a conversation that grew after the initial scan kept serving
  // a stale message_count / last_updated_at from GET /api/conversations/:id —
  // disagreeing with the list view and with what --resume actually replays.
  // findConversationByUuid now re-scans when the JSONL on disk is newer.
  describe("GET /api/conversations/:id stale-snapshot re-scan", () => {
    let growServer: StreamerServer;
    let growPort: number;
    let profileDir: string;
    let jsonlPath: string;
    const convId = "grow-session-1111";

    beforeEach(async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-grow-profile-"));
      const projDir = join(profileDir, "projects", "-tmp-grow-project");
      mkdirSync(projDir, { recursive: true });
      jsonlPath = join(projDir, `${convId}.jsonl`);
      const line = (uuid: string, role: string, ts: string, text: string) =>
        `${JSON.stringify({
          type: role,
          uuid,
          timestamp: ts,
          sessionId: convId,
          slug: "grow-session",
          cwd: "/tmp/grow-project",
          message: { role, model: "claude-sonnet-4-6", content: [{ type: "text", text }] },
        })}\n`;
      writeFileSync(
        jsonlPath,
        line("g-u1", "user", "2026-06-05T08:00:00.000Z", "first message") +
          line("g-a1", "assistant", "2026-06-05T08:00:05.000Z", "first reply"),
      );

      growPort = await getRandomPort();
      growServer = new StreamerServer({
        port: growPort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-grow-cache-")),
        scanProfiles: [
          { id: "grow", label: "Grow", configDir: profileDir, enabled: true, emoji: "🌱" },
        ],
      });
      await growServer.listen(growPort);
    });

    afterEach(async () => {
      await growServer.close();
    });

    it("reflects messages appended after the initial scan", async () => {
      const url = `http://localhost:${growPort}/api/conversations/${convId}?msg_limit=80`;
      const headers = { Authorization: `Bearer ${API_KEY}` };

      // Warm the scanner snapshot at 2 messages.
      const first = await fetch(url, { headers });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        meta: { message_count: number; last_updated_at: string };
        messages: Array<{ text: string }>;
      };
      expect(firstBody.messages.length).toBe(2);

      // Grow the conversation and push the mtime past the snapshot timestamp.
      const newLine = `${JSON.stringify({
        type: "assistant",
        uuid: "g-a2",
        timestamp: "2026-06-07T10:04:11.912Z",
        sessionId: convId,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "the real latest message" }],
        },
      })}\n`;
      appendFileSync(jsonlPath, newLine);
      const future = new Date("2026-06-07T10:04:12.000Z");
      utimesSync(jsonlPath, future, future);

      // The re-fetch must re-scan and surface the appended message.
      const second = await fetch(url, { headers });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        meta: { message_count: number; last_updated_at: string };
        messages: Array<{ text: string }>;
      };
      expect(secondBody.messages.length).toBe(3);
      expect(secondBody.messages.at(-1)?.text).toContain("the real latest message");
      expect(secondBody.meta.last_updated_at).toBe("2026-06-07T10:04:11.912Z");
    });
  });

  describe("GET /api/conversations/:id paged scanner reads", () => {
    let profileDir: string;
    const convId = "large-page-session-3333";

    beforeEach(() => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-large-page-profile-"));
      const projDir = join(profileDir, "projects", "-tmp-large-page-project");
      mkdirSync(projDir, { recursive: true });
      const jsonlPath = join(projDir, `${convId}.jsonl`);
      const lines: string[] = [];
      for (let i = 0; i < 300; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        lines.push(
          `${JSON.stringify({
            type: role,
            uuid: `lp-${i}`,
            timestamp: `2026-06-05T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(
              i % 60,
            ).padStart(2, "0")}.000Z`,
            sessionId: convId,
            slug: "large-page-session",
            cwd: "/tmp/large-page-project",
            message: {
              role,
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: `large page message ${i}` }],
            },
          })}\n`,
        );
      }
      writeFileSync(jsonlPath, lines.join(""));
    });

    async function fetchPageWithScannerPrototype(
      getConversationPage: unknown,
    ): Promise<{ text: string; body: any }> {
      const port = await getRandomPort();
      const pageServer = new StreamerServer({
        port,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-large-page-cache-")),
        scanProfiles: [
          {
            id: "large-page",
            label: "Large Page",
            configDir: profileDir,
            enabled: true,
            emoji: "P",
          },
        ],
      });
      const proto = ConversationScanner.prototype as unknown as {
        getConversationPage?: unknown;
      };
      const original = proto.getConversationPage;
      proto.getConversationPage = getConversationPage;
      try {
        await pageServer.listen(port);
        const res = await fetch(
          `http://localhost:${port}/api/conversations/${convId}?msg_limit=37&before_index=211`,
          { headers: { Authorization: `Bearer ${API_KEY}` } },
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        return { text, body: JSON.parse(text) };
      } finally {
        proto.getConversationPage = original;
        await pageServer.close();
      }
    }

    it("returns the same pagination and page bytes as the full-parse fallback", async () => {
      const proto = ConversationScanner.prototype as unknown as {
        getConversationPage?: unknown;
      };
      const paged = await fetchPageWithScannerPrototype(proto.getConversationPage);
      const fallback = await fetchPageWithScannerPrototype(undefined);

      expect(paged.body.message_pagination).toEqual(fallback.body.message_pagination);
      expect(Buffer.from(JSON.stringify(paged.body.messages))).toEqual(
        Buffer.from(JSON.stringify(fallback.body.messages)),
      );
      expect(paged.text).toBe(fallback.text);
    });
  });

  describe("GET /api/conversations/:id ETag / If-None-Match", () => {
    let etagServer: StreamerServer;
    let etagPort: number;
    let profileDir: string;
    let jsonlPath: string;
    let scannerDb: string;
    const convId = "etag-session-2222";

    beforeEach(async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-etag-profile-"));
      scannerDb = join(profileDir, "scanner.db");
      process.env.TB_SCANNER_DB = scannerDb;
      const projDir = join(profileDir, "projects", "-tmp-etag-project");
      mkdirSync(projDir, { recursive: true });
      jsonlPath = join(projDir, `${convId}.jsonl`);
      const line = (uuid: string, role: string, ts: string, text: string) =>
        `${JSON.stringify({
          type: role,
          uuid,
          timestamp: ts,
          sessionId: convId,
          slug: "etag-session",
          cwd: "/tmp/etag-project",
          message: { role, model: "claude-sonnet-4-6", content: [{ type: "text", text }] },
        })}\n`;
      writeFileSync(
        jsonlPath,
        line("e-u1", "user", "2026-06-05T08:00:00.000Z", "first message") +
          line("e-a1", "assistant", "2026-06-05T08:00:05.000Z", "first reply"),
      );

      etagPort = await getRandomPort();
      etagServer = new StreamerServer({
        port: etagPort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-etag-cache-")),
        scanProfiles: [
          { id: "etag", label: "ETag", configDir: profileDir, enabled: true, emoji: "🏷️" },
        ],
      });
      await etagServer.listen(etagPort);
    });

    afterEach(async () => {
      await etagServer.close();
      delete process.env.TB_SCANNER_DB;
      rmSync(scannerDb, { force: true });
    });

    const url = () => `http://localhost:${etagPort}/api/conversations/${convId}`;
    const auth = { Authorization: `Bearer ${API_KEY}` };

    it("returns an ETag header with the body on first fetch", async () => {
      const res = await fetch(url(), { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
      // ETag must be readable cross-origin so the mobile fetch can store it.
      expect(res.headers.get("access-control-expose-headers")).toContain("ETag");
      const body = (await res.json()) as { messages: unknown[] };
      expect(body.messages.length).toBe(2);
    });

    it("returns 304 with empty body when If-None-Match matches", async () => {
      const first = await fetch(url(), { headers: auth });
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const second = await fetch(url(), {
        headers: { ...auth, "If-None-Match": etag as string },
      });
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
      expect(await second.text()).toBe("");
    });

    it("returns 200 with a new ETag after a message is appended", async () => {
      const first = await fetch(url(), { headers: auth });
      const etag = first.headers.get("etag") as string;

      const newLine = `${JSON.stringify({
        type: "assistant",
        uuid: "e-a2",
        timestamp: "2026-06-07T10:04:11.912Z",
        sessionId: convId,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "a brand new message" }],
        },
      })}\n`;
      appendFileSync(jsonlPath, newLine);
      const future = new Date("2026-06-07T10:04:12.000Z");
      utimesSync(jsonlPath, future, future);

      const second = await fetch(url(), {
        headers: { ...auth, "If-None-Match": etag },
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).not.toBe(etag);
      const body = (await second.json()) as { messages: Array<{ text: string }> };
      expect(body.messages.length).toBe(3);
      expect(body.messages.at(-1)?.text).toContain("a brand new message");
    });

    it("returns 200 (never 304) for a back-page request even with a matching If-None-Match", async () => {
      const first = await fetch(url(), { headers: auth });
      const etag = first.headers.get("etag") as string;

      const backPage = await fetch(`${url()}?msg_limit=1&before_index=1`, {
        headers: { ...auth, "If-None-Match": etag },
      });
      expect(backPage.status).toBe(200);
      const body = (await backPage.json()) as {
        messages: unknown[];
        message_pagination: { before_index: number; from_index: number };
      };
      expect(body.message_pagination.before_index).toBe(1);
      expect(body.messages.length).toBe(1);
    });

    it("returns 200 for a request without If-None-Match (old-client path)", async () => {
      const res = await fetch(url(), { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: unknown[] };
      expect(body.messages.length).toBe(2);
    });
  });

  describe("GET /api/conversations?refresh=1 reconcile (Stage 3)", () => {
    let refreshServer: StreamerServer;
    let refreshPort: number;
    let profileDir: string;
    let projDir: string;
    let scannerDb: string;
    const auth = { Authorization: `Bearer ${API_KEY}` };

    const convLine = (convId: string, ts: string, text: string) =>
      `${JSON.stringify({
        type: "user",
        uuid: `u-${convId}-${ts}`,
        timestamp: ts,
        sessionId: convId,
        slug: convId,
        cwd: "/tmp/refresh-project",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;

    const writeConv = (convId: string, text: string) =>
      writeFileSync(
        join(projDir, `${convId}.jsonl`),
        convLine(convId, "2026-06-05T08:00:00.000Z", text),
      );

    const listConversations = async () => {
      const res = await fetch(`http://localhost:${refreshPort}/api/conversations?refresh=1`, {
        headers: auth,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        conversations: Array<{ id: string; preview?: string; messageCount: number }>;
      };
    };

    beforeEach(async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-refresh-profile-"));
      scannerDb = join(profileDir, "scanner.db");
      process.env.TB_SCANNER_DB = scannerDb;
      projDir = join(profileDir, "projects", "-tmp-refresh-project");
      mkdirSync(projDir, { recursive: true });
      writeConv("refresh-a", "alpha");
      writeConv("refresh-b", "beta");

      refreshPort = await getRandomPort();
      refreshServer = new StreamerServer({
        port: refreshPort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-refresh-cache-")),
        scanProfiles: [
          { id: "refresh", label: "Refresh", configDir: profileDir, enabled: true, emoji: "🔄" },
        ],
        // Disable Codex scanning so the test doesn't pick up the real
        // ~/.codex/sessions history (the default codexRoots).
        codexRoots: [],
      });
      await refreshServer.listen(refreshPort);
    });

    afterEach(async () => {
      await refreshServer.close();
      delete process.env.TB_SCANNER_DB;
      rmSync(profileDir, { recursive: true, force: true });
    });

    it("passes fullRescan:true to the scanner (bypasses the dir-mtime gate) on refresh=1", async () => {
      const scanSpy = vi.spyOn(ConversationScanner.prototype, "scan");
      await listConversations();
      // Some scan() ran with fullRescan:true — the explicit-refresh escape hatch.
      const sawFullRescan = scanSpy.mock.calls.some(
        (args) => (args[0] as { fullRescan?: boolean } | undefined)?.fullRescan === true,
      );
      expect(sawFullRescan).toBe(true);
      scanSpy.mockRestore();
    });

    it("returns the full correct list on refresh=1 with nothing changed", async () => {
      const first = await listConversations();
      const firstIds = first.conversations.map((c) => c.id).sort();
      expect(firstIds).toEqual(["refresh-a", "refresh-b"]);

      // A second refresh with nothing changed on disk returns the identical list
      // (unchanged files are served from the reconciled cache, not reparsed —
      // the scanner's classify() skips them; proven in the scanner package).
      const second = await listConversations();
      expect(second.conversations.map((c) => c.id).sort()).toEqual(firstIds);
    });

    it("reflects an added conversation on the next refresh=1", async () => {
      const before = await listConversations();
      expect(before.conversations.map((c) => c.id).sort()).toEqual(["refresh-a", "refresh-b"]);

      writeConv("refresh-c", "gamma");
      const after = await listConversations();
      expect(after.conversations.map((c) => c.id).sort()).toEqual([
        "refresh-a",
        "refresh-b",
        "refresh-c",
      ]);
    });

    it("drops a removed conversation on the next refresh=1 (reconcile, not stale cache)", async () => {
      const before = await listConversations();
      expect(before.conversations.map((c) => c.id).sort()).toEqual(["refresh-a", "refresh-b"]);

      rmSync(join(projDir, "refresh-b.jsonl"));
      const after = await listConversations();
      expect(after.conversations.map((c) => c.id).sort()).toEqual(["refresh-a"]);
    });

    it("reflects a changed conversation's new content on the next refresh=1", async () => {
      await listConversations();

      // Rewrite refresh-a with different, longer content and bump its mtime.
      writeFileSync(
        join(projDir, "refresh-a.jsonl"),
        convLine("refresh-a", "2026-06-06T09:00:00.000Z", "alpha rewritten with new text"),
      );
      const future = new Date("2026-06-06T09:00:01.000Z");
      utimesSync(join(projDir, "refresh-a.jsonl"), future, future);

      const after = await listConversations();
      const a = after.conversations.find((c) => c.id === "refresh-a");
      expect(a?.preview).toContain("alpha rewritten");
    });
  });

  describe("GET /api/conversations/:id resumability classification", () => {
    let availPort: number;
    let availServer: StreamerServer;
    let profileDir: string;
    let liveCwd: string;
    let scannerDb: string;
    const auth = { Authorization: `Bearer ${API_KEY}` };

    const AVAILABLE = "avail-resumable-0001";
    const MISSING = "avail-pathmissing-0002";
    const WORKTREE = "avail-worktree-0003";

    const writeConv = (id: string, cwd: string) => {
      const projDir = join(profileDir, "projects", `-proj-${id}`);
      mkdirSync(projDir, { recursive: true });
      const line = (uuid: string, role: string, ts: string, text: string) =>
        `${JSON.stringify({
          type: role,
          uuid,
          timestamp: ts,
          sessionId: id,
          cwd,
          message: { role, model: "claude-sonnet-4-6", content: [{ type: "text", text }] },
        })}\n`;
      writeFileSync(
        join(projDir, `${id}.jsonl`),
        line(`${id}-u1`, "user", "2026-06-10T08:00:00.000Z", "hi") +
          line(`${id}-a1`, "assistant", "2026-06-10T08:00:05.000Z", "hello"),
      );
    };

    beforeEach(async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-avail-profile-"));
      scannerDb = join(profileDir, "scanner.db");
      process.env.TB_SCANNER_DB = scannerDb;
      // A cwd that exists on disk (the temp dir itself) → resumable.
      liveCwd = mkdtempSync(join(tmpdir(), "threadbase-avail-live-cwd-"));
      writeConv(AVAILABLE, liveCwd);
      // A cwd that does not exist, and is not a worktree path → path_missing.
      writeConv(MISSING, "/tmp/threadbase-avail-gone-9e8d7c");
      // A cwd that does not exist and looks like a removed git worktree.
      writeConv(WORKTREE, "/tmp/some-repo/.worktrees/feature-x-gone");

      availPort = await getRandomPort();
      availServer = new StreamerServer({
        port: availPort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-avail-cache-")),
        scanProfiles: [
          { id: "avail", label: "Avail", configDir: profileDir, enabled: true, emoji: "🔎" },
        ],
      });
      await availServer.listen(availPort, { awaitReady: true });
    });

    afterEach(async () => {
      await availServer.close();
      delete process.env.TB_SCANNER_DB;
      rmSync(scannerDb, { force: true });
    });

    const fetchMeta = async (id: string) => {
      const res = await fetch(
        `http://localhost:${availPort}/api/conversations/${id}?msg_limit=80`,
        { headers: auth },
      );
      return { res, body: (await res.json()) as any };
    };

    it("marks a conversation resumable when its project dir exists", async () => {
      const { res, body } = await fetchMeta(AVAILABLE);
      expect(res.status).toBe(200);
      expect(body.messages.length).toBe(2);
      expect(body.meta.resumable).toBe(true);
      expect(body.meta.unavailable_reason).toBeUndefined();
    });

    it("serves history but flags path_missing when the project dir is gone", async () => {
      const { res, body } = await fetchMeta(MISSING);
      expect(res.status).toBe(200);
      expect(body.messages.length).toBe(2); // full history still served
      expect(body.meta.resumable).toBe(false);
      expect(body.meta.unavailable_reason).toBe("path_missing");
    });

    it("flags worktree_removed when the missing cwd is a worktree path", async () => {
      const { res, body } = await fetchMeta(WORKTREE);
      expect(res.status).toBe(200);
      expect(body.messages.length).toBe(2);
      expect(body.meta.resumable).toBe(false);
      expect(body.meta.unavailable_reason).toBe("worktree_removed");
    });

    it("returns 404 with code=not_found for an unknown id", async () => {
      const res = await fetch(
        `http://localhost:${availPort}/api/conversations/does-not-exist-9999?msg_limit=80`,
        { headers: auth },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("not_found");
    });
  });

  describe("warm-up scanner reuse (Layer A)", () => {
    let reusePort: number;
    let reuseServer: StreamerServer;
    let profileDir: string;
    let isolatedScannerDb: string | null = null;
    const convId = "reuse-session-4444";
    const auth = { Authorization: `Bearer ${API_KEY}` };

    afterEach(async () => {
      await reuseServer?.close();
      if (isolatedScannerDb) {
        delete process.env.TB_SCANNER_DB;
        rmSync(isolatedScannerDb, { force: true });
        isolatedScannerDb = null;
      }
      vi.restoreAllMocks();
    });

    it("uses a non-persistent scanner for startup warm-up when a persisted stat cache exists", async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-statcache-profile-"));
      const projDir = join(profileDir, "projects", "-proj-statcache");
      mkdirSync(projDir, { recursive: true });
      const jsonlPath = join(projDir, `${convId}.jsonl`);
      writeFileSync(
        jsonlPath,
        `${JSON.stringify({
          type: "user",
          uuid: "sc-u1",
          timestamp: "2026-06-10T08:00:00.000Z",
          sessionId: convId,
          cwd: profileDir,
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        })}\n`,
      );

      const cacheDir = mkdtempSync(join(tmpdir(), "threadbase-statcache-cache-"));
      const cache = ConversationCache.open(join(cacheDir, "cache.db"), 10);
      cache.upsertFromScannerMeta([
        {
          id: convId,
          sessionId: convId,
          filePath: jsonlPath,
          projectPath: profileDir,
          projectName: "statcache",
          title: "statcache",
          messageCount: 1,
          timestamp: "2026-06-10T08:00:00.000Z",
          preview: "cached preview",
          toolNames: [],
        },
      ]);
      cache.close();

      const scanCalls: Array<{ persistent: boolean; hasStatCache: boolean }> = [];
      const realScan = ConversationScanner.prototype.scan;
      vi.spyOn(ConversationScanner.prototype, "scan").mockImplementation(async function (
        this: ConversationScanner,
        options: unknown,
      ) {
        scanCalls.push({
          persistent: (this as unknown as { persistent: boolean }).persistent,
          hasStatCache: !!(options as { statCache?: unknown } | undefined)?.statCache,
        });
        return (realScan as (...a: unknown[]) => Promise<unknown>).call(this, options);
      } as never);

      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir,
        codexRoots: [],
        scanProfiles: [
          { id: "statcache", label: "StatCache", configDir: profileDir, enabled: true, emoji: "S" },
        ],
      });
      await reuseServer.listen(reusePort, { awaitReady: true });

      expect(scanCalls).toContainEqual({ persistent: false, hasStatCache: true });
    });

    it("does not re-scan on the first request after warm-up completes", async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-reuse-profile-"));
      const projDir = join(profileDir, "projects", "-proj-reuse");
      mkdirSync(projDir, { recursive: true });
      const line = (uuid: string, role: string, ts: string, text: string) =>
        `${JSON.stringify({
          type: role,
          uuid,
          timestamp: ts,
          sessionId: convId,
          cwd: profileDir, // exists → resumable, irrelevant here
          message: { role, content: [{ type: "text", text }] },
        })}\n`;
      writeFileSync(
        join(projDir, `${convId}.jsonl`),
        line("r-u1", "user", "2026-06-10T08:00:00.000Z", "hi") +
          line("r-a1", "assistant", "2026-06-10T08:00:05.000Z", "hello"),
      );

      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-reuse-cache-")),
        scanProfiles: [
          { id: "reuse", label: "Reuse", configDir: profileDir, enabled: true, emoji: "♻️" },
        ],
      });
      // awaitReady → warm-up scan finishes (and is adopted) before we continue.
      await reuseServer.listen(reusePort, { awaitReady: true });

      // Spy AFTER warm-up so the count is scoped to post-warm-up scans only.
      // (The prototype spy is process-global, so baselining here avoids
      // counting the warm-up scan and any concurrent server's scans.)
      const scanSpy = vi.spyOn(ConversationScanner.prototype, "scan");

      // A detail request after warm-up must reuse the adopted scanner — the
      // whole point of Layer A. If the warm-up scanner weren't adopted, this
      // request would trigger a fresh full scan here.
      const res = await fetch(
        `http://localhost:${reusePort}/api/conversations/${convId}?msg_limit=80`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      expect(scanSpy.mock.calls.length).toBe(0); // no scan triggered by the request
    });

    it("does not full-rescan the detail path while scannerStale is set (Bug 2 stall)", async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-stale-profile-"));
      const projDir = join(profileDir, "projects", "-proj-stale");
      mkdirSync(projDir, { recursive: true });
      const jsonlPath = join(projDir, `${convId}.jsonl`);
      const line = (uuid: string, role: string, ts: string, text: string) =>
        `${JSON.stringify({
          type: role,
          uuid,
          timestamp: ts,
          sessionId: convId,
          cwd: profileDir,
          message: { role, content: [{ type: "text", text }] },
        })}\n`;
      writeFileSync(
        jsonlPath,
        line("s-u1", "user", "2026-06-10T08:00:00.000Z", "hi") +
          line("s-a1", "assistant", "2026-06-10T08:00:05.000Z", "hello"),
      );

      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-stale-cache-")),
        scanProfiles: [
          { id: "stale", label: "Stale", configDir: profileDir, enabled: true, emoji: "⏳" },
        ],
      });
      // awaitReady → warm-up scan finishes and is adopted before we continue.
      await reuseServer.listen(reusePort, { awaitReady: true });

      // Spy AFTER warm-up so the count is scoped to the request below — a full
      // rescan on the detail path while stale would show up here as scan() calls.
      const scanSpy = vi.spyOn(ConversationScanner.prototype, "scan");

      // Simulate the onConversationChanged stale-flip that lands between requests
      // under active-session churn: a sibling file changed, so the global scanner
      // is marked stale. Pre-fix, the detail request would honor this and pay a
      // full-tree rescan (the 14–78s stall). Post-fix it must reuse the indexed
      // scanner and never call scan().
      (reuseServer as unknown as { scannerStale: boolean }).scannerStale = true;

      const res = await fetch(
        `http://localhost:${reusePort}/api/conversations/${convId}?msg_limit=80`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ text: string }> };

      // Success criterion: no full-tree scan() on the detail path while stale.
      expect(scanSpy.mock.calls.length).toBe(0);
      // The request still serves correct content (not an empty/error body).
      expect(body.messages.length).toBe(2);
      // The global stale flag stays set so the next list-level call still rescans.
      expect((reuseServer as unknown as { scannerStale: boolean }).scannerStale).toBe(true);
    });

    it("reconciles single-file drift on the stale detail path via refreshFile, not scan()", async () => {
      // Deterministic unit-level proof that the detail path reconciles the one
      // conversation it serves with refreshFile (cheap, single-file) instead of
      // a full-tree scan — even when scannerStale is set. Driving
      // findConversationByUuid directly with a mocked stale snapshot avoids the
      // chokidar watcher racing ahead and refreshing the file first.
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-drift-profile-"));
      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-drift-cache-")),
        scanProfiles: [
          { id: "drift", label: "Drift", configDir: profileDir, enabled: true, emoji: "🌊" },
        ],
      });
      await reuseServer.listen(reusePort, { awaitReady: true });

      const srv = reuseServer as unknown as {
        scannerStale: boolean;
        scannerReady: Promise<unknown> | null;
        scanner: unknown;
        isConversationSnapshotStale: (conv: unknown) => boolean;
        findConversationByUuid: (uuid: string) => Promise<unknown>;
      };

      const staleSnapshot = {
        id: convId,
        sessionId: convId,
        filePath: "/tmp/drift.jsonl",
        timestamp: "2026-06-10T08:00:05.000Z",
        messageCount: 2,
        messages: [],
      };
      const refreshedSnapshot = { ...staleSnapshot, messageCount: 3, messages: [] };

      // Force the indexed scanner to return the stale snapshot, mark it stale on
      // disk, and capture the refresh. scan() must never be called.
      const scanSpy = vi.spyOn(ConversationScanner.prototype, "scan");
      const getConvSpy = vi
        .spyOn(ConversationScanner.prototype, "getConversation")
        .mockResolvedValueOnce(staleSnapshot as never)
        .mockResolvedValueOnce(refreshedSnapshot as never);
      const refreshSpy = vi
        .spyOn(ConversationScanner.prototype, "refreshFile")
        .mockResolvedValue({ id: convId, messageCount: 3 } as never);
      vi.spyOn(srv, "isConversationSnapshotStale").mockReturnValue(true);

      srv.scannerStale = true;
      const result = (await srv.findConversationByUuid(convId)) as { messageCount: number };

      expect(scanSpy.mock.calls.length).toBe(0);
      expect(refreshSpy).toHaveBeenCalledWith("/tmp/drift.jsonl");
      expect(getConvSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.messageCount).toBe(3);
      // Stale flag untouched: a subsequent list-level getScanner() still rescans.
      expect(srv.scannerStale).toBe(true);
    });

    it("returns the count?refresh=1 quickly without a synchronous full scan", async () => {
      // refresh=1 used to force a full scan() on the request path; on a cold/empty
      // index that scan walks every JSONL and blocks ~16s, tripping mobile's
      // request timeout. Post-fix it serves the cached total immediately and
      // reconciles in the background — fast regardless of refresh.
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-count-refresh-profile-"));
      isolatedScannerDb = join(profileDir, "scanner.db");
      process.env.TB_SCANNER_DB = isolatedScannerDb;
      const projDir = join(profileDir, "projects", "-proj-count");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(
        join(projDir, `${convId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          uuid: "c-u1",
          timestamp: "2026-06-10T08:00:00.000Z",
          sessionId: convId,
          cwd: profileDir,
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        })}\n`,
      );

      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-count-refresh-cache-")),
        codexRoots: [], // don't scan ~/.codex/sessions — only the one test conversation
        scanProfiles: [
          { id: "count", label: "Count", configDir: profileDir, enabled: true, emoji: "🔢" },
        ],
      });
      // awaitReady → warm-up scan populates the cache with the one conversation.
      await reuseServer.listen(reusePort, { awaitReady: true });

      // Spy AFTER warm-up: the background reconcile fires a scan() (fire-and-
      // forget), but the request must RESOLVE before that scan finishes. Gate
      // scan() so a request that blocked on it would never return in time.
      let releaseScan: () => void = () => {};
      const scanGate = new Promise<void>((r) => {
        releaseScan = r;
      });
      const realScan = ConversationScanner.prototype.scan;
      vi.spyOn(ConversationScanner.prototype, "scan").mockImplementation(async function (
        this: ConversationScanner,
        ...args: unknown[]
      ) {
        await scanGate;
        return (realScan as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      } as never);

      const started = Date.now();
      const res = await fetch(`http://localhost:${reusePort}/api/conversations/count?refresh=1`, {
        headers: auth,
      });
      const elapsed = Date.now() - started;
      releaseScan();

      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number };
      // Correct total served from the cache populated by warm-up.
      expect(body.total).toBe(1);
      // Fast: returned even though the (background) scan was still gated — the
      // request never blocked on the full rescan.
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
