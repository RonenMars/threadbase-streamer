import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "http";
import { StreamerServer } from "../src/server";

// The rotation assertion below reads the emitted log record rather than console.
// The logger only writes an unstructured console duplicate at an interactive
// terminal now, and the masked key prefixes live in the record's fields, which
// never reached console at all — so capturing console could not actually see
// whether a full key leaked.
const recorded = vi.hoisted(() => [] as Array<{ msg: unknown; fields?: Record<string, unknown> }>);

vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  const tap = (real: import("../src/logger").Logger) => {
    const wrap =
      (level: "debug" | "info" | "warn" | "error") =>
      (msg: string, fields?: Record<string, unknown>, dest?: import("../src/logger").LogDest) => {
        recorded.push({ msg, fields });
        real[level](msg, fields, dest);
      };
    return {
      ...real,
      debug: wrap("debug"),
      info: wrap("info"),
      warn: wrap("warn"),
      error: wrap("error"),
    };
  };
  return { ...actual, getLogger: (component?: string) => tap(actual.getLogger(component)) };
});

// The /api/auth/rotate tests below rotate the API key, which calls setApiKey() →
// writes server.yaml. Redirect that write to a throwaway dir so the suite never
// clobbers the user's live ~/.threadbase/server.yaml (which would desync a
// running prod streamer and 401 every client until restart).
// homedir() is sandboxed suite-wide by __tests__/setup/sandbox-home.ts, so
// TB_TEST_REAL_HOME is the only handle on the developer's actual home — the one
// the guard below has to watch.
//
// Every config file here resolves through the same
// `THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase")` pattern (alertStore,
// runtime-store, server-identity, pty-host/socket), so one escape exposes all of
// them. Guarding only server.yaml is how a stray `ignore` resolution wrote test
// fixture ids into a real cache-alert.json and went unnoticed for weeks.
//
// Runtime state (logs/, cache/, runtime.db*) is deliberately NOT guarded: a prod
// streamer running on the developer's machine rewrites those throughout any test
// run, so watching them would fail on someone else's writes.
const GUARDED_CONFIG_FILES = [
  "server.yaml",
  "cache-alert.json",
  "gate-answers.json",
  "update.yaml",
  "shim.conf",
] as const;

const REAL_CONFIG_DIR = join(process.env.TB_TEST_REAL_HOME || homedir(), ".threadbase");

/**
 * mtime+size per guarded file, `null` when absent.
 *
 * Absence is recorded rather than skipped so a CI runner with no ~/.threadbase
 * asserts the suite did not CREATE one — the old guard read a single mtime and
 * silently checked nothing whenever the file was missing, which is every CI run.
 * Size rides along because two writes inside the same millisecond share an mtime.
 */
function snapshotConfigDir(dir: string): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  for (const name of GUARDED_CONFIG_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      snapshot[name] = null;
      continue;
    }
    const stat = statSync(path);
    snapshot[name] = `${stat.mtimeMs}:${stat.size}`;
  }
  return snapshot;
}

let originalConfigDir: string | undefined;
let realConfigBefore: Record<string, string | null>;

let originalCorsEnv: string | undefined;

beforeAll(() => {
  originalConfigDir = process.env.THREADBASE_CONFIG_DIR;
  process.env.THREADBASE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tb-sec-"));
  // CORS is off by default; the allowlist tests below assert the enabled path.
  originalCorsEnv = process.env.THREADBASE_ALLOW_BROWSER_CORS;
  process.env.THREADBASE_ALLOW_BROWSER_CORS = "true";
  realConfigBefore = snapshotConfigDir(REAL_CONFIG_DIR);
});

afterAll(() => {
  if (originalCorsEnv === undefined) delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
  else process.env.THREADBASE_ALLOW_BROWSER_CORS = originalCorsEnv;
  if (originalConfigDir !== undefined) {
    process.env.THREADBASE_CONFIG_DIR = originalConfigDir;
  } else {
    delete process.env.THREADBASE_CONFIG_DIR;
  }
  // Guard: prove the suite never touched the real config directory.
  expect(snapshotConfigDir(REAL_CONFIG_DIR)).toEqual(realConfigBefore);
});

describe("real config guard", () => {
  // The guard above only fires on a machine where something escapes the sandbox,
  // so the comparison it relies on is exercised here against a temp directory.
  it("notices a created, modified, or deleted config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-guard-"));
    try {
      const empty = snapshotConfigDir(dir);
      expect(empty["server.yaml"]).toBeNull();

      const configPath = join(dir, "server.yaml");
      writeFileSync(configPath, "api_key: tb_first\n");
      const created = snapshotConfigDir(dir);
      expect(created).not.toEqual(empty);

      // Longer content, so the size differs even when both writes land in the
      // same millisecond and share an mtime.
      writeFileSync(configPath, "api_key: tb_second_and_longer\n");
      expect(snapshotConfigDir(dir)).not.toEqual(created);

      rmSync(configPath);
      expect(snapshotConfigDir(dir)).toEqual(empty);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const API_KEY = "tb_sectest_key_0000000000000000";

describe("security hardening", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    server = new StreamerServer({ apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0);
    port = server.port;
    baseUrl = `http://localhost:${port}`;
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
        warnServer = new StreamerServer({ apiKey: API_KEY, localNoAuth: true, verbose: false });
        await warnServer.listen(0);
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
        quietServer = new StreamerServer({ apiKey: API_KEY, localNoAuth: false, verbose: false });
        await quietServer.listen(0);
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
      const noAuthServer = new StreamerServer({
        apiKey: API_KEY,
        localNoAuth: true,
        verbose: false,
      });
      await noAuthServer.listen(0);
      const p = noAuthServer.port;
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
      const cliServer = new StreamerServer({
        apiKey: API_KEY,
        apiKeySource: "cli",
        localNoAuth: false,
        verbose: false,
      });
      await cliServer.listen(0);
      const p = cliServer.port;
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
      const from = recorded.length;
      const res = await fetch(`${baseUrl}/api/auth/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);

      const rotationLog = recorded
        .slice(from)
        .find((e) => typeof e.msg === "string" && e.msg.includes("API key rotated"));
      expect(rotationLog).toBeDefined();
      // The whole record — message and fields — must carry only the masked
      // prefixes. The fields are where a full key would actually leak.
      const serialized = `${rotationLog?.msg} ${JSON.stringify(rotationLog?.fields ?? {})}`;
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).toContain(`${API_KEY.slice(0, 6)}…`);
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
      // node:http, not fetch: fetch is a browser-shaped client and some
      // dispatchers/global stubs attach Origin. Mobile sends none; this is the
      // actual on-the-wire request.
      const url = new URL(`${baseUrl}/api/info`);
      const { status, acao } = await new Promise<{
        status: number;
        acao: string | undefined;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { Authorization: `Bearer ${API_KEY}` },
          },
          (res) => {
            res.resume();
            const raw = res.headers["access-control-allow-origin"];
            resolve({
              status: res.statusCode ?? 0,
              acao: Array.isArray(raw) ? raw[0] : raw,
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(acao).toBeUndefined();
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
