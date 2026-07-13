import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
function asstLine(uuid: string, ts: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId: "sess",
    cwd: "/project",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}
const summaryLine = JSON.stringify({ type: "summary", summary: "s", leafUuid: "x" });

/** Write `content` to the jsonl file and return the spans for [from, end). */
function appendAndSpan(content: string, from: number): ReturnType<typeof splitCompleteLines> {
  writeFileSync(jsonlPath, content);
  const buf = Buffer.from(content, "utf-8").subarray(from);
  return splitCompleteLines(buf, from);
}

beforeEach(() => {
  dbDir = join(tmpdir(), `offset-writer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  jsonlPath = join(dbDir, "the-conv-id.jsonl");
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ConversationCache.extendMessageIndex (incremental writer)", () => {
  it("indexes message lines with byte spans and skips non-message lines", () => {
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    const l0 = userLine("u0", "2026-01-01T00:00:00.000Z", "hi");
    const l1 = asstLine("a1", "2026-01-01T00:00:01.000Z", "yo");
    const content = `${l0}\n${summaryLine}\n${l1}\n`;
    const { spans } = appendAndSpan(content, 0);

    const seqs = cache.extendMessageIndex(jsonlPath, spans, statSync(jsonlPath));
    // Returned seqs are parallel to spans: message lines get their
    // message_index, the summary line (middle) gets null.
    expect(seqs).toEqual([0, null, 1]);

    // Two message lines → two rows; the summary line got no row.
    expect(cache.getIndexedMessageCount(convId)).toBe(2);
    const rows = cache.getMessageIndexWindow(convId, 0, 10);
    expect(rows.map((r) => r.message_index)).toEqual([0, 1]);
    expect(rows[0].uuid).toBe("u0");
    expect(rows[1].uuid).toBe("a1");
    expect(rows[0].role).toBe("user");
    expect(rows[1].role).toBe("assistant");

    // Byte spans point at the actual line bytes.
    expect(rows[0].byte_offset).toBe(0);
    expect(rows[0].byte_length).toBe(Buffer.byteLength(l0, "utf-8"));
    // l1 starts after l0 + "\n" + summary + "\n".
    const l1Offset = Buffer.byteLength(`${l0}\n${summaryLine}\n`, "utf-8");
    expect(rows[1].byte_offset).toBe(l1Offset);
    expect(rows[1].byte_length).toBe(Buffer.byteLength(l1, "utf-8"));

    // file_state advanced to end of the last consumed line.
    const fs = cache.getFileState(jsonlPath);
    expect(fs?.last_message_index).toBe(1);
    expect(fs?.byte_offset).toBe(Buffer.byteLength(content, "utf-8"));
    expect(fs?.size).toBe(statSync(jsonlPath).size);
  });

  it("continues the message_index across a second append (incremental)", () => {
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    const l0 = userLine("u0", "2026-01-01T00:00:00.000Z", "one");
    const first = `${l0}\n`;
    cache.extendMessageIndex(jsonlPath, appendAndSpan(first, 0).spans, statSync(jsonlPath));
    expect(cache.getIndexedMessageCount(convId)).toBe(1);

    // Append two more messages, reading only the new bytes.
    const l1 = asstLine("a1", "2026-01-01T00:00:01.000Z", "two");
    const l2 = userLine("u2", "2026-01-01T00:00:02.000Z", "three");
    const content = `${first}${l1}\n${l2}\n`;
    const from = Buffer.byteLength(first, "utf-8");
    cache.extendMessageIndex(jsonlPath, appendAndSpan(content, from).spans, statSync(jsonlPath));

    expect(cache.getIndexedMessageCount(convId)).toBe(3);
    const rows = cache.getMessageIndexWindow(convId, 0, 10);
    expect(rows.map((r) => r.message_index)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.uuid)).toEqual(["u0", "a1", "u2"]);
    // The second batch's offsets are absolute, not relative to the read start.
    expect(rows[1].byte_offset).toBe(from);
  });

  it("is a no-op for an empty span batch", () => {
    const convId = ConversationCache.conversationIdForFile(jsonlPath);
    writeFileSync(jsonlPath, "");
    cache.extendMessageIndex(jsonlPath, [], statSync(jsonlPath));
    expect(cache.getIndexedMessageCount(convId)).toBe(0);
    expect(cache.getFileState(jsonlPath)).toBeNull();
  });
});
