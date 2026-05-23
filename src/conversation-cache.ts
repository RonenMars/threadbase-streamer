import Database from "better-sqlite3";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "fs";
import { dirname, join } from "path";
import { runSqliteMigrations } from "./db/sqlite-migrate";

export interface ConversationListItem {
  id: string;
  filePath: string;
  projectId: string | null;
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
  content?: unknown[];
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
  project_id: string | null;
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

type ContentBlock = { type: string; text?: string; [key: string]: unknown };

interface JsonlLine {
  role?: string;
  type?: string;
  timestamp?: string;
  // Real Claude JSONL emits either an array of blocks or a raw string. Normalize
  // via `normalizeContent` before consuming.
  content?: ContentBlock[] | string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
}

function normalizeContent(raw: ContentBlock[] | string | null | undefined): ContentBlock[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return [];
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

CREATE TABLE IF NOT EXISTS session_names (
  session_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

export class ConversationCache {
  private db: Database.Database;
  private tailSize: number;
  private fileIndex = new Map<string, string>();
  private fileIndexLoaded = false;
  // Monotonically increasing counter for tail updated_at — guarantees strict
  // ordering even when multiple updateFromLine() calls land within the same ms.
  private tailSeq = Date.now();
  // Monotonically increasing counter for session_names updated_at.
  private nameSeq = Date.now();

  private stmts: {
    getById: Database.Statement;
    getFullById: Database.Statement;
    updateMeta: Database.Statement;
    insertSkeleton: Database.Statement;
    upsertFull: Database.Statement;
    getTail: Database.Statement;
    hasTail: Database.Statement;
    upsertTail: Database.Statement;
    list: Database.Statement;
    count: Database.Statement;
    listByProject: Database.Statement;
    countByProject: Database.Statement;
    deleteById: Database.Statement;
    deleteTailById: Database.Statement;
    deleteAll: Database.Statement;
    deleteTailAll: Database.Statement;
    getIdByFilePath: Database.Statement;
    allFilePaths: Database.Statement;
    upsertSessionName: Database.Statement;
    getSessionName: Database.Statement;
    listSessionNames: Database.Statement;
    setConversationProjectId: Database.Statement;
    getLatestConversation: Database.Statement;
    listConversationsForProjectBackfill: Database.Statement;
    hasOrphanProjectId: Database.Statement;
    popularProjects: Database.Statement;
  };

  private migrationsDir?: string;

  private constructor(db: Database.Database, tailSize: number, migrationsDir?: string) {
    this.migrationsDir = migrationsDir;
    this.db = db;
    this.tailSize = tailSize;
    db.exec(SCHEMA);
    runSqliteMigrations(db, this.migrationsDir);
    this.stmts = {
      getById: db.prepare("SELECT id FROM conversation_meta WHERE id = ?"),
      getFullById: db.prepare("SELECT * FROM conversation_meta WHERE id = ?"),
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
        WHERE conversation_meta.updated_at < excluded.updated_at
      `),
      getTail: db.prepare("SELECT * FROM conversation_tail WHERE conversation_id = ?"),
      hasTail: db.prepare("SELECT 1 FROM conversation_tail WHERE conversation_id = ? LIMIT 1"),
      upsertTail: db.prepare(`
        INSERT INTO conversation_tail (conversation_id, messages_json, tail_size, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          messages_json = excluded.messages_json,
          tail_size     = excluded.tail_size,
          updated_at    = excluded.updated_at
        WHERE conversation_tail.updated_at < excluded.updated_at
      `),
      list: db.prepare(
        "SELECT * FROM conversation_meta ORDER BY last_activity DESC LIMIT ? OFFSET ?",
      ),
      count: db.prepare("SELECT COUNT(*) as n FROM conversation_meta"),
      listByProject: db.prepare(
        "SELECT * FROM conversation_meta WHERE project_path = ? ORDER BY last_activity DESC LIMIT ? OFFSET ?",
      ),
      countByProject: db.prepare(
        "SELECT COUNT(*) as n FROM conversation_meta WHERE project_path = ?",
      ),
      deleteById: db.prepare("DELETE FROM conversation_meta WHERE id = ?"),
      deleteTailById: db.prepare("DELETE FROM conversation_tail WHERE conversation_id = ?"),
      deleteAll: db.prepare("DELETE FROM conversation_meta"),
      deleteTailAll: db.prepare("DELETE FROM conversation_tail"),
      getIdByFilePath: db.prepare("SELECT id FROM conversation_meta WHERE file_path = ?"),
      allFilePaths: db.prepare("SELECT id, file_path FROM conversation_meta"),
      upsertSessionName: db.prepare(`
        INSERT INTO session_names (session_id, name, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          name       = excluded.name,
          updated_at = excluded.updated_at
        WHERE session_names.updated_at < excluded.updated_at
      `),
      getSessionName: db.prepare("SELECT name FROM session_names WHERE session_id = ?"),
      listSessionNames: db.prepare("SELECT session_id, name FROM session_names"),
      setConversationProjectId: db.prepare(
        "UPDATE conversation_meta SET project_id = ? WHERE id = ?",
      ),
      getLatestConversation: db.prepare(
        "SELECT id, last_activity FROM conversation_meta WHERE last_activity IS NOT NULL ORDER BY last_activity DESC, id DESC LIMIT 1",
      ),
      listConversationsForProjectBackfill: db.prepare(
        "SELECT id, project_path, project_id, last_activity FROM conversation_meta WHERE project_path IS NOT NULL",
      ),
      hasOrphanProjectId: db.prepare(
        "SELECT 1 FROM conversation_meta WHERE project_id IS NULL AND project_path IS NOT NULL LIMIT 1",
      ),
      popularProjects: db.prepare(
        `SELECT project_path, project_name, COUNT(*) as cnt
         FROM conversation_meta
         WHERE project_path IS NOT NULL
         GROUP BY project_path
         ORDER BY cnt DESC
         LIMIT ?`,
      ),
    };
  }

  /**
   * Expose the underlying handle so projects/cache_metadata repositories can
   * share the same connection. Internal API; not part of the public surface.
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  static open(dbPath: string, tailSize = 10, migrationsDir?: string): ConversationCache {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return new ConversationCache(db, tailSize, migrationsDir);
  }

  close(): void {
    this.db.close();
  }

  getPopularProjects(limit: number): Array<{ path: string; name: string; sessionCount: number }> {
    const rows = this.stmts.popularProjects.all(limit) as Array<{
      project_path: string;
      project_name: string | null;
      cnt: number;
    }>;
    return rows.map((r) => ({
      path: r.project_path,
      name: r.project_name ?? r.project_path.split(/[/\\]/).pop() ?? r.project_path,
      sessionCount: r.cnt,
    }));
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
    if (role !== "user" && role !== "assistant") return;

    const timestamp = line.timestamp ?? new Date().toISOString();
    const activityMs = new Date(timestamp).getTime();
    if (Number.isNaN(activityMs)) return;

    const contentBlocks = normalizeContent(line.message?.content ?? line.content);
    const text = contentBlocks.find((b) => b.type === "text")?.text?.slice(0, 200) ?? "";
    const lastMessage = JSON.stringify({ role, timestamp, text });
    const seq = ++this.tailSeq;

    this.ensureFileIndex();

    let convId = this.fileIndex.get(filePath);
    if (!convId) {
      const pseudoId =
        filePath
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.jsonl$/, "") ?? filePath;
      this.stmts.insertSkeleton.run(pseudoId, filePath, 0);
      this.fileIndex.set(filePath, pseudoId);
      convId = pseudoId;
    }

    const result = this.stmts.updateMeta.run(activityMs, lastMessage, seq, convId);
    if (result.changes === 0) return;

    const tailRow = this.stmts.getTail.get(convId) as TailRow | undefined;
    const msgs: CachedTailMessage[] = tailRow
      ? (JSON.parse(tailRow.messages_json) as CachedTailMessage[])
      : [];

    msgs.push({ role, timestamp, text, content: contentBlocks });
    if (msgs.length > this.tailSize) msgs.splice(0, msgs.length - this.tailSize);

    this.stmts.upsertTail.run(convId, JSON.stringify(msgs), msgs.length, seq);
  }

  upsertFromScannerMeta(metas: ScannerMeta[]): void {
    const run = this.db.transaction((items: ScannerMeta[]) => {
      for (const m of items) {
        const id =
          m.sessionId ||
          m.id
            .split("/")
            .pop()
            ?.replace(/\.jsonl$/, "") ||
          m.id;
        const lastActivityMs = m.timestamp ? new Date(m.timestamp).getTime() : null;
        this.stmts.upsertFull.run({
          id,
          file_path: m.filePath,
          project_path: m.projectPath ?? null,
          project_name: m.projectName ?? null,
          title: m.title ?? m.projectName ?? null,
          model: m.model ?? null,
          account: m.account ?? null,
          branch: m.gitBranch ?? null,
          message_count: m.messageCount ?? 0,
          last_activity: lastActivityMs,
          first_message: m.firstMessage ? JSON.stringify(m.firstMessage) : null,
          last_message: m.lastMessage ? JSON.stringify(m.lastMessage) : null,
          preview: m.preview ?? null,
          updated_at: 0,
        });
        if (this.fileIndexLoaded) this.fileIndex.set(m.filePath, id);
      }
    });
    run(metas);
  }

  // Reads the last `tailSize` qualifying lines from a JSONL file and writes them
  // to conversation_tail. Reads backward in 8 KB chunks so memory usage is
  // bounded regardless of file size. Uses updated_at=0 so any live
  // updateFromLine() call (which uses Date.now()) always wins the upsert.
  // Returns false if the file cannot be read or the tail already exists.
  populateTailFromFile(convId: string, filePath: string): boolean {
    if (this.stmts.hasTail.get(convId)) return false;

    let fileSize: number;
    let fd: number;
    try {
      fileSize = statSync(filePath).size;
      fd = openSync(filePath, "r");
    } catch {
      return false;
    }

    const CHUNK = 8192;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = fileSize;
    let partial = "";
    const lines: string[] = [];

    try {
      while (pos > 0 && lines.length < this.tailSize * 4) {
        const toRead = Math.min(CHUNK, pos);
        pos -= toRead;
        readSync(fd, buf, 0, toRead, pos);
        const chunk = buf.subarray(0, toRead).toString("utf8");
        const combined = chunk + partial;
        const parts = combined.split("\n");
        // parts[0] may be a partial line — keep it for the next iteration
        partial = parts[0];
        for (let i = parts.length - 1; i >= 1; i--) {
          lines.push(parts[i]);
        }
      }
      if (partial) lines.push(partial);
    } finally {
      closeSync(fd);
    }

    const msgs: CachedTailMessage[] = [];
    for (let i = 0; i < lines.length && msgs.length < this.tailSize; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let parsed: JsonlLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const role = parsed.role ?? parsed.type;
      if (!role) continue;
      const timestamp = parsed.timestamp ?? "";
      const contentBlocks = normalizeContent(parsed.message?.content ?? parsed.content);
      const text = contentBlocks.find((b) => b.type === "text")?.text?.slice(0, 200) ?? "";
      msgs.unshift({ role, timestamp, text, content: contentBlocks });
    }
    if (msgs.length === 0) return false;
    this.stmts.upsertTail.run(convId, JSON.stringify(msgs), msgs.length, 0);
    return true;
  }

  listConversations(opts: { project?: string; limit: number; offset: number }): {
    conversations: ConversationListItem[];
    total: number;
  } {
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
        projectId: r.project_id,
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

  getMetaById(id: string): ConversationListItem | null {
    const row = this.stmts.getFullById.get(id) as MetaRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      filePath: row.file_path,
      projectId: row.project_id,
      projectPath: row.project_path,
      projectName: row.project_name,
      title: row.title,
      model: row.model,
      account: row.account,
      branch: row.branch,
      messageCount: row.message_count,
      lastActivity: row.last_activity
        ? new Date(row.last_activity).toISOString()
        : new Date(0).toISOString(),
      firstMessage: row.first_message,
      lastMessage: row.last_message,
      preview: row.preview,
    };
  }

  setConversationProjectId(conversationId: string, projectId: string): void {
    this.stmts.setConversationProjectId.run(projectId, conversationId);
  }

  getLatestConversation(): { id: string; lastActivity: string | null } | null {
    const row = this.stmts.getLatestConversation.get() as
      | { id: string; last_activity: number | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      lastActivity: row.last_activity ? new Date(row.last_activity).toISOString() : null,
    };
  }

  hasOrphanProjectId(): boolean {
    return this.stmts.hasOrphanProjectId.get() !== undefined;
  }

  listConversationsForProjectBackfill(): Array<{
    id: string;
    projectPath: string | null;
    projectId: string | null;
    lastActivity: string | null;
  }> {
    const rows = this.stmts.listConversationsForProjectBackfill.all() as Array<{
      id: string;
      project_path: string | null;
      project_id: string | null;
      last_activity: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectPath: r.project_path,
      projectId: r.project_id,
      lastActivity: r.last_activity ? new Date(r.last_activity).toISOString() : null,
    }));
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

  upsertSessionName(sessionId: string, name: string): void {
    this.stmts.upsertSessionName.run(sessionId, name, ++this.nameSeq);
  }

  getSessionName(sessionId: string): string | null {
    const row = this.stmts.getSessionName.get(sessionId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  listSessionNames(): Record<string, string> {
    const rows = this.stmts.listSessionNames.all() as { session_id: string; name: string }[];
    return Object.fromEntries(rows.map((r) => [r.session_id, r.name]));
  }

  invalidate(id?: string): void {
    if (id) {
      this.stmts.deleteTailById.run(id);
      this.stmts.deleteById.run(id);
      if (this.fileIndexLoaded) {
        for (const [fp, cid] of this.fileIndex) {
          if (cid === id) {
            this.fileIndex.delete(fp);
            break;
          }
        }
      }
    } else {
      this.stmts.deleteTailAll.run();
      this.stmts.deleteAll.run();
      this.fileIndex.clear();
    }
  }

  invalidateByFilePath(filePath: string): string | null {
    const row = this.stmts.getIdByFilePath.get(filePath) as { id: string } | undefined;
    if (!row) return null;
    this.invalidate(row.id);
    return row.id;
  }

  /**
   * Drop rows whose `file_path` no longer exists on disk AND which have no
   * cached tail to fall back to. Rows with a tail are left alone so
   * `handleGetConversation` can still serve the cached tail even when the
   * JSONL has been deleted.
   */
  pruneGhostFiles(exists: (filePath: string) => boolean = existsSync): string[] {
    const rows = this.stmts.allFilePaths.all() as { id: string; file_path: string }[];
    const ghosts: string[] = [];
    const prune = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmts.deleteTailById.run(id);
        this.stmts.deleteById.run(id);
      }
    });
    for (const row of rows) {
      if (exists(row.file_path)) continue;
      if (this.stmts.hasTail.get(row.id)) continue;
      ghosts.push(row.id);
    }
    if (ghosts.length > 0) {
      prune(ghosts);
      if (this.fileIndexLoaded) {
        for (const id of ghosts) {
          for (const [fp, cid] of this.fileIndex) {
            if (cid === id) {
              this.fileIndex.delete(fp);
              break;
            }
          }
        }
      }
    }
    return ghosts;
  }
}
