import type Database from "better-sqlite3";
import { getLogger } from "../logger";

const log = getLogger("db");

/**
 * Slow-query threshold, in milliseconds.
 *
 * Measured, not guessed. Against the live 22 MB `cache.db` on this machine
 * (583 conversations, 38 717 index rows, warm page cache), 3 600 read samples
 * across the twelve statements the hot paths actually run gave p50 0.03 ms,
 * p99 0.87 ms, p99.9 1.43 ms, max 1.83 ms; 1 200 write samples gave p99
 * 0.09 ms with rare WAL-checkpoint spikes to 4.37 ms. So *every* healthy query
 * on this machine finishes inside ~4.4 ms, and the checkpoint spikes are the
 * only thing anywhere near that.
 *
 * 35 ms sits two anchors above that: it is 8x the slowest healthy operation
 * ever observed, so checkpoint spikes can never page anyone, and it is more
 * than the 34 ms *end-to-end* time of the fastest complete conversation fetch
 * measured on this box. A query crossing it therefore cost more on its own
 * than an entire healthy request — which is the point at which a warn line is
 * worth the bytes it occupies in the log.
 *
 * Override with `THREADBASE_DB_SLOW_QUERY_MS`; <= 0 disables slow logging.
 */
export const DEFAULT_SLOW_QUERY_MS = 35;

/**
 * Per-statement label, held in a box so `labelStatements` can replace the
 * SQL-derived fallback with the real name after the statements are assigned.
 * A symbol keeps it off `Object.keys`, so nothing that enumerates a statement
 * bag sees it.
 */
const LABEL = Symbol("tbQueryLabel");

interface Labelled {
  [LABEL]?: { label: string };
}

/**
 * `verb:table` — what a statement is called before anyone names it.
 *
 * Never the full SQL text (too verbose for a per-query line) and never the
 * bound parameters (they carry file paths and conversation ids).
 */
function deriveLabel(sql: string): string {
  const verb = /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? "sql";
  const table = /(?:from|into|update)\s+([A-Za-z_]\w*)/i.exec(sql)?.[1] ?? "?";
  return `${verb}:${table}`;
}

function resolveSlowMs(): number {
  const raw = process.env.THREADBASE_DB_SLOW_QUERY_MS;
  if (raw === undefined || raw === "") return DEFAULT_SLOW_QUERY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SLOW_QUERY_MS;
}

function record(label: string, ms: number, rows: number, slowMs: number): void {
  // Structured only ("pino"), never `both`. The default dest writes the message
  // a second time via console.*, and both streams land in the same prod log —
  // a duplicate line per query is exactly the volume this instrumentation is
  // supposed to stay under.
  if (slowMs > 0 && ms >= slowMs) {
    log.warn(
      `[db] slow query ${label} ${ms.toFixed(1)}ms rows=${rows}`,
      { event: "db.slow_query", stmt: label, ms: Math.round(ms * 100) / 100, rows },
      "pino",
    );
    return;
  }
  // Everything else is off by default: a single conversation fetch runs dozens
  // of statements, so this is only affordable when someone asked for it.
  if (log.pino.isLevelEnabled("debug")) {
    log.debug(
      `[db] ${label} ${ms.toFixed(2)}ms rows=${rows}`,
      { event: "db.query", stmt: label, ms: Math.round(ms * 100) / 100, rows },
      "pino",
    );
  }
}

function rowsOf(method: "get" | "all" | "run", result: unknown): number {
  if (method === "all") return Array.isArray(result) ? result.length : 0;
  if (method === "run") return (result as Database.RunResult | undefined)?.changes ?? 0;
  return result === undefined ? 0 : 1;
}

/**
 * Time every `.get()` / `.all()` / `.run()` on every statement this connection
 * prepares.
 *
 * Wrapping `prepare` is what makes this one edit per database instead of one
 * per query: `better-sqlite3` is synchronous, so a call's wall time *is* its
 * cost, and every statement in the process — the 45 in ConversationCache, the
 * 4 in RuntimeStore, and the ~40 more inside the repositories that share these
 * handles — is created here. Measured overhead is +0.09 µs on an 8.9 µs call
 * (~1%), which is why it is always on rather than behind a flag.
 *
 * Only the three terminal methods are replaced, as own properties; `iterate`,
 * `pluck`, `raw`, `columns` and `bind` keep resolving to the prototype
 * untouched. A statement that throws is not recorded — the error surfaces on
 * its own path.
 */
export function instrumentDatabase(
  db: Database.Database,
  options: { slowMs?: number } = {},
): Database.Database {
  const slowMs = options.slowMs ?? resolveSlowMs();
  const prepare = db.prepare.bind(db);

  db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    const box = { label: deriveLabel(sql) };
    Object.defineProperty(stmt, LABEL, { value: box, configurable: true });

    for (const method of ["get", "all", "run"] as const) {
      const original = stmt[method].bind(stmt) as (...args: unknown[]) => unknown;
      Object.defineProperty(stmt, method, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const started = performance.now();
          const result = original(...args);
          record(box.label, performance.now() - started, rowsOf(method, result), slowMs);
          return result;
        },
      });
    }
    return stmt;
  }) as typeof db.prepare;

  return db;
}

/**
 * Name the statements in a `{ name: Statement }` bag after their keys, so a
 * slow-query line reads `getMessageIndexWindow` rather than
 * `select:conversation_message_index`.
 *
 * Separate from `instrumentDatabase` because `prepare` cannot know the key its
 * result is about to be assigned to. Statements from a connection that was
 * never instrumented are skipped.
 */
export function labelStatements(statements: object): void {
  for (const [name, stmt] of Object.entries(statements)) {
    const box = (stmt as Labelled | null)?.[LABEL];
    if (box) box.label = name;
  }
}
