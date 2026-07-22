/**
 * Regression: adopt must resolve its working directory from the conversation's
 * JSONL when discovery could not report one. Windows exposes no process CWD
 * (neither CIM nor wmic carries it), so discovery reports "" rather than
 * fabricating a path — and adopt refused every session there with
 * ADOPT_NO_PROJECT_PATH. Resolution mirrors handleResume: the JSONL is the file
 * Claude itself looks up by filename when processing --resume.
 *
 * Ordering is the point of these tests. Adopt is destructive-then-restorative,
 * so every reason the respawn cannot work has to be checked BEFORE the kill —
 * a guard that returns the right status after signalling still destroys the
 * user's session. Hence the process.kill spy in the refusal cases.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
}));

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

import { spawn as nodePtySpawn } from "node-pty";
import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";

const ptySpawn = nodePtySpawn as unknown as ReturnType<typeof vi.fn>;

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

const API_KEY = "tb_test_key_adopt_cwd_jsonl";
const CONV_ID = "bbbbbbbb-2222-4333-8444-555555555555";
const EXTERNAL_PID = 999_999;

// process.kill stand-in for a process that dies on SIGTERM: the signal-0
// liveness probe waitForProcessExit uses throws ESRCH, so the wait resolves.
function gonePid(_pid: number, signal?: unknown): boolean {
  if (signal === 0) throw new Error("ESRCH");
  return true;
}

function discoveredWithUnknownCwd() {
  return [
    {
      pid: EXTERNAL_PID,
      projectPath: "", // unknown — the Windows case
      projectName: "",
      branch: "",
      conversationId: CONV_ID,
      startedAt: new Date(),
    },
  ] as never;
}

describe("POST /api/sessions/:id/adopt — cwd resolved from the conversation JSONL", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;
  let configDir: string;
  let projectsDir: string;
  let projectCwd: string;

  beforeEach(async () => {
    ptySpawn.mockClear();

    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-adopt-cwd-"));
    configDir = join(tmpBase, "profile");
    projectsDir = join(configDir, "projects", "-encoded-project-dir");
    mkdirSync(projectsDir, { recursive: true });
    // The directory the conversation was launched in — a real one, so the
    // project-dir pre-flight check passes unless a test removes it.
    projectCwd = join(tmpBase, "project");
    mkdirSync(projectCwd, { recursive: true });

    const port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "cache"),
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeJsonl(entry: Record<string, unknown>): void {
    writeFileSync(join(projectsDir, `${CONV_ID}.jsonl`), `${JSON.stringify(entry)}\n`);
  }

  async function adopt(): Promise<Response> {
    return fetch(`${baseUrl}/api/sessions/${CONV_ID}/adopt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  it("adopts a session with unknown projectPath, spawning with the JSONL cwd", async () => {
    writeJsonl({ cwd: projectCwd, type: "user", message: "hi" });
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discoveredWithUnknownCwd());

    // SIGTERM succeeds; the liveness probe (signal 0) reports the process gone,
    // so the kill-then-wait completes and adopt proceeds to the respawn.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(gonePid as never);

    try {
      const res = await adopt();

      expect(res.status).toBe(201);
      expect(killSpy).toHaveBeenCalledWith(EXTERNAL_PID, "SIGTERM");
      expect(ptySpawn).toHaveBeenCalledTimes(1);
      const spawnOpts = ptySpawn.mock.calls[0][2] as { cwd: string };
      expect(spawnOpts.cwd).toBe(projectCwd);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("refuses with ADOPT_NO_PROJECT_PATH when the JSONL has no cwd, without killing", async () => {
    writeJsonl({ type: "user", message: "hi" });
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discoveredWithUnknownCwd());

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const res = await adopt();

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("ADOPT_NO_PROJECT_PATH");
      expect(killSpy).not.toHaveBeenCalled();
      expect(ptySpawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("refuses before the kill when the resolved directory no longer exists", async () => {
    rmSync(projectCwd, { recursive: true, force: true });
    writeJsonl({ cwd: projectCwd, type: "user", message: "hi" });
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discoveredWithUnknownCwd());

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const res = await adopt();

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("ADOPT_PROJECT_PATH_MISSING");
      expect(killSpy).not.toHaveBeenCalled();
      expect(ptySpawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
