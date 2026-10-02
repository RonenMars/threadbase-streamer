/**
 * POST /api/sessions/:id/terminate — stop an agent running outside the
 * streamer without taking its conversation over.
 *
 * It shares owner resolution and the kill-then-wait step with adopt, so what
 * these pin is the part that differs: terminate respawns nothing, and the
 * session leaves the list as soon as its process is gone.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
  readGitBranch: vi.fn().mockResolvedValue(""),
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { spawn as nodePtySpawn } from "node-pty";
import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";

const ptySpawn = nodePtySpawn as unknown as ReturnType<typeof vi.fn>;

const API_KEY = "tb_test_key_terminate_external";
const CONVERSATION_ID = "5b0c7f0e-2f7a-4c55-9d43-1f6a3c2b9e10";
const EXTERNAL_PID = 999_998;

describe("POST /api/sessions/:id/terminate", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;

  beforeEach(async () => {
    ptySpawn.mockClear();
    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-terminate-"));
    const configDir = join(tmpBase, "profile");
    mkdirSync(join(configDir, "projects"), { recursive: true });

    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "cache"),
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(0);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([]);
    await server.close();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function discovered(projectPath: string) {
    return [
      {
        pid: EXTERNAL_PID,
        provider: "claude-code",
        projectPath,
        projectName: "project",
        branch: "",
        conversationId: CONVERSATION_ID,
        startedAt: new Date(),
      },
    ] as never;
  }

  function terminate(id = CONVERSATION_ID): Promise<Response> {
    return fetch(`${baseUrl}/api/sessions/${id}/terminate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  async function listedIds(): Promise<string[]> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as { sessions?: Array<{ id: string }> } | Array<{ id: string }>;
    const sessions = Array.isArray(body) ? body : (body.sessions ?? []);
    return sessions.map((s) => s.id);
  }

  it("SIGTERMs the external process, waits for it, and respawns nothing", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discovered(join(tmpBase, "project")));
    const signals: Array<[number, unknown]> = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: unknown,
    ) => {
      signals.push([pid, signal]);
      // Signal 0 is the liveness probe; ESRCH means the process is gone.
      if (signal === 0) throw new Error("ESRCH");
      return true;
    }) as never);

    try {
      const res = await terminate();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "terminated",
        sessionId: CONVERSATION_ID,
        pid: EXTERNAL_PID,
      });
      expect(signals).toContainEqual([EXTERNAL_PID, "SIGTERM"]);
      expect(ptySpawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("needs no resolvable project directory, unlike adopt", async () => {
    // Windows discovery reports an empty cwd. Adopt refuses that because it
    // could not respawn; terminate puts nothing back, so it must not care.
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discovered(""));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      _pid: number,
      signal?: unknown,
    ) => {
      if (signal === 0) throw new Error("ESRCH");
      return true;
    }) as never);

    try {
      expect((await terminate()).status).toBe(200);
      expect(ptySpawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("drops the session from the list once its process is gone", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discovered(join(tmpBase, "project")));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      _pid: number,
      signal?: unknown,
    ) => {
      if (signal === 0) throw new Error("ESRCH");
      return true;
    }) as never);

    try {
      expect((await terminate()).status).toBe(200);
      // The next listing re-runs discovery; stop reporting the dead process.
      vi.mocked(discoverClaudeProcesses).mockReturnValue([]);
      expect(await listedIds()).not.toContain(CONVERSATION_ID);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("answers 409 TERMINATE_KILL_TIMEOUT when the process survives SIGTERM", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue(discovered(join(tmpBase, "project")));
    // Never throws: the liveness probe keeps reporting the process as alive.
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    try {
      const res = await terminate();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "TERMINATE_KILL_TIMEOUT", pid: EXTERNAL_PID });
      expect(ptySpawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  }, 15_000);

  it("answers 404 and signals nothing for an unknown session", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    try {
      const res = await terminate("00000000-0000-4000-8000-000000000000");
      expect(res.status).toBe(404);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
