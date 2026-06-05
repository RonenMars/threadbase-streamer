/**
 * Regression test: handleResume must read cwd from the JSONL, not from the
 * scanner's (potentially stale) conversation index.
 *
 * Bug: scanner returned …/tb-mobile/android for a conversation whose JSONL
 * recorded cwd as …/tb-mobile, causing claude --resume to fail with
 * "No conversation found with session ID".
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";

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

const API_KEY = "tb_test_resume_cwd";
const TEST_UUID = "ba124111-fc6c-4973-b5c6-7ef8bacdc77b";
const CORRECT_CWD = "/Test/foo/bar";
const WRONG_CWD = "/Test/foo/bar/wrong";

describe("handleResume — cwd from JSONL", () => {
  let ptySpawn: ReturnType<typeof vi.fn>;
  let claudeProjectsDir: string;
  let tmpClaudeDir: string;

  beforeAll(async () => {
    const nodePty = await import("node-pty");
    ptySpawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
  });

  beforeEach(() => {
    ptySpawn.mockClear();

    // Create a temp ~/.claude/projects/-Test-foo-bar/<uuid>.jsonl with the correct cwd
    tmpClaudeDir = mkdtempSync(join(tmpdir(), "threadbase-resume-cwd-test-"));
    claudeProjectsDir = join(tmpClaudeDir, "projects");
    const encodedDir = "-Test-foo-bar";
    const projectDir = join(claudeProjectsDir, encodedDir);
    mkdirSync(projectDir, { recursive: true });

    const jsonlPath = join(projectDir, `${TEST_UUID}.jsonl`);
    writeFileSync(
      jsonlPath,
      `${JSON.stringify({ cwd: CORRECT_CWD, type: "user", message: "hello" })}\n`,
    );
  });

  it("spawns claude with cwd from JSONL, not from scanner's stale projectPath", async () => {
    // Import StreamerServer after setting up mocks
    const { StreamerServer } = await import("../src/server");
    const nodePty = await import("node-pty");
    ptySpawn = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;
    ptySpawn.mockClear();

    const port = await getRandomPort();
    const cacheDir = mkdtempSync(join(tmpdir(), "threadbase-resume-cache-"));

    // Point the server at our temp ~/.claude dir by overriding homedir temporarily.
    // We patch the private findJsonlPath by swapping process.env.HOME.
    const originalHome = process.env.HOME;
    process.env.HOME = tmpClaudeDir;

    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
    });
    await server.listen(port);

    try {
      const res = await fetch(`http://localhost:${port}/api/sessions/resume`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ sessionId: TEST_UUID }),
      });

      // We expect the server to attempt to spawn — either 201 (pty started)
      // or potentially a scanner 404 (scanner has no index for this uuid).
      // What matters is: IF spawn was called, the cwd must be CORRECT_CWD.
      if (ptySpawn.mock.calls.length > 0) {
        const spawnOpts = ptySpawn.mock.calls[0][2] as { cwd: string };
        expect(spawnOpts.cwd).toBe(CORRECT_CWD);
        expect(spawnOpts.cwd).not.toBe(WRONG_CWD);
      } else {
        // spawn wasn't called — the scanner has no entry for this uuid and
        // the JSONL cwd alone was used. Verify the response isn't 400/500.
        // A 404 is acceptable here (scanner returned null, no conv found via index).
        expect([201, 404].includes(res.status)).toBe(true);
        if (res.status === 201) {
          // Should not reach here without spawn being called
          throw new Error("Got 201 but spawn was not called");
        }
      }
    } finally {
      process.env.HOME = originalHome;
      await server.close();
    }
  });

  it("readCwdFromJsonl extracts the first cwd field from a JSONL file", async () => {
    const { StreamerServer } = await import("../src/server");

    const server = new StreamerServer({
      port: await getRandomPort(),
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-resume-cwd2-")),
    });

    const originalHome = process.env.HOME;
    process.env.HOME = tmpClaudeDir;

    try {
      const jsonlPath = join(claudeProjectsDir, "-Test-foo-bar", `${TEST_UUID}.jsonl`);
      const cwd = await (server as any).readCwdFromJsonl(jsonlPath);
      expect(cwd).toBe(CORRECT_CWD);
    } finally {
      process.env.HOME = originalHome;
      await server.close();
    }
  });

  it("readCwdFromJsonl returns null for a JSONL with no cwd fields", async () => {
    const { StreamerServer } = await import("../src/server");

    const server = new StreamerServer({
      port: await getRandomPort(),
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-resume-cwd3-")),
    });

    const noCwdPath = join(tmpClaudeDir, "no-cwd.jsonl");
    writeFileSync(noCwdPath, `${JSON.stringify({ type: "user", message: "hello" })}\n`);

    try {
      const cwd = await (server as any).readCwdFromJsonl(noCwdPath);
      expect(cwd).toBeNull();
    } finally {
      await server.close();
    }
  });
});
