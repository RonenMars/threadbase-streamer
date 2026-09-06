/**
 * Adopt must respawn a session with the provider it discovered.
 *
 * `LiveSessionManager.start` defaults to Claude when no provider is passed, and
 * adopt passed none — so taking over a Codex session ran `claude --resume`
 * against a Codex rollout id. Nothing failed loudly: the spawn succeeded, the
 * wrong agent attached to the wrong conversation, and the user's real terminal
 * process had already been SIGTERMed to make room for it.
 *
 * The spawned binary is the assertion because it is the thing that was wrong.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
      resize: vi.fn(),
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

const API_KEY = "tb_test_key_adopt_provider";
// A Codex rollout id, which is what `codex resume <uuid>` states in argv and
// therefore what discovery reports as the conversation.
const ROLLOUT_ID = "01a06e20-75ff-7cb2-8cc2-14fb76121928";
const EXTERNAL_PID = 999_999;

// The signal-0 liveness probe throws ESRCH for a process that is gone, which is
// what lets kill-then-wait complete and adopt proceed to the respawn.
function gonePid(_pid: number, signal?: unknown): boolean {
  if (signal === 0) throw new Error("ESRCH");
  return true;
}

describe("POST /api/sessions/:id/adopt — provider", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;
  let projectCwd: string;

  beforeEach(async () => {
    ptySpawn.mockClear();

    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-adopt-provider-"));
    const configDir = join(tmpBase, "profile");
    mkdirSync(join(configDir, "projects"), { recursive: true });
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

  function discovered(provider: "claude-code" | "codex-cli") {
    return [
      {
        pid: EXTERNAL_PID,
        provider,
        projectPath: projectCwd,
        projectName: "project",
        branch: "",
        conversationId: ROLLOUT_ID,
        startedAt: new Date(),
      },
    ] as never;
  }

  async function adopt(): Promise<Response> {
    return fetch(`${baseUrl}/api/sessions/${ROLLOUT_ID}/adopt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  function spawnedBinary(): string {
    return String(ptySpawn.mock.calls[0][0]).toLowerCase();
  }

  it("respawns a discovered Codex session as Codex", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discovered("codex-cli"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(gonePid as never);

    try {
      const res = await adopt();

      expect(res.status).toBe(201);
      expect(ptySpawn).toHaveBeenCalledTimes(1);
      expect(spawnedBinary()).toContain("codex");
      expect(spawnedBinary()).not.toContain("claude");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("still respawns a discovered Claude session as Claude", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discovered("claude-code"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(gonePid as never);

    try {
      const res = await adopt();

      expect(res.status).toBe(201);
      expect(ptySpawn).toHaveBeenCalledTimes(1);
      expect(spawnedBinary()).toContain("claude");
    } finally {
      killSpy.mockRestore();
    }
  });
});
