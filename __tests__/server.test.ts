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
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import { ConversationCache } from "../src/conversation-cache";
import { PTYManager } from "../src/pty-manager";
import { GRACE_MAX_DEFERS, IDLE_REAP_AFTER_MS, StreamerServer } from "../src/server";

const FIXTURE_PROFILES = [
  {
    id: "test",
    label: "Test",
    configDir: join(__dirname, "./fixtures/contract-projects"),
    enabled: true,
    emoji: "🧪",
  },
];

// Isolate every server in this file from real host data: without this, a
// scanProfiles fixture alone still lets the scanner glob the developer's
// actual ~/.codex/sessions (codexRoots defaults there) and read/write the
// scanner package's shared persistent index at
// ~/.config/threadbase-scanner/index.db (unscoped by scanProfiles). Spread
// first in each StreamerServer config so a test-specific override still wins.
const HOST_ISOLATION = { codexRoots: [] as string[], scannerPersistent: false };

// Ask the kernel for an ephemeral port at bind time. Probing for a free port
// up front and releasing it is a TOCTOU race: test files run in parallel, so
// another server can take the port between the probe's close() and our
// listen(), producing a flaky EADDRINUSE. Callers pass 0 to listen() and read
// the real port back off `srv.port`.
const EPHEMERAL_PORT = 0;
async function getRandomPort(): Promise<number> {
  return EPHEMERAL_PORT;
}

const API_KEY = "tb_test_key_for_integration_tests";

describe("StreamerServer", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let cacheDir: string;

  beforeEach(async () => {
    port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-server-test-"));
    server = new StreamerServer({
      ...HOST_ISOLATION,
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: FIXTURE_PROFILES,
    });
    await server.listen(port, { awaitReady: true });
    port = server.port;
    baseUrl = `http://localhost:${port}`;
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
        ...HOST_ISOLATION,
        port,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir,
        browseRoot,
        scanProfiles: FIXTURE_PROFILES,
      });
      await server.listen(port, { awaitReady: true });
      port = server.port;
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
      browseRoot = mkdtempSync(join(tmpdir(), "threadbase-browse-test-"));
      mkdirSync(join(browseRoot, "project"));
      codexRoot = mkdtempSync(join(tmpdir(), "threadbase-codex-root-"));
      previousBrowseRootEnv = process.env.THREADBASE_BROWSE_ROOT;
      process.env.THREADBASE_BROWSE_ROOT = browseRoot;
      boundServer = new StreamerServer({
        ...HOST_ISOLATION,
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
      boundPort = boundServer.port;
      boundBaseUrl = `http://localhost:${boundPort}`;
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

    async function waitForBoundFetchReady(): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${boundBaseUrl}/api/conversations/count`, {
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        if (response.status !== 503) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Bound server did not finish startup warm-up");
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
      await waitForBoundFetchReady();

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

    it("resolves GET /api/conversations/:placeholderId via boundConversationId and serves Codex messages", async () => {
      const liveSessionId = "159fd3ce-ad78-4980-b441-1cfa05edaec9";
      const codexSessionId = "codex-persisted-id-messages";
      const projectPath = realpathSync(join(browseRoot, "project"));

      const now = new Date();
      const dateDir = join(
        codexRoot,
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      );
      mkdirSync(dateDir, { recursive: true });
      const lines = [
        {
          timestamp: now.toISOString(),
          type: "session_meta",
          payload: {
            id: codexSessionId,
            session_id: codexSessionId,
            cwd: projectPath,
            timestamp: now.toISOString(),
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhide me" },
            ],
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "real user question" }],
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "real assistant reply" }],
          },
        },
      ];
      writeFileSync(
        join(dateDir, `rollout-2026-01-01T00-00-00-${codexSessionId}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );

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
      // PtyManager.hasSession is what findConversationByUuid live-bypass checks.
      vi.spyOn((boundServer as any).ptyManager, "hasSession").mockImplementation(
        (id: string) => id === liveSessionId,
      );

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);
      await waitForBoundFetchReady();

      // Placeholder id (what mobile used to request) must resolve via boundConversationId.
      const byPlaceholder = await fetch(
        `${boundBaseUrl}/api/conversations/${liveSessionId}?msg_limit=80`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      expect(byPlaceholder.status).toBe(200);
      const placeholderBody = await byPlaceholder.json();
      const roles = (placeholderBody.messages ?? []).map((m: { role: string }) => m.role);
      const texts = (placeholderBody.messages ?? []).map((m: { text: string }) => m.text);
      expect(texts.some((t: string) => t.includes("AGENTS.md"))).toBe(false);
      expect(texts).toContain("real user question");
      expect(texts).toContain("real assistant reply");
      expect(roles).toEqual(["user", "assistant"]);

      // Bound Codex UUID also works directly.
      const byBound = await fetch(
        `${boundBaseUrl}/api/conversations/${codexSessionId}?msg_limit=80`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      expect(byBound.status).toBe(200);
      const boundBody = await byBound.json();
      expect((boundBody.messages ?? []).map((m: { text: string }) => m.text)).toContain(
        "real user question",
      );

      codexStartFreshSpy.mockRestore();
      vi.restoreAllMocks();
    });

    it("msg_limit on bound id slices the injection-filtered list (not scanner getConversationPage)", async () => {
      // Regression: handleGetConversation used to call getConversationPage after
      // building `filtered`, which re-read the unfiltered LRU and dropped the
      // newest user turn while surfacing AGENTS.md — mobile always sends msg_limit=80.
      const liveSessionId = "259fd3ce-ad78-4980-b441-1cfa05edaec9";
      const codexSessionId = "codex-persisted-id-msg-limit";
      const projectPath = realpathSync(join(browseRoot, "project"));

      const now = new Date();
      const dateDir = join(
        codexRoot,
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      );
      mkdirSync(dateDir, { recursive: true });
      const lines = [
        {
          timestamp: now.toISOString(),
          type: "session_meta",
          payload: {
            id: codexSessionId,
            session_id: codexSessionId,
            cwd: projectPath,
            timestamp: now.toISOString(),
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhide me" },
            ],
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first user turn" }],
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "first assistant reply" }],
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second user turn" }],
          },
        },
        {
          timestamp: now.toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "second assistant reply" }],
          },
        },
      ];
      writeFileSync(
        join(dateDir, `rollout-2026-01-01T00-00-00-${codexSessionId}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );

      const poisonPage = {
        messages: [
          {
            role: "user",
            text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhide me",
            timestamp: now.toISOString(),
          },
          {
            role: "user",
            text: "first user turn",
            timestamp: now.toISOString(),
          },
          {
            role: "assistant",
            text: "first assistant reply",
            timestamp: now.toISOString(),
          },
          // Deliberately omit the second turn — the old getConversationPage path
          // could serve a stale/unfiltered window that looked like this.
        ],
        total: 7,
        fromIndex: 0,
      };

      const scannerProto = (await import("@threadbase-sh/scanner")).ConversationScanner
        .prototype as unknown as {
        getConversationPage?: (...args: unknown[]) => unknown;
      };
      const originalGetPage = scannerProto.getConversationPage;
      scannerProto.getConversationPage = async () => poisonPage;

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
      vi.spyOn((boundServer as any).ptyManager, "hasSession").mockImplementation(
        (id: string) => id === liveSessionId,
      );

      try {
        const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ path: "project", provider: "codex-cli" }),
        });
        expect(startRes.status).toBe(200);
        await waitForBoundFetchReady();

        const byBound = await fetch(
          `${boundBaseUrl}/api/conversations/${codexSessionId}?msg_limit=80`,
          { headers: { Authorization: `Bearer ${API_KEY}` } },
        );
        expect(byBound.status).toBe(200);
        const body = await byBound.json();
        const texts = (body.messages ?? []).map((m: { text: string }) => m.text);
        expect(texts.some((t: string) => t.includes("AGENTS.md"))).toBe(false);
        expect(texts).toContain("first user turn");
        expect(texts).toContain("second user turn");
        expect(texts).toContain("second assistant reply");
        expect(body.message_pagination?.total).toBe(4);
      } finally {
        scannerProto.getConversationPage = originalGetPage;
        codexStartFreshSpy.mockRestore();
        vi.restoreAllMocks();
      }
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
      await waitForBoundFetchReady();

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
      await waitForBoundFetchReady();

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
      await waitForBoundFetchReady();

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

      // Include a real user response_item — session_meta alone is filtered out
      // when normalizing Codex lines to the Claude shape mobile understands.
      const now = new Date();
      const dateDir = join(
        codexRoot,
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      );
      mkdirSync(dateDir, { recursive: true });
      writeFileSync(
        join(dateDir, `rollout-2026-01-01T00-00-00-${codexSessionId}.jsonl`),
        [
          JSON.stringify({
            timestamp: now.toISOString(),
            type: "session_meta",
            payload: {
              id: codexSessionId,
              session_id: codexSessionId,
              cwd: projectPath,
              timestamp: now.toISOString(),
            },
          }),
          JSON.stringify({
            timestamp: now.toISOString(),
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "wire-test question" }],
            },
          }),
        ].join("\n") + "\n",
      );

      const startRes = await fetch(`${boundBaseUrl}/api/sessions/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "project", provider: "codex-cli" }),
      });
      expect(startRes.status).toBe(200);
      await waitForBoundFetchReady();

      // tryWire() runs synchronously during start: it replays chat-bearing
      // lines as Claude-shaped conversation_event frames and broadcasts
      // session_update carrying the freshly-bound conversation id.
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

      const chatEvent = events.find(
        (e) => e.type === "conversation_event" && e.sessionId === liveSessionId,
      );
      expect(chatEvent).toBeTruthy();
      const parsedLine = JSON.parse(chatEvent.line);
      expect(parsedLine.type).toBe("user");
      expect(parsedLine.message.content[0].text).toBe("wire-test question");
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

    it("does NOT hold a running session before the defer cap, and re-arms the timer", () => {
      vi.useFakeTimers();
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn((server as any).sessionStore, "get").mockReturnValue(mkSession("running"));
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});
      const armSpy = vi.spyOn(server as any, "startGraceTimer");

      (server as any).startGraceTimer(SID, 10);
      // Fire twice — both below the cap, so it defers and re-arms without holding.
      vi.advanceTimersByTime(20);

      expect(holdSpy).not.toHaveBeenCalled();
      // re-armed: startGraceTimer called again (beyond the initial invocation)
      expect(armSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      // defer count is tracked and still under the cap
      expect((server as any).ptyGraceDeferCounts.get(SID)).toBeLessThanOrEqual(GRACE_MAX_DEFERS);

      // stop the re-armed timer so it doesn't fire after restore
      const t = (server as any).ptyGraceTimers.get(SID);
      if (t) clearTimeout(t);
      (server as any).ptyGraceDeferCounts.delete(SID);
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("holds a running session anyway once GRACE_MAX_DEFERS is exceeded", () => {
      vi.useFakeTimers();
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn((server as any).sessionStore, "get").mockReturnValue(mkSession("running"));
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});

      (server as any).startGraceTimer(SID, 10);
      // GRACE_MAX_DEFERS defers, then one more fire that exceeds the cap and holds.
      vi.advanceTimersByTime(10 * (GRACE_MAX_DEFERS + 1));

      expect(holdSpy).toHaveBeenCalledWith(SID);
      // count is cleared once it holds
      expect((server as any).ptyGraceDeferCounts.has(SID)).toBe(false);
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("holds a waiting_input session when the grace timer fires", () => {
      vi.useFakeTimers();
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn((server as any).sessionStore, "get").mockReturnValue(mkSession("waiting_input"));
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});

      (server as any).startGraceTimer(SID, 10);
      vi.advanceTimersByTime(10);

      expect(holdSpy).toHaveBeenCalledWith(SID);
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });

  // The reconciler's verdicts are useless if they never reach a client. This
  // covers the overlay that carries them onto session responses.
  describe("withReconciledLifecycle", () => {
    const mkResp = (over: Record<string, unknown> = {}) =>
      ({
        id: "prev-run-sess",
        status: "idle",
        ptyAttached: false,
        lifecycle: "completed",
        lifecycleSource: "exit",
        ...over,
      }) as any;

    afterEach(() => (server as any).sessionLifecycles.clear());

    it("applies a reconciled verdict to a session this run does not own", () => {
      (server as any).sessionLifecycles.set("prev-run-sess", "orphaned");

      const [out] = (server as any).withReconciledLifecycle([mkResp()]);

      expect(out.lifecycle).toBe("orphaned");
      expect(out.lifecycleSource).toBe("reconcile");
    });

    // A live session's own lifecycle is authoritative — a verdict from boot
    // must never override what this run currently observes.
    it("never overrides a session whose PTY is attached here", () => {
      (server as any).sessionLifecycles.set("prev-run-sess", "orphaned");

      const [out] = (server as any).withReconciledLifecycle([
        mkResp({ ptyAttached: true, lifecycle: "attached", lifecycleSource: "spawn" }),
      ]);

      expect(out.lifecycle).toBe("attached");
      expect(out.lifecycleSource).toBe("spawn");
    });

    it("leaves sessions with no verdict untouched", () => {
      const input = mkResp();
      const [out] = (server as any).withReconciledLifecycle([input]);
      expect(out).toBe(input);
    });
  });

  // The registry records this token so the boot reconciler can reject a
  // recycled pid: it must be a string genuinely present in the spawned
  // process's argv, or the guard silently never matches.
  describe("spawnArgvToken", () => {
    const base = {
      id: "sess-abc",
      projectPath: "/work/repo",
      projectName: "repo",
      branch: "",
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
    };

    it("uses the session id for Claude — always in argv via --resume/--session-id", () => {
      const token = (server as any).spawnArgvToken({ ...base, provider: "claude-code" });
      expect(token).toBe("sess-abc");
    });

    it("uses the rollout id for a bound Codex session — `codex resume <id>`", () => {
      const token = (server as any).spawnArgvToken({
        ...base,
        provider: "codex-cli",
        boundConversationId: "rollout-5",
      });
      expect(token).toBe("rollout-5");
    });

    // A fresh Codex spawn is `codex --cd <path> --no-alt-screen` — the local
    // placeholder id appears nowhere in argv, so matching on it would never hit.
    it("falls back to the project path for an unbound fresh Codex session", () => {
      const token = (server as any).spawnArgvToken({ ...base, provider: "codex-cli" });
      expect(token).toBe("/work/repo");
      expect(token).not.toBe("sess-abc");
    });
  });

  describe("idle reaper", () => {
    // The reaper is the resource bound that replaces kill-on-disconnect. Drive
    // reapIdleSessions() with an explicit `now` rather than the interval, so
    // these assert the eligibility rules and not the clock.
    const mkSession = (over: Record<string, unknown> = {}) =>
      ({
        id: "reap-sess",
        status: "waiting_input",
        projectPath: "/tmp",
        projectName: "test",
        branch: "",
        promptCount: 0,
        startedAt: new Date(0),
        completedAt: null,
        lastOutput: "",
        ...over,
      }) as any;

    afterEach(() => vi.restoreAllMocks());

    it("reaps a settled session whose agent has been silent past the threshold", () => {
      vi.spyOn(PTYManager.prototype, "listSessions").mockReturnValue([mkSession()]);
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});

      const reaped = (server as any).reapIdleSessions(IDLE_REAP_AFTER_MS + 1);

      expect(holdSpy).toHaveBeenCalledWith("reap-sess");
      expect(reaped).toEqual(["reap-sess"]);
    });

    // The whole point of C1: a long-running turn is never interrupted, no
    // matter how old it is or whether anyone is watching.
    it("never reaps a running session, however long it has been running", () => {
      vi.spyOn(PTYManager.prototype, "listSessions").mockReturnValue([
        mkSession({ status: "running" }),
      ]);
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});

      const reaped = (server as any).reapIdleSessions(IDLE_REAP_AFTER_MS * 100);

      expect(holdSpy).not.toHaveBeenCalled();
      expect(reaped).toEqual([]);
    });

    it("does not reap a settled session that is still within the threshold", () => {
      vi.spyOn(PTYManager.prototype, "listSessions").mockReturnValue([mkSession()]);
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});

      const reaped = (server as any).reapIdleSessions(IDLE_REAP_AFTER_MS - 1);

      expect(holdSpy).not.toHaveBeenCalled();
      expect(reaped).toEqual([]);
    });

    // Agent output — not user input — is what keeps a session alive. An agent
    // grinding through a long task with nobody watching must survive.
    it("treats recent agent output as activity", () => {
      vi.spyOn(PTYManager.prototype, "listSessions").mockReturnValue([mkSession()]);
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});
      const now = IDLE_REAP_AFTER_MS * 10;
      // Chunk arrived a moment ago, even though startedAt is ancient.
      (server as any).lastAgentChunkAt.set("reap-sess", now - 1000);

      const reaped = (server as any).reapIdleSessions(now);

      expect(holdSpy).not.toHaveBeenCalled();
      expect(reaped).toEqual([]);
      (server as any).lastAgentChunkAt.delete("reap-sess");
    });
  });

  describe("ptyGracePeriodMs = 0 disables auto-hold", () => {
    // Subscribe a real WS to a session id, close it, and inspect whether the
    // last-subscriber-disconnect path armed a grace timer. subscribe_session's
    // addSessionSubscriber runs regardless of hasSession (the hasSession check
    // only gates terminal_replay), so no live PTY is needed.
    const SID = "disable-grace-sess";
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

    // Poll for a condition instead of sleeping a fixed interval: a WS message
    // round-trip has no fixed upper bound, so a flat 50 ms wait fails under
    // load (parallel test files on a busy machine).
    async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    async function subscribeAndClose(srv: StreamerServer): Promise<void> {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws?key=${API_KEY}`);
      await new Promise<void>((r) => ws.on("open", () => r()));
      ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SID }));
      // wait for the server to register the subscriber before we disconnect
      await waitFor(() => (srv as any).sessionSubscribers.has(SID));
      expect((srv as any).sessionSubscribers.has(SID)).toBe(true);
      ws.close();
      // wait for handleWsClose to run. It removes this ws from the session's
      // subscriber set (the set itself is left in place either way), so an
      // emptied set is the signal that the close path has completed —
      // regardless of whether a grace timer was armed.
      await waitFor(() => ((srv as any).sessionSubscribers.get(SID)?.size ?? 0) === 0);
    }

    it("does NOT arm a grace timer on disconnect when grace is 0", async () => {
      const p = await getRandomPort();
      const srv = new StreamerServer({
        ...HOST_ISOLATION,
        port: p,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-grace0-test-")),
        scanProfiles: FIXTURE_PROFILES,
        ptyGracePeriodMs: 0,
      });
      await srv.listen(p, { awaitReady: true });
      try {
        await subscribeAndClose(srv);
        expect((srv as any).ptyGraceTimers.has(SID)).toBe(false);
      } finally {
        await srv.close();
      }
    });

    // A socket closing is not a request to stop the agent — phones sleep, signal
    // drops, Wi-Fi hands off to cellular. This asserts the C1 inversion: even
    // with a positive grace period, an involuntary disconnect arms nothing. The
    // resource bound moved to the idle reaper (see "idle reaper" below).
    it("does NOT arm a grace timer on disconnect even when grace is positive", async () => {
      const p = await getRandomPort();
      const srv = new StreamerServer({
        ...HOST_ISOLATION,
        port: p,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-gracepos-test-")),
        scanProfiles: FIXTURE_PROFILES,
        ptyGracePeriodMs: 60_000,
      });
      await srv.listen(p, { awaitReady: true });
      try {
        await subscribeAndClose(srv);
        expect((srv as any).ptyGraceTimers.has(SID)).toBe(false);
      } finally {
        await srv.close();
      }
    });

    it("holds immediately on an explicit hold_session when grace is 0", async () => {
      const p = await getRandomPort();
      const srv = new StreamerServer({
        ...HOST_ISOLATION,
        port: p,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-hold0-test-")),
        scanProfiles: FIXTURE_PROFILES,
        ptyGracePeriodMs: 0,
      });
      await srv.listen(p, { awaitReady: true });
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn((srv as any).sessionStore, "get").mockReturnValue(mkSession("waiting_input"));
      try {
        const ws = new WebSocket(`ws://localhost:${srv.port}/ws?key=${API_KEY}`);
        await new Promise<void>((r) => ws.on("open", () => r()));
        ws.send(JSON.stringify({ type: "hold_session", sessionId: SID }));
        await waitFor(() => holdSpy.mock.calls.length > 0);
        expect(holdSpy).toHaveBeenCalledWith(SID);
        ws.close();
      } finally {
        vi.restoreAllMocks();
        await srv.close();
      }
    });

    it("arms the full grace timer on hold_session instead of holding immediately", async () => {
      const p = await getRandomPort();
      const srv = new StreamerServer({
        ...HOST_ISOLATION,
        port: p,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-holdgrace-test-")),
        scanProfiles: FIXTURE_PROFILES,
        ptyGracePeriodMs: 60_000,
      });
      await srv.listen(p, { awaitReady: true });
      const holdSpy = vi.spyOn(PTYManager.prototype, "putOnHold").mockImplementation(() => {});
      try {
        const ws = new WebSocket(`ws://localhost:${srv.port}/ws?key=${API_KEY}`);
        await new Promise<void>((r) => ws.on("open", () => r()));
        ws.send(JSON.stringify({ type: "hold_session", sessionId: SID }));
        await waitFor(() => (srv as any).ptyGraceTimers.has(SID));
        expect(holdSpy).not.toHaveBeenCalled();
        const t = (srv as any).ptyGraceTimers.get(SID);
        if (t) clearTimeout(t);
        ws.close();
      } finally {
        vi.restoreAllMocks();
        await srv.close();
      }
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

  // A retry must not submit the same prompt to the agent twice. The rate
  // limiter does not cover this: 500/min targets floods, and a genuine retry
  // (flaky network, double-tap, client resend on timeout) sits well inside it.
  describe("POST /api/sessions/:id/input idempotency", () => {
    const SID = "idem-sess";

    it("submits once and replays the result for a repeated key", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      const sendInput = vi.spyOn(PTYManager.prototype, "sendInput").mockReturnValue(1);
      try {
        const post = () =>
          fetch(`${baseUrl}/api/sessions/${SID}/input`, {
            method: "POST",
            headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: "hello", idempotencyKey: "retry-1" }),
          });

        const first = await post();
        const second = await post();

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual(await first.json());
        // The point: the agent saw the prompt exactly once.
        expect(sendInput).toHaveBeenCalledTimes(1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("submits both when the keys differ", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      const sendInput = vi.spyOn(PTYManager.prototype, "sendInput").mockReturnValue(1);
      try {
        for (const key of ["a-1", "a-2"]) {
          await fetch(`${baseUrl}/api/sessions/${SID}-distinct/input`, {
            method: "POST",
            headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: "hello", idempotencyKey: key }),
          });
        }
        expect(sendInput).toHaveBeenCalledTimes(2);
      } finally {
        vi.restoreAllMocks();
      }
    });

    // Optional field — existing clients keep working with no retry protection.
    it("still accepts input with no key at all", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      const sendInput = vi.spyOn(PTYManager.prototype, "sendInput").mockReturnValue(1);
      try {
        const res = await fetch(`${baseUrl}/api/sessions/${SID}-nokey/input`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: "hello" }),
        });
        expect(res.status).toBe(200);
        expect(sendInput).toHaveBeenCalledTimes(1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    // A client sending a malformed key believes it has protection it lacks.
    it("rejects a malformed key rather than silently ignoring it", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      const sendInput = vi.spyOn(PTYManager.prototype, "sendInput").mockReturnValue(1);
      try {
        const res = await fetch(`${baseUrl}/api/sessions/${SID}-bad/input`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: "hello", idempotencyKey: "" }),
        });
        expect(res.status).toBe(400);
        expect(sendInput).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    // A transient failure must stay retryable — recording it would replay a
    // temporary error as a permanent one.
    it("does not record a failed write", async () => {
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);
      const sendInput = vi.spyOn(PTYManager.prototype, "sendInput").mockImplementation(() => {
        throw new Error("Session not found: x");
      });
      try {
        const post = () =>
          fetch(`${baseUrl}/api/sessions/${SID}-fail/input`, {
            method: "POST",
            headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: "hello", idempotencyKey: "fail-1" }),
          });

        expect((await post()).status).toBe(400);
        expect((await post()).status).toBe(400);
        // Retried for real, not replayed from the cache.
        expect(sendInput).toHaveBeenCalledTimes(2);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  // Registration used to be a no-op returning { ok: true }: mobile registered,
  // got success, and nothing was stored — so nothing could ever be delivered.
  describe("push registration", () => {
    it("persists a registration and reports its health", async () => {
      const reg = await fetch(`${baseUrl}/api/push/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ token: "ExponentPushToken[abc]", platform: "ios" }),
      });
      expect(reg.status).toBe(200);

      const health = await fetch(`${baseUrl}/api/push/health`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await health.json();

      expect(body.available).toBe(true);
      // "never-delivered" is the honest state: registered, nothing sent yet.
      expect(body.tokens[0]).toMatchObject({ platform: "ios", state: "never-delivered" });
    });

    // A push token is a delivery credential; a health endpoint has no reason
    // to echo one back.
    it("never returns the token itself", async () => {
      await fetch(`${baseUrl}/api/push/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ token: "ExponentPushToken[secret-value]", platform: "android" }),
      });

      const res = await fetch(`${baseUrl}/api/push/health`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(await res.text()).not.toContain("secret-value");
    });

    it.each([
      ["missing token", { platform: "ios" }],
      ["empty token", { token: "", platform: "ios" }],
      ["bad platform", { token: "t", platform: "windows" }],
    ])("rejects an invalid registration (%s)", async (_name, payload) => {
      const res = await fetch(`${baseUrl}/api/push/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await fetch(`${baseUrl}/api/push/health`);
      expect(res.status).toBe(401);
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
    let prevCorsEnv: string | undefined;

    beforeAll(() => {
      // CORS is off by default; enable it so these assertions exercise the
      // allowed-origin path. Read once at middleware construction (per
      // beforeEach's `new StreamerServer`), so it must be set before this
      // describe block's tests run.
      prevCorsEnv = process.env.THREADBASE_ALLOW_BROWSER_CORS;
      process.env.THREADBASE_ALLOW_BROWSER_CORS = "true";
    });

    afterAll(() => {
      if (prevCorsEnv === undefined) delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
      else process.env.THREADBASE_ALLOW_BROWSER_CORS = prevCorsEnv;
    });

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
        ...HOST_ISOLATION,
        port: localPort,
        apiKey: API_KEY,
        localNoAuth: true,
        verbose: false,
        scanProfiles: FIXTURE_PROFILES,
      });
      await localServer.listen(localPort, { awaitReady: true });
      localPort = localServer.port;
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
        ...HOST_ISOLATION,
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
      await growServer.listen(growPort, { awaitReady: true });
      growPort = growServer.port;
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

      // Stale-while-revalidate (guard rails): the first re-fetch serves the
      // current snapshot and refreshes in the background, so the appended
      // message surfaces on a subsequent fetch once the refresh settles. The
      // refresh is TTL-throttled (REFRESH_TTL_MS = 2s), so the poll interval
      // must be long enough to cross that window. Poll until it lands — exactly
      // how a live client reconciles.
      let secondBody: {
        meta: { message_count: number; last_updated_at: string };
        messages: Array<{ text: string }>;
      } = { meta: { message_count: 2, last_updated_at: "" }, messages: [] };
      for (let attempt = 0; attempt < 24; attempt++) {
        const res = await fetch(url, { headers });
        expect(res.status).toBe(200);
        secondBody = await res.json();
        if (secondBody.messages.length === 3) break;
        await new Promise((r) => setTimeout(r, 150));
      }
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
        ...HOST_ISOLATION,
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
        await pageServer.listen(port, { awaitReady: true });
        const res = await fetch(
          `http://localhost:${pageServer.port}/api/conversations/${convId}?msg_limit=37&before_index=211`,
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
        ...HOST_ISOLATION,
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
      await etagServer.listen(etagPort, { awaitReady: true });
      etagPort = etagServer.port;
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

      // Stale-while-revalidate: the first re-fetch still matches the old ETag
      // (304) and refreshes in the background; the new ETag + appended message
      // surface once the refresh settles. The refresh is TTL-throttled
      // (REFRESH_TTL_MS = 2s), so the poll interval crosses that window. Poll
      // with the client's stored ETag until it 200s with fresh content.
      let last: Response = first;
      let body: { messages: Array<{ text: string }> } = { messages: [] };
      for (let attempt = 0; attempt < 24; attempt++) {
        last = await fetch(url(), { headers: { ...auth, "If-None-Match": etag } });
        if (last.status === 200) {
          body = await last.json();
          if (body.messages.length === 3) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(last.status).toBe(200);
      expect(last.headers.get("etag")).not.toBe(etag);
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
        ...HOST_ISOLATION,
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
      await refreshServer.listen(refreshPort, { awaitReady: true });
      refreshPort = refreshServer.port;
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

    it("passes an onProgress callback to the scanner on refresh=1 (live progress, not a dead bar)", async () => {
      // Capture scan options without invoking the real persistent engine — this
      // asserts the rescanForRefresh wiring (mechanism), not the scan itself, and
      // stays green on boxes where the nested better-sqlite3 binding is unbuilt.
      const scanOptions: Array<Record<string, unknown> | undefined> = [];
      vi.spyOn(ConversationScanner.prototype, "scan").mockImplementation(async function (
        this: ConversationScanner,
        options: unknown,
      ) {
        scanOptions.push(options as Record<string, unknown> | undefined);
        (options as { onProgress?: (s: number, t: number) => void } | undefined)?.onProgress?.(
          1,
          1,
        );
        return { conversations: [], total: 0, scanned: 0 } as never;
      } as never);

      const res = await fetch(`http://localhost:${refreshPort}/api/conversations?refresh=1`, {
        headers: auth,
      });
      expect(res.status).toBe(200);

      // The explicit-refresh scan (fullRescan:true) must carry an onProgress so
      // the client renders scan_progress instead of a frozen bar.
      const refreshScan = scanOptions.find(
        (o) => (o as { fullRescan?: boolean } | undefined)?.fullRescan === true,
      );
      expect(refreshScan).toBeDefined();
      expect(typeof (refreshScan as { onProgress?: unknown }).onProgress).toBe("function");

      vi.restoreAllMocks();
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

  describe("GET /api/conversations auto-reconcile without refresh=1", () => {
    let autoServer: StreamerServer;
    let autoPort: number;
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
        cwd: "/tmp/auto-refresh-project",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;

    const writeConv = (convId: string, text: string, ts = "2026-06-05T08:00:00.000Z") =>
      writeFileSync(join(projDir, `${convId}.jsonl`), convLine(convId, ts, text));

    const listCached = async () => {
      const res = await fetch(`http://localhost:${autoPort}/api/conversations`, {
        headers: auth,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        conversations: Array<{ id: string; preview?: string; messageCount: number }>;
      };
    };

    const listForced = async () => {
      const res = await fetch(`http://localhost:${autoPort}/api/conversations?refresh=1`, {
        headers: auth,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        conversations: Array<{ id: string; preview?: string; messageCount: number }>;
      };
    };

    // The auto-reconcile is stale-while-revalidate: the first cached list after
    // a disk change serves stale and kicks a background rescan, so the fresh
    // data appears on a later poll rather than the triggering request. Poll
    // until the predicate holds (mirrors how the polling mobile client sees it).
    const listCachedUntil = async (
      pred: (r: { conversations: Array<{ id: string; preview?: string }> }) => boolean,
      timeoutMs = 4000,
    ) => {
      const deadline = Date.now() + timeoutMs;
      let last = await listCached();
      while (!pred(last)) {
        if (Date.now() > deadline) return last;
        await new Promise((r) => setTimeout(r, 50));
        last = await listCached();
      }
      return last;
    };

    beforeEach(async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-auto-refresh-"));
      scannerDb = join(profileDir, "scanner.db");
      process.env.TB_SCANNER_DB = scannerDb;
      projDir = join(profileDir, "projects", "-tmp-auto-project");
      mkdirSync(projDir, { recursive: true });
      writeConv("auto-a", "alpha");
      writeConv("auto-b", "beta");

      autoPort = await getRandomPort();
      autoServer = new StreamerServer({
        port: autoPort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-auto-cache-")),
        scanProfiles: [
          { id: "auto", label: "Auto", configDir: profileDir, enabled: true, emoji: "🔄" },
        ],
        codexRoots: [],
        // The scanner otherwise opens its own persistent SQLite index, which
        // needs a native better-sqlite3 build that is not guaranteed locally.
        scannerPersistent: false,
      });
      // getRandomPort() returns the ephemeral 0, so the real port has to be
      // read back after binding or every fetch below targets localhost:0.
      await autoServer.listen(autoPort, { awaitReady: true });
      autoPort = autoServer.port;
      // Seed cache + conversations_last_indexed_at via the explicit reconcile path.
      await listForced();
    });

    afterEach(async () => {
      await autoServer.close();
      delete process.env.TB_SCANNER_DB;
      rmSync(profileDir, { recursive: true, force: true });
    });

    it("surfaces a new JSONL under an existing project without ?refresh=1", async () => {
      const before = await listCached();
      expect(before.conversations.map((c) => c.id).sort()).toEqual(["auto-a", "auto-b"]);

      writeConv("auto-c", "gamma", "2026-06-07T10:00:00.000Z");
      // Child project dir mtime advances on add; parent root may not. Bump the
      // project dir past conversations_last_indexed_at so the freshness gate fires.
      const future = new Date(Date.now() + 60_000);
      utimesSync(projDir, future, future);

      // Background revalidation, so poll until the new conversation lands.
      const after = await listCachedUntil((r) => r.conversations.some((c) => c.id === "auto-c"));
      expect(after.conversations.map((c) => c.id).sort()).toEqual(["auto-a", "auto-b", "auto-c"]);
    });

    it("updates preview after external append when scannerStale is set (no ?refresh=1)", async () => {
      await listCached();

      writeFileSync(
        join(projDir, "auto-a.jsonl"),
        convLine("auto-a", "2026-06-07T11:00:00.000Z", "alpha continued externally"),
      );
      // Simulate directory-watcher dirty bit without waiting on chokidar.
      (autoServer as unknown as { scannerStale: boolean }).scannerStale = true;

      const after = await listCachedUntil((r) =>
        Boolean(r.conversations.find((c) => c.id === "auto-a")?.preview?.includes("externally")),
      );
      const a = after.conversations.find((c) => c.id === "auto-a");
      expect(a?.preview).toContain("alpha continued externally");
    });

    it("serves the cached list immediately while a routine reconcile runs in the background", async () => {
      // Prime the cache so there is something stale to serve.
      await listCached();

      // Make the rescan slow, and prove the request does NOT wait for it: a
      // blocking reconcile would take the full delay; stale-while-revalidate
      // returns at once with the cached rows.
      let releaseScan!: () => void;
      const scanGate = new Promise<void>((r) => {
        releaseScan = r;
      });
      const orig = (autoServer as unknown as { rescanForRefresh: () => Promise<unknown> })
        .rescanForRefresh;
      const spy = vi
        .spyOn(
          autoServer as unknown as { rescanForRefresh: () => Promise<unknown> },
          "rescanForRefresh",
        )
        .mockImplementation(async function (this: unknown, ...args: unknown[]) {
          await scanGate;
          return (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args);
        });

      writeConv("auto-slow", "delta", "2026-06-07T12:00:00.000Z");
      (autoServer as unknown as { scannerStale: boolean }).scannerStale = true;

      const t0 = Date.now();
      const res = await listCached();
      const elapsed = Date.now() - t0;

      // Returned promptly with the stale rows, without the new one, while the
      // (gated) rescan is still running.
      expect(elapsed).toBeLessThan(1000);
      expect(res.conversations.map((c) => c.id)).not.toContain("auto-slow");

      // Let the background rescan finish; the next polls converge on fresh data.
      releaseScan();
      const after = await listCachedUntil((r) => r.conversations.some((c) => c.id === "auto-slow"));
      expect(after.conversations.map((c) => c.id)).toContain("auto-slow");
      spy.mockRestore();
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
        ...HOST_ISOLATION,
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
      availPort = availServer.port;
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
    let isolatedConfigDir: string | null = null;
    const convId = "reuse-session-4444";
    const auth = { Authorization: `Bearer ${API_KEY}` };

    afterEach(async () => {
      await reuseServer?.close();
      if (isolatedScannerDb) {
        delete process.env.TB_SCANNER_DB;
        rmSync(isolatedScannerDb, { force: true });
        isolatedScannerDb = null;
      }
      if (isolatedConfigDir) {
        delete process.env.THREADBASE_CONFIG_DIR;
        rmSync(isolatedConfigDir, { recursive: true, force: true });
        isolatedConfigDir = null;
      }
      vi.restoreAllMocks();
    });

    it("returns an explicit startup warm-up status from session and conversation fetches", async () => {
      let releaseScan!: () => void;
      const scanPending = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      vi.spyOn(ConversationScanner.prototype, "scan").mockReturnValueOnce(scanPending as never);

      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-warmup-status-cache-")),
        scanProfiles: FIXTURE_PROFILES,
      });
      await reuseServer.listen(reusePort);
      reusePort = reuseServer.port;

      try {
        for (const path of [
          "/api/sessions?limit=50",
          "/api/sessions/not-yet-indexed",
          "/api/conversations/count",
          "/api/conversations?limit=50&offset=0",
          "/api/conversations/not-yet-indexed?msg_limit=80",
        ]) {
          const res = await fetch(`http://localhost:${reusePort}${path}`, { headers: auth });
          expect(res.status, path).toBe(503);
          await expect(res.json()).resolves.toMatchObject({
            code: "SERVER_WARMING_UP",
            warmupState: "startup",
          });
        }
      } finally {
        releaseScan();
      }
    });

    it("returns conversation_refresh while an explicit conversation refresh is running", async () => {
      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-refresh-status-cache-")),
        scanProfiles: FIXTURE_PROFILES,
        ...HOST_ISOLATION,
      });
      await reuseServer.listen(reusePort, { awaitReady: true });
      reusePort = reuseServer.port;

      let releaseScan!: () => void;
      let markScanStarted!: () => void;
      const scanPending = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      const scanStarted = new Promise<void>((resolve) => {
        markScanStarted = resolve;
      });
      vi.spyOn(ConversationScanner.prototype, "scan").mockImplementationOnce((async () => {
        markScanStarted();
        await scanPending;
      }) as never);

      const refresh = fetch(
        `http://localhost:${reusePort}/api/conversations?refresh=1&limit=50&offset=0`,
        { headers: auth },
      );
      await scanStarted;

      const duringRefresh = await fetch(`http://localhost:${reusePort}/api/sessions/count`, {
        headers: auth,
      });
      expect(duringRefresh.status).toBe(503);
      await expect(duringRefresh.json()).resolves.toMatchObject({
        code: "SERVER_WARMING_UP",
        warmupState: "conversation_refresh",
      });

      releaseScan();
      expect((await refresh).status).toBe(200);
    });

    it("acknowledges reset_rescan while fetches report cache_reset", async () => {
      isolatedConfigDir = mkdtempSync(join(tmpdir(), "threadbase-reset-status-config-"));
      process.env.THREADBASE_CONFIG_DIR = isolatedConfigDir;
      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-reset-status-cache-")),
        scanProfiles: FIXTURE_PROFILES,
      });
      await reuseServer.listen(reusePort, { awaitReady: true });
      reusePort = reuseServer.port;

      const monitor = (reuseServer as unknown as { cacheMonitor: object }).cacheMonitor;
      Reflect.set(monitor, "_pending", {
        fingerprint: "sha256:test-reset",
        severity: "low",
        detectedAt: new Date().toISOString(),
        missingCount: 0,
        totalRows: 0,
        backupPath: join(isolatedConfigDir, "already-backed-up.db"),
        missing: [],
      });

      let releaseScan!: () => void;
      let markScanStarted!: () => void;
      const scanPending = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      const scanStarted = new Promise<void>((resolve) => {
        markScanStarted = resolve;
      });
      vi.spyOn(ConversationScanner.prototype, "scan").mockImplementationOnce((async () => {
        markScanStarted();
        await scanPending;
      }) as never);

      const resolved = await fetch(`http://localhost:${reusePort}/api/cache/alert/resolve`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: "sha256:test-reset", action: "reset_rescan" }),
      });
      expect(resolved.status).toBe(200);
      await scanStarted;

      const duringReset = await fetch(`http://localhost:${reusePort}/api/conversations/count`, {
        headers: auth,
      });
      expect(duringReset.status).toBe(503);
      await expect(duringReset.json()).resolves.toMatchObject({
        code: "SERVER_WARMING_UP",
        warmupState: "cache_reset",
      });

      releaseScan();
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
        ...HOST_ISOLATION,
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
      reusePort = reuseServer.port;

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
        ...HOST_ISOLATION,
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
      reusePort = reuseServer.port;

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
        ...HOST_ISOLATION,
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
      reusePort = reuseServer.port;

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
        ...HOST_ISOLATION,
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
      reusePort = reuseServer.port;

      const srv = reuseServer as unknown as {
        scannerStale: boolean;
        scannerReady: Promise<unknown> | null;
        scanner: unknown;
        isConversationSnapshotStale: (conv: unknown) => boolean;
        findConversationByUuid: (uuid: string) => Promise<unknown>;
        inFlightCacheWrites: Set<Promise<unknown>>;
      };

      const staleSnapshot = {
        id: convId,
        sessionId: convId,
        filePath: "/tmp/drift.jsonl",
        timestamp: "2026-06-10T08:00:05.000Z",
        messageCount: 2,
        messages: [],
      };

      // Force the indexed scanner to return the stale snapshot, mark it stale on
      // disk, and capture the refresh. scan() must never be called.
      const scanSpy = vi.spyOn(ConversationScanner.prototype, "scan");
      const getConvSpy = vi
        .spyOn(ConversationScanner.prototype, "getConversation")
        .mockResolvedValue(staleSnapshot as never);
      const refreshSpy = vi
        .spyOn(ConversationScanner.prototype, "refreshFile")
        .mockResolvedValue({ id: convId, messageCount: 3 } as never);
      vi.spyOn(srv, "isConversationSnapshotStale").mockReturnValue(true);
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(false);

      srv.scannerStale = true;
      // Stale-while-revalidate: the response is the current snapshot, served
      // synchronously without awaiting the parse. scan() must never be called;
      // the single-file refresh runs in the background (tracked so close()
      // awaits it) rather than blocking the request behind a full-tree scan.
      const result = (await srv.findConversationByUuid(convId)) as { messageCount: number };
      expect(result.messageCount).toBe(2);
      expect(scanSpy.mock.calls.length).toBe(0);

      // Drain the tracked background refresh, then confirm it hit the one file.
      await Promise.all([...srv.inFlightCacheWrites]);
      expect(refreshSpy).toHaveBeenCalledWith("/tmp/drift.jsonl");
      // Stale flag untouched: a subsequent list-level getScanner() still rescans.
      expect(srv.scannerStale).toBe(true);
      void getConvSpy;
    });

    it("single-flights refreshFile: 20 concurrent stale detail requests → one parse", async () => {
      // A live, actively-appended file's mtime is always newer than the
      // snapshot, so pre-guard every request refreshed. The single-flight +
      // TTL guard collapses a retry storm to one underlying refreshFile.
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-sf-profile-"));
      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        ...HOST_ISOLATION,
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-sf-cache-")),
        scanProfiles: [
          { id: "sf", label: "SF", configDir: profileDir, enabled: true, emoji: "🌊" },
        ],
      });
      await reuseServer.listen(reusePort, { awaitReady: true });
      reusePort = reuseServer.port;

      const srv = reuseServer as unknown as {
        isConversationSnapshotStale: (conv: unknown) => boolean;
        findConversationByUuid: (uuid: string) => Promise<unknown>;
        inFlightCacheWrites: Set<Promise<unknown>>;
      };

      const snapshot = {
        id: convId,
        sessionId: convId,
        filePath: "/tmp/sf.jsonl",
        timestamp: "2026-06-10T08:00:05.000Z",
        messageCount: 2,
        messages: [],
      };
      vi.spyOn(ConversationScanner.prototype, "getConversation").mockResolvedValue(
        snapshot as never,
      );
      // A refresh that stays pending until we release it, so all 20 requests
      // land while it is in flight and coalesce onto the same promise.
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = () => r();
      });
      const refreshSpy = vi
        .spyOn(ConversationScanner.prototype, "refreshFile")
        .mockImplementation(async () => {
          await gate;
          return { id: convId, messageCount: 3 } as never;
        });
      vi.spyOn(srv, "isConversationSnapshotStale").mockReturnValue(true);
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(false);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => srv.findConversationByUuid(convId)),
      );
      // Every request got the snapshot immediately (SWR), before any refresh
      // completed.
      for (const r of results) expect((r as { messageCount: number }).messageCount).toBe(2);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      release();
      await Promise.all([...srv.inFlightCacheWrites]);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it("live-session bypass: hasSession true → zero refreshFile from the detail path", async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-live-profile-"));
      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        ...HOST_ISOLATION,
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-live-cache-")),
        scanProfiles: [
          { id: "live", label: "Live", configDir: profileDir, enabled: true, emoji: "🔴" },
        ],
      });
      await reuseServer.listen(reusePort, { awaitReady: true });
      reusePort = reuseServer.port;

      const srv = reuseServer as unknown as {
        isConversationSnapshotStale: (conv: unknown) => boolean;
        findConversationByUuid: (uuid: string) => Promise<unknown>;
      };

      const snapshot = {
        id: convId,
        sessionId: convId,
        filePath: "/tmp/live.jsonl",
        timestamp: "2026-06-10T08:00:05.000Z",
        messageCount: 2,
        messages: [],
      };
      vi.spyOn(ConversationScanner.prototype, "getConversation").mockResolvedValue(
        snapshot as never,
      );
      const refreshSpy = vi.spyOn(ConversationScanner.prototype, "refreshFile");
      // Even though the on-disk file looks stale, a live session must bypass the
      // stale-check entirely.
      const staleSpy = vi.spyOn(srv, "isConversationSnapshotStale").mockReturnValue(true);
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(true);

      const result = (await srv.findConversationByUuid(convId)) as { messageCount: number };
      expect(result.messageCount).toBe(2);
      expect(refreshSpy).not.toHaveBeenCalled();
      // The stale-check itself is skipped on the live path.
      expect(staleSpy).not.toHaveBeenCalled();
    });

    it("TTL: two sequential stale requests inside the window → one refresh; spaced beyond it → two", async () => {
      profileDir = mkdtempSync(join(tmpdir(), "threadbase-ttl-profile-"));
      reusePort = await getRandomPort();
      reuseServer = new StreamerServer({
        ...HOST_ISOLATION,
        port: reusePort,
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "threadbase-ttl-cache-")),
        scanProfiles: [
          { id: "ttl", label: "TTL", configDir: profileDir, enabled: true, emoji: "⏱️" },
        ],
      });
      await reuseServer.listen(reusePort, { awaitReady: true });
      reusePort = reuseServer.port;

      const srv = reuseServer as unknown as {
        isConversationSnapshotStale: (conv: unknown) => boolean;
        findConversationByUuid: (uuid: string) => Promise<unknown>;
        inFlightCacheWrites: Set<Promise<unknown>>;
      };

      const snapshot = {
        id: convId,
        sessionId: convId,
        filePath: "/tmp/ttl.jsonl",
        timestamp: "2026-06-10T08:00:05.000Z",
        messageCount: 2,
        messages: [],
      };
      vi.spyOn(ConversationScanner.prototype, "getConversation").mockResolvedValue(
        snapshot as never,
      );
      const refreshSpy = vi
        .spyOn(ConversationScanner.prototype, "refreshFile")
        .mockResolvedValue({ id: convId, messageCount: 3 } as never);
      vi.spyOn(srv, "isConversationSnapshotStale").mockReturnValue(true);
      vi.spyOn(PTYManager.prototype, "hasSession").mockReturnValue(false);

      // First request refreshes; drain it so its completedAt is stamped.
      await srv.findConversationByUuid(convId);
      await Promise.all([...srv.inFlightCacheWrites]);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      // Second request within REFRESH_TTL_MS (2s) → skipped, no new refresh.
      await srv.findConversationByUuid(convId);
      await Promise.all([...srv.inFlightCacheWrites]);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      // Advance past the TTL (REFRESH_TTL_MS = 2000 in server.ts) → the next
      // request refreshes again. Fake timers only for the clock the guard reads
      // (Date.now).
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 2000 + 1);
      try {
        await srv.findConversationByUuid(convId);
        await Promise.all([...srv.inFlightCacheWrites]);
      } finally {
        vi.useRealTimers();
      }
      expect(refreshSpy).toHaveBeenCalledTimes(2);
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
        ...HOST_ISOLATION,
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
      reusePort = reuseServer.port;

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
