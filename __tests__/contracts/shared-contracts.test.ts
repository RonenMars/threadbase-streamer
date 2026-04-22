import { join } from "path";
import type { StreamerServer } from "../../src/server";
import { createTestServer, FIXTURES_DIR, get, validateAgainstSchema } from "./test-helpers";

const FIXTURE_DIR = join(FIXTURES_DIR, "contract-projects");

describe("Shared contract tests", () => {
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

  describe("list envelope", () => {
    it("matches shared ConversationListEnvelope schema", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      validateAgainstSchema(body, "shared", "ConversationListEnvelope");
    });

    it("each conversation has shared required fields", async () => {
      const { body } = await get(baseUrl, "/api/conversations?limit=10", headers);
      for (const conv of body.conversations) {
        validateAgainstSchema(conv, "shared", "ConversationListItem");
      }
    });
  });

  describe("server info", () => {
    it("matches shared ServerInfo schema", async () => {
      const { body } = await get(baseUrl, "/api/info", headers);
      validateAgainstSchema(body, "shared", "ServerInfo");
    });
  });

  describe("pagination", () => {
    it("offset and limit produce correct hasMore", async () => {
      const all = await get(baseUrl, "/api/conversations?limit=100", headers);
      const total = all.body.total;

      const page1 = await get(baseUrl, "/api/conversations?limit=1&offset=0", headers);
      expect(page1.body.hasMore).toBe(total > 1);
      expect(page1.body.offset).toBe(0);
      expect(page1.body.conversations.length).toBe(Math.min(1, total));
    });
  });
});
