import {
  type ConversationMessage,
  type ConversationMeta,
  createJsonlParseState,
  type FileStatEntry,
  type JsonlParseState,
  parseJsonlLine,
} from "@threadbase-sh/scanner";
import Database from "better-sqlite3";
import { closeSync, existsSync, mkdirSync, openSync, readSync, type Stats, statSync } from "fs";
import { open as openAsync } from "fs/promises";
import { dirname } from "path";
import { setImmediate as yieldToEventLoop } from "timers/promises";
import { runSqliteMigrations } from "./db/sqlite-migrate";
import { CLAUDE_CODE_PROVIDER } from "./providers";
import {
  DEFAULT_AGENT_ENTRYPOINTS,
  isAgentFile,
  isAgentLine,
} from "./services/conversations/isAgentConversation";
import { fileIdentity, type LineSpan, splitCompleteLines } from "./utils/fileIdentity";

export interface ConversationCacheOptions {
  // When true, drop conversations whose JSONL came from an agent entrypoint.
  // Default false to preserve legacy behavior.
  filterAgentConversations?: boolean;
  // Set of `entrypoint` values to treat as agent traffic. Defaults to
  // DEFAULT_AGENT_ENTRYPOINTS ({ sdk-cli, claude-vscode }).
  agentEntrypoints?: ReadonlySet<string>;
  // Fired the first time an agent JSONL is detected for a given file path
  // (from updateFromLine). Lets the server unwatch the file.
  onAgentFileDetected?: (filePath: string) => void;
}

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
  source: string | null;
  provider: "claude-code" | "codex-cli";
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

/** A row of `conversation_file_state` — per-file offset-index resume state. */
export interface FileStateRow {
  path: string;
  identity: string;
  size: number;
  mtime_ms: number;
  byte_offset: number;
  last_message_index: number;
}

/** A row of `conversation_message_index` — one indexed message's byte span. */
export interface MessageIndexRow {
  conversation_id: string;
  message_index: number;
  byte_offset: number;
  byte_length: number;
  uuid: string | null;
  role: string | null;
  ts: number | null;
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
  provider?: "claude-code" | "codex-cli";
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
  source: string | null;
  provider: "claude-code" | "codex-cli";
  updated_at: number;
  scanner_meta_json: string | null;
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
  // Set by Claude Code / Agent SDK on every real message line. "cli" = human
  // interactive Claude Code; "sdk-cli" = Claude Agent SDK / claude-mem / hooks.
  entrypoint?: string;
  // Project context: the scanner sets `cwd` from any line that carries it
  // (attachment, metadata, user, assistant). The live watcher must do the
  // same — otherwise skeleton rows persist with NULL project_path.
  cwd?: string;
  slug?: string;
  // Real Claude JSONL emits either an array of blocks or a raw string. Normalize
  // via `normalizeContent` before consuming.
  content?: ContentBlock[] | string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
}

// Last three path segments — mirrors @threadbase-sh/scanner's
// `getShortProjectName`. Inlined here because the scanner does not export it.
function shortProjectName(fullPath: string): string {
  const parts = fullPath.split(/[/\\]/).filter(Boolean);
  return parts.slice(-3).join("/");
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
  // Per-file scanner parse state for the incremental offset-index writer. The
  // reducer is stateful across lines (pending tool_uses, latest timestamp), so
  // it must persist between watcher reads of the same file. Cleared on
  // truncation/backfill.
  private indexParseState = new Map<string, JsonlParseState>();
  // Single-flight guard for backfillIndex — concurrent detail requests for the
  // same cold file await one walk, not N. Entry dropped on settle.
  private backfillInFlight = new Map<string, Promise<void>>();
  // Monotonically increasing counter for tail updated_at — guarantees strict
  // ordering even when multiple updateFromLine() calls land within the same ms.
  private tailSeq = Date.now();
  // Monotonically increasing counter for session_names updated_at.
  private nameSeq = Date.now();

  private stmts: {
    getById: Database.Statement;
    getFullById: Database.Statement;
    updateMeta: Database.Statement;
    updateMetaBatch: Database.Statement;
    insertSkeleton: Database.Statement;
    backfillSkeletonProject: Database.Statement;
    upsertFull: Database.Statement;
    getTail: Database.Statement;
    hasTail: Database.Statement;
    upsertTail: Database.Statement;
    list: Database.Statement;
    count: Database.Statement;
    listByProject: Database.Statement;
    countByProject: Database.Statement;
    listByProvider: Database.Statement;
    countByProvider: Database.Statement;
    deleteById: Database.Statement;
    deleteTailById: Database.Statement;
    deleteAll: Database.Statement;
    deleteTailAll: Database.Statement;
    getIdByFilePath: Database.Statement;
    allFilePaths: Database.Statement;
    allFileStats: Database.Statement;
    allScannerStatCacheRows: Database.Statement;
    updateScannerCache: Database.Statement;
    getFileMetadata: Database.Statement;
    upsertFileMetadata: Database.Statement;
    upsertSessionName: Database.Statement;
    getSessionName: Database.Statement;
    listSessionNames: Database.Statement;
    setConversationProjectId: Database.Statement;
    markAsStreamer: Database.Statement;
    getLatestConversation: Database.Statement;
    listConversationsForProjectBackfill: Database.Statement;
    hasOrphanProjectId: Database.Statement;
    popularProjects: Database.Statement;
    getFileState: Database.Statement;
    upsertFileState: Database.Statement;
    deleteFileState: Database.Statement;
    deleteMessageIndex: Database.Statement;
    insertMessageIndexRow: Database.Statement;
    getMessageIndexWindow: Database.Statement;
    getIndexedMessageCount: Database.Statement;
  };

  private migrationsDir?: string;

  // When true, ingestion drops conversations whose JSONL `entrypoint` belongs
  // to `agentEntrypoints`. See isAgentConversation.ts.
  private filterAgentConversations = false;
  private agentEntrypoints: ReadonlySet<string> = DEFAULT_AGENT_ENTRYPOINTS;
  private onAgentFileDetected?: (filePath: string) => void;

  private constructor(
    db: Database.Database,
    tailSize: number,
    migrationsDir?: string,
    options?: ConversationCacheOptions,
  ) {
    this.migrationsDir = migrationsDir;
    this.db = db;
    this.tailSize = tailSize;
    this.filterAgentConversations = options?.filterAgentConversations ?? false;
    this.agentEntrypoints = options?.agentEntrypoints ?? DEFAULT_AGENT_ENTRYPOINTS;
    this.onAgentFileDetected = options?.onAgentFileDetected;
    db.exec(SCHEMA);
    runSqliteMigrations(db, this.migrationsDir);
    this.stmts = {
      getById: db.prepare("SELECT id FROM conversation_meta WHERE id = ?"),
      getFullById: db.prepare("SELECT * FROM conversation_meta WHERE id = ?"),
      updateMeta: db.prepare(
        "UPDATE conversation_meta SET message_count = message_count + 1, last_activity = ?, last_message = ?, updated_at = ? WHERE id = ?",
      ),
      // Batch equivalent of updateMeta: bumps message_count by N in one write
      // (used by updateFromLines so a burst of appended lines is one UPDATE).
      updateMetaBatch: db.prepare(
        "UPDATE conversation_meta SET message_count = message_count + @inc, last_activity = @last_activity, last_message = @last_message, updated_at = @updated_at WHERE id = @id",
      ),
      insertSkeleton: db.prepare(
        "INSERT OR IGNORE INTO conversation_meta (id, file_path, message_count, updated_at) VALUES (?, ?, 1, ?)",
      ),
      // Fills project_path / project_name / title on a row whose columns are
      // still NULL. Never overwrites scanner-populated values — the scanner's
      // upsertFromScannerMeta remains authoritative for those columns.
      backfillSkeletonProject: db.prepare(
        `UPDATE conversation_meta
         SET project_path = COALESCE(project_path, @project_path),
             project_name = COALESCE(project_name, @project_name),
             title        = COALESCE(title,        @title)
         WHERE id = @id
           AND (project_path IS NULL OR project_name IS NULL OR title IS NULL)`,
      ),
      upsertFull: db.prepare(`
        INSERT INTO conversation_meta
          (id, file_path, project_path, project_name, title, model, account, branch,
           message_count, last_activity, first_message, last_message, preview, updated_at,
           mtime_ms, file_size, provider, scanner_meta_json)
        VALUES
          (@id, @file_path, @project_path, @project_name, @title, @model, @account, @branch,
           @message_count, @last_activity, @first_message, @last_message, @preview, @updated_at,
           @mtime_ms, @file_size, @provider, @scanner_meta_json)
        ON CONFLICT(id) DO UPDATE SET
          file_path     = excluded.file_path,
          project_path  = excluded.project_path,
          project_name  = excluded.project_name,
          title         = excluded.title,
          model         = excluded.model,
          account       = excluded.account,
          branch        = excluded.branch,
          -- message_count is incremented by live tailing but recounted from
          -- scratch by a scanner rescan; a stale rescan must not carry a live
          -- session's count backwards, so take the max instead of overwriting.
          message_count = MAX(conversation_meta.message_count, excluded.message_count),
          last_activity = excluded.last_activity,
          first_message = excluded.first_message,
          last_message  = excluded.last_message,
          preview       = excluded.preview,
          updated_at    = excluded.updated_at,
          mtime_ms      = excluded.mtime_ms,
          file_size     = excluded.file_size,
          provider      = excluded.provider,
          scanner_meta_json = excluded.scanner_meta_json
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
      listByProvider: db.prepare(
        "SELECT * FROM conversation_meta WHERE provider = ? ORDER BY last_activity DESC LIMIT ? OFFSET ?",
      ),
      countByProvider: db.prepare("SELECT COUNT(*) as n FROM conversation_meta WHERE provider = ?"),
      deleteById: db.prepare("DELETE FROM conversation_meta WHERE id = ?"),
      deleteTailById: db.prepare("DELETE FROM conversation_tail WHERE conversation_id = ?"),
      deleteAll: db.prepare("DELETE FROM conversation_meta"),
      deleteTailAll: db.prepare("DELETE FROM conversation_tail"),
      getIdByFilePath: db.prepare("SELECT id FROM conversation_meta WHERE file_path = ?"),
      allFilePaths: db.prepare("SELECT id, file_path FROM conversation_meta"),
      allFileStats: db.prepare(
        "SELECT file_path, mtime_ms, file_size FROM conversation_meta WHERE mtime_ms IS NOT NULL AND file_size IS NOT NULL",
      ),
      allScannerStatCacheRows: db.prepare(
        "SELECT file_path, mtime_ms, file_size, scanner_meta_json FROM conversation_meta WHERE mtime_ms IS NOT NULL AND file_size IS NOT NULL AND scanner_meta_json IS NOT NULL",
      ),
      updateScannerCache: db.prepare(
        "UPDATE conversation_meta SET mtime_ms = ?, file_size = ?, scanner_meta_json = ? WHERE id = ?",
      ),
      getFileMetadata: db.prepare(
        "SELECT mtime_ms, file_size, is_agent, agent_entrypoints_key FROM conversation_file_metadata WHERE file_path = ?",
      ),
      upsertFileMetadata: db.prepare(`
        INSERT INTO conversation_file_metadata
          (file_path, mtime_ms, file_size, is_agent, agent_entrypoints_key, updated_at)
        VALUES
          (@file_path, @mtime_ms, @file_size, @is_agent, @agent_entrypoints_key, @updated_at)
        ON CONFLICT(file_path) DO UPDATE SET
          mtime_ms = excluded.mtime_ms,
          file_size = excluded.file_size,
          is_agent = excluded.is_agent,
          agent_entrypoints_key = excluded.agent_entrypoints_key,
          updated_at = excluded.updated_at
      `),
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
      markAsStreamer: db.prepare("UPDATE conversation_meta SET source = 'streamer' WHERE id = ?"),
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
      getFileState: db.prepare("SELECT * FROM conversation_file_state WHERE path = ?"),
      upsertFileState: db.prepare(
        `INSERT INTO conversation_file_state
           (path, identity, size, mtime_ms, byte_offset, last_message_index)
         VALUES (@path, @identity, @size, @mtime_ms, @byte_offset, @last_message_index)
         ON CONFLICT(path) DO UPDATE SET
           identity           = excluded.identity,
           size               = excluded.size,
           mtime_ms           = excluded.mtime_ms,
           byte_offset        = excluded.byte_offset,
           last_message_index = excluded.last_message_index`,
      ),
      deleteFileState: db.prepare("DELETE FROM conversation_file_state WHERE path = ?"),
      deleteMessageIndex: db.prepare(
        "DELETE FROM conversation_message_index WHERE conversation_id = ?",
      ),
      insertMessageIndexRow: db.prepare(
        `INSERT INTO conversation_message_index
           (conversation_id, message_index, byte_offset, byte_length, uuid, role, ts)
         VALUES (@conversation_id, @message_index, @byte_offset, @byte_length, @uuid, @role, @ts)
         ON CONFLICT(conversation_id, message_index) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           byte_length = excluded.byte_length,
           uuid        = excluded.uuid,
           role        = excluded.role,
           ts          = excluded.ts`,
      ),
      getMessageIndexWindow: db.prepare(
        `SELECT message_index, byte_offset, byte_length, uuid, role, ts
         FROM conversation_message_index
         WHERE conversation_id = ? AND message_index >= ? AND message_index < ?
         ORDER BY message_index ASC`,
      ),
      getIndexedMessageCount: db.prepare(
        "SELECT COUNT(*) as cnt FROM conversation_message_index WHERE conversation_id = ?",
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

  // ── Offset index (design 1b) ────────────────────────────────────────────
  // conversation_file_state + conversation_message_index back the windowed
  // detail read path (SQL window select + pread of byte ranges). All methods
  // are thin wrappers over the prepared statements above.

  getFileState(path: string): FileStateRow | null {
    return (this.stmts.getFileState.get(path) as FileStateRow | undefined) ?? null;
  }

  upsertFileState(row: FileStateRow): void {
    this.stmts.upsertFileState.run(row);
  }

  /** Drop a file's index rows + file_state (truncation / identity change). */
  deleteFileIndex(path: string, conversationId: string): void {
    const tx = this.db.transaction(() => {
      this.stmts.deleteMessageIndex.run(conversationId);
      this.stmts.deleteFileState.run(path);
    });
    tx();
    this.indexParseState.delete(path);
  }

  /** Append/replace index rows in one transaction. */
  appendMessageIndexRows(rows: MessageIndexRow[]): void {
    const tx = this.db.transaction((batch: MessageIndexRow[]) => {
      for (const r of batch) this.stmts.insertMessageIndexRow.run(r);
    });
    tx(rows);
  }

  /** Rows for message_index in [fromIndex, toIndex), ordered ascending. */
  getMessageIndexWindow(
    conversationId: string,
    fromIndex: number,
    toIndex: number,
  ): MessageIndexRow[] {
    return this.stmts.getMessageIndexWindow.all(
      conversationId,
      fromIndex,
      toIndex,
    ) as MessageIndexRow[];
  }

  getIndexedMessageCount(conversationId: string): number {
    return (this.stmts.getIndexedMessageCount.get(conversationId) as { cnt: number }).cnt;
  }

  /**
   * Conversation id for a JSONL path — the filename stem (matches the pseudo-id
   * updateFromLine derives and the uuid the detail read path resolves). The
   * offset index keys on this so the window select and the cursor agree.
   */
  static conversationIdForFile(filePath: string): string {
    return (
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.jsonl$/, "") ?? filePath
    );
  }

  /**
   * Incremental offset-index writer: extend the index for a burst of appended
   * lines (one watcher read) using their byte spans. Each line is classified
   * with the scanner's parseJsonlLine (a running per-file reducer state), so the
   * message ordering can never drift from the scanner's. Message lines get an
   * index row at the next message_index; non-message lines (summary/sidecar)
   * get no row but still advance byte_offset. file_state is updated to the end
   * of the last consumed span.
   *
   * Requires an up-to-date `stat` (identity/size/mtime) for the file so the read
   * path can detect truncation/replacement.
   *
   * `readFrom` is the absolute byte offset the watcher read started at, and
   * `endOffset` is where it ended (readFrom + consumed, i.e. the watcher's new
   * entry.offset). CONTIGUITY GUARD: the read must begin exactly where the index
   * left off (`readFrom === existing.byte_offset`, or 0 with no state). If it
   * doesn't — the watcher attached at EOF after the server was down, or an
   * append raced an in-flight backfill — extending would assign wrong
   * message_index values over a hole. In that case this writes nothing and
   * returns null so the caller drops the index and backfills.
   *
   * On success returns the message_index assigned to each input span (null for a
   * non-message line) so the caller can stamp WS `seq`. Empty array when spans
   * is empty. `endOffset` is stored verbatim as byte_offset so the watcher's
   * offset and file_state.byte_offset are the same number by construction.
   */
  extendMessageIndex(
    filePath: string,
    spans: LineSpan[],
    stat: Stats,
    readFrom: number,
    endOffset: number,
  ): (number | null)[] | null {
    const existing = this.getFileState(filePath);
    const expectedStart = existing?.byte_offset ?? 0;
    // Non-contiguous read → the index would develop a hole with wrong indices.
    // Decline; the caller drops + backfills.
    if (readFrom !== expectedStart) return null;

    if (spans.length === 0) return [];
    const convId = ConversationCache.conversationIdForFile(filePath);

    let state = this.indexParseState.get(filePath);
    if (!state) {
      state = createJsonlParseState();
      this.indexParseState.set(filePath, state);
    }

    let nextIndex = existing ? existing.last_message_index + 1 : 0;
    const rows: MessageIndexRow[] = [];
    const seqs: (number | null)[] = [];

    for (const span of spans) {
      const msg = parseJsonlLine(span.text, state);
      if (!msg) {
        seqs.push(null); // summary/sidecar/malformed → no index row, no seq
        continue;
      }
      rows.push({
        conversation_id: convId,
        message_index: nextIndex,
        byte_offset: span.byteOffset,
        byte_length: span.byteLength,
        uuid: msg.uuid ?? null,
        role: msg.role ?? null,
        ts: msg.timestamp ? Date.parse(msg.timestamp) || null : null,
      });
      seqs.push(nextIndex);
      nextIndex++;
    }

    const tx = this.db.transaction(() => {
      for (const r of rows) this.stmts.insertMessageIndexRow.run(r);
      this.stmts.upsertFileState.run({
        path: filePath,
        identity: fileIdentity(stat),
        size: stat.size,
        mtime_ms: Math.round(stat.mtimeMs),
        // Store the watcher's end offset verbatim — same number as entry.offset,
        // so the next read's contiguity check compares like-for-like (never
        // false-positive on a read that ended in trailing empty lines).
        byte_offset: endOffset,
        last_message_index: nextIndex - 1,
      });
    });
    tx();
    return seqs;
  }

  clearIndexParseState(filePath: string): void {
    this.indexParseState.delete(filePath);
  }

  /**
   * On-demand full backfill of the offset index for a file with no/stale
   * file_state (cold conversation, or after a truncation/replacement). Rebuilds
   * from byte 0: drops any existing rows, walks the whole file in chunks with a
   * running parse state, yields to the event loop every ~1000 lines so a large
   * file never blocks, and writes index rows + file_state.
   *
   * Single-flighted per path: concurrent callers await the same walk. The
   * triggering detail request is served by the scanner fallback while this runs.
   */
  backfillIndex(filePath: string): Promise<void> {
    const inFlight = this.backfillInFlight.get(filePath);
    if (inFlight) return inFlight;
    const walk = this.runBackfill(filePath).finally(() => {
      this.backfillInFlight.delete(filePath);
    });
    this.backfillInFlight.set(filePath, walk);
    return walk;
  }

  private async runBackfill(filePath: string): Promise<void> {
    const convId = ConversationCache.conversationIdForFile(filePath);
    // Reset any partial/stale state before rebuilding from scratch.
    this.deleteFileIndex(filePath, convId);
    this.indexParseState.delete(filePath);

    const CHUNK = 256 * 1024;
    const YIELD_EVERY = 1000;
    const state = createJsonlParseState();
    const fh = await openAsync(filePath, "r");
    let fileOffset = 0; // absolute byte offset of `carry`'s first byte
    let carry = Buffer.alloc(0); // bytes after the last "\n" of the previous chunk
    let nextIndex = 0;
    let linesSinceYield = 0;
    let lastConsumedEnd = 0; // absolute byte offset just past the last full line
    let stat: Stats;

    try {
      stat = await fh.stat();
      const buf = Buffer.alloc(CHUNK);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
        if (bytesRead === 0) break;
        const combined =
          carry.length > 0
            ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
            : buf.subarray(0, bytesRead);
        const { spans, consumed } = splitCompleteLines(combined, fileOffset);

        const rows: MessageIndexRow[] = [];
        for (const span of spans) {
          const msg = parseJsonlLine(span.text, state);
          linesSinceYield++;
          if (msg) {
            rows.push({
              conversation_id: convId,
              message_index: nextIndex,
              byte_offset: span.byteOffset,
              byte_length: span.byteLength,
              uuid: msg.uuid ?? null,
              role: msg.role ?? null,
              ts: msg.timestamp ? Date.parse(msg.timestamp) || null : null,
            });
            nextIndex++;
          }
          if (linesSinceYield >= YIELD_EVERY) {
            linesSinceYield = 0;
            await yieldToEventLoop();
          }
        }
        if (rows.length > 0) this.appendMessageIndexRows(rows);

        lastConsumedEnd = fileOffset + consumed;
        // Keep the unconsumed remainder (a torn line at the chunk boundary).
        // Copy it — `combined` may be a view into the reused read buffer, which
        // the next fh.read overwrites.
        carry = Buffer.from(combined.subarray(consumed));
        fileOffset += consumed;
      }
    } finally {
      await fh.close();
    }

    this.upsertFileState({
      path: filePath,
      identity: fileIdentity(stat),
      size: stat.size,
      mtime_ms: Math.round(stat.mtimeMs),
      byte_offset: lastConsumedEnd,
      last_message_index: nextIndex - 1,
    });
    // Seed the incremental writer's state so subsequent appends continue the
    // same reducer instead of re-parsing from scratch.
    this.indexParseState.set(filePath, state);
  }

  /**
   * Windowed detail read straight from the offset index — the hot path.
   * Returns the parsed messages for message_index in [fromIndex, toIndex) plus
   * the total indexed count, or null when the index can't serve this file (no
   * file_state, identity/size mismatch = truncation/replacement, or cold index)
   * so the caller falls back to the scanner and enqueues a backfill.
   *
   * On a match it SQL-selects the window's byte ranges and preads exactly those
   * ranges from the JSONL (never the whole file), parsing only the sliced lines.
   * Returns messages in the same ConversationMessage shape parseJsonlLine
   * produces during a scan, so the payload is identical to the scanner path.
   */
  readMessageWindow(
    filePath: string,
    fromIndex: number,
    toIndex: number,
  ): { messages: ConversationMessage[]; total: number; fromIndex: number } | null {
    const fileState = this.getFileState(filePath);
    if (!fileState) return null;

    let stat: Stats;
    try {
      stat = statSync(filePath);
    } catch {
      return null;
    }
    // The index is authoritative only up to byte_offset. Decline unless it
    // covers the whole file exactly:
    //  - identity changed  → file replaced;
    //  - size < byte_offset → truncated;
    //  - size > byte_offset → the file grew past the index (untailed messages
    //    at the tail, e.g. an append with no live watcher extending the index).
    // Serving a slice in that last case silently drops the appended messages —
    // the exact live-append bug this feature exists to fix. In every mismatch
    // the caller drops the index + backfills and falls back to the scanner.
    if (fileIdentity(stat) !== fileState.identity || stat.size !== fileState.byte_offset) {
      return null;
    }

    const total = fileState.last_message_index + 1;
    const from = Math.max(0, fromIndex);
    const to = Math.min(toIndex, total);
    if (to <= from) return { messages: [], total, fromIndex: from };

    const rows = this.getMessageIndexWindow(
      ConversationCache.conversationIdForFile(filePath),
      from,
      to,
    );
    if (rows.length === 0) return { messages: [], total, fromIndex: from };

    const messages: ConversationMessage[] = [];
    const fd = openSync(filePath, "r");
    try {
      // A fresh parse state per window (not seeded by replaying earlier lines —
      // that would re-read from byte 0 and defeat the index). parseJsonlLine's
      // per-line ConversationMessage output does not depend on the cross-line
      // reducer state in the current scanner, so a windowed read is byte-
      // identical to a full contiguous parse — pinned by
      // offset-index-read.test.ts ("windowed read of a tool_use → tool_result
      // pair matches a full contiguous parse"). If a future scanner makes the
      // per-line shape state-dependent, that test fails rather than silently
      // serving a slightly-less-enriched payload.
      const state = createJsonlParseState();
      for (const row of rows) {
        const buf = Buffer.alloc(row.byte_length);
        readSync(fd, buf, 0, row.byte_length, row.byte_offset);
        const msg = parseJsonlLine(buf.toString("utf-8"), state);
        if (msg) messages.push(msg);
      }
    } finally {
      closeSync(fd);
    }

    return { messages, total, fromIndex: from };
  }

  private agentEntrypointsKey(): string {
    return [...this.agentEntrypoints].sort().join(",");
  }

  private classifyAgentFile(filePath: string, mtimeMs: number, fileSize: number): boolean {
    if (this.agentEntrypoints.size === 0) return false;

    const entrypointsKey = this.agentEntrypointsKey();
    const cached = this.stmts.getFileMetadata.get(filePath) as
      | {
          mtime_ms: number;
          file_size: number;
          is_agent: number;
          agent_entrypoints_key: string;
        }
      | undefined;
    if (
      cached &&
      cached.mtime_ms === mtimeMs &&
      cached.file_size === fileSize &&
      cached.agent_entrypoints_key === entrypointsKey
    ) {
      return cached.is_agent === 1;
    }

    const isAgent = isAgentFile(filePath, this.agentEntrypoints);
    this.stmts.upsertFileMetadata.run({
      file_path: filePath,
      mtime_ms: mtimeMs,
      file_size: fileSize,
      is_agent: isAgent ? 1 : 0,
      agent_entrypoints_key: entrypointsKey,
      updated_at: Date.now(),
    });
    return isAgent;
  }

  isAgentFileCached(filePath: string): boolean {
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(filePath);
    } catch {
      return false;
    }
    return this.classifyAgentFile(filePath, s.mtimeMs, s.size);
  }

  static open(
    dbPath: string,
    tailSize = 10,
    migrationsDir?: string,
    options?: ConversationCacheOptions,
  ): ConversationCache {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return new ConversationCache(db, tailSize, migrationsDir, options);
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

    if (this.filterAgentConversations && isAgentLine(line, this.agentEntrypoints)) {
      this.deleteByFilePath(filePath);
      this.onAgentFileDetected?.(filePath);
      return;
    }

    const role = line.role ?? line.type;
    const isMessage = role === "user" || role === "assistant";

    this.ensureFileIndex();

    // Skip lines that carry neither a message nor project context — there's
    // nothing for us to record.
    if (!isMessage && !line.cwd && !line.slug) return;

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

    // Backfill project_path / project_name / title from cwd on any line that
    // carries it. COALESCE inside the SQL ensures we never overwrite a
    // scanner-populated value. Without this, the chokidar watcher leaves
    // skeleton rows with NULL project context, which renders as blank cards
    // on the mobile Recents tab.
    if (line.cwd || line.slug) {
      const projectPath = line.cwd ?? null;
      const projectName = projectPath ? shortProjectName(projectPath) : null;
      const title = line.slug ?? projectName ?? null;
      this.stmts.backfillSkeletonProject.run({
        id: convId,
        project_path: projectPath,
        project_name: projectName,
        title,
      });
    }

    if (!isMessage) return;

    const timestamp = line.timestamp ?? new Date().toISOString();
    const activityMs = new Date(timestamp).getTime();
    if (Number.isNaN(activityMs)) return;

    const contentBlocks = normalizeContent(line.message?.content ?? line.content);
    const text = contentBlocks.find((b) => b.type === "text")?.text?.slice(0, 200) ?? "";
    const lastMessage = JSON.stringify({ role, timestamp, text });
    const seq = ++this.tailSeq;

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

  /**
   * Batched form of updateFromLine: applies a burst of newly-appended lines
   * (one chokidar read) in a single transaction with one message_count bump,
   * one meta write, and one tail read/write — instead of 2-4 synchronous
   * writes per line. Semantics are identical to replaying each line through
   * updateFromLine in order: the agent filter short-circuits the whole batch,
   * project context is backfilled last-wins, message_count increases by the
   * number of surviving message lines, and last_activity/last_message reflect
   * the final message line.
   */
  updateFromLines(filePath: string, rawLines: string[]): void {
    // Classify all lines first (outside the transaction). A single watched
    // file maps to one conversation, so we accumulate into scalars.
    let sawProjectContext = false;
    let backfillProjectPath: string | null = null;
    let backfillProjectName: string | null = null;
    let backfillTitle: string | null = null;
    let msgCount = 0;
    let lastActivityMs: number | null = null;
    let lastMessage: string | null = null;
    const newTail: CachedTailMessage[] = [];

    for (const rawLine of rawLines) {
      let line: JsonlLine;
      try {
        line = JSON.parse(rawLine);
      } catch {
        continue;
      }

      // The first agent line nukes the file and aborts the whole batch —
      // matches updateFromLine's per-line return.
      if (this.filterAgentConversations && isAgentLine(line, this.agentEntrypoints)) {
        this.deleteByFilePath(filePath);
        this.onAgentFileDetected?.(filePath);
        return;
      }

      const role = line.role ?? line.type;
      const isMessage = role === "user" || role === "assistant";

      // Skip lines that carry neither a message nor project context.
      if (!isMessage && !line.cwd && !line.slug) continue;

      if (line.cwd || line.slug) {
        sawProjectContext = true;
        // First-wins per column, mirroring updateFromLine's per-line replay:
        // backfillSkeletonProject COALESCEs each column independently, so the
        // first non-null value seen for a column sticks and later lines can't
        // override it. Accumulating last-wins here would diverge from per-line
        // replay when a conversation's cwd/slug changes mid-batch.
        const lineProjectPath = line.cwd ?? null;
        const lineProjectName = lineProjectPath ? shortProjectName(lineProjectPath) : null;
        const lineTitle = line.slug ?? lineProjectName ?? null;
        backfillProjectPath ??= lineProjectPath;
        backfillProjectName ??= lineProjectName;
        backfillTitle ??= lineTitle;
      }

      if (!isMessage) continue;

      const timestamp = line.timestamp ?? new Date().toISOString();
      const activityMs = new Date(timestamp).getTime();
      if (Number.isNaN(activityMs)) continue;

      const contentBlocks = normalizeContent(line.message?.content ?? line.content);
      const text = contentBlocks.find((b) => b.type === "text")?.text?.slice(0, 200) ?? "";
      msgCount += 1;
      lastActivityMs = activityMs;
      lastMessage = JSON.stringify({ role, timestamp, text });
      newTail.push({ role, timestamp, text, content: contentBlocks });
    }

    // Nothing recordable in this batch.
    if (!sawProjectContext && msgCount === 0) return;

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
    const id = convId;

    const apply = this.db.transaction(() => {
      if (sawProjectContext) {
        this.stmts.backfillSkeletonProject.run({
          id,
          project_path: backfillProjectPath,
          project_name: backfillProjectName,
          title: backfillTitle,
        });
      }

      if (msgCount === 0) return;

      const seq = ++this.tailSeq;
      const result = this.stmts.updateMetaBatch.run({
        inc: msgCount,
        last_activity: lastActivityMs,
        last_message: lastMessage,
        updated_at: seq,
        id,
      });
      if (result.changes === 0) return;

      const tailRow = this.stmts.getTail.get(id) as TailRow | undefined;
      const msgs: CachedTailMessage[] = tailRow
        ? (JSON.parse(tailRow.messages_json) as CachedTailMessage[])
        : [];
      msgs.push(...newTail);
      if (msgs.length > this.tailSize) msgs.splice(0, msgs.length - this.tailSize);

      this.stmts.upsertTail.run(id, JSON.stringify(msgs), msgs.length, seq);
    });
    apply();
  }

  // Returns the IDs of rows actually upserted (i.e. excluding any agent JSONLs
  // skipped by the filter). The server's warm-up loop uses this to populate
  // tails only for IDs that have a parent conversation_meta row — otherwise
  // the conversation_tail FK fires and aborts the warm-up (regression covered
  // in conversation-cache.test.ts).
  upsertFromScannerMeta(metas: ScannerMeta[]): string[] {
    const filter = this.filterAgentConversations;
    const upsertedIds: string[] = [];
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
        let mtimeMs: number | null = null;
        let fileSize: number | null = null;
        try {
          const s = statSync(m.filePath);
          mtimeMs = s.mtimeMs;
          fileSize = s.size;
        } catch {
          // file disappeared between scan and upsert — store without stat
        }
        const seq = ++this.tailSeq;
        if (
          filter &&
          mtimeMs !== null &&
          fileSize !== null &&
          this.classifyAgentFile(m.filePath, mtimeMs, fileSize)
        ) {
          continue;
        }
        const scannerMetaJson = JSON.stringify(m);
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
          updated_at: seq,
          mtime_ms: mtimeMs,
          file_size: fileSize,
          provider: m.provider ?? CLAUDE_CODE_PROVIDER,
          scanner_meta_json: scannerMetaJson,
        });
        this.stmts.updateScannerCache.run(mtimeMs, fileSize, scannerMetaJson, id);
        if (this.fileIndexLoaded) this.fileIndex.set(m.filePath, id);
        upsertedIds.push(id);
      }
    });
    run(metas);
    return upsertedIds;
  }

  // Returns true if a row was deleted. Used by the prune-on-startup step and
  // by updateFromLine when a previously-cached file turns out to be an agent
  // JSONL.
  deleteByFilePath(filePath: string): boolean {
    const row = this.stmts.getIdByFilePath.get(filePath) as { id: string } | undefined;
    if (!row) return false;
    this.stmts.deleteTailById.run(row.id);
    const result = this.stmts.deleteById.run(row.id);
    this.fileIndex.delete(filePath);
    return result.changes > 0;
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

  listConversations(opts: { project?: string; provider?: string; limit: number; offset: number }): {
    conversations: ConversationListItem[];
    total: number;
  } {
    const { project, provider, limit, offset } = opts;
    let total: number;
    let rows: MetaRow[];

    if (project) {
      total = (this.stmts.countByProject.get(project) as { n: number }).n;
      rows = limit === 0 ? [] : (this.stmts.listByProject.all(project, limit, offset) as MetaRow[]);
    } else if (provider) {
      total = (this.stmts.countByProvider.get(provider) as { n: number }).n;
      rows =
        limit === 0 ? [] : (this.stmts.listByProvider.all(provider, limit, offset) as MetaRow[]);
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
        source: r.source,
        provider: r.provider ?? CLAUDE_CODE_PROVIDER,
      })),
    };
  }

  /** Returns a map of filePath → { mtimeMs, size } for all rows that have
   *  stat data stored. Used by the server to build the statCache passed to
   *  ConversationScanner.scan() so unchanged files are skipped. */
  getFileStats(): Map<string, { mtimeMs: number; size: number }> {
    const rows = this.stmts.allFileStats.all() as Array<{
      file_path: string;
      mtime_ms: number;
      file_size: number;
    }>;
    const map = new Map<string, { mtimeMs: number; size: number }>();
    for (const r of rows) {
      map.set(r.file_path, { mtimeMs: r.mtime_ms, size: r.file_size });
    }
    return map;
  }

  getScannerStatCache(): Map<string, { stat: FileStatEntry; meta: ConversationMeta }> {
    const rows = this.stmts.allScannerStatCacheRows.all() as Array<{
      file_path: string;
      mtime_ms: number;
      file_size: number;
      scanner_meta_json: string;
    }>;
    const map = new Map<string, { stat: FileStatEntry; meta: ConversationMeta }>();
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.scanner_meta_json) as ConversationMeta;
        map.set(r.file_path, {
          stat: { mtimeMs: r.mtime_ms, size: r.file_size },
          meta,
        });
      } catch {
        // Ignore malformed legacy/cache rows; the scanner will parse the file.
      }
    }
    return map;
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
      source: row.source,
      provider: row.provider ?? CLAUDE_CODE_PROVIDER,
    };
  }

  setConversationProjectId(conversationId: string, projectId: string): void {
    this.stmts.setConversationProjectId.run(projectId, conversationId);
  }

  markAsStreamer(id: string): void {
    this.stmts.markAsStreamer.run(id);
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

  /**
   * Drop the cached row for a file. Two callers with opposite intent:
   *  - a directory-watch "change" event (the file was appended to) — pass
   *    `skipIfTailed: true`. A cached tail means the row is being actively
   *    maintained from the file's real content by the live-tail
   *    (updateFromLines) or warm-up path, fresher than any scanner-derived
   *    view. Both watchers fire on the same append with no ordering guarantee;
   *    without this guard the invalidate can land after the tail write and wipe
   *    the just-cached row, flickering the conversation out of
   *    /api/conversations on nearly every message (CRITICAL #2). The debounced
   *    rescan still re-derives metadata, so skipping the eager drop loses
   *    nothing.
   *  - a genuine unlink (the file is gone) — leave `skipIfTailed` false so the
   *    row is always removed, otherwise a deleted session ghosts in the cache.
   */
  invalidateByFilePath(filePath: string, opts?: { skipIfTailed?: boolean }): string | null {
    const row = this.stmts.getIdByFilePath.get(filePath) as { id: string } | undefined;
    if (!row) return null;
    if (opts?.skipIfTailed && this.stmts.hasTail.get(row.id)) return null;
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

  /**
   * Reconcile the cache against the authoritative set of conversation file
   * paths a fresh scan surfaced: drop any cached row whose `file_path` is not
   * in `livePaths` (removed from disk, or now filtered out — e.g. became an
   * agent JSONL). This is the "removed conversations" half of a ?refresh=1
   * reconcile; the additions/updates half is upsertFromScannerMeta.
   *
   * Skip semantics depend on whether the file still exists on disk:
   *  - File GONE from disk → always removed, tail or not. This matches the old
   *    invalidate()+rebuild behavior (a deleted conversation must disappear on
   *    refresh) and keeps refresh=1 truthful about removals. NOTE: this is an
   *    INTENTIONAL divergence from pruneGhostFiles(), which KEEPS tailed ghosts
   *    so their cached history stays viewable on a background prune. refresh=1
   *    has the opposite contract (mobile relies on removals being reflected), so
   *    do not "unify" the two — they serve different purposes.
   *  - File STILL on disk but absent from `livePaths` → the CRITICAL #2 race:
   *    the scan snapshot predates a just-created (and now live-tailed) file.
   *    A tailed row here is actively maintained from real content, so it is
   *    kept — dropping it would flicker the active conversation out of
   *    /api/conversations. An untailed on-disk row not in the snapshot is a
   *    transient scan/discovery gap; it is left alone (not removed) and the
   *    next reconcile picks it up, rather than risk removing a real file the
   *    scan simply hasn't surfaced yet.
   * Returns the removed IDs.
   */
  reconcileDeletions(
    livePaths: Set<string>,
    opts?: { exists?: (filePath: string) => boolean },
  ): string[] {
    const exists = opts?.exists ?? existsSync;
    const rows = this.stmts.allFilePaths.all() as { id: string; file_path: string }[];
    const removed: string[] = [];
    const drop = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmts.deleteTailById.run(id);
        this.stmts.deleteById.run(id);
      }
    });
    for (const row of rows) {
      if (livePaths.has(row.file_path)) continue;
      // Not in the scan snapshot. If the file is gone from disk, it's a genuine
      // deletion — remove it. If it still exists, this is a scan/discovery gap
      // (the CRITICAL #2 race for live files); leave it for the next reconcile.
      if (exists(row.file_path)) continue;
      removed.push(row.id);
    }
    if (removed.length > 0) {
      drop(removed);
      if (this.fileIndexLoaded) {
        for (const id of removed) {
          for (const [fp, cid] of this.fileIndex) {
            if (cid === id) {
              this.fileIndex.delete(fp);
              break;
            }
          }
        }
      }
    }
    return removed;
  }
}
