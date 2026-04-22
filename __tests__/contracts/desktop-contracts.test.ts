import { join } from "path";
import type { StreamerServer } from "../../src/server";
import { createTestServer, FIXTURES_DIR, get, validateAgainstSchema } from "./test-helpers";

const FIXTURE_DIR = join(FIXTURES_DIR, "contract-projects");

describe("Desktop contract tests", () => {
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

  describe("GET /api/conversations — list", () => {
    // Known mismatch: electron expects SearchResult[] (flat array),
    // streamer returns ConversationPage (wrapped object).
    it.skip("returns flat SearchResult[] matching desktop schema (KNOWN MISMATCH: returns ConversationPage instead)", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      validateAgainstSchema(body, "desktop", "DesktopSearchResultArray");
    });

    it("returns conversations with fields electron will need", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      expect(body.conversations.length).toBeGreaterThan(0);
      for (const conv of body.conversations) {
        expect(conv).toHaveProperty("id");
        expect(conv).toHaveProperty("title"); // desktop expects "projectName"
        expect(conv).toHaveProperty("projectPath");
        expect(conv).toHaveProperty("messageCount");
        expect(conv).toHaveProperty("lastActivity"); // desktop expects "timestamp"
        expect(conv).toHaveProperty("account");
        expect(conv).toHaveProperty("preview");
      }
    });
  });

  describe("GET /api/conversations/:id — detail", () => {
    // Known mismatch: electron expects flat Conversation with messages/fullText/sessionId,
    // streamer returns { meta, messages } Go-compatible wrapper.
    it.skip("returns flat Conversation matching desktop schema (KNOWN MISMATCH: returns { meta, messages } wrapper)", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=1", headers);
      const id = list.body.conversations[0].id;
      const { body } = await get(baseUrl, `/api/conversations/${id}`, headers);
      validateAgainstSchema(body, "desktop", "DesktopConversation");
    });

    it("returns detail data that could map to desktop fields", async () => {
      const list = await get(baseUrl, "/api/conversations?limit=1", headers);
      const id = list.body.conversations[0].id;
      const { body } = await get(baseUrl, `/api/conversations/${id}`, headers);

      expect(body).toHaveProperty("meta");
      expect(body).toHaveProperty("messages");
      expect(body.meta).toHaveProperty("id");
      expect(body.meta).toHaveProperty("project_name");
      expect(body.meta).toHaveProperty("file_path");
      expect(body.messages.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/info", () => {
    it("returns ServerInfo matching shared schema", async () => {
      const { status, body } = await get(baseUrl, "/api/info", headers);
      expect(status).toBe(200);
      validateAgainstSchema(body, "shared", "ServerInfo");
    });
  });

  describe("GET /api/sessions", () => {
    it("returns array", async () => {
      const { status, body } = await get(baseUrl, "/api/sessions", headers);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });
});
