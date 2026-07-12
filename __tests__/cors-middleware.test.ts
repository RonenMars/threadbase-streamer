import { mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAllowedOrigins } from "../src/api/middleware/cors.middleware";
import { StreamerServer } from "../src/server";

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
      const res = await fetch(`http://localhost:${port}/api/info`, {
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
      const res = await fetch(`http://localhost:${port}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}`, Origin: "http://localhost:8081" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    } finally {
      await server.close();
    }
  });
});
