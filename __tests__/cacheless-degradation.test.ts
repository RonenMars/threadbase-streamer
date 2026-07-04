import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_cacheless_test_key_000000000000000";
const auth = { Authorization: `Bearer ${API_KEY}` };

const FIXTURE_PROFILES = [
  {
    id: "test",
    label: "Test",
    configDir: join(__dirname, "./fixtures/contract-projects"),
    enabled: true,
    emoji: "🧪",
  },
];

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

// Regression for the 2026-07-03 incident: with better-sqlite3 unusable (node
// ABI mismatch), ConversationCache.open threw (caught, "running without
// cache") but the scanner's own SQLite index kept throwing on every request —
// GET /api/conversations/:id returned 500 in ~2ms forever and the app showed
// "Couldn't load conversation". SQLite being unavailable must degrade to
// serving straight from the JSONLs on disk.
describe("conversation API without SQLite (degraded mode)", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let tmpBase: string;
  let savedScannerDb: string | undefined;

  beforeEach(async () => {
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-cacheless-test-"));

    // A regular FILE where directories are expected: every SQLite open under
    // it fails (ENOTDIR), simulating an unusable better-sqlite3 / cache path.
    const blocker = join(tmpBase, "blocked");
    writeFileSync(blocker, "not a directory");
    savedScannerDb = process.env.TB_SCANNER_DB;
    process.env.TB_SCANNER_DB = join(blocker, "scanner.db");

    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(blocker, "cache"),
      scanProfiles: FIXTURE_PROFILES,
    });
    await server.listen(port, { awaitReady: true });
  });

  afterEach(async () => {
    await server.close();
    if (savedScannerDb === undefined) delete process.env.TB_SCANNER_DB;
    else process.env.TB_SCANNER_DB = savedScannerDb;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("lists conversations from disk", async () => {
    const res = await fetch(`${baseUrl}/api/conversations?limit=50&offset=0`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations.length).toBeGreaterThan(0);
  });

  it("serves conversation detail from disk instead of 500ing", async () => {
    const list = await fetch(`${baseUrl}/api/conversations?limit=50&offset=0`, { headers: auth });
    const { conversations } = (await list.json()) as { conversations: Array<{ id: string }> };
    expect(conversations.length).toBeGreaterThan(0);

    for (const conv of conversations) {
      const res = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent(conv.id)}?msg_limit=80`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: unknown[] };
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBeGreaterThan(0);
    }
  });
});
