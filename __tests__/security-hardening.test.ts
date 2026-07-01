import { existsSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "http";
import { StreamerServer } from "../src/server";

// The /api/auth/rotate tests below rotate the API key, which calls setApiKey() →
// writes server.yaml. Redirect that write to a throwaway dir so the suite never
// clobbers the user's live ~/.threadbase/server.yaml (which would desync a
// running prod streamer and 401 every client until restart).
const REAL_CONFIG = join(homedir(), ".threadbase", "server.yaml");
let originalConfigDir: string | undefined;
let realConfigMtimeBefore: number | undefined;

beforeAll(() => {
  originalConfigDir = process.env.THREADBASE_CONFIG_DIR;
  process.env.THREADBASE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tb-sec-"));
  realConfigMtimeBefore = existsSync(REAL_CONFIG) ? statSync(REAL_CONFIG).mtimeMs : undefined;
});

afterAll(() => {
  if (originalConfigDir !== undefined) {
    process.env.THREADBASE_CONFIG_DIR = originalConfigDir;
  } else {
    delete process.env.THREADBASE_CONFIG_DIR;
  }
  // Guard: prove the suite never touched the real config.
  if (realConfigMtimeBefore !== undefined) {
    expect(statSync(REAL_CONFIG).mtimeMs).toBe(realConfigMtimeBefore);
  }
});

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

const API_KEY = "tb_sectest_key_0000000000000000";

describe("security hardening", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({ apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
  });

  // ── H1: localNoAuth startup warning ────────────────────────────────────────

  describe("localNoAuth startup warning", () => {
    it("emits a warning to stderr when localNoAuth is true", async () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.join(" "));
      let warnServer: StreamerServer | undefined;
      try {
        const p = await getRandomPort();
        warnServer = new StreamerServer({ apiKey: API_KEY, localNoAuth: true, verbose: false });
        await warnServer.listen(p);
      } finally {
        console.warn = orig;
        await warnServer?.close();
      }
      expect(warns.some((w) => w.includes("localNoAuth is ENABLED"))).toBe(true);
    });

    it("emits no warning when localNoAuth is false", async () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.join(" "));
      let quietServer: StreamerServer | undefined;
      try {
        const p = await getRandomPort();
        quietServer = new StreamerServer({ apiKey: API_KEY, localNoAuth: false, verbose: false });
        await quietServer.listen(p);
      } finally {
        console.warn = orig;
        await quietServer?.close();
      }
      expect(warns.some((w) => w.includes("localNoAuth"))).toBe(false);
    });
  });

  // ── H2: POST /api/auth/rotate ───────────────────────────────────────────────

  describe("POST /api/auth/rotate", () => {
    it("requires authentication", async () => {
      const res = await fetch(`${baseUrl}/api/auth/rotate`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns a new key with the tb_ prefix", async () => {
      const res = await fetch(`${baseUrl}/api/auth/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { apiKey: string };
      expect(body.apiKey).toMatch(/^tb_[a-f0-9]{32}$/);
      expect(body.apiKey).not.toBe(API_KEY);
    });

    it("old key is rejected after rotation", async () => {
      const rotateRes = await fetch(`${baseUrl}/api/auth/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(rotateRes.status).toBe(200);

      const infoRes = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(infoRes.status).toBe(401);
    });

    it("new key is accepted after rotation", async () => {
      const rotateRes = await fetch(`${baseUrl}/api/auth/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const { apiKey: newKey } = (await rotateRes.json()) as { apiKey: string };

      const infoRes = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${newKey}` },
      });
      expect(infoRes.status).toBe(200);
    });

    it("returns 403 when localNoAuth is active", async () => {
      const p = await getRandomPort();
      const noAuthServer = new StreamerServer({
        apiKey: API_KEY,
        localNoAuth: true,
        verbose: false,
      });
      await noAuthServer.listen(p);
      try {
        const res = await fetch(`http://localhost:${p}/api/auth/rotate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        expect(res.status).toBe(403);
      } finally {
        await noAuthServer.close();
      }
    });

    it("returns persisted=true and no warning when key came from server.yaml", async () => {
      const res = await fetch(`${baseUrl}/api/auth/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = (await res.json()) as { persisted: boolean; warning?: string };
      expect(body.persisted).toBe(true);
      expect(body.warning).toBeUndefined();
    });

    it("returns persisted=false and a warning when key came from --api-key CLI flag", async () => {
      const p = await getRandomPort();
      const cliServer = new StreamerServer({
        apiKey: API_KEY,
        apiKeySource: "cli",
        localNoAuth: false,
        verbose: false,
      });
      await cliServer.listen(p);
      try {
        const res = await fetch(`http://localhost:${p}/api/auth/rotate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { persisted: boolean; warning?: string };
        expect(body.persisted).toBe(false);
        expect(body.warning).toMatch(/--api-key/);
      } finally {
        await cliServer.close();
      }
    });

    it("logs the rotation event with masked key prefixes, not full keys", async () => {
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        const res = await fetch(`${baseUrl}/api/auth/rotate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
        expect(res.status).toBe(200);
      } finally {
        console.log = orig;
      }
      const rotationLog = logs.find((l) => l.includes("API key rotated"));
      expect(rotationLog).toBeDefined();
      expect(rotationLog).not.toContain(API_KEY);
    });
  });

  // ── M2: CORS origin allowlist ───────────────────────────────────────────────

  describe("CORS origin allowlist", () => {
    it("sets ACAO for an allowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Origin: "http://localhost:8081",
        },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
      expect(res.headers.get("vary")).toContain("Origin");
    });

    it("omits ACAO for a disallowed origin", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Origin: "https://attacker.example.com",
        },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("omits ACAO when no Origin header is present (mobile requests)", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      // Mobile clients send no Origin — must still get a 200, just no CORS headers
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("OPTIONS from allowed origin returns 204", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:19006" },
      });
      expect(res.status).toBe(204);
    });

    it("OPTIONS from disallowed origin returns 403", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        method: "OPTIONS",
        headers: { Origin: "https://attacker.example.com" },
      });
      expect(res.status).toBe(403);
    });
  });

  // ── M3: Rate limiting ───────────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("POST /api/sessions/start returns 429 after 10 requests per minute", async () => {
      const statuses: number[] = [];
      // 12 requests — first 10 should pass (or fail for other reasons), 11th+ should 429
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${baseUrl}/api/sessions/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: "/nonexistent" }),
        });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });
  });
});
