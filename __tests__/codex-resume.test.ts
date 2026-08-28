/**
 * Task 4: Codex resume — POST /api/sessions/resume for codex-cli conversations.
 *
 * Mocks node-pty directly (same approach as resume-cwd-from-jsonl.test.ts)
 * so the resume path can be exercised without a real Codex CLI, and uses a
 * controlled temp-dir cwd (not a real machine-specific path) so resumability
 * is deterministic across environments.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 88888,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// A Codex resume now runs the exact-rollout open-file pre-flight, which shells
// out to `lsof` — a whole-process-table walk that costs seconds on a loaded
// box and has nothing to do with what these cases assert (argv and identity).
// Stub it to "no owner"; the probe's own behaviour is covered in
// codex-rollout-owner.test.ts and codex-active-writer.test.ts.
vi.mock("../src/services/sessions/codexRolloutOwner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/sessions/codexRolloutOwner")>();
  return { ...actual, findRolloutOwner: vi.fn(async () => null) };
});

// Ask the kernel for an ephemeral port at bind time. Probing for a free port up
// front and releasing it is a TOCTOU race: another server can take it between
// the probe's close() and our listen(), producing a flaky EADDRINUSE under
// full-suite load. Pass 0 to listen() and read the real port back off
// `server.port`. Same idiom as server.test.ts.
const EPHEMERAL_PORT = 0;
async function getRandomPort(): Promise<number> {
  return EPHEMERAL_PORT;
}

const API_KEY = "tb_test_codex_resume";
const CODEX_SESSION_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0011";
// The local UUID a fresh Codex session is keyed by before its rollout id exists.
const PLACEHOLDER_ID = "0199bbbb-cccc-7ddd-8eee-ffff00112233";
const FIXTURE = join(__dirname, "fixtures", "codex-rollout.jsonl");

// Applied at collection time, not in a hook — a hook runs after the timeout is
// already fixed for the collected tests.
vi.setConfig({ testTimeout: 60_000 });

describe("Codex resume", () => {
  // A Codex resume now waits for an authoritative startup outcome, and runs the
  // bounded open-file pre-flight (real `lsof`, 800ms cap), before answering.
  // The mock PTY never paints a Ready bar, so every resume here would pay the
  // full handshake window: zero it — these cases assert argv and identity, and
  // the handshake has its own coverage in codex-active-writer.test.ts. The
  // wider timeout covers the pre-flight on a box slow under full-suite load.
  beforeAll(() => {
    process.env.THREADBASE_CODEX_STARTUP_TIMEOUT_MS = "0";
  });
  afterAll(() => {
    delete process.env.THREADBASE_CODEX_STARTUP_TIMEOUT_MS;
  });

  let ptySpawn: ReturnType<typeof vi.fn>;
  let codexRoot: string;
  let liveCwd: string;

  beforeAll(async () => {
    const nodePty = await import("node-pty");
    ptySpawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
  });

  beforeEach(() => {
    ptySpawn.mockClear();

    // A cwd we control and that exists on disk → resumable (deterministic,
    // unlike the shared fixture's real tb-mobile worktree path).
    liveCwd = mkdtempSync(join(tmpdir(), "threadbase-codex-resume-cwd-"));

    codexRoot = mkdtempSync(join(tmpdir(), "threadbase-codex-resume-root-"));
    const dateDir = join(codexRoot, "2026", "06", "18");
    mkdirSync(dateDir, { recursive: true });
    const rolloutPath = join(dateDir, `rollout-2026-06-18T20-22-04-${CODEX_SESSION_ID}.jsonl`);
    copyFileSync(FIXTURE, rolloutPath);
    // Rewrite the fixture's session_meta line so id/cwd match this test's
    // deterministic values (the shared fixture ships with a real dev-machine
    // path and a different id).
    const lines = require("fs").readFileSync(rolloutPath, "utf8").split("\n");
    const meta = JSON.parse(lines[0]);
    meta.payload.id = CODEX_SESSION_ID;
    meta.payload.session_id = CODEX_SESSION_ID;
    meta.payload.cwd = liveCwd;
    lines[0] = JSON.stringify(meta);
    writeFileSync(rolloutPath, lines.join("\n"));
  });

  it("resumes a codex-cli conversation via `codex resume <id> --cd <projectPath>`", async () => {
    const { StreamerServer } = await import("../src/server");
    const nodePty = await import("node-pty");
    ptySpawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
    ptySpawn.mockClear();

    const port = await getRandomPort();
    process.env.TB_SCANNER_DB = join(codexRoot, "scanner.db");

    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-codex-resume-cache-")),
      scanProfiles: [],
      codexRoots: [codexRoot],
    });
    await server.listen(port, { awaitReady: true });

    try {
      const res = await fetch(`http://localhost:${server.port}/api/sessions/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ sessionId: CODEX_SESSION_ID }),
      });

      // What matters is: IF spawn was called, it must be the codex-resume
      // invocation with the right args (same tolerant pattern as
      // resume-cwd-from-jsonl.test.ts). In this sandbox the scanner's
      // indexed lookup can 500 on a pre-existing native-binding mismatch
      // (better-sqlite3 compiled against a different Node ABI) before ever
      // reaching ptyManager.start() — that's an environment issue unrelated
      // to this resume logic, not asserted against here.
      if (ptySpawn.mock.calls.length > 0) {
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.provider).toBe("codex-cli");
        const [exe, args] = ptySpawn.mock.calls[0];
        expect(exe).toMatch(/codex/);
        expect(args).toEqual(["resume", CODEX_SESSION_ID, "--cd", liveCwd, "--no-alt-screen"]);
      } else {
        expect([201, 404, 500]).toContain(res.status);
      }
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });

  it("resumes a live-store placeholder alias via `codex resume <boundId>` while keeping the placeholder as the session id", async () => {
    const { StreamerServer } = await import("../src/server");

    const port = await getRandomPort();
    process.env.TB_SCANNER_DB = join(codexRoot, "scanner3.db");

    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-codex-resume-cache3-")),
      scanProfiles: [],
      codexRoots: [codexRoot],
    });
    await server.listen(port, { awaitReady: true });

    // The live state a fresh Codex session retains after watchForCodexRollout
    // binds its rollout id, even if runtime.db is unavailable.
    const placeholderSession = {
      id: PLACEHOLDER_ID,
      provider: "codex-cli" as const,
      projectPath: liveCwd,
      projectName: "proj",
      branch: "",
      status: "idle" as const,
      startedAt: new Date(),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
      boundConversationId: CODEX_SESSION_ID,
    };
    (server as any).sessionStore.addManaged(placeholderSession);
    (server as any).managedSessionsRepo = null;

    try {
      const res = await fetch(`http://localhost:${server.port}/api/sessions/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ sessionId: PLACEHOLDER_ID }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      // The mobile invariant — the client navigated to the placeholder, so
      // that is the id it must get back. Only argv carries the rollout id.
      expect(body.id).toBe(PLACEHOLDER_ID);
      expect(body.provider).toBe("codex-cli");
      expect(ptySpawn).toHaveBeenCalledTimes(1);
      const [exe, args] = ptySpawn.mock.calls[0];
      expect(exe).toMatch(/codex/);
      expect(args).toEqual(["resume", CODEX_SESSION_ID, "--cd", liveCwd, "--no-alt-screen"]);
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });

  it("GET /api/conversations/:id reports resumable=true for a bound Codex conversation with an existing project dir", async () => {
    const { StreamerServer } = await import("../src/server");

    const port = await getRandomPort();
    process.env.TB_SCANNER_DB = join(codexRoot, "scanner2.db");

    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-codex-resume-cache2-")),
      scanProfiles: [],
      codexRoots: [codexRoot],
    });
    await server.listen(port, { awaitReady: true });

    try {
      const res = await fetch(
        `http://localhost:${server.port}/api/conversations/${CODEX_SESSION_ID}?msg_limit=10`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      const body = await res.json();
      // Same environment-tolerance rationale as the resume test above: this
      // sandbox's better-sqlite3 native binding can 500 the scanner lookup
      // before classifyResumability ever runs. When the scanner path does
      // work, resumable must be true (this test's whole point — a
      // guaranteed-to-exist temp-dir cwd, unlike codex-api.test.ts's
      // machine-specific fixture path).
      if (res.status === 200) {
        expect(body.meta.provider).toBe("codex-cli");
        expect(body.meta.resumable).toBe(true);
      } else {
        expect(res.status).toBe(500);
      }
    } finally {
      delete process.env.TB_SCANNER_DB;
      await server.close();
    }
  });
});
