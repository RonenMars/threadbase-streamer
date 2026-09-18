// Migration 022 drops the offset index for Codex and Cursor files, whose
// message numbering changed with scanner 0.19.0, and leaves Claude's alone.
// The migration already ran when the cache opened, so each test seeds rows and
// re-executes the SQL file against them.
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";

const SQL = readFileSync(
  join(__dirname, "..", "src", "db", "migrations", "022_reindex_codex_cursor_offsets.sql"),
  "utf8",
);

const FILES = {
  codex: {
    provider: "codex-cli",
    path: "/home/dev/.codex/sessions/2026/09/18/rollout-2026-09-18T17-25-17-0001.jsonl",
    id: "rollout-2026-09-18T17-25-17-0001",
  },
  cursor: {
    provider: "cursor",
    path: "/home/dev/.cursor/projects/p/agent-transcripts/aaaa-1111/aaaa-1111.jsonl",
    id: "aaaa-1111",
  },
  claude: {
    provider: "claude-code",
    path: "/home/dev/.claude/projects/p/bbbb-2222.jsonl",
    id: "bbbb-2222",
  },
};

let dbDir: string;
let cache: ConversationCache;

beforeEach(() => {
  dbDir = join(tmpdir(), `reindex-022-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  const db = cache.getDatabase();
  for (const f of Object.values(FILES)) {
    db.prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, updated_at) VALUES (?, ?, ?, 0)",
    ).run(f.id, f.path, f.provider);
    db.prepare(
      `INSERT INTO conversation_file_state (path, identity, size, mtime_ms, byte_offset, last_message_index)
       VALUES (?, 'ino', 10, 0, 10, 1)`,
    ).run(f.path);
    for (const i of [0, 1]) {
      db.prepare(
        `INSERT INTO conversation_message_index (conversation_id, message_index, byte_offset, byte_length)
         VALUES (?, ?, ?, 5)`,
      ).run(f.id, i, i * 5);
    }
  }
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const remaining = () => {
  const db = cache.getDatabase();
  const states = (
    db.prepare("SELECT path FROM conversation_file_state").all() as { path: string }[]
  )
    .map((r) => r.path)
    .sort();
  const ids = (
    db.prepare("SELECT DISTINCT conversation_id AS id FROM conversation_message_index").all() as {
      id: string;
    }[]
  )
    .map((r) => r.id)
    .sort();
  return { states, ids };
};

describe("migration 022 — reindex codex/cursor offsets", () => {
  it("starts with all three files indexed", () => {
    expect(remaining().ids).toEqual([FILES.codex.id, FILES.cursor.id, FILES.claude.id].sort());
  });

  it("drops Codex and Cursor index rows and file state, keeping Claude's", () => {
    cache.getDatabase().exec(SQL);
    expect(remaining()).toEqual({ states: [FILES.claude.path], ids: [FILES.claude.id] });
  });

  it("is idempotent", () => {
    cache.getDatabase().exec(SQL);
    cache.getDatabase().exec(SQL);
    expect(remaining()).toEqual({ states: [FILES.claude.path], ids: [FILES.claude.id] });
  });
});
