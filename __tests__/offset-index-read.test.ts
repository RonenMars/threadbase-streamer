import * as fs from "fs";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
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

  it("returns null when the file GREW past the index (untailed appends)", async () => {
    // The index must never serve a slice of a file that grew beyond byte_offset
    // — those appended messages aren't indexed yet, so a slice would silently
    // drop them. This is the live-append bug: an append with no watcher
    // extending the index must force a scanner fallback + re-backfill, not a
    // truncated view. (Regression guard.)
    const lines = [0, 1].map((i) => userLine(`u${i}`, `m${i}`));
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    await cache.backfillIndex(jsonlPath);
    expect(cache.readMessageWindow(jsonlPath, 0, 10)?.total).toBe(2);

    // Append a 3rd message directly (no incremental extend). size > byte_offset.
    appendFileSync(jsonlPath, `${userLine("u2", "m2")}\n`);
    expect(cache.readMessageWindow(jsonlPath, 0, 10)).toBeNull();

    // A re-backfill re-covers the file, and the read now returns all three.
    await cache.backfillIndex(jsonlPath);
    const win = cache.readMessageWindow(jsonlPath, 0, 10);
    expect(win?.total).toBe(3);
    expect(win?.messages.map((m) => m.uuid)).toEqual(["u0", "u1", "u2"]);
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

  it("windowed read of a tool_use → tool_result pair matches a full contiguous parse", async () => {
    // readMessageWindow parses each windowed line with a FRESH parse state (no
    // cross-line reducer seeding), so a tool_result whose tool_use is outside
    // the window can't pick up any state-dependent enrichment. This test pins
    // that the windowed output is byte-identical to a full contiguous parse for
    // a real tool_use/tool_result pair — if a future scanner version makes the
    // per-line output depend on reducer state, this fails instead of silently
    // degrading the detail payload.
    const asst = JSON.stringify({
      type: "assistant",
      uuid: "a0",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess",
      cwd: "/project",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
      },
    });
    const result = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: "sess",
      cwd: "/project",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }],
      },
    });
    const trailer = userLine("u2", "after");
    const content = `${asst}\n${result}\n${trailer}\n`;
    writeFileSync(jsonlPath, content);

    // Full contiguous parse (shared state across all lines), from the backfill.
    await cache.backfillIndex(jsonlPath);
    const full = cache.readMessageWindow(jsonlPath, 0, 999);

    // A window that STARTS at the tool_result (its tool_use is outside the
    // window) — the enrichment-gap case. Must be identical to the same messages
    // in the full parse.
    const windowed = cache.readMessageWindow(jsonlPath, 1, 3);
    expect(windowed?.messages).toEqual(full?.messages.slice(1));
  });
});
