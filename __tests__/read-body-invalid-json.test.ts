// readBody rejects on unparseable JSON. Handlers that don't catch it must still
// answer a clean 400 { error, code } via the app's error handler, not a 500 (#677).

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const API_KEY = "tb_test_read_body_invalid_json";

describe("invalid JSON request body", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "tb-invalid-json-cache-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  async function makeServer() {
    const { StreamerServer } = await import("../src/server");
    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0);
    return server;
  }

  // Routes whose handler reads the body with no surrounding try/catch.
  it.each(["/api/sessions/resume", "/api/sessions/start", "/api/sessions/abc/raw-key"])(
    "POST %s answers 400 INVALID_BODY",
    async (path) => {
      const server = await makeServer();
      try {
        const res = await fetch(`http://localhost:${server.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
          body: "not json",
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "INVALID_BODY" });
      } finally {
        await server.close();
      }
    },
    30_000,
  );
});
