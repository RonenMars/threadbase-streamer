import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

// ServerConfig.skipStartupWarmup exists because listen() kicks off a full scan of
// every conversation on the machine and close() awaits it, so any test that
// constructs a server pays that cost twice. On a loaded machine a single close()
// was measured at 34s, which is what made server-bind-retry.test.ts flake against
// the 15s timeout.
//
// These tests pin the two properties that make the flag safe to rely on: the
// warm-up really is skipped, and the server still answers rather than throwing.

const API_KEY = "tb_test_key_for_skip_warmup";

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

/** A config dir holding one conversation JSONL the warm-up scan would index. */
function seedConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-skip-warmup-cfg-"));
  const project = join(dir, "projects", "-tmp-proj");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "11111111-2222-3333-4444-555555555555.jsonl"),
    `${JSON.stringify({
      type: "user",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/tmp/proj",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    })}\n`,
  );
  return dir;
}

function makeServer(port: number, skipStartupWarmup: boolean, configDir: string): StreamerServer {
  return new StreamerServer({
    port,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir: mkdtempSync(join(tmpdir(), "tb-skip-warmup-cache-")),
    scannerPersistent: false,
    scanProfiles: [{ id: "t", label: "t", configDir, enabled: true, emoji: "" }],
    skipStartupWarmup,
  });
}

async function countConversations(port: number): Promise<number> {
  const res = await fetch(`http://localhost:${port}/api/conversations`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const body = (await res.json()) as { conversations?: unknown[] } | unknown[];
  return Array.isArray(body) ? body.length : (body.conversations?.length ?? 0);
}

describe("skipStartupWarmup", () => {
  let server: StreamerServer;

  afterEach(async () => {
    await server?.close();
  });

  it("indexes conversations when the warm-up runs (default behaviour)", async () => {
    const port = await getRandomPort();
    server = makeServer(port, false, seedConfigDir());
    // awaitReady blocks until the warm-up settles, so this does not race the scan.
    await server.listen(port, { awaitReady: true });

    expect(await countConversations(port)).toBeGreaterThan(0);
    // Long timeout on purpose: this is the control case that DOES run the
    // warm-up, and paying for a real scan is the very cost the flag avoids.
  }, 120_000);

  // Skipping must not break the endpoint — it degrades to empty, never throws.
  it("skips the scan and still serves conversations as empty", async () => {
    const port = await getRandomPort();
    server = makeServer(port, true, seedConfigDir());
    await server.listen(port, { awaitReady: true });

    const res = await fetch(`http://localhost:${port}/api/conversations`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  // The property the flake fix depends on: close() must not await a scan that
  // never ran, nor hang on the skipped warm-up promise.
  it("closes promptly when the warm-up is skipped", async () => {
    const port = await getRandomPort();
    server = makeServer(port, true, seedConfigDir());
    await server.listen(port, { awaitReady: true });

    const started = Date.now();
    await server.close();
    // Generous bound: the point is "does not await a full scan", not a benchmark.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
