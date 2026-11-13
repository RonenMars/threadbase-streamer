import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
}));

import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_owned_pid";
const MANAGED_ID = "ec943a8d-1e8b-4eeb-96f8-511a97481149";
// The id the process's registry reported — not the id the streamer spawned it under.
const REGISTRY_ID = "9f66e9cd-2b55-40ea-81a7-327c27cc0024";
const PID = 4242;

describe("GET /api/sessions — a managed PTY child is not also listed as external", () => {
  let server: StreamerServer;
  let baseUrl: string;

  beforeEach(async () => {
    vi.mocked(discoverClaudeProcesses).mockReset();
    vi.mocked(discoverClaudeProcesses).mockResolvedValue([
      {
        pid: PID,
        provider: "claude-code",
        projectPath: "/tmp/worktrees/use-copy-to-clipboard",
        projectName: "use-copy-to-clipboard",
        branch: "refactor/use-copy-to-clipboard",
        conversationId: REGISTRY_ID,
        startedAt: new Date(),
      },
    ]);
    server = new StreamerServer({ port: 0, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  async function listIds(ownedPid: number | null): Promise<string[]> {
    const ptyManager = (server as any).sessionHandlers.deps.ptyManager;
    vi.spyOn(ptyManager, "listSessions").mockReturnValue([{ id: MANAGED_ID }] as never);
    vi.spyOn(ptyManager, "getPid").mockReturnValue(ownedPid);
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as { id: string }[] | { sessions: { id: string }[] };
    return (Array.isArray(body) ? body : body.sessions).map((s) => s.id);
  }

  it("lists the process when no managed session owns its pid (positive control)", async () => {
    expect(await listIds(null)).toContain(REGISTRY_ID);
  });

  it("drops the process when its pid is a managed session's, whatever id it reports", async () => {
    expect(await listIds(PID)).not.toContain(REGISTRY_ID);
  });
});
