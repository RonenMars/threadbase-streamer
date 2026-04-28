import { createServer } from "http";
import { join } from "path";
import { StreamerServer } from "../src/server";

const FIXTURE_PROFILES = [
  {
    id: "test",
    label: "Test",
    configDir: join(__dirname, "../vendor/scanner/__fixtures__/contract-projects"),
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

  beforeEach(async () => {
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
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
    it("returns empty session list initially", async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns 404 for nonexistent session", async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(404);
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

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`${baseUrl}/api/nonexistent`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(404);
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
});
