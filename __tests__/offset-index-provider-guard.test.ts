import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { fileIdentity, splitCompleteLines } from "../src/utils/fileIdentity";

// Regression guard for the post-1.28.0 hotfix: the offset index parses with the
// claude-code reducer, so a codex-cli file "indexed" as zero messages and its
// file_state (last_message_index = -1, byte_offset = EOF) then served empty
// windows for a real conversation. Non-claude providers must never enter the
// index, and a poisoned row must never be served.

let dbDir: string;
let cache: ConversationCache;

const CODEX_CONV = "rollout-codex-1";
const CLAUDE_CONV = "claude-conv-1";
let codexPath: string;
let claudePath: string;

const codexLine = JSON.stringify({
  timestamp: "2026-07-13T11:33:44.087Z",
  type: "session_meta",
  payload: { session_id: CODEX_CONV, cwd: "/tmp", originator: "codex-tui" },
});

const claudeLine = (i: number) =>
  JSON.stringify({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: `u${i}`,
    timestamp: `2026-07-13T10:00:0${i % 10}.000Z`,
    sessionId: CLAUDE_CONV,
    cwd: "/tmp",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `msg ${i}` }],
    },
  });

function seedMeta(id: string, filePath: string, provider: string): void {
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, ?, 5, 1)",
    )
    .run(id, filePath, provider);
}

beforeEach(() => {
  dbDir = join(tmpdir(), `provider-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  codexPath = join(dbDir, `${CODEX_CONV}.jsonl`);
  claudePath = join(dbDir, `${CLAUDE_CONV}.jsonl`);
  writeFileSync(codexPath, `${[codexLine, codexLine, codexLine].join("\n")}\n`);
  writeFileSync(claudePath, `${[0, 1, 2, 3].map(claudeLine).join("\n")}\n`);
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("offset index provider guard", () => {
  it("backfillIndex on a codex-cli file writes no file_state and no rows", async () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    await cache.backfillIndex(codexPath);
    expect(cache.getFileState(codexPath)).toBeNull();
    expect(cache.getIndexedMessageCount(CODEX_CONV)).toBe(0);
  });

  it("backfillIndex purges a poisoned pre-hotfix row for a codex file", async () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    const stat = statSync(codexPath);
    cache.upsertFileState({
      path: codexPath,
      identity: fileIdentity(stat),
      size: stat.size,
      mtime_ms: Math.round(stat.mtimeMs),
      byte_offset: stat.size,
      last_message_index: -1,
    });
    await cache.backfillIndex(codexPath);
    expect(cache.getFileState(codexPath)).toBeNull();
  });

  it("extendMessageIndex on a codex file writes nothing and returns all-null seqs (not a decline)", () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    const stat = statSync(codexPath);
    const buf = Buffer.from(`${codexLine}\n`);
    const { spans } = splitCompleteLines(buf, 0);
    const seqs = cache.extendMessageIndex(codexPath, spans, stat, 0, buf.length);
    expect(seqs).toEqual([null]);
    expect(cache.getFileState(codexPath)).toBeNull();
    expect(cache.getIndexedMessageCount(CODEX_CONV)).toBe(0);
  });

  it("readMessageWindow declines a poisoned row (last_message_index = -1) that matches the file exactly", () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    const stat = statSync(codexPath);
    cache.upsertFileState({
      path: codexPath,
      identity: fileIdentity(stat),
      size: stat.size,
      mtime_ms: Math.round(stat.mtimeMs),
      byte_offset: stat.size,
      last_message_index: -1,
    });
    expect(cache.readMessageWindow(codexPath, 0, 80)).toBeNull();
  });

  it("claude-code files still index and serve (guard does not over-block)", async () => {
    seedMeta(CLAUDE_CONV, claudePath, "claude-code");
    await cache.backfillIndex(claudePath);
    expect(cache.getFileState(claudePath)).not.toBeNull();
    expect(cache.getIndexedMessageCount(CLAUDE_CONV)).toBe(4);
    const window = cache.readMessageWindow(claudePath, 0, 80);
    expect(window?.total).toBe(4);
    expect(window?.messages).toHaveLength(4);
  });

  it("files with no cached meta are NOT indexable (provider unknown = unsafe)", async () => {
    // No conversation_meta row at all: the provider is unknown, so indexing
    // is declined. A later request backfills once the meta row exists.
    await cache.backfillIndex(claudePath);
    expect(cache.getFileState(claudePath)).toBeNull();
  });

  it("guards a codex rollout file whose filename stem differs from its meta id", async () => {
    // Real codex naming: rollout-<ts>-<uuid>.jsonl, while the meta row's id is
    // the bare uuid — an id-by-filename lookup misses, which is exactly how the
    // first version of this guard failed in production. The by-path lookup
    // must resolve it.
    const rolloutPath = join(dbDir, "rollout-2026-07-13T14-21-49-abc-123.jsonl");
    writeFileSync(rolloutPath, `${codexLine}\n`);
    seedMeta("abc-123", rolloutPath, "codex-cli");
    await cache.backfillIndex(rolloutPath);
    expect(cache.getFileState(rolloutPath)).toBeNull();
  });
});
