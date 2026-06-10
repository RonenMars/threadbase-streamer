import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";
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

  describe("POST /api/sessions/:id/cancel", () => {
    it("returns 400 for nonexistent session", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(400);
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
    it("returns CORS headers", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("handles OPTIONS preflight", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        method: "OPTIONS",
      });
      expect(res.status).toBe(204);
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
});
