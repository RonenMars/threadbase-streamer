/**
 * Regression: findJsonlPath must resolve JSONLs from the configured
 * scanProfiles roots, not a hardcoded ~/.claude/projects.
 *
 * The degraded-mode resume path (handleResume → findJsonlPath →
 * readCwdFromJsonl) is the one caller that invokes findJsonlPath
 * unconditionally regardless of scanProfiles — the two conversation-detail
 * callers are both short-circuited by an `if (this.scanProfiles) return null`
 * guard, so a profile-scoped server never reaches them. Before the fix,
 * findJsonlPath walked ~/.claude/projects and could never see a JSONL that
 * lived only under a custom profile root, so resume fell back to the scanner's
 * projectPath (or 400'd) instead of the JSONL's authoritative cwd.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 99999,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const API_KEY = "tb_findjsonl_profile_test_key_00000";
const auth = { Authorization: `Bearer ${API_KEY}` };

// A UUID that exists ONLY under the profile fixture, never under ~/.claude.
const PROFILE_UUID = "11112222-3333-4444-5555-666677778888";
// A distinctive cwd recorded in the JSONL. It differs from the encoded project
// dir name, so if resume ever fell back to a scanner/encoded-path derivation
// instead of reading this JSONL, the spawn cwd would not match.
const PROFILE_CWD = "/tmp/threadbase-findjsonl-profile-cwd";

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

describe("findJsonlPath honors scanProfiles (degraded-mode resume)", () => {
  let ptySpawn: ReturnType<typeof vi.fn>;
  let tmpBase: string;
  let configDir: string;
  let emptyHome: string;
  let originalHome: string | undefined;
  let savedScannerDb: string | undefined;

  beforeEach(async () => {
    const nodePty = await import("node-pty");
    ptySpawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
    ptySpawn.mockClear();

    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-findjsonl-profile-"));

    // Fixture profile root: <configDir>/projects/<encoded>/<uuid>.jsonl, with a
    // cwd distinct from the encoded dir name.
    configDir = join(tmpBase, "profile");
    const projectDir = join(configDir, "projects", "-encoded-project-dir");
    mkdirSync(projectDir, { recursive: true });
    const profileJsonl = join(projectDir, `${PROFILE_UUID}.jsonl`);
    writeFileSync(
      profileJsonl,
      `${JSON.stringify({ cwd: PROFILE_CWD, type: "user", message: "hi" })}\n`,
    );
    // Age the JSONL beyond the resume busy-window so the collision probe treats
    // this conversation as idle (resumable), not actively owned — this test
    // exercises cwd resolution, not the busy check.
    const idle = new Date(Date.now() - 30 * 60_000);
    utimesSync(profileJsonl, idle, idle);

    // Point HOME at an EMPTY dir with no projects/ — so the OLD hardcoded
    // ~/.claude/projects would resolve to nothing and findJsonlPath would miss
    // the fixture. Only the profile-scoped fix can find it.
    emptyHome = join(tmpBase, "empty-home");
    mkdirSync(join(emptyHome, ".claude", "projects"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = emptyHome;

    // Force degraded mode: a regular FILE where directories are expected makes
    // every SQLite open fail (ENOTDIR). Same trick as cacheless-degradation.
    const blocker = join(tmpBase, "blocked");
    writeFileSync(blocker, "not a directory");
    savedScannerDb = process.env.TB_SCANNER_DB;
    process.env.TB_SCANNER_DB = join(blocker, "scanner.db");
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (savedScannerDb === undefined) delete process.env.TB_SCANNER_DB;
    else process.env.TB_SCANNER_DB = savedScannerDb;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("resumes with cwd read from the profile JSONL, not ~/.claude/projects", async () => {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "blocked", "cache"),
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(port, { awaitReady: true });

    try {
      const res = await fetch(`http://localhost:${port}/api/sessions/resume`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: PROFILE_UUID }),
      });

      // findJsonlPath found the profile JSONL, readCwdFromJsonl pulled PROFILE_CWD,
      // and handleResume spawned with it. Before the fix, findJsonlPath walked the
      // (empty) ~/.claude/projects, returned null, and resume never spawned here.
      expect(res.status).toBe(201);
      expect(ptySpawn).toHaveBeenCalledTimes(1);
      const spawnOpts = ptySpawn.mock.calls[0][2] as { cwd: string };
      expect(spawnOpts.cwd).toBe(PROFILE_CWD);
    } finally {
      await server.close();
    }
  });
});
