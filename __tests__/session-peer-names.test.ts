import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
}));

import { SessionPeerNamesRepository } from "../src/db/repositories/session-peer-names.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";
import type { DiscoveredProcess } from "../src/types";

const CONV = "9f66e9cd-2b55-40ea-81a7-327c27cc0024";
const OTHER = "ec943a8d-1e8b-4eeb-96f8-511a97481149";

function proc(overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid: 4242,
    provider: "claude-code",
    projectPath: "/tmp/peer-name-proj",
    projectName: "peer-name-proj",
    branch: "main",
    conversationId: CONV,
    startedAt: new Date(),
    peerName: { name: "tb-streamer-d9", source: "derived", since: 1000 },
    ...overrides,
  };
}

describe("SessionPeerNamesRepository", () => {
  let dir: string;
  let store: RuntimeStore;
  let repo: SessionPeerNamesRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-peer-names-"));
    store = RuntimeStore.open(join(dir, "runtime.db"));
    repo = new SessionPeerNamesRepository(store.getDatabase());
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a discovered process's peer name by conversation id", () => {
    repo.record([proc()], 5000);
    expect(repo.get(CONV)).toEqual({
      name: "tb-streamer-d9",
      source: "derived",
      since: 1000,
      pid: 4242,
      updatedAt: 5000,
    });
  });

  it("follows a rename, and leaves an unchanged name's updatedAt alone", () => {
    repo.record([proc()], 5000);
    repo.record([proc()], 6000);
    expect(repo.get(CONV)?.updatedAt).toBe(5000);
    repo.record(
      [proc({ peerName: { name: "name slug developer", source: "user", since: 7000 } })],
      8000,
    );
    expect(repo.get(CONV)).toMatchObject({
      name: "name slug developer",
      source: "user",
      updatedAt: 8000,
    });
  });

  it("keeps the last name after the process is gone", () => {
    repo.record([proc()], 5000);
    repo.record([], 6000);
    expect(repo.get(CONV)?.name).toBe("tb-streamer-d9");
  });

  it("lets two conversations share a name, and skips processes without one", () => {
    repo.record(
      [
        proc(),
        proc({ pid: 4343, conversationId: OTHER }),
        proc({
          pid: 4444,
          conversationId: "a1b2c3d4-0000-4000-8000-000000000000",
          peerName: undefined,
        }),
        proc({ pid: 4545, conversationId: null }),
      ],
      5000,
    );
    expect(repo.get(CONV)?.name).toBe("tb-streamer-d9");
    expect(repo.get(OTHER)?.name).toBe("tb-streamer-d9");
    expect(repo.get("a1b2c3d4-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("GET /api/sessions — peer name", () => {
  const API_KEY = "tb_test_key_peer_name";
  const MANAGED_ID = "3c0a7d52-6c1e-4d0a-9b8e-2f1f3c4d5e6f";
  let server: StreamerServer;
  let baseUrl: string;

  beforeEach(async () => {
    vi.mocked(discoverClaudeProcesses).mockReset();
    vi.mocked(discoverClaudeProcesses).mockResolvedValue([proc()]);
    server = new StreamerServer({ port: 0, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  async function list(): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as unknown;
    return (Array.isArray(body) ? body : (body as { sessions: [] }).sessions) as Array<
      Record<string, unknown>
    >;
  }

  function peerRepo(): SessionPeerNamesRepository {
    return new SessionPeerNamesRepository((server as any).runtimeStore.getDatabase());
  }

  it("exposes an external session's peer name", async () => {
    const row = (await list()).find((s) => s.id === CONV);
    expect(row).toMatchObject({ peerName: "tb-streamer-d9", peerNameSource: "derived" });
  });

  it("records the peer name of the streamer's own PTY child too", async () => {
    const ptyManager = (server as any).sessionHandlers.deps.ptyManager;
    vi.spyOn(ptyManager, "listSessions").mockReturnValue([{ id: MANAGED_ID }] as never);
    vi.spyOn(ptyManager, "getPid").mockReturnValue(4242);
    const rows = await list();
    expect(rows.map((s) => s.id)).not.toContain(CONV);
    expect(peerRepo().get(CONV)?.name).toBe("tb-streamer-d9");
  });
});
