import * as fs from "fs";
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { splitCompleteLines } from "../src/utils/fileIdentity";

let dbDir: string;
let cache: ConversationCache;
let jsonlPath: string;

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess",
    cwd: "/project",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** Extend the index from the current end of file_state to EOF (incremental). */
function extendToEof() {
  const st = statSync(jsonlPath);
  const prev = cache.getFileState(jsonlPath);
  const from = prev?.byte_offset ?? 0;
  const buf = fs.readFileSync(jsonlPath).subarray(from);
  const { spans, consumed } = splitCompleteLines(buf, from);
  cache.extendMessageIndex(jsonlPath, spans, st, from, from + consumed);
}

beforeEach(() => {
  dbDir = join(tmpdir(), `offset-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  jsonlPath = join(dbDir, "read-conv.jsonl");
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ConversationCache.readMessageWindow", () => {
  it("returns null when there is no file_state (cold index)", () => {
    writeFileSync(jsonlPath, `${userLine("u0", "hi")}\n`);
    expect(cache.readMessageWindow(jsonlPath, 0, 10)).toBeNull();
  });

  it("reads exactly the requested window, not the whole conversation", () => {
    const lines = [0, 1, 2, 3, 4].map((i) => userLine(`u${i}`, `msg ${i}`));
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    // Backfill then read a middle window [1, 3). Only messages 1 and 2 come
    // back — proving the pread targeted their byte ranges (a full read would
    // have surfaced all five). Correct uuids+text confirm the ranges are exact.
    return cache.backfillIndex(jsonlPath).then(() => {
      const win = cache.readMessageWindow(jsonlPath, 1, 3);
      expect(win).not.toBeNull();
      expect(win?.total).toBe(5);
      expect(win?.fromIndex).toBe(1);
      expect(win?.messages).toHaveLength(2);
      expect(win?.messages.map((m) => m.uuid)).toEqual(["u1", "u2"]);
      expect(win?.messages.map((m) => m.text)).toEqual(["msg 1", "msg 2"]);
    });
  });

  it("serves a window spanning the backfilled + incrementally-appended boundary", () => {
    // Backfill the first 3, then append 2 more incrementally.
    const first = [0, 1, 2].map((i) => userLine(`u${i}`, `m${i}`));
    writeFileSync(jsonlPath, `${first.join("\n")}\n`);
    return cache.backfillIndex(jsonlPath).then(() => {
      writeFileSync(
        jsonlPath,
        `${first.join("\n")}\n${userLine("u3", "m3")}\n${userLine("u4", "m4")}\n`,
      );
      extendToEof();

      // A window [2, 5) straddles the backfill/tail boundary (index 2 was
      // backfilled; 3,4 were appended).
      const win = cache.readMessageWindow(jsonlPath, 2, 5);
      expect(win?.total).toBe(5);
      expect(win?.messages.map((m) => m.uuid)).toEqual(["u2", "u3", "u4"]);
    });
  });

  it("returns null after truncation/replacement (identity/size mismatch)", () => {
    const lines = [0, 1, 2].map((i) => userLine(`u${i}`, `m${i}`));
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    return cache.backfillIndex(jsonlPath).then(() => {
      expect(cache.readMessageWindow(jsonlPath, 0, 10)).not.toBeNull();
      // Replace with a much shorter file — size now < recorded byte_offset.
      writeFileSync(jsonlPath, `${userLine("z0", "z")}\n`);
      expect(cache.readMessageWindow(jsonlPath, 0, 10)).toBeNull();
    });
  });

  it("clamps an over-wide window to the indexed total", () => {
    const lines = [0, 1].map((i) => userLine(`u${i}`, `m${i}`));
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    return cache.backfillIndex(jsonlPath).then(() => {
      const win = cache.readMessageWindow(jsonlPath, 0, 999);
      expect(win?.messages.map((m) => m.uuid)).toEqual(["u0", "u1"]);
      expect(win?.total).toBe(2);
    });
  });
});
