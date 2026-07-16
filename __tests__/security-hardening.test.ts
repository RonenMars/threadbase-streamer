import { existsSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "http";
import WebSocket from "ws";
import { LiveSessionManager } from "../src/live-session-manager";
import { StreamerServer } from "../src/server";

// The /api/auth/rotate tests below rotate the API key, which calls setApiKey() →
// writes server.yaml. Redirect that write to a throwaway dir so the suite never
// clobbers the user's live ~/.threadbase/server.yaml (which would desync a
// running prod streamer and 401 every client until restart).
const REAL_CONFIG = join(homedir(), ".threadbase", "server.yaml");
let originalConfigDir: string | undefined;
let realConfigMtimeBefore: number | undefined;

let originalCorsEnv: string | undefined;

beforeAll(() => {
  originalConfigDir = process.env.THREADBASE_CONFIG_DIR;
  process.env.THREADBASE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tb-sec-"));
  // CORS is off by default; the allowlist tests below assert the enabled path.
  originalCorsEnv = process.env.THREADBASE_ALLOW_BROWSER_CORS;
  process.env.THREADBASE_ALLOW_BROWSER_CORS = "true";
  realConfigMtimeBefore = existsSync(REAL_CONFIG) ? statSync(REAL_CONFIG).mtimeMs : undefined;
});

afterAll(() => {
  if (originalCorsEnv === undefined) delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
  else process.env.THREADBASE_ALLOW_BROWSER_CORS = originalCorsEnv;
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
  // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L17

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
  // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L26

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
  // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L51

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
  // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L58

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

  // ── L1: hold_session ownership ────────────────────────────────────────────
  // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L85

  describe("hold_session ownership", () => {
    const FAKE_SESSION = "l1-fake-session-id";

    function openWs(): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    }
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("lets the subscribing client hold its own session (putOnHold is called)", async () => {
      // Pretend the fake id is a live PTY so the grace timer reaches putOnHold.
      vi.spyOn(LiveSessionManager.prototype, "hasSession").mockReturnValue(true);
      vi.spyOn(LiveSessionManager.prototype, "getOutputLines").mockResolvedValue([]);
      const putOnHold = vi
        .spyOn(LiveSessionManager.prototype, "putOnHold")
        .mockImplementation(() => {});

      const ws = await openWs();
      ws.send(JSON.stringify({ type: "subscribe_session", sessionId: FAKE_SESSION }));
      await delay(50);
      ws.send(JSON.stringify({ type: "hold_session", sessionId: FAKE_SESSION }));
      await delay(150);

      expect(putOnHold).toHaveBeenCalledWith(FAKE_SESSION);
      ws.close();
    });

    it("ignores hold_session from a client that never subscribed (putOnHold NOT called)", async () => {
      vi.spyOn(LiveSessionManager.prototype, "hasSession").mockReturnValue(true);
      const putOnHold = vi
        .spyOn(LiveSessionManager.prototype, "putOnHold")
        .mockImplementation(() => {});

      const ws = await openWs();
      // No subscribe_session — this client does not own FAKE_SESSION.
      ws.send(JSON.stringify({ type: "hold_session", sessionId: FAKE_SESSION }));
      await delay(150);

      expect(putOnHold).not.toHaveBeenCalled();
      ws.close();
    });
  });

  // ── M1: WebSocket auth (?key= backward compat + first-message handshake) ────
  // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L40

  describe("WebSocket authentication", () => {
    function connectWs(url: string) {
      const ws = new WebSocket(url);
      const messages: Array<Record<string, unknown>> = [];
      let closeCode: number | undefined;
      ws.on("message", (d) => {
        try {
          messages.push(JSON.parse(d.toString()));
        } catch {
          /* ignore non-JSON */
        }
      });
      ws.on("close", (code: number) => {
        closeCode = code;
      });
      return { ws, messages, getCloseCode: () => closeCode };
    }

    async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return pred();
    }

    it("authenticates a WebSocket via ?key= (backward compat)", async () => {
      const c = connectWs(`ws://localhost:${port}/ws?key=${API_KEY}`);
      await new Promise<void>((r) => c.ws.on("open", () => r()));
      const gotList = await waitFor(() => c.messages.some((m) => m.type === "session_list"));
      expect(gotList).toBe(true);
      c.ws.close();
    });

    it("authenticates a keyless WebSocket via a first-message auth handshake", async () => {
      const c = connectWs(`ws://localhost:${port}/ws`);
      await new Promise<void>((r) => c.ws.on("open", () => r()));
      c.ws.send(JSON.stringify({ type: "auth", token: API_KEY }));
      const gotList = await waitFor(() => c.messages.some((m) => m.type === "session_list"));
      expect(gotList).toBe(true);
      c.ws.close();
    });

    it("closes a keyless WebSocket that sends an invalid auth token", async () => {
      const c = connectWs(`ws://localhost:${port}/ws`);
      await new Promise<void>((r) => c.ws.on("open", () => r()));
      c.ws.send(JSON.stringify({ type: "auth", token: "tb_wrong_key_00000000000000000000" }));
      const closed = await waitFor(() => c.getCloseCode() !== undefined);
      expect(closed).toBe(true);
      expect(c.getCloseCode()).toBe(4401);
      expect(c.messages.some((m) => m.type === "session_list")).toBe(false);
    });

    it("closes a keyless WebSocket that never authenticates within the timeout", async () => {
      // Dedicated fast-booting server with a short auth window so the test
      // doesn't wait the full 5s default.
      const p = await getRandomPort();
      const shortServer = new StreamerServer({
        apiKey: API_KEY,
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir: mkdtempSync(join(tmpdir(), "tb-sec-ws-")),
        scanProfiles: [],
        wsAuthTimeoutMs: 300,
      });
      await shortServer.listen(p);
      try {
        const c = connectWs(`ws://localhost:${p}/ws`);
        await new Promise<void>((r) => c.ws.on("open", () => r()));
        const closed = await waitFor(() => c.getCloseCode() !== undefined, 3000);
        expect(closed).toBe(true);
        expect(c.getCloseCode()).toBe(4401);
        expect(c.messages.some((m) => m.type === "session_list")).toBe(false);
      } finally {
        await shortServer.close();
      }
    }, 30000);
  });
});
