import { createServer } from "http";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
}));

import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";

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

const API_KEY = "tb_test_key_adopt_no_path";
const CONV_ID = "aaaaaaaa-1111-4222-8333-444444444444";

// Adopt is destructive-then-restorative: it SIGTERMs the user's real terminal
// session and then respawns it. Every reason the respawn cannot work has to be
// checked BEFORE the kill, otherwise the session is destroyed with nothing to
// put back. Windows exposes no process CWD, so projectPath is legitimately
// empty there — previously it was filled with the CLI's own install directory,
// and adopt "succeeded" into the wrong project.
describe("POST /api/sessions/:id/adopt — unknown working directory", () => {
  let server: StreamerServer;
  let baseUrl: string;

  beforeEach(async () => {
    const port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({ port, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
  });

  it("refuses with ADOPT_NO_PROJECT_PATH and does NOT kill the process", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([
      {
        pid: 999_999,
        projectPath: "", // unknown — the Windows case
        projectName: "",
        branch: "",
        conversationId: CONV_ID,
        startedAt: new Date(),
      },
    ] as never);

    // Spy on the kill path: the guard must run before anything destructive.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await fetch(`${baseUrl}/api/sessions/${CONV_ID}/adopt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("ADOPT_NO_PROJECT_PATH");
    // The whole point: nothing was signalled.
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("still rejects a session with no known PID before touching anything", async () => {
    vi.mocked(discoverClaudeProcesses).mockReturnValue([] as never);

    const res = await fetch(`${baseUrl}/api/sessions/${CONV_ID}/adopt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    // No discovered process at all -> 404, well before the kill.
    expect(res.status).toBe(404);
  });
});
