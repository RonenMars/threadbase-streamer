import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamerServer } from "../src/server";

const SESSION_ID = "019edbc1-13a7-7fa1-80b4-7eafc270f03e";
const FIXTURE = join(__dirname, "fixtures", "codex-rollout.jsonl");
const API_KEY = "tb_external_liveness_key_0000000000";
const auth = { Authorization: `Bearer ${API_KEY}` };

describe("conversations tagged with the outside process running them", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let tmpBase: string;

  const get = async (path: string) => (await fetch(`${baseUrl}${path}`, { headers: auth })).json();

  beforeEach(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), "threadbase-external-liveness-"));
    process.env.TB_SCANNER_DB = join(tmpBase, "scanner.db");
    const root = join(tmpBase, "codex-sessions", "2026", "06", "18");
    mkdirSync(root, { recursive: true });
    copyFileSync(FIXTURE, join(root, `rollout-2026-06-18T20-22-04-${SESSION_ID}.jsonl`));
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(tmpBase, "cache"),
      scanProfiles: [],
      codexRoots: [join(tmpBase, "codex-sessions")],
      scannerPersistent: false,
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    delete process.env.TB_SCANNER_DB;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  /** Make discovery report an outside process on `id`, without scanning real processes. */
  async function discoverOutside(id: string, projectPath: string) {
    vi.spyOn((server as any).sessionHandlers, "refreshDiscovery").mockImplementation(async () => {
      (server as any).sessionStore.setDiscovered([
        {
          pid: 4242,
          provider: "codex-cli",
          projectPath,
          projectName: "p",
          branch: "main",
          conversationId: id,
          startedAt: new Date(),
        },
      ]);
      return [];
    });
  }

  it("tags the list row, the single view and the project summary", async () => {
    const before = (await get("/api/conversations?limit=50")) as any;
    const row = before.conversations.find((c: any) => c.id.includes(SESSION_ID));
    expect(row).toBeDefined();
    // control: nothing is running outside, so nothing is tagged
    expect(row.ownership).toBeUndefined();
    const projectsBefore = (await get("/api/projects/summary")) as any;
    expect(JSON.stringify(projectsBefore)).not.toContain('liveExternalCount":1');

    await discoverOutside(row.id, row.projectPath);

    const after = (await get("/api/conversations?limit=50")) as any;
    const tagged = after.conversations.find((c: any) => c.id === row.id);
    expect(tagged.ownership).toBe("external");
    expect(tagged.processLiveness).toBe("alive");

    const one = (await get(`/api/conversations/${row.id}?msg_limit=5`)) as any;
    expect(one.meta.ownership).toBe("external");
    expect(one.meta.processLiveness).toBe("alive");

    const projects = (await get("/api/projects/summary")) as any;
    const list = projects.projects ?? projects;
    const proj = list.find((p: any) => p.path === row.projectPath);
    expect(proj.liveExternalCount).toBe(1);
  });

  it("the single view does not wait for a slow discovery scan", async () => {
    const list = (await get("/api/conversations?limit=50")) as any;
    const id = list.conversations.find((c: any) => c.id.includes(SESSION_ID)).id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const refresh = vi
      .spyOn((server as any).sessionHandlers, "refreshDiscovery")
      .mockImplementation(async () => {
        await gate;
        return [];
      });
    const t0 = Date.now();
    const one = (await get(`/api/conversations/${id}?msg_limit=5`)) as any;
    const elapsed = Date.now() - t0;
    expect(refresh).toHaveBeenCalled(); // positive control: the scan was asked for, just not awaited
    expect(one.meta.id).toBe(id);
    expect(elapsed).toBeLessThan(2000);
    release();
  });

  it("treats a negative limit or offset as the floor, not as unbounded", async () => {
    const res = (await get("/api/conversations?limit=-1&offset=-5")) as any;
    expect(res.offset).toBe(0);
    expect(res.conversations.length).toBeGreaterThanOrEqual(1);
  });
});
