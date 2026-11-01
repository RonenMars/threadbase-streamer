import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { StreamerServer } from "../src/server";

// The tail-populate loop used to yield once per 50 calls, so its stall was
// bounded by 50 x the slowest call. It now yields once a slice has used its
// time budget, whatever the call count.

function seed(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-warmup-yield-cfg-"));
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

describe("warm-up tail populate yields on a time budget", () => {
  let server: StreamerServer;
  afterEach(async () => {
    await server?.close();
  });

  it("yields to the event loop between slow populate calls even when fewer than 50 ran", async () => {
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_test_key_for_warmup_yield",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-warmup-yield-cache-")),
      scannerPersistent: false,
      scanProfiles: [{ id: "t", label: "t", configDir: seed(8), enabled: true, emoji: "" }],
    });

    let ticks = 0;
    let scheduling = true;
    const tick = () => {
      ticks++;
      if (scheduling) setImmediate(tick);
    };
    setImmediate(tick);

    const ticksAtCall: number[] = [];
    const orig = ConversationCache.prototype.populateTailFromFile;
    const spy = vi
      .spyOn(ConversationCache.prototype, "populateTailFromFile")
      .mockImplementation(function (this: ConversationCache, convId: string, filePath: string) {
        ticksAtCall.push(ticks);
        const end = performance.now() + 30; // a call slower than the whole slice budget
        while (performance.now() < end) {}
        return orig.call(this, convId, filePath);
      });
    try {
      await server.listen(0, { awaitReady: true });
    } finally {
      scheduling = false;
      spy.mockRestore();
    }

    expect(ticksAtCall.length).toBe(8);
    for (let i = 1; i < ticksAtCall.length; i++) {
      expect(ticksAtCall[i]).toBeGreaterThan(ticksAtCall[i - 1]);
    }
  }, 60_000);
});
