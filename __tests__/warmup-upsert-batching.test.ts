import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";
import { StreamerServer } from "../src/server";

// The warm-up upserts the whole corpus's ScannerMeta in one call to
// upsertFromScannerMeta, which wraps every item in a single synchronous
// db.transaction and does a sync file read per item. On a real box that
// blocked the event loop for seconds. This test pins that the warm-up
// chunks the upsert (same BATCH+setImmediate pattern as the tail-populate
// loop) instead of doing it in one synchronous shot, and that tails still
// get warmed for every upserted conversation across batches.

const API_KEY = "tb_test_key_for_warmup_batching";
const CONVERSATION_COUNT = 120; // three batches: 50, 50, 20

function seedManyConversations(): { dir: string; ids: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "tb-warmup-batch-cfg-"));
  const project = join(dir, "projects", "-tmp-proj");
  mkdirSync(project, { recursive: true });
  const ids: string[] = [];
  for (let i = 0; i < CONVERSATION_COUNT; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    ids.push(id);
    writeFileSync(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: "user",
        sessionId: id,
        cwd: "/tmp/proj",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: `hello ${i}` },
      })}\n`,
    );
  }
  return { dir, ids };
}

function makeServer(configDir: string): StreamerServer {
  return new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir: mkdtempSync(join(tmpdir(), "tb-warmup-batch-cache-")),
    scannerPersistent: false,
    scanProfiles: [{ id: "t", label: "t", configDir, enabled: true, emoji: "" }],
  });
}

describe("warm-up upsert batching", () => {
  let server: StreamerServer;

  afterEach(async () => {
    await server?.close();
  });

  it("chunks the upsert into <=50-item batches and yields to the event loop between them", async () => {
    const { dir } = seedManyConversations();
    server = makeServer(dir);

    const origUpsert = ConversationCache.prototype.upsertFromScannerMeta;
    const batchSizes: number[] = [];
    const ticksAtCall: number[] = [];

    // A self-rescheduling setImmediate counter: how many event-loop turns
    // have elapsed since listen() started. If the upsert never yields, every
    // call happens on the same tick (ticksAtCall stays flat); if it chunks
    // with setImmediate between batches, the counter has advanced by the
    // time each subsequent batch runs.
    let ticks = 0;
    let scheduling = true;
    const tick = () => {
      ticks++;
      if (scheduling) setImmediate(tick);
    };
    setImmediate(tick);

    const spy = vi
      .spyOn(ConversationCache.prototype, "upsertFromScannerMeta")
      .mockImplementation(function (this: ConversationCache, metas) {
        batchSizes.push(metas.length);
        ticksAtCall.push(ticks);
        return origUpsert.call(this, metas);
      });

    try {
      await server.listen(0, { awaitReady: true });
    } finally {
      scheduling = false;
      spy.mockRestore();
    }

    expect(batchSizes.length).toBeGreaterThan(1);
    for (const size of batchSizes) expect(size).toBeLessThanOrEqual(50);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(CONVERSATION_COUNT);
    for (let i = 1; i < ticksAtCall.length; i++) {
      expect(ticksAtCall[i]).toBeGreaterThan(ticksAtCall[i - 1]);
    }
  }, 60_000);

  it("still warms tails for every seeded conversation (upsertedIds is the union across batches)", async () => {
    const { dir, ids } = seedManyConversations();
    server = makeServer(dir);

    const tailedIds = new Set<string>();
    const origPopulate = ConversationCache.prototype.populateTailFromFile;
    const spy = vi
      .spyOn(ConversationCache.prototype, "populateTailFromFile")
      .mockImplementation(function (this: ConversationCache, convId: string, filePath: string) {
        tailedIds.add(convId);
        return origPopulate.call(this, convId, filePath);
      });

    try {
      await server.listen(0, { awaitReady: true });
    } finally {
      spy.mockRestore();
    }

    for (const id of ids) expect(tailedIds.has(id)).toBe(true);
  }, 60_000);
});
