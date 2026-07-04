// Preflight guard for the better-sqlite3 native binary.
//
// better-sqlite3 ships a compiled `.node` addon tied to a specific Node ABI
// (NODE_MODULE_VERSION). When the installed binary was built against a
// different Node than the one running (a stale node_modules after a Node
// upgrade or branch switch — `git pull` does NOT rebuild native modules), the
// module throws at open time. The server used to catch that and silently run
// *without* the SQLite cache, which turns every /api/conversations,
// /api/conversations/count and /project-chats request into a 500 with no
// obvious cause. Fail loudly at startup instead.

const REBUILD_HINT = "npm rebuild better-sqlite3";

/** Thrown when the installed better-sqlite3 binary can't load under this Node. */
export class SqliteAbiError extends Error {
  constructor(cause: string) {
    super(
      `better-sqlite3 native module failed to load — likely a Node ABI mismatch ` +
        `(node_modules was built against a different Node version).\n` +
        `  Running Node: ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})\n` +
        `  Fix: ${REBUILD_HINT}\n` +
        `  (or 'npm ci' after any dependency-affecting pull)\n` +
        `  Underlying error: ${cause}`,
    );
    this.name = "SqliteAbiError";
  }
}

// The ABI-mismatch error text better-sqlite3 surfaces from the native loader.
const ABI_MARKERS = ["NODE_MODULE_VERSION", "was compiled against a different Node.js version"];

/** True when an error message looks like a better-sqlite3 native ABI mismatch. */
export function isAbiMismatch(message: string): boolean {
  return ABI_MARKERS.some((m) => message.includes(m));
}

/**
 * Load better-sqlite3 and open a throwaway in-memory DB. Returns normally when
 * the native binary is usable under the current Node. Throws {@link SqliteAbiError}
 * on an ABI mismatch; rethrows anything else unchanged.
 */
export function checkSqliteAbi(): void {
  try {
    // Require lazily so a broken binary surfaces here, not at import time.
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAbiMismatch(message)) {
      throw new SqliteAbiError(message);
    }
    throw err;
  }
}
