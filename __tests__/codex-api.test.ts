import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamerServer } from "../src/server";

const CODEX_SESSION_ID = "019edbc1-13a7-7fa1-80b4-7eafc270f03e";
const FIXTURE = join(__dirname, "fixtures", "codex-rollout.jsonl");
const API_KEY = "tb_codex_api_test_key_00000000000000";
const auth = { Authorization: `Bearer ${API_KEY}` };

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

function makeCodexRoot(tmpBase: string): string {
  const root = join(tmpBase, "codex-sessions");
  const dateDir = join(root, "2026", "06", "18");
  mkdirSync(dateDir, { recursive: true });
  copyFileSync(FIXTURE, join(dateDir, `rollout-2026-06-18T20-22-04-${CODEX_SESSION_ID}.jsonl`));
  return root;
}

describe("codex conversations — HTTP API", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let tmpBase: string;

  beforeEach(async () => {
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-codex-api-test-"));
    // Isolate the scanner's SQLite index to an empty temp DB so the warmup scan
    // only sees the codexRoots fixture file instead of the 5000+ real conversations
    // in ~/.config/threadbase-scanner/index.db.
    process.env.TB_SCANNER_DB = join(tmpBase, "scanner.db");
    const codexRoot = makeCodexRoot(tmpBase);

    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "cache"),
      scanProfiles: [], // empty → no threadbase scan, only codexRoots
      codexRoots: [codexRoot],
    });
    await server.listen(port, { awaitReady: true });
  });

  afterEach(async () => {
    await server.close();
    delete process.env.TB_SCANNER_DB;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe("GET /api/conversations", () => {
    it("returns codex conversation with provider=codex-cli", async () => {
      const res = await fetch(`${baseUrl}/api/conversations?limit=50&offset=0`, {
        headers: auth,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const codex = body.conversations.find((c: any) => c.id.includes(CODEX_SESSION_ID));
      expect(codex).toBeDefined();
      expect(codex.provider).toBe("codex-cli");
    });
  });

  describe("GET /api/conversations/:id", () => {
    it("returns provider=codex-cli and resumable based on project-path availability", async () => {
      // Codex resume is implemented (Task 4) — resumability now depends on
      // the same on-disk availability check as claude-code, not a
      // provider-forced false. This fixture's cwd is a real path on the dev
      // machine that may or may not exist in other environments, so assert
      // against the same classifyResumability-shaped outcome rather than a
      // hardcoded value.
      const res = await fetch(`${baseUrl}/api/conversations/${CODEX_SESSION_ID}?msg_limit=10`, {
        headers: auth,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.meta.provider).toBe("codex-cli");
      expect(typeof body.meta.resumable).toBe("boolean");
      if (!body.meta.resumable) {
        expect(["path_missing", "worktree_removed"]).toContain(body.meta.unavailable_reason);
      }
    });

    it("still serves messages for codex conversations", async () => {
      const res = await fetch(`${baseUrl}/api/conversations/${CODEX_SESSION_ID}?msg_limit=50`, {
        headers: auth,
      });
      const body = (await res.json()) as any;
      expect(body.messages.length).toBeGreaterThan(0);
    });
  });
});
