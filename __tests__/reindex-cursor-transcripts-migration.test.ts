// Migration 023 drops the offset index for every agent-transcripts file —
// including one still recorded as claude-code, which is exactly the file #929's
// race damaged — and leaves Claude and Codex files alone. The migration already
// ran when the cache opened, so each test seeds rows and re-executes the SQL.
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";

const SQL = readFileSync(
  join(__dirname, "..", "src", "db", "migrations", "023_reindex_cursor_transcript_offsets.sql"),
  "utf8",
);

const FILES = {
  cursor: {
    provider: "cursor",
    path: "/home/dev/.cursor/projects/p/agent-transcripts/aaaa-1111/aaaa-1111.jsonl",
    id: "aaaa-1111",
  },
  misclassified: {
    provider: "claude-code",
    path: "/home/dev/.cursor/projects/p/agent-transcripts/cccc-3333/cccc-3333.jsonl",
    id: "cccc-3333",
  },
  claude: {
    provider: "claude-code",
    path: "/home/dev/.claude/projects/p/bbbb-2222.jsonl",
    id: "bbbb-2222",
  },
  codex: {
    provider: "codex-cli",
    path: "/home/dev/.codex/sessions/2026/09/19/rollout-2026-09-19T10-00-00-dddd.jsonl",
    id: "rollout-2026-09-19T10-00-00-dddd",
  },
};

let dbDir: string;
let cache: ConversationCache;

beforeEach(() => {
  dbDir = join(tmpdir(), `reindex-023-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const kept = {
  states: [FILES.claude.path, FILES.codex.path].sort(),
  ids: [FILES.claude.id, FILES.codex.id].sort(),
};

describe("migration 023 — reindex cursor transcript offsets", () => {
  it("starts with all four files indexed", () => {
    expect(remaining().ids).toHaveLength(4);
  });

  it("drops every agent-transcripts file, including one still recorded as claude-code", () => {
    cache.getDatabase().exec(SQL);
    expect(remaining()).toEqual(kept);
  });

  it("is idempotent", () => {
    cache.getDatabase().exec(SQL);
    cache.getDatabase().exec(SQL);
    expect(remaining()).toEqual(kept);
  });
});
