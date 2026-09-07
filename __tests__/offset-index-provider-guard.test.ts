import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";
import { fileIdentity, splitCompleteLines } from "../src/utils/fileIdentity";

// Regression guard for the post-1.28.0 hotfix: the offset index parsed every
// file with the claude-code reducer, so a codex-cli file "indexed" as zero
// messages and its file_state (last_message_index = -1, byte_offset = EOF) then
// served empty windows for a real conversation.
//
// Codex is now indexed, with its own reducer, so the guard is no longer
// "exclude codex" — it is "never index a file with a reducer that cannot read
// it". A provider with no reducer still writes nothing, a poisoned row from
// before this change is still never served, and the new obligation is that a
// codex file indexes to the SAME messages a full parse yields, which is the
// property whose absence caused the original incident.

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

const codexMessage = (i: number) =>
  JSON.stringify({
    timestamp: `2026-07-13T11:33:5${i}.000Z`,
    ordinal: i + 1,
    type: "response_item",
    payload: {
      type: "message",
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: i % 2 === 0 ? "input_text" : "output_text", text: `codex msg ${i}` }],
    },
  });

// Never rendered — the reducer drops it, so the index must not count it either.
const codexDeveloperLine = JSON.stringify({
  timestamp: "2026-07-13T11:33:59.000Z",
  ordinal: 99,
  type: "response_item",
  payload: {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "sandbox policy" }],
  },
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
    .run(id, canonicalizeFilePath(filePath), provider);
}

beforeEach(() => {
  dbDir = join(tmpdir(), `provider-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  codexPath = join(dbDir, `${CODEX_CONV}.jsonl`);
  claudePath = join(dbDir, `${CLAUDE_CONV}.jsonl`);
  writeFileSync(
    codexPath,
    `${[codexLine, codexMessage(0), codexMessage(1), codexDeveloperLine, codexMessage(2)].join("\n")}\n`,
  );
  writeFileSync(claudePath, `${[0, 1, 2, 3].map(claudeLine).join("\n")}\n`);
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("offset index provider guard", () => {
  it("backfillIndex on a codex-cli file indexes exactly the messages it renders", async () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    await cache.backfillIndex(codexPath);

    expect(cache.getFileState(codexPath)).not.toBeNull();
    // Three rendered messages — NOT five lines, and not four: session_meta and
    // the developer-role line render as nothing, and an index that counted them
    // would put every message_index one or two out of step with the scanner.
    expect(cache.getIndexedMessageCount(CODEX_CONV)).toBe(3);
  });

  it("serves a codex window with the messages a full parse yields", async () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    await cache.backfillIndex(codexPath);

    const window = cache.readMessageWindow(codexPath, 0, 80);
    expect(window?.total).toBe(3);
    expect(window?.messages.map((m) => m.text)).toEqual([
      "codex msg 0",
      "codex msg 1",
      "codex msg 2",
    ]);
    expect(window?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("extendMessageIndex assigns codex seqs to rendered lines only", () => {
    seedMeta(CODEX_CONV, codexPath, "codex-cli");
    const stat = statSync(codexPath);
    const buf = Buffer.from(`${[codexLine, codexMessage(0), codexDeveloperLine].join("\n")}\n`);
    const { spans } = splitCompleteLines(buf, 0);

    const seqs = cache.extendMessageIndex(codexPath, spans, stat, 0, buf.length);

    // session_meta and developer get no row and no seq; the one real message is 0.
    expect(seqs).toEqual([null, 0, null]);
    expect(cache.getIndexedMessageCount(CODEX_CONV)).toBe(1);
  });

  it("indexes a codex rollout whose filename stem differs from its meta id", async () => {
    // Real codex naming: rollout-<ts>-<uuid>.jsonl, while the meta row's id is
    // the bare uuid — an id-by-filename lookup misses, which is how the first
    // version of this guard failed in production. The provider lookup resolves
    // by path; the index rows key off the stem, and every reader derives that
    // same stem from the same path, so the two never have to agree.
    const rolloutPath = join(dbDir, "rollout-2026-07-13T14-21-49-abc-123.jsonl");
    writeFileSync(rolloutPath, `${[codexLine, codexMessage(0)].join("\n")}\n`);
    seedMeta("abc-123", rolloutPath, "codex-cli");

    await cache.backfillIndex(rolloutPath);

    expect(cache.getFileState(rolloutPath)).not.toBeNull();
    expect(cache.readMessageWindow(rolloutPath, 0, 80)?.messages).toHaveLength(1);
  });

  it("a provider with no reducer is still never indexed", async () => {
    // The guard that survives: an unrecognised provider has no way to be read,
    // and indexing it would write the same empty-window rows the hotfix removed.
    seedMeta(CODEX_CONV, codexPath, "gemini-cli");
    await cache.backfillIndex(codexPath);
    expect(cache.getFileState(codexPath)).toBeNull();
    expect(cache.getIndexedMessageCount(CODEX_CONV)).toBe(0);
  });

  it("backfillIndex purges a poisoned pre-hotfix row it cannot re-index", async () => {
    seedMeta(CODEX_CONV, codexPath, "gemini-cli");
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
});
