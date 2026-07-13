import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { splitCompleteLines } from "../src/utils/fileIdentity";

let dbDir: string;
let cache: ConversationCache;
let jsonlPath: string;

function userLine(uuid: string, ts: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId: "sess",
    cwd: "/project",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}
const summaryLine = JSON.stringify({ type: "summary", summary: "s", leafUuid: "x" });

function writeConversation(n: number, withSummary = false): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      userLine(`u${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, `msg ${i}`),
    );
    if (withSummary && i === 1) lines.push(summaryLine);
  }
  const content = `${lines.join("\n")}\n`;
  writeFileSync(jsonlPath, content);
  return content;
}

beforeEach(() => {
  dbDir = join(tmpdir(), `offset-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  jsonlPath = join(dbDir, "backfill-conv.jsonl");
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ConversationCache.backfillIndex", () => {
  it("indexes an existing file from scratch, skipping non-message lines", async () => {
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    const content = writeConversation(4, /* withSummary */ true);
    await cache.backfillIndex(jsonlPath);

    // 4 messages; the summary line got no row.
    expect(cache.getIndexedMessageCount(convId)).toBe(4);
    const rows = cache.getMessageIndexWindow(convId, 0, 100);
    expect(rows.map((r) => r.uuid)).toEqual(["u0", "u1", "u2", "u3"]);

    // file_state reflects the whole file.
    const fs = cache.getFileState(jsonlPath);
    expect(fs?.last_message_index).toBe(3);
    expect(fs?.size).toBe(statSync(jsonlPath).size);
    expect(fs?.byte_offset).toBe(Buffer.byteLength(content, "utf-8"));

    // Byte spans actually point at each line.
    for (const r of rows) {
      const slice = content.slice(r.byte_offset, r.byte_offset + r.byte_length);
      expect(JSON.parse(slice).uuid).toBe(r.uuid);
    }
  });

  it("works across chunk boundaries (torn line spanning two 256KB reads)", async () => {
    // Each message body is ~1KB, so ~500 lines is ~500KB — comfortably past one
    // 256KB read chunk, forcing at least one JSON line astride a chunk boundary.
    // The carry logic must stitch it back together.
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    const big = "x".repeat(1024);
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(userLine(`u${i}`, `2026-01-01T00:00:00.000Z`, `${big} ${i}`));
    }
    const content = `${lines.join("\n")}\n`;
    writeFileSync(jsonlPath, content);
    expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(256 * 1024);

    await cache.backfillIndex(jsonlPath);

    expect(cache.getIndexedMessageCount(convId)).toBe(500);
    const rows = cache.getMessageIndexWindow(convId, 0, 1000);
    // Every indexed span parses back to the right line — proves no boundary
    // corruption of byte_offset/byte_length.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const slice = content.slice(r.byte_offset, r.byte_offset + r.byte_length);
      expect(JSON.parse(slice).uuid).toBe(`u${i}`);
    }
  });

  it("single-flights concurrent backfills for the same path (one walk)", async () => {
    writeConversation(10);
    // Spy on the DB layer proxy: appendMessageIndexRows is called during a walk.
    const spy = vi.spyOn(cache, "appendMessageIndexRows");
    const [a, b, c] = await Promise.all([
      cache.backfillIndex(jsonlPath),
      cache.backfillIndex(jsonlPath),
      cache.backfillIndex(jsonlPath),
    ]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(c).toBeUndefined();
    // A single walk ran (10 lines < one batch → exactly one append call). If the
    // three had each walked, we'd see 3.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cache.getIndexedMessageCount(ConversationCache.conversationIdForFile(jsonlPath))).toBe(
      10,
    );
  });

  it("rebuilds after truncation/replacement (drops old rows, re-indexes)", async () => {
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    writeConversation(5);
    await cache.backfillIndex(jsonlPath);
    expect(cache.getIndexedMessageCount(convId)).toBe(5);

    // Replace the file with a shorter conversation (truncation/replacement).
    writeConversation(2);
    await cache.backfillIndex(jsonlPath);

    // Old rows are gone; only the 2 new messages remain.
    expect(cache.getIndexedMessageCount(convId)).toBe(2);
    const rows = cache.getMessageIndexWindow(convId, 0, 100);
    expect(rows.map((r) => r.message_index)).toEqual([0, 1]);
    const fs = cache.getFileState(jsonlPath);
    expect(fs?.last_message_index).toBe(1);
    expect(fs?.size).toBe(statSync(jsonlPath).size);
  });

  it("a tail append during an in-flight backfill declines instead of colliding at index 0", async () => {
    // While a backfill is in flight there is no file_state yet, so a naive
    // extend would start the appended tail at message_index 0 and collide with
    // the backfill's own rows. The contiguity guard (readFrom !== 0) makes it
    // decline. Simulate the exact state: no file_state, a tail read at
    // readFrom > 0.
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    writeConversation(5);
    expect(cache.getFileState(jsonlPath)).toBeNull(); // backfill hasn't written state

    const content = readFileSync(jsonlPath, "utf-8");
    const from = 100; // a tail read starting mid-file, not byte 0
    const { spans, consumed } = splitCompleteLines(
      Buffer.from(content, "utf-8").subarray(from),
      from,
    );
    const result = cache.extendMessageIndex(
      jsonlPath,
      spans,
      statSync(jsonlPath),
      from,
      from + consumed,
    );

    // Declined — no rows written at message_index 0, no file_state created.
    expect(result).toBeNull();
    expect(cache.getIndexedMessageCount(convId)).toBe(0);
    expect(cache.getFileState(jsonlPath)).toBeNull();

    // The single-flighted backfill still produces a correct, collision-free index.
    await cache.backfillIndex(jsonlPath);
    expect(cache.getIndexedMessageCount(convId)).toBe(5);
    expect(cache.getMessageIndexWindow(convId, 0, 100).map((r) => r.message_index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});
