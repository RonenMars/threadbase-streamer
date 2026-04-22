import { join } from "path";
import type { StreamerServer } from "../../src/server";
import { createTestServer, FIXTURES_DIR, get, validateAgainstSchema } from "./test-helpers";

const FIXTURE_DIR = join(FIXTURES_DIR, "contract-projects");

describe("Mobile contract tests", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const ctx = await createTestServer(FIXTURE_DIR);
    server = ctx.server;
    baseUrl = ctx.baseUrl;
    headers = ctx.headers;
  });

  afterAll(async () => {
    await server.close();
  });

  describe("GET /api/conversations", () => {
    it("returns ConversationPage matching mobile schema", async () => {
      const { status, body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      expect(status).toBe(200);
      validateAgainstSchema(body, "mobile", "MobileConversationPage");
    });

    it("returns at least one conversation from fixtures", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      expect(body.conversations.length).toBeGreaterThan(0);
    });

    it("returns conversations with required mobile fields", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      for (const conv of body.conversations) {
        expect(conv).toHaveProperty("id");
        expect(conv).toHaveProperty("title");
        expect(conv).toHaveProperty("projectPath");
        expect(conv).toHaveProperty("messageCount");
        expect(conv).toHaveProperty("lastActivity");
      }
    });
  });

  describe("GET /api/conversations/:id", () => {
    it("returns detail matching mobile schema", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=1", headers);
      const id = list.body.conversations[0].id;

      const { status, body } = await get(baseUrl, `/api/conversations/${id}`, headers);
      expect(status).toBe(200);
      validateAgainstSchema(body, "mobile", "MobileConversationDetail");
    });

    it("returns meta with required fields", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=1", headers);
      const id = list.body.conversations[0].id;

      const { body } = await get(baseUrl, `/api/conversations/${id}`, headers);
      expect(body.meta).toHaveProperty("id");
      expect(body.meta).toHaveProperty("project_name");
      expect(body.meta).toHaveProperty("project_path");
      expect(body.meta).toHaveProperty("file_path");
      expect(body.meta).toHaveProperty("message_count");
    });

    it("returns messages with role and timestamp", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=1", headers);
      const id = list.body.conversations[0].id;

      const { body } = await get(baseUrl, `/api/conversations/${id}`, headers);
      expect(body.messages.length).toBeGreaterThan(0);
      for (const msg of body.messages) {
        expect(msg).toHaveProperty("role");
        expect(msg).toHaveProperty("timestamp");
        expect(msg).toHaveProperty("text");
      }
    });
  });

  describe("GET /api/info", () => {
    it("returns ServerInfo matching mobile schema", async () => {
      const { status, body } = await get(baseUrl, "/api/info", headers);
      expect(status).toBe(200);
      validateAgainstSchema(body, "shared", "ServerInfo");
    });
  });

  describe("GET /api/search", () => {
    it("returns ConversationPage matching mobile schema", async () => {
      const { status, body } = await get(baseUrl, "/api/search?q=help", headers);
      expect(status).toBe(200);
      validateAgainstSchema(body, "mobile", "MobileConversationPage");
    });
  });

  describe("GET /api/sessions", () => {
    it("returns array (empty in test — no PTY)", async () => {
      const { status, body } = await get(baseUrl, "/api/sessions", headers);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });
});
