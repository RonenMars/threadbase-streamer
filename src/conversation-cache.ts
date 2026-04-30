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
        WHERE conversation_meta.updated_at < excluded.updated_at
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
      const pseudoId =
        filePath
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.jsonl$/, "") ?? filePath;
      this.stmts.insertSkeleton.run(pseudoId, filePath, 0);
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
}
