# Cache Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SQLite-backed `ConversationCache` that serves `/api/conversations` and `/api/conversations/{id}` (tail) from disk-persisted cache updated in real-time by the FileWatcher, eliminating scanner disk I/O on every request and making history cold-starts and conversation opens instant.

**Architecture:** A new `src/conversation-cache.ts` module wraps `better-sqlite3` with two tables (`conversation_meta` and `conversation_tail`). It is wired into the `FileWatcher`'s `onNewLine` callback alongside the WsHub broadcast, and populated from the scanner's metadata map on startup. REST endpoints read from cache first, fall back to scanner on miss. Process discovery in `/api/sessions` gets a 5s in-memory TTL cache.

**Tech Stack:** TypeScript, `better-sqlite3` (synchronous SQLite), vitest (existing), existing `FileWatcher`, `ConversationScanner` from `@threadbase/scanner`

**Spec:** `docs/superpowers/specs/2026-04-30-cache-layer-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/conversation-cache.ts` | **Create** | `ConversationCache` class — schema, all SQLite reads/writes |
| `src/__tests__/conversation-cache.test.ts` | **Create** | Unit tests for all public methods |
| `src/auth.ts` | **Modify** | Add `loadCacheDir()` and `loadTailSize()` — same regex pattern as existing loaders |
| `src/types.ts` | **Modify** | Add `cacheDir?` and `tailSize?` to `ServerConfig` |
| `src/server.ts` | **Modify** | Wire cache into startup, list/count/detail endpoints, FileWatcher callback, discovery TTL |
| `package.json` | **Modify** | Add `better-sqlite3` + `@types/better-sqlite3` |

---

## Task 1: Install `better-sqlite3`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

```bash
npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3
```

Expected: `package.json` gains `"better-sqlite3"` in `dependencies` and `"@types/better-sqlite3"` in `devDependencies`. No errors.

- [ ] **Step 2: Verify TypeScript can see the types**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add package.json package-lock.json && git commit -m "chore: add better-sqlite3 dependency"
```

---

## Task 2: Add config loaders and `ServerConfig` fields

**Files:**
- Modify: `src/auth.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add `loadCacheDir()` and `loadTailSize()` to `src/auth.ts`**

Open `src/auth.ts`. After the existing `loadPublicUrl()` function (the last function in the file, ends around line 54), add:

```ts
export function loadCacheDir(): string | undefined {
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const match = content.match(/cache_dir:\s*(.+)/);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

export function loadTailSize(): number | undefined {
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const match = content.match(/tail_size:\s*(\d+)/);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}
```

- [ ] **Step 2: Add fields to `ServerConfig` in `src/types.ts`**

Open `src/types.ts`. Find the `ServerConfig` interface. Add two optional fields after `idleSweeperIntervalMs?`:

```ts
  cacheDir?: string;
  tailSize?: number;
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/auth.ts src/types.ts && git commit -m "feat: add cacheDir and tailSize config fields"
```

---

## Task 3: Write failing tests for `ConversationCache`

**Files:**
- Create: `src/__tests__/conversation-cache.test.ts`

All tests will fail until Task 4 creates the implementation — that is correct.

- [ ] **Step 1: Create `src/__tests__/conversation-cache.test.ts`**

```ts
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../conversation-cache";

let dbDir: string;
let cache: ConversationCache;

beforeEach(() => {
  dbDir = join(tmpdir(), `conv-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"), 3);
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const BASE_META = {
  id: "abc-123",
  sessionId: "abc-123",
  filePath: "/home/.claude/projects/proj/abc-123.jsonl",
  projectPath: "/home/proj",
  projectName: "My Project",
  title: "My Project",
  model: "claude-3-5-sonnet",
  account: "acc1",
  gitBranch: "main",
  messageCount: 2,
  timestamp: "2024-01-01T10:00:00.000Z",
  firstMessage: null,
  lastMessage: null,
  preview: "Hello",
};

describe("open()", () => {
  it("creates tables idempotently (opening same db twice does not throw)", () => {
    const cache2 = ConversationCache.open(join(dbDir, "cache.db"), 3);
    cache2.close();
  });
});

describe("upsertFromScannerMeta()", () => {
  it("inserts a new row", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
  });

  it("inserts multiple rows in batch", () => {
    const metas = [
      { ...BASE_META, id: "id-1", sessionId: "id-1", filePath: "/p/id-1.jsonl" },
      { ...BASE_META, id: "id-2", sessionId: "id-2", filePath: "/p/id-2.jsonl" },
      { ...BASE_META, id: "id-3", sessionId: "id-3", filePath: "/p/id-3.jsonl" },
    ];
    cache.upsertFromScannerMeta(metas as any);
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("does not overwrite a row updated within 24h", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    // Simulate a new line arriving (message_count goes from 2 to 3)
    cache.updateFromLine(BASE_META.filePath, JSON.stringify({
      role: "user",
      timestamp: "2024-01-01T10:01:00.000Z",
      content: [{ type: "text", text: "new message" }],
    }));
    // Re-upsert with original messageCount: 2 — should not overwrite the fresh row
    cache.upsertFromScannerMeta([BASE_META as any]);
    const result = cache.listConversations({ limit: 10, offset: 0 });
    expect(result.conversations[0].messageCount).toBe(3);
  });
});

describe("updateFromLine()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([BASE_META as any]);
  });

  it("increments message_count by 1", () => {
    cache.updateFromLine(BASE_META.filePath, JSON.stringify({
      role: "user",
      timestamp: "2024-01-01T10:01:00.000Z",
      content: [{ type: "text", text: "hi" }],
    }));
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(3);
  });

  it("updates last_activity to the line timestamp", () => {
    cache.updateFromLine(BASE_META.filePath, JSON.stringify({
      role: "assistant",
      timestamp: "2024-06-15T08:30:00.000Z",
      content: [{ type: "text", text: "reply" }],
    }));
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].lastActivity).toBe("2024-06-15T08:30:00.000Z");
  });

  it("appends messages to tail and trims to tailSize (3)", () => {
    for (let i = 0; i < 5; i++) {
      cache.updateFromLine(BASE_META.filePath, JSON.stringify({
        role: "user",
        timestamp: `2024-01-0${i + 2}T00:00:00.000Z`,
        content: [{ type: "text", text: `msg ${i}` }],
      }));
    }
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail!.messages).toHaveLength(3);
    expect(tail!.messages[2].text).toContain("msg 4");
  });

  it("ignores lines that are not valid JSON", () => {
    cache.updateFromLine(BASE_META.filePath, "not json at all");
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(2);
  });

  it("does not throw for an unknown file path", () => {
    expect(() => {
      cache.updateFromLine("/unknown/path.jsonl", JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T00:00:00.000Z",
        content: [{ type: "text", text: "msg" }],
      }));
    }).not.toThrow();
  });
});

describe("listConversations()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "conv-a", sessionId: "conv-a", filePath: "/p/a.jsonl",
        projectPath: "/proj/alpha", projectName: "Alpha", timestamp: "2024-03-01T00:00:00.000Z" },
      { ...BASE_META, id: "conv-b", sessionId: "conv-b", filePath: "/p/b.jsonl",
        projectPath: "/proj/beta", projectName: "Beta", timestamp: "2024-01-01T00:00:00.000Z" },
      { ...BASE_META, id: "conv-c", sessionId: "conv-c", filePath: "/p/c.jsonl",
        projectPath: "/proj/alpha", projectName: "Alpha", timestamp: "2024-06-01T00:00:00.000Z" },
    ] as any);
  });

  it("returns total count", () => {
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("returns total without rows when limit is 0", () => {
    const r = cache.listConversations({ limit: 0, offset: 0 });
    expect(r.total).toBe(3);
    expect(r.conversations).toHaveLength(0);
  });

  it("filters by project", () => {
    const r = cache.listConversations({ limit: 10, offset: 0, project: "/proj/alpha" });
    expect(r.total).toBe(2);
    expect(r.conversations.every((c) => c.projectPath === "/proj/alpha")).toBe(true);
  });

  it("paginates correctly", () => {
    const page1 = cache.listConversations({ limit: 2, offset: 0 });
    const page2 = cache.listConversations({ limit: 2, offset: 2 });
    expect(page1.conversations).toHaveLength(2);
    expect(page2.conversations).toHaveLength(1);
  });

  it("sorts by last_activity descending by default", () => {
    const r = cache.listConversations({ limit: 10, offset: 0 });
    const times = r.conversations.map((c) => new Date(c.lastActivity).getTime());
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });
});

describe("getConversationTail()", () => {
  it("returns null for unknown id", () => {
    expect(cache.getConversationTail("nonexistent")).toBeNull();
  });

  it("returns null when conversation exists but has no tail", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.getConversationTail("abc-123")).toBeNull();
  });

  it("returns messages after updateFromLine calls", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLine(BASE_META.filePath, JSON.stringify({
      role: "user",
      timestamp: "2024-01-01T10:00:00.000Z",
      content: [{ type: "text", text: "hello" }],
    }));
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail!.messages).toHaveLength(1);
    expect(tail!.messages[0].role).toBe("user");
    expect(tail!.messages[0].text).toBe("hello");
  });
});

describe("hasConversation()", () => {
  it("returns false for unknown id", () => {
    expect(cache.hasConversation("unknown")).toBe(false);
  });

  it("returns true after upsert", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
  });
});

describe("invalidate()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "inv-1", sessionId: "inv-1", filePath: "/p/inv-1.jsonl" },
      { ...BASE_META, id: "inv-2", sessionId: "inv-2", filePath: "/p/inv-2.jsonl" },
    ] as any);
  });

  it("with no args clears all rows", () => {
    cache.invalidate();
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("with id removes only that row", () => {
    cache.invalidate("inv-1");
    expect(cache.hasConversation("inv-1")).toBe(false);
    expect(cache.hasConversation("inv-2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — confirm all fail**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx vitest run __tests__/conversation-cache.test.ts 2>&1 | tail -10
```

Expected: all fail with `Cannot find module '../conversation-cache'`.

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/__tests__/conversation-cache.test.ts && git commit -m "test: add failing ConversationCache tests"
```

---

## Task 4: Implement `ConversationCache`

**Files:**
- Create: `src/conversation-cache.ts`

- [ ] **Step 1: Create `src/conversation-cache.ts`**

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface ConversationListItem {
  id: string;
  filePath: string;
  projectPath: string | null;
  projectName: string | null;
  title: string | null;
  model: string | null;
  account: string | null;
  branch: string | null;
  messageCount: number;
  lastActivity: string;
  firstMessage: string | null;
  lastMessage: string | null;
  preview: string | null;
}

export interface CachedTailMessage {
  role: string;
  timestamp: string;
  text: string;
}

export interface CachedTail {
  conversationId: string;
  messages: CachedTailMessage[];
  tailSize: number;
}

export interface ScannerMeta {
  id: string;
  sessionId?: string;
  filePath: string;
  projectPath?: string;
  projectName?: string;
  title?: string;
  model?: string;
  account?: string;
  gitBranch?: string;
  messageCount?: number;
  timestamp?: string;
  firstMessage?: unknown;
  lastMessage?: unknown;
  preview?: string;
}

interface MetaRow {
  id: string;
  file_path: string;
  project_path: string | null;
  project_name: string | null;
  title: string | null;
  model: string | null;
  account: string | null;
  branch: string | null;
  message_count: number;
  last_activity: number | null;
  first_message: string | null;
  last_message: string | null;
  preview: string | null;
  updated_at: number;
}

interface TailRow {
  conversation_id: string;
  messages_json: string;
  tail_size: number;
  updated_at: number;
}

interface JsonlLine {
  role?: string;
  type?: string;
  timestamp?: string;
  content?: Array<{ type: string; text?: string }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_meta (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  project_path  TEXT,
  project_name  TEXT,
  title         TEXT,
  model         TEXT,
  account       TEXT,
  branch        TEXT,
  message_count INTEGER DEFAULT 0,
  last_activity INTEGER,
  first_message TEXT,
  last_message  TEXT,
  preview       TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_last_activity ON conversation_meta(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_meta_project ON conversation_meta(project_path);

CREATE TABLE IF NOT EXISTS conversation_tail (
  conversation_id TEXT PRIMARY KEY REFERENCES conversation_meta(id) ON DELETE CASCADE,
  messages_json   TEXT NOT NULL,
  tail_size       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`;

export class ConversationCache {
  private db: Database.Database;
  private tailSize: number;
  private fileIndex = new Map<string, string>();
  private fileIndexLoaded = false;

  private stmts: {
    getById: Database.Statement;
    updateMeta: Database.Statement;
    insertSkeleton: Database.Statement;
    upsertFull: Database.Statement;
    getTail: Database.Statement;
    upsertTail: Database.Statement;
    list: Database.Statement;
    count: Database.Statement;
    listByProject: Database.Statement;
    countByProject: Database.Statement;
    deleteById: Database.Statement;
    deleteAll: Database.Statement;
    deleteTailAll: Database.Statement;
    allFilePaths: Database.Statement;
  };

  private constructor(db: Database.Database, tailSize: number) {
    this.db = db;
    this.tailSize = tailSize;
    db.exec(SCHEMA);
    this.stmts = {
      getById: db.prepare("SELECT id FROM conversation_meta WHERE id = ?"),
      updateMeta: db.prepare(
        "UPDATE conversation_meta SET message_count = message_count + 1, last_activity = ?, last_message = ?, updated_at = ? WHERE id = ?",
      ),
      insertSkeleton: db.prepare(
        "INSERT OR IGNORE INTO conversation_meta (id, file_path, message_count, updated_at) VALUES (?, ?, 1, ?)",
      ),
      upsertFull: db.prepare(`
        INSERT INTO conversation_meta
          (id, file_path, project_path, project_name, title, model, account, branch,
           message_count, last_activity, first_message, last_message, preview, updated_at)
        VALUES
          (@id, @file_path, @project_path, @project_name, @title, @model, @account, @branch,
           @message_count, @last_activity, @first_message, @last_message, @preview, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          file_path     = excluded.file_path,
          project_path  = excluded.project_path,
          project_name  = excluded.project_name,
          title         = excluded.title,
          model         = excluded.model,
          account       = excluded.account,
          branch        = excluded.branch,
          message_count = excluded.message_count,
          last_activity = excluded.last_activity,
          first_message = excluded.first_message,
          last_message  = excluded.last_message,
          preview       = excluded.preview,
          updated_at    = excluded.updated_at
        WHERE conversation_meta.updated_at < excluded.updated_at - 86400000
      `),
      getTail: db.prepare("SELECT * FROM conversation_tail WHERE conversation_id = ?"),
      upsertTail: db.prepare(`
        INSERT INTO conversation_tail (conversation_id, messages_json, tail_size, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          messages_json = excluded.messages_json,
          tail_size     = excluded.tail_size,
          updated_at    = excluded.updated_at
      `),
      list: db.prepare("SELECT * FROM conversation_meta ORDER BY last_activity DESC LIMIT ? OFFSET ?"),
      count: db.prepare("SELECT COUNT(*) as n FROM conversation_meta"),
      listByProject: db.prepare(
        "SELECT * FROM conversation_meta WHERE project_path = ? ORDER BY last_activity DESC LIMIT ? OFFSET ?",
      ),
      countByProject: db.prepare("SELECT COUNT(*) as n FROM conversation_meta WHERE project_path = ?"),
      deleteById: db.prepare("DELETE FROM conversation_meta WHERE id = ?"),
      deleteAll: db.prepare("DELETE FROM conversation_meta"),
      deleteTailAll: db.prepare("DELETE FROM conversation_tail"),
      allFilePaths: db.prepare("SELECT id, file_path FROM conversation_meta"),
    };
  }

  static open(dbPath: string, tailSize = 10): ConversationCache {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return new ConversationCache(db, tailSize);
  }

  close(): void {
    this.db.close();
  }

  private ensureFileIndex(): void {
    if (this.fileIndexLoaded) return;
    const rows = this.stmts.allFilePaths.all() as Array<{ id: string; file_path: string }>;
    for (const row of rows) {
      this.fileIndex.set(row.file_path, row.id);
    }
    this.fileIndexLoaded = true;
  }

  updateFromLine(filePath: string, rawLine: string): void {
    let line: JsonlLine;
    try {
      line = JSON.parse(rawLine);
    } catch {
      return;
    }

    const role = line.role ?? line.type;
    if (!role) return;

    const timestamp = line.timestamp ?? new Date().toISOString();
    const activityMs = new Date(timestamp).getTime();
    if (Number.isNaN(activityMs)) return;

    const text = line.content?.find((b) => b.type === "text")?.text?.slice(0, 200) ?? "";
    const lastMessage = JSON.stringify({ role, timestamp, text });
    const now = Date.now();

    this.ensureFileIndex();

    let convId = this.fileIndex.get(filePath);
    if (!convId) {
      const pseudoId = filePath.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") ?? filePath;
      this.stmts.insertSkeleton.run(pseudoId, filePath, now);
      this.fileIndex.set(filePath, pseudoId);
      convId = pseudoId;
    }

    const result = this.stmts.updateMeta.run(activityMs, lastMessage, now, convId);
    if (result.changes === 0) return;

    const tailRow = this.stmts.getTail.get(convId) as TailRow | undefined;
    const msgs: CachedTailMessage[] = tailRow
      ? (JSON.parse(tailRow.messages_json) as CachedTailMessage[])
      : [];

    msgs.push({ role, timestamp, text });
    if (msgs.length > this.tailSize) msgs.splice(0, msgs.length - this.tailSize);

    this.stmts.upsertTail.run(convId, JSON.stringify(msgs), msgs.length, now);
  }

  upsertFromScannerMeta(metas: ScannerMeta[]): void {
    const cutoff = Date.now() - 86_400_000;
    const run = this.db.transaction((items: ScannerMeta[]) => {
      for (const m of items) {
        const id = m.sessionId || m.id.split("/").pop()?.replace(/\.jsonl$/, "") || m.id;
        const lastActivityMs = m.timestamp ? new Date(m.timestamp).getTime() : null;
        this.stmts.upsertFull.run({
          id,
          file_path: m.filePath,
          project_path: m.projectPath ?? null,
          project_name: m.projectName ?? null,
          title: m.projectName ?? null,
          model: m.model ?? null,
          account: m.account ?? null,
          branch: m.gitBranch ?? null,
          message_count: m.messageCount ?? 0,
          last_activity: lastActivityMs,
          first_message: m.firstMessage ? JSON.stringify(m.firstMessage) : null,
          last_message: m.lastMessage ? JSON.stringify(m.lastMessage) : null,
          preview: m.preview ?? null,
          updated_at: cutoff - 1,
        });
        if (this.fileIndexLoaded) this.fileIndex.set(m.filePath, id);
      }
    });
    run(metas);
  }

  listConversations(opts: {
    project?: string;
    limit: number;
    offset: number;
  }): { conversations: ConversationListItem[]; total: number } {
    const { project, limit, offset } = opts;
    let total: number;
    let rows: MetaRow[];

    if (project) {
      total = (this.stmts.countByProject.get(project) as { n: number }).n;
      rows = limit === 0 ? [] : (this.stmts.listByProject.all(project, limit, offset) as MetaRow[]);
    } else {
      total = (this.stmts.count.get() as { n: number }).n;
      rows = limit === 0 ? [] : (this.stmts.list.all(limit, offset) as MetaRow[]);
    }

    return {
      total,
      conversations: rows.map((r) => ({
        id: r.id,
        filePath: r.file_path,
        projectPath: r.project_path,
        projectName: r.project_name,
        title: r.title,
        model: r.model,
        account: r.account,
        branch: r.branch,
        messageCount: r.message_count,
        lastActivity: r.last_activity
          ? new Date(r.last_activity).toISOString()
          : new Date(0).toISOString(),
        firstMessage: r.first_message,
        lastMessage: r.last_message,
        preview: r.preview,
      })),
    };
  }

  getConversationTail(id: string): CachedTail | null {
    const row = this.stmts.getTail.get(id) as TailRow | undefined;
    if (!row) return null;
    return {
      conversationId: id,
      messages: JSON.parse(row.messages_json) as CachedTailMessage[],
      tailSize: row.tail_size,
    };
  }

  hasConversation(id: string): boolean {
    return !!this.stmts.getById.get(id);
  }

  invalidate(id?: string): void {
    if (id) {
      this.stmts.deleteById.run(id);
      if (this.fileIndexLoaded) {
        for (const [fp, cid] of this.fileIndex) {
          if (cid === id) { this.fileIndex.delete(fp); break; }
        }
      }
    } else {
      this.stmts.deleteTailAll.run();
      this.stmts.deleteAll.run();
      this.fileIndex.clear();
    }
  }
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx vitest run __tests__/conversation-cache.test.ts 2>&1 | tail -30
```

Expected: all tests pass. Fix any failures before proceeding.

- [ ] **Step 3: Run full suite to confirm no regressions**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm test 2>&1 | tail -15
```

- [ ] **Step 4: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/conversation-cache.ts && git commit -m "feat: implement ConversationCache with SQLite"
```

---

## Task 5: Wire `ConversationCache` into server startup and FileWatcher

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add import and private fields**

At the top of `src/server.ts`, add the import (alongside existing imports):

```ts
import { ConversationCache } from "./conversation-cache";
```

And update the `loadBrowseRoot` import line to also import the new loaders:

```ts
import { loadBrowseRoot, loadCacheDir, loadPublicUrl, loadTailSize, validateApiKey, validatePublicUrl } from "./auth";
```

Add two private fields to the `StreamerServer` class alongside the existing fields:

```ts
  private cache: ConversationCache | null = null;
  private cacheDir: string;
  private tailSize: number;
```

- [ ] **Step 2: Initialize `cacheDir` and `tailSize` in the constructor**

In the `StreamerServer` constructor, after the line `this.idleTimeoutMs = config.idleTimeoutMs ?? 60_000;`, add:

```ts
    this.cacheDir = config.cacheDir ?? loadCacheDir() ?? join(homedir(), ".threadbase", "cache");
    this.tailSize = config.tailSize ?? loadTailSize() ?? 10;
```

(`homedir` and `join` are already imported in `server.ts` — confirm with `grep "homedir\|from.*path" src/server.ts | head -5` before adding a duplicate import.)

- [ ] **Step 3: Open cache in `listen()` and populate after scanner warm-up**

In `listen()`, find this line:

```ts
        void this.getScanner().catch(() => {});
```

Replace it with:

```ts
        try {
          this.cache = ConversationCache.open(join(this.cacheDir, "cache.db"), this.tailSize);
        } catch (err) {
          console.warn("ConversationCache failed to open (running without cache):", err);
        }
        void this.getScanner()
          .then((scanner) => {
            if (!this.cache) return;
            this.cache.upsertFromScannerMeta([...scanner.getMetadataCache().values()] as any[]);
          })
          .catch(() => {});
```

- [ ] **Step 4: Add cache subscriber to FileWatcher callback**

Find the `FileWatcher` constructor call (the `onNewLine` handler). Add one line at the very start of the callback body:

```ts
      onNewLine: (filePath, line) => {
        this.cache?.updateFromLine(filePath, line);   // ← add this line
        // Find which session this file belongs to
        for (const [sessionId, watchedPath] of this.sessionFileMap) {
```

- [ ] **Step 5: Close cache in `close()`**

Find the `close()` method. Add `this.cache?.close();` alongside the other cleanup calls.

- [ ] **Step 6: Verify TypeScript**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 7: Run tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm test 2>&1 | tail -15
```

- [ ] **Step 8: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/server.ts && git commit -m "feat: wire ConversationCache into server startup and FileWatcher"
```

---

## Task 6: Serve `/api/conversations` and `/api/conversations/count` from cache

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Replace `handleListConversations` body**

Find `private async handleListConversations(url: URL, res: ServerResponse)`. Replace its entire body with:

```ts
    const limit = intParam(url, "limit", 50);
    const offset = intParam(url, "offset", 0);
    const sort = (url.searchParams.get("sort") ?? "recent") as SortOrder;
    const project = url.searchParams.get("project") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    if (bustCache) {
      this.cache?.invalidate();
      this.scanner = null;
      this.scannerReady = null;
    }

    if (this.cache && !bustCache) {
      const { conversations, total } = this.cache.listConversations({ project, limit, offset });
      const adapted = conversations.map((c) => ({
        id: c.id,
        title: c.projectName,
        sessionName: undefined as string | undefined,
        filePath: c.filePath,
        projectPath: c.projectPath,
        branch: c.branch ?? undefined,
        account: c.account ?? undefined,
        preview: c.preview ?? undefined,
        messageCount: c.messageCount,
        lastActivity: c.lastActivity,
        firstMessage: c.firstMessage ? (JSON.parse(c.firstMessage) as unknown) : undefined,
        lastMessage: c.lastMessage ? (JSON.parse(c.lastMessage) as unknown) : undefined,
        model: c.model ?? undefined,
      }));
      json(res, 200, { conversations: adapted, hasMore: offset + limit < total, offset, total });
      return;
    }

    // Fallback: scanner (first boot before cache is populated, or after bust)
    const scanner = await this.getScanner();
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) metas = applyProjectFilter(metas, project);
    metas = applySort(metas, sort);
    const total = metas.length;
    const page = applyPagination(metas, limit, offset);

    const adapted = (page.items as ConversationMeta[]).map((c) => ({
      id: c.sessionId || c.id.split("/").pop()?.replace(/\.jsonl$/, "") || c.id,
      title: c.projectName,
      sessionName: c.sessionName || undefined,
      filePath: c.filePath,
      projectPath: c.projectPath,
      branch: c.gitBranch ?? undefined,
      account: c.account,
      preview: c.preview || undefined,
      messageCount: c.messageCount,
      lastActivity: c.timestamp,
      firstMessage: c.firstMessage ?? undefined,
      lastMessage: c.lastMessage ?? undefined,
      model: c.model ?? undefined,
    }));
    json(res, 200, { conversations: adapted, hasMore: offset + limit < total, offset, total });

    if (this.cache && bustCache) {
      this.cache.upsertFromScannerMeta([...scanner.getMetadataCache().values()] as any[]);
    }
```

- [ ] **Step 2: Replace `handleConversationsCount` body**

Find `private async handleConversationsCount(url: URL, res: ServerResponse)`. Replace its entire body with:

```ts
    const project = url.searchParams.get("project") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    if (bustCache) {
      this.cache?.invalidate();
      this.scanner = null;
      this.scannerReady = null;
    }

    if (this.cache && !bustCache) {
      const { total } = this.cache.listConversations({ project, limit: 0, offset: 0 });
      json(res, 200, { total });
      return;
    }

    const scanner = await this.getScanner();
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) metas = applyProjectFilter(metas, project);
    json(res, 200, { total: metas.length });
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm test 2>&1 | tail -15
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/server.ts && git commit -m "feat: serve /api/conversations and /count from SQLite cache"
```

---

## Task 7: Serve conversation tail from cache in `handleGetConversation`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add cache tail check at start of `handleGetConversation`**

Find `private async handleGetConversation(id: string, url: URL, res: ServerResponse)`. The current first line is:

```ts
    const conversation = await this.findConversationByUuid(id);
```

Add the following block immediately before it:

```ts
    const usePaging = url.searchParams.has("msg_limit") || url.searchParams.has("before_index");
    if (!usePaging && this.cache) {
      const tail = this.cache.getConversationTail(id);
      if (tail && tail.messages.length > 0) {
        const messagesPayload = tail.messages.map((m, idx) => ({
          message_index: idx,
          role: m.role,
          timestamp: m.timestamp,
          text: m.text,
          tool_calls: [] as unknown[],
          content: [] as unknown[],
        }));
        json(res, 200, {
          meta: { id },
          messages: messagesPayload,
          message_pagination: {
            total: tail.tailSize,
            before_index: tail.tailSize,
            from_index: 0,
            has_more_older: false,
            next_before_index: null,
          },
        });
        return;
      }
    }
```

The rest of the method (the `findConversationByUuid` path) is unchanged — it remains as the fallback for paginated requests and cache misses.

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm test 2>&1 | tail -15
```

- [ ] **Step 4: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/server.ts && git commit -m "feat: serve conversation tail from SQLite cache"
```

---

## Task 8: Add 5s TTL cache for process discovery in `handleListSessions`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add `discoveryCache` private field**

Add alongside the other private fields in `StreamerServer`:

```ts
  private discoveryCache: { entries: ReturnType<typeof discoverClaudeProcesses>; fetchedAt: number } | null = null;
```

- [ ] **Step 2: Replace `handleListSessions` body**

Find `private handleListSessions(res: ServerResponse)`. Replace its entire body with:

```ts
    const DISCOVERY_TTL_MS = 5_000;
    const now = Date.now();

    if (!this.discoveryCache || now - this.discoveryCache.fetchedAt >= DISCOVERY_TTL_MS) {
      try {
        const discovered = discoverClaudeProcesses();
        this.sessionStore.setDiscovered(discovered);
        this.discoveryCache = { entries: discovered, fetchedAt: now };
      } catch {
        // Discovery is best-effort
      }
    }

    json(res, 200, this.sessionStore.list());
```

- [ ] **Step 3: Invalidate discovery cache on session mutations**

In `server.ts`, find the three methods that mutate sessions: `handleStartSession`, `handleResume`, and `handleCancelSession`. Add `this.discoveryCache = null;` as the first line of each method body.

For `handleStartSession`, find the line where the session actually starts (after input validation). Add it there, not before the validation.

- [ ] **Step 4: Verify TypeScript**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm test 2>&1 | tail -15
```

- [ ] **Step 6: Commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add src/server.ts && git commit -m "feat: add 5s TTL cache for process discovery in /api/sessions"
```

---

## Task 9: Lint, build, final verification

- [ ] **Step 1: Run lint**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm run lint 2>&1 | tail -20
```

Expected: no errors. Fix any before continuing.

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 3: Build**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && npm run build 2>&1 | tail -10
```

Expected: build succeeds, no errors.

- [ ] **Step 4: Commit any lint fixups**

Only run if step 1 required changes:

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer && git add -p && git commit -m "fix: lint fixups after cache layer integration"
```
