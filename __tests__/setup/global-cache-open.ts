import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationCache } from "../../src/conversation-cache";

/**
 * Refuse to start the suite against a cache that cannot open.
 *
 * A broken better-sqlite3 binary does not fail the tests that need it: the
 * server catches `cache.open_failed` and degrades to cacheless, so every
 * cache-dependent test 404s and the cause looks like a product bug. Opening one
 * throwaway ConversationCache here, once, in the main process, turns that into a
 * single named failure before any test runs. (#513)
 */
export default function setup(): void {
  const dir = mkdtempSync(join(tmpdir(), "tb-cache-open-probe-"));
  try {
    ConversationCache.open(join(dir, "cache.db")).close();
  } catch (err) {
    // vitest 5.0.5 crashes while source-mapping an error thrown from a global
    // setup ("code.charCodeAt is not a function") and prints that instead of the
    // cause, so print the cause ourselves and throw a frameless error.
    const message = `Test cache cannot open: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`\n${message}\n`);
    throw Object.assign(new Error(message), { stack: message });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
