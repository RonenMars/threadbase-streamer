import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { resolveAllowedOrigins } from "../src/api/middleware/cors.middleware";
import { StreamerServer } from "../src/server";

// Ask the kernel for an ephemeral port at bind time. Probing for a free port up
// front and releasing it is a TOCTOU race: another server can take it between
// the probe's close() and our listen(), producing a flaky EADDRINUSE under
// full-suite load. Pass 0 to listen() and read the real port back off
// `server.port`. Same idiom as server.test.ts.
const EPHEMERAL_PORT = 0;
async function getRandomPort(): Promise<number> {
  return EPHEMERAL_PORT;
}

describe("resolveAllowedOrigins", () => {
  it("returns null (CORS off) when unset or falsy", () => {
    for (const v of [undefined, "", "  ", "0", "false", "no", "off", "FALSE"]) {
      expect(resolveAllowedOrigins(v)).toBeNull();
    }
  });

  it("enables the localhost dev defaults for on/off tokens", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      const origins = resolveAllowedOrigins(v);
      expect(origins?.has("http://localhost:8081")).toBe(true);
      expect(origins?.has("https://app.example.com")).toBe(false);
    }
  });

  it("adds explicit origins on top of the dev defaults", () => {
    const origins = resolveAllowedOrigins("https://app.example.com, https://admin.example.com");
    expect(origins?.has("http://localhost:8081")).toBe(true);
    expect(origins?.has("https://app.example.com")).toBe(true);
    expect(origins?.has("https://admin.example.com")).toBe(true);
  });
});

describe("browser_cors in server.yaml", () => {
  const API_KEY = "tb_yaml_cors_test_key_00000000";
  let originalConfigDir: string | undefined;
  let originalCorsEnv: string | undefined;
  let configDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.THREADBASE_CONFIG_DIR;
    originalCorsEnv = process.env.THREADBASE_ALLOW_BROWSER_CORS;
    delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
    configDir = mkdtempSync(join(tmpdir(), "tb-yaml-cors-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = originalConfigDir;
    if (originalCorsEnv === undefined) delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
    else process.env.THREADBASE_ALLOW_BROWSER_CORS = originalCorsEnv;
  });

  it("survives a redeploy: a browser_cors: yaml value enables CORS with no env var set", async () => {
    writeFileSync(join(configDir, "server.yaml"), `api_key: ${API_KEY}\nbrowser_cors: true\n`);
    const port = await getRandomPort();
    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-yaml-cors-cache-")),
      scanProfiles: [],
    });
    await server.listen(port);
    try {
      const res = await fetch(`http://localhost:${server.port}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}`, Origin: "http://localhost:8081" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    } finally {
      await server.close();
    }
  });

  it("THREADBASE_ALLOW_BROWSER_CORS overrides a browser_cors: yaml value", async () => {
    writeFileSync(join(configDir, "server.yaml"), `api_key: ${API_KEY}\nbrowser_cors: false\n`);
    process.env.THREADBASE_ALLOW_BROWSER_CORS = "true";
    const port = await getRandomPort();
    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-yaml-cors-cache-")),
      scanProfiles: [],
    });
    await server.listen(port);
    try {
      const res = await fetch(`http://localhost:${server.port}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}`, Origin: "http://localhost:8081" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    } finally {
      await server.close();
    }
  });
});

describe("browser clients (Expo web)", () => {
  const API_KEY = "tb_browser_cors_test_key_000000";
  const ORIGIN = "https://app.example.com";
  let originalCorsEnv: string | undefined;
  let server: StreamerServer;
  let ws: WebSocket | undefined;

  beforeEach(async () => {
    originalCorsEnv = process.env.THREADBASE_ALLOW_BROWSER_CORS;
    process.env.THREADBASE_ALLOW_BROWSER_CORS = ORIGIN;
    server = new StreamerServer({
      port: EPHEMERAL_PORT,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-browser-cors-cache-")),
      scanProfiles: [],
    });
    await server.listen(EPHEMERAL_PORT);
  });

  afterEach(async () => {
    ws?.terminate();
    ws = undefined;
    await server.close();
    if (originalCorsEnv === undefined) delete process.env.THREADBASE_ALLOW_BROWSER_CORS;
    else process.env.THREADBASE_ALLOW_BROWSER_CORS = originalCorsEnv;
  });

  // tb-mobile sends X-Client-Id on every REST call. A preflight that omits it
  // makes the browser cancel the request as "Failed to fetch".
  it("allows the X-Client-Id request header in a preflight", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/conversations`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type,x-client-id",
      },
    });
    expect(res.status).toBe(204);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("x-client-id");
  });

  // A sealed REST request sends the envelope headers instead of Authorization,
  // and the client refuses a response whose marker or bodiless record it cannot
  // read. Literal names: they are the wire contract tb-mobile sends.
  it("allows the sealed REST headers and methods, and exposes the sealed response headers", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "QUERY"]) {
      const res = await fetch(`http://localhost:${server.port}/api/conversations`, {
        method: "OPTIONS",
        headers: {
          Origin: ORIGIN,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers":
            "content-type,if-none-match,x-client-id,x-tb-ctx,x-tb-e2ee,x-tb-env,x-tb-seq",
        },
      });
      expect(res.status).toBe(204);
      const methods = (res.headers.get("access-control-allow-methods") ?? "").split(/,\s*/);
      expect(methods).toContain(method);
      const allowed = (res.headers.get("access-control-allow-headers") ?? "")
        .toLowerCase()
        .split(/,\s*/);
      for (const h of ["x-tb-e2ee", "x-tb-ctx", "x-tb-seq", "x-tb-env", "x-client-id"]) {
        expect(allowed).toContain(h);
      }
      const exposed = (res.headers.get("access-control-expose-headers") ?? "")
        .toLowerCase()
        .split(/,\s*/);
      expect(exposed).toEqual(expect.arrayContaining(["x-tb-e2ee", "x-tb-env", "etag"]));
    }
  });

  // Browsers always send Origin on a WebSocket upgrade. @hono/node-ws runs the
  // upgrade through the app with no Node response object, so the CORS branch for
  // an allowed origin must not assume one exists.
  it("upgrades a WebSocket that carries an allowed Origin", async () => {
    const socket = new WebSocket(`ws://localhost:${server.port}/ws?key=${API_KEY}`, {
      origin: ORIGIN,
    });
    ws = socket;
    const outcome = await new Promise<string>((resolve) => {
      socket.on("open", () => resolve("open"));
      socket.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
      socket.on("error", (err) => resolve(`error ${err.message}`));
    });
    expect(outcome).toBe("open");
  });
});
