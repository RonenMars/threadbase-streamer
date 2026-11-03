import { ConversationScanner } from "@threadbase-sh/scanner";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";
import { SessionRegistryBoot } from "../src/session-registry-boot";

// Cold start: the startup scan can take ~35 s on a large corpus, and until it
// ends the gated read endpoints used to answer 503 SERVER_WARMING_UP. When
// cache.db already held rows at boot, the list reads answer from those rows
// instead, labelled `warming` (body field + X-Threadbase-Warming header) so a
// client can tell they may be stale. Everything else, and a first boot with an
// empty cache, behaves as before.

const API_KEY = "tb_test_key_for_warmup_serve_cached";
const auth = { Authorization: `Bearer ${API_KEY}` };
const WARMING_HEADER = "x-threadbase-warming";
const PROFILES = [
  {
    id: "test",
    label: "Test",
    configDir: join(__dirname, "./fixtures/contract-projects"),
    enabled: true,
    emoji: "🧪",
  },
];

function makeServer(cacheDir: string, runtimeDbPath: string): StreamerServer {
  return new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    runtimeDbPath,
    scanProfiles: PROFILES,
    codexRoots: [],
    cursorRoots: [],
    scannerPersistent: false,
  });
}

describe("serving cached rows during the startup warm-up", () => {
  let cacheDir: string;
  let runtimeDbPath: string;
  let server: StreamerServer | undefined;
  let release: (() => void) | undefined;

  beforeEach(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "tb-warm-serve-cache-"));
    runtimeDbPath = join(mkdtempSync(join(tmpdir(), "tb-warm-serve-rt-")), "runtime.db");
    // Populate cache.db with a real scan, then stop, as a previous run would have.
    const first = makeServer(cacheDir, runtimeDbPath);
    await first.listen(0, { awaitReady: true });
    await first.close();
  }, 120_000);

  afterEach(async () => {
    release?.();
    await server?.close();
    server = undefined;
    release = undefined;
    vi.restoreAllMocks();
  });

  /** Restart on the populated cache with a scan that does not finish until released. */
  async function restartWithHungScan(): Promise<{ port: number; scanCalls: () => number }> {
    let calls = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ConversationScanner.prototype, "scan").mockImplementation((async () => {
      calls += 1;
      await pending;
    }) as never);
    server = makeServer(cacheDir, runtimeDbPath);
    await server.listen(0);
    return { port: server.port, scanCalls: () => calls };
  }

  const get = (port: number, path: string) =>
    fetch(`http://localhost:${port}${path}`, { headers: auth });

  it("answers the conversation list from cached rows, labelled warming", async () => {
    const { port } = await restartWithHungScan();
    const res = await get(port, "/api/conversations?limit=50");
    expect(res.status).toBe(200);
    expect(res.headers.get(WARMING_HEADER)).toBe("startup");
    const body = (await res.json()) as { conversations: unknown[]; total: number; warming: string };
    expect(body.warming).toBe("startup");
    expect(body.total).toBeGreaterThan(0);
    expect(body.conversations.length).toBeGreaterThan(0);
  });

  it("answers the count, recents and project summaries from cached rows", async () => {
    const { port } = await restartWithHungScan();
    const count = await get(port, "/api/conversations/count");
    expect(count.status).toBe(200);
    expect(count.headers.get(WARMING_HEADER)).toBe("startup");
    expect(await count.json()).toMatchObject({ warming: "startup" });

    const recents = await get(port, "/api/sessions/recents?limit=5");
    expect(recents.status).toBe(200);
    expect(await recents.json()).toMatchObject({ warming: "startup" });

    const projects = await get(port, "/api/projects/summary");
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({ warming: "startup" });
  });

  it("answers the session list, count and detail once boot recovery has settled", async () => {
    const { port } = await restartWithHungScan();
    await vi.waitFor(async () => {
      const res = await get(port, "/api/sessions/count");
      expect(res.status).toBe(200);
    });
    const count = await get(port, "/api/sessions/count");
    expect(count.headers.get(WARMING_HEADER)).toBe("startup");
    expect(await count.json()).toMatchObject({ warming: "startup" });

    const list = await get(port, "/api/sessions");
    expect(list.status).toBe(200);
    expect(list.headers.get(WARMING_HEADER)).toBe("startup");
    expect(Array.isArray(await list.json())).toBe(true);

    const page = await get(port, "/api/sessions?limit=10");
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ warming: "startup" });
  });

  it("answers a cached conversation by id but asks for a retry on an unknown one", async () => {
    const { port } = await restartWithHungScan();
    const list = (await (await get(port, "/api/conversations?limit=1")).json()) as {
      conversations: Array<{ id: string }>;
    };
    const known = await get(port, `/api/sessions/${list.conversations[0].id}`);
    expect(known.status).toBe(200);
    expect(known.headers.get(WARMING_HEADER)).toBe("startup");

    // A partial index cannot say "not found": the file may exist, unscanned.
    const unknown = await get(port, "/api/sessions/not-yet-indexed");
    expect(unknown.status).toBe(503);
    expect(unknown.headers.get(WARMING_HEADER)).toBeNull();
    expect(await unknown.json()).toMatchObject({ code: "SERVER_WARMING_UP" });
  });

  it("keeps the conversation detail gated: it needs the scanner", async () => {
    const { port } = await restartWithHungScan();
    const res = await get(port, "/api/conversations/not-yet-indexed?msg_limit=80");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "SERVER_WARMING_UP", warmupState: "startup" });
  });

  it("does not start a second scan for refresh=1 while the startup scan runs", async () => {
    const { port, scanCalls } = await restartWithHungScan();
    await vi.waitFor(() => expect(scanCalls()).toBe(1));
    expect((await get(port, "/api/conversations?refresh=1")).status).toBe(200);
    expect((await get(port, "/api/conversations/count?refresh=1")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(scanCalls()).toBe(1);
  });

  it("holds the session list back until boot recovery has rehydrated it", async () => {
    let releaseRecovery!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const real = SessionRegistryBoot.prototype.reconcilePreviousSessions;
    vi.spyOn(SessionRegistryBoot.prototype, "reconcilePreviousSessions").mockImplementation(
      function (this: SessionRegistryBoot) {
        return gate.then(() => real.call(this));
      },
    );
    const { port } = await restartWithHungScan();
    // Cache reads do not depend on the registry, the session list does.
    expect((await get(port, "/api/conversations/count")).status).toBe(200);
    expect((await get(port, "/api/sessions")).status).toBe(503);
    expect((await get(port, "/api/sessions/count")).status).toBe(503);
    releaseRecovery();
    await vi.waitFor(async () => expect((await get(port, "/api/sessions/count")).status).toBe(200));
  });

  it("starts no scan or sub-agent refresh of its own while serving", async () => {
    const { port } = await restartWithHungScan();
    const manager = (
      server as unknown as {
        scannerManager: {
          reconcileMode: () => string | null;
          startBackgroundReconcile: (mode: string) => void;
          refreshSubagentsOf: (p: string) => Promise<void>;
        };
      }
    ).scannerManager;
    // A watcher event marks the scanner stale; on a warm server that starts a reconcile.
    vi.spyOn(manager, "reconcileMode").mockReturnValue("full");
    const reconcile = vi.spyOn(manager, "startBackgroundReconcile");
    const subagents = vi.spyOn(manager, "refreshSubagentsOf");
    const list = (await (await get(port, "/api/conversations?limit=1")).json()) as {
      conversations: Array<{ id: string }>;
    };
    const withParent = await get(port, `/api/conversations?parent=${list.conversations[0].id}`);
    expect(withParent.status).toBe(200);
    expect(reconcile).not.toHaveBeenCalled();
    expect(subagents).not.toHaveBeenCalled();
  });

  it("stops labelling once the scan has finished", async () => {
    const { port } = await restartWithHungScan();
    expect((await get(port, "/api/conversations")).status).toBe(200);
    release?.();
    await vi.waitFor(async () => {
      const res = await get(port, "/api/conversations/count");
      expect(res.headers.get(WARMING_HEADER)).toBeNull();
    });
    const body = (await (await get(port, "/api/conversations/count")).json()) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("warming");
  });

  it("goes back to 503 when a cache reset starts during the warm-up", async () => {
    const { port } = await restartWithHungScan();
    const internals = server as unknown as {
      withWarmup: <T>(s: string, op: () => Promise<T>) => Promise<T>;
    };
    let finish!: () => void;
    const reset = internals.withWarmup(
      "cache_reset",
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const res = await get(port, "/api/conversations/count");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ warmupState: "cache_reset" });
    finish();
    await reset;
  });
});

describe("first boot with an empty cache", () => {
  it("still answers 503 SERVER_WARMING_UP from every gated read", async () => {
    const pending = new Promise<void>(() => {});
    vi.spyOn(ConversationScanner.prototype, "scan").mockReturnValueOnce(pending as never);
    const server = makeServer(
      mkdtempSync(join(tmpdir(), "tb-warm-empty-cache-")),
      join(mkdtempSync(join(tmpdir(), "tb-warm-empty-rt-")), "runtime.db"),
    );
    await server.listen(0);
    try {
      for (const path of [
        "/api/conversations",
        "/api/conversations/count",
        "/api/sessions/recents",
        "/api/projects/summary",
        "/api/sessions",
        "/api/sessions/count",
      ]) {
        const res = await fetch(`http://localhost:${server.port}${path}`, { headers: auth });
        expect(res.status, path).toBe(503);
        expect(res.headers.get(WARMING_HEADER), path).toBeNull();
      }
    } finally {
      vi.restoreAllMocks();
      // The hung scan never settles; skip close()'s wait on it.
      await (server as unknown as { close: (o?: { exiting: boolean }) => Promise<void> }).close({
        exiting: true,
      });
    }
  }, 30_000);
});
