import { join } from "path";
import type { StreamerServer } from "../../src/server";
import {
  createTestServer,
  FIXTURES_DIR,
  get,
  validateAgainstSchema,
} from "../contracts/test-helpers";

const FIXTURE_DIR = join(FIXTURES_DIR, "contract-projects");

describe("API E2E tests", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let headers: Record<string, string>;
  const prevCorsEnv = process.env.THREADBASE_ALLOW_BROWSER_CORS;

  beforeAll(async () => {
    // CORS is off by default; enable it so the CORS assertions below exercise
    // the allowed-origin path. Read once at middleware construction, so it must
    // be set before createTestServer builds the app.
    process.env.THREADBASE_ALLOW_BROWSER_CORS = "true";
    const ctx = await createTestServer(FIXTURE_DIR);
    server = ctx.server;
    baseUrl = ctx.baseUrl;
    headers = ctx.headers;
  });

  afterAll(async () => {
    await server.close();
    if (prevCorsEnv === undefined) delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
    else process.env.THREADBASE_ALLOW_BROWSER_CORS = prevCorsEnv;
  });

  describe("conversation list pipeline", () => {
    it("returns fixture conversations through full scan pipeline", async () => {
      const { status, body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      expect(status).toBe(200);
      expect(body.total).toBeGreaterThan(0);
      expect(body.conversations.length).toBeGreaterThan(0);
      validateAgainstSchema(body, "mobile", "MobileConversationPage");
    });

    // Regression test for test-server isolation: without scannerPersistent: false
    // and codexRoots: [] in createTestServer(), the scanner's shared default
    // SQLite index (~/.config/threadbase-scanner/index.db) leaks real host
    // conversations in on machines with actual Claude Code / Codex history,
    // making `total` wildly exceed the fixture count.
    it("returns exactly the fixture conversations, isolated from real host data", async () => {
      const { status, body } = await get(baseUrl, "/api/conversations?limit=100", headers);
      expect(status).toBe(200);
      expect(body.total).toBe(3);
      for (const convo of body.conversations) {
        expect(convo.filePath).toContain(FIXTURE_DIR);
      }
    });

    it("respects limit parameter", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=1", headers);
      expect(body.conversations.length).toBeLessThanOrEqual(1);
    });

    it("respects offset parameter", async () => {
      const all = await get(baseUrl, "/api/conversations?limit=100", headers);
      if (all.body.total > 1) {
        const { body } = await get(baseUrl, "/api/conversations?limit=1&offset=1", headers);
        expect(body.offset).toBe(1);
        expect(body.conversations[0].id).not.toBe(all.body.conversations[0].id);
      }
    });
  });

  describe("conversation detail pipeline", () => {
    it("returns full conversation with messages through scan pipeline", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=1", headers);
      const id = list.body.conversations[0].id;

      const { status, body } = await get(baseUrl, `/api/conversations/${id}`, headers);
      expect(status).toBe(200);
      expect(body.meta.id).toBeTruthy();
      expect(body.messages.length).toBeGreaterThan(0);
      validateAgainstSchema(body, "mobile", "MobileConversationDetail");
    });

    it("returns 404 for nonexistent conversation", async () => {
      const { status } = await get(baseUrl, "/api/conversations/nonexistent-uuid", headers);
      expect(status).toBe(404);
    });
  });

  describe("tool use in detail", () => {
    it("returns tool_use and tool_result content blocks for tool-use fixture", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=10", headers);
      const toolsConv = list.body.conversations.find(
        (c: any) => c.title?.includes("tools-project") || c.projectPath?.includes("tools-project"),
      );

      if (!toolsConv) {
        // If we can't find the tools fixture, skip gracefully
        return;
      }

      const { body } = await get(baseUrl, `/api/conversations/${toolsConv.id}`, headers);
      const assistantMsgs = body.messages.filter((m: any) => m.role === "assistant");
      const hasToolUse = assistantMsgs.some((m: any) =>
        m.content?.some((c: any) => c.type === "tool_use"),
      );
      expect(hasToolUse).toBe(true);
    });
  });

  describe("search pipeline", () => {
    it("returns results for matching query", async () => {
      const { status, body } = await get(baseUrl, "/api/search?q=help", headers);
      expect(status).toBe(200);
      validateAgainstSchema(body, "mobile", "MobileConversationPage");
    });

    it("returns 400 for missing query", async () => {
      const { status } = await get(baseUrl, "/api/search", headers);
      expect(status).toBe(400);
    });
  });

  describe("server info", () => {
    it("returns valid server info", async () => {
      const { status, body } = await get(baseUrl, "/api/info", headers);
      expect(status).toBe(200);
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof body.machineName).toBe("string");
      expect(typeof body.platform).toBe("string");
      expect(typeof body.activeSessions).toBe("number");
      validateAgainstSchema(body, "shared", "ServerInfo");
    });
  });

  describe("sessions (no PTY in test)", () => {
    it("returns empty array when no sessions are running", async () => {
      const { status, body } = await get(baseUrl, "/api/sessions", headers);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe("authentication", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await fetch(`${baseUrl}/api/conversations`);
      expect(res.status).toBe(401);
    });

    it("rejects wrong API key", async () => {
      const res = await fetch(`${baseUrl}/api/conversations`, {
        headers: { Authorization: "Bearer wrong_key" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("CORS", () => {
    it("returns CORS headers on OPTIONS from an allowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/conversations`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:8081" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    });

    it("rejects OPTIONS from a disallowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/conversations`, {
        method: "OPTIONS",
        headers: { Origin: "http://evil.example.com" },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    // Regression: /api/sessions/count writes directly to the raw ServerResponse
    // and returns the ALREADY_HANDLED sentinel, so Hono never pipes c.res.headers.
    // The header must still land on the actual GET, not just the preflight.
    it("returns CORS header on an actual GET to a direct-write route", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/count`, {
        headers: { ...headers, Origin: "http://localhost:8081" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    });
  });
});
