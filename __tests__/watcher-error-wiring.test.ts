// The ConversationWatcher's `onError` channel was constructed but never wired
// by server.ts, so every watcher error was discarded.
//
// The one that has to be loud is ENOSPC. A directory watch costs one OS watch
// handle PER FILE under the root (chokidar recurses), so the handle count
// tracks the conversation corpus — on Linux that is spent against inotify's
// per-user max_user_watches, which can be as low as 8192. Past the ceiling the
// watch simply never attaches: live tails go quiet and new conversations stop
// being discovered, with nothing in the log connecting either symptom to the
// watch budget.
//
// These assertions are meaningful because they have been seen to fail: against
// the unmodified server (onError unset) the first test throws on calling
// `undefined`, and both log assertions report zero captured lines.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

type Captured = { message: string; meta: Record<string, unknown> };

function buildServer(): { server: StreamerServer; errors: Captured[]; cleanup: () => void } {
  const cacheDir = mkdtempSync(join(tmpdir(), "watcher-error-cache-"));
  const scanDir = mkdtempSync(join(tmpdir(), "watcher-error-scan-"));

  const server = new StreamerServer({
    port: 0,
    apiKey: "tb_test_watcher_error",
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    scanProfiles: [{ id: "test", label: "Test", configDir: scanDir, enabled: true, emoji: "🧪" }],
    // Match every other server fixture: keeps the scanner off its own
    // persistent SQLite index (real host conversations + a native build).
    codexRoots: [],
    scannerPersistent: false,
  });

  const errors: Captured[] = [];
  // Private field, reached at runtime as the other server fixtures do.
  (server as any).log.error = (message: string, meta: Record<string, unknown>) => {
    errors.push({ message, meta });
  };

  return {
    server,
    errors,
    cleanup: () => {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(scanDir, { recursive: true, force: true });
    },
  };
}

// The callback server.ts handed to the ConversationWatcher constructor. Reading
// it back is the point of the test: an unwired channel reads as `undefined`.
function wiredOnError(server: StreamerServer): (p: string, e: Error) => void {
  return (server as any).fileWatcher.onError;
}

describe("watcher error wiring", () => {
  it("routes an ENOSPC watch failure to a named, actionable log line", () => {
    const { server, errors, cleanup } = buildServer();
    try {
      const err: NodeJS.ErrnoException = new Error("ENOSPC: System limit reached");
      err.code = "ENOSPC";

      wiredOnError(server)("/home/u/.claude/projects/p/conv.jsonl", err);

      expect(errors).toHaveLength(1);
      expect(errors[0].meta.event).toBe("watcher.limit_exhausted");
      // The operator has to be able to act on it without reading the source.
      expect(errors[0].message).toContain("max_user_watches");
      expect(errors[0].message).toContain("/home/u/.claude/projects/p/conv.jsonl");
    } finally {
      cleanup();
    }
  });

  it("still reports a non-ENOSPC watcher error, under a distinct event", () => {
    const { server, errors, cleanup } = buildServer();
    try {
      wiredOnError(server)("/tmp/whatever.jsonl", new Error("EACCES: permission denied"));

      expect(errors).toHaveLength(1);
      expect(errors[0].meta.event).toBe("watcher.error");
      expect(errors[0].message).toContain("EACCES: permission denied");
    } finally {
      cleanup();
    }
  });
});
