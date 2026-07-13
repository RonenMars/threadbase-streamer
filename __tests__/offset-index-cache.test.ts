import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationCache,
  type FileStateRow,
  type MessageIndexRow,
} from "../src/conversation-cache";

let dbDir: string;
let cache: ConversationCache;

const CONV = "conv-1";
const PATH = "/tmp/conv-1.jsonl";

function row(i: number, offset: number, len: number): MessageIndexRow {
  return {
    conversation_id: CONV,
    message_index: i,
    byte_offset: offset,
    byte_length: len,
    uuid: `u${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    ts: 1_000 + i,
  };
}

beforeEach(() => {
  dbDir = join(tmpdir(), `offset-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ConversationCache offset-index methods", () => {
  it("round-trips file state", () => {
    expect(cache.getFileState(PATH)).toBeNull();
    const state: FileStateRow = {
      path: PATH,
      identity: "inode:1:2",
      size: 500,
      mtime_ms: 123456,
      byte_offset: 480,
      last_message_index: 4,
    };
    cache.upsertFileState(state);
    expect(cache.getFileState(PATH)).toEqual(state);

    // Upsert overwrites in place.
    cache.upsertFileState({ ...state, size: 600, byte_offset: 590, last_message_index: 5 });
    const updated = cache.getFileState(PATH);
    expect(updated?.size).toBe(600);
    expect(updated?.last_message_index).toBe(5);
  });

  it("appends index rows and reads a tail window", () => {
    const rows = [row(0, 0, 10), row(1, 11, 20), row(2, 32, 15), row(3, 48, 25)];
    cache.appendMessageIndexRows(rows);
    expect(cache.getIndexedMessageCount(CONV)).toBe(4);

    // Tail of the last 2 → [2, 4).
    const tail = cache.getMessageIndexWindow(CONV, 2, 4);
    expect(tail.map((r) => r.message_index)).toEqual([2, 3]);
    expect(tail[0].byte_offset).toBe(32);
    expect(tail[1].byte_length).toBe(25);
  });

  it("reads a middle window (before_index / after_index style)", () => {
    cache.appendMessageIndexRows([0, 1, 2, 3, 4, 5].map((i) => row(i, i * 10, 8)));
    // after_index=2, limit 2 → [2, 4)
    const win = cache.getMessageIndexWindow(CONV, 2, 4);
    expect(win.map((r) => r.message_index)).toEqual([2, 3]);
    // before_index=3, limit 2 → [1, 3)
    const back = cache.getMessageIndexWindow(CONV, 1, 3);
    expect(back.map((r) => r.message_index)).toEqual([1, 2]);
  });

  it("upserts (replaces) a row on conflicting (conversation_id, message_index)", () => {
    cache.appendMessageIndexRows([row(0, 0, 10)]);
    cache.appendMessageIndexRows([{ ...row(0, 100, 99), uuid: "u0-new" }]);
    expect(cache.getIndexedMessageCount(CONV)).toBe(1);
    const [only] = cache.getMessageIndexWindow(CONV, 0, 1);
    expect(only.byte_offset).toBe(100);
    expect(only.byte_length).toBe(99);
    expect(only.uuid).toBe("u0-new");
  });

  it("deleteFileIndex drops both the rows and the file_state (truncation)", () => {
    cache.upsertFileState({
      path: PATH,
      identity: "inode:1:2",
      size: 100,
      mtime_ms: 1,
      byte_offset: 100,
      last_message_index: 2,
    });
    cache.appendMessageIndexRows([row(0, 0, 10), row(1, 11, 10), row(2, 22, 10)]);
    expect(cache.getIndexedMessageCount(CONV)).toBe(3);

    cache.deleteFileIndex(PATH, CONV);
    expect(cache.getIndexedMessageCount(CONV)).toBe(0);
    expect(cache.getFileState(PATH)).toBeNull();
  });
});
