import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { StreamerServer } from "../src/server";

// The warm-up upsert used to take 50 files per synchronous transaction, so a
// batch of files that are slow to classify (a Codex rollout is read whole)
// held the event loop for the sum. Its batch size now follows the slice budget.

function seed(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-warmup-slice-cfg-"));
  const project = join(dir, "projects", "-tmp-proj");
  mkdirSync(project, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
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
  return dir;
}

async function warmUpBatchSizes(
  count: number,
  costMs: (batchSize: number) => number,
): Promise<number[]> {
  const server = new StreamerServer({
    port: 0,
    apiKey: "tb_test_key_for_warmup_slice",
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir: mkdtempSync(join(tmpdir(), "tb-warmup-slice-cache-")),
    scannerPersistent: false,
    scanProfiles: [{ id: "t", label: "t", configDir: seed(count), enabled: true, emoji: "" }],
  });
  const sizes: number[] = [];
  const orig = ConversationCache.prototype.upsertFromScannerMeta;
  const spy = vi
    .spyOn(ConversationCache.prototype, "upsertFromScannerMeta")
    .mockImplementation(function (this: ConversationCache, metas) {
      sizes.push(metas.length);
      const end = performance.now() + costMs(metas.length);
      while (performance.now() < end) {}
      return orig.call(this, metas);
    });
  try {
    await server.listen(0, { awaitReady: true });
  } finally {
    spy.mockRestore();
    await server.close();
  }
  return sizes;
}

describe("warm-up upsert batch size follows the slice budget", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps one file per transaction while each file alone exceeds the budget", async () => {
    const sizes = await warmUpBatchSizes(8, (n) => 30 * n);
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  }, 60_000);

  it("grows the batch while files are cheap, so a fast corpus is not committed one by one", async () => {
    const sizes = await warmUpBatchSizes(40, () => 0);
    expect(sizes.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40);
  }, 60_000);

  it("halves the batch again once it outgrows the budget", async () => {
    const sizes = await warmUpBatchSizes(40, (n) => (n >= 4 ? 30 : 0));
    expect(sizes.slice(0, 6)).toEqual([1, 2, 4, 2, 4, 2]);
  }, 60_000);
});
