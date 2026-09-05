// The transcript watchers give up 120s after the SPAWN, but both providers
// create the transcript on the user's FIRST TURN — so what the deadline really
// races is human think time. Measured over a 20.5-day production log:
//
//   claude  21 fresh starts, 12 ever typed, gap from pty.ready to first input
//           3.6 4.3 5.1 8.4 12.3 12.3 15.9 19.5 61.7 72.5 275.7 405.7 s
//   codex    5 fresh starts,  3 ever typed, 60.2 75.6 86.8 s
//
// The two Claude sessions past 120s never emitted session.jsonl_wired.
//
// These drive SessionWatchers directly rather than through StreamerServer:
// once a server is listening in the same process, fs.watch stops delivering
// reliably (measured: 0 of 1 events on a plain tmpdir), which is what the
// "in vitest this sometimes misses" note in watch-for-jsonl.test.ts is about.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { SessionWatchers, type SessionWatchersDeps } from "../src/session-watchers";

const SESSION_ID = "b1b1b1b1-0000-4000-8000-000000000001";

function claudeProjectsDir(projectPath: string): string {
  return join(homedir(), ".claude", "projects", projectPath.replace(/[/\\:.]/g, "-"));
}

describe("transcript watch deadline", () => {
  let projectPath: string;
  let codexRoot: string;
  let sessionFileMap: Map<string, string>;
  let managed: { startedAt: Date; promptCount: number; boundConversationId?: string };
  let hasSession: boolean;
  let watchers: SessionWatchers;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "tb-watch-deadline-proj-"));
    codexRoot = mkdtempSync(join(tmpdir(), "tb-watch-deadline-codex-"));
    sessionFileMap = new Map();
    managed = { startedAt: new Date(), promptCount: 0 };
    hasSession = true;

    watchers = new SessionWatchers({
      ptyManager: { hasSession: () => hasSession },
      sessionStore: {
        getManaged: () => managed,
        listManaged: () => [],
        updateManaged: (_id: string, patch: Record<string, unknown>) =>
          Object.assign(managed, patch),
        get: () => null,
      },
      wsHub: { broadcast: () => {} },
      fileWatcher: { watch: () => {} },
      sessionFileMap,
      scannerManager: { markStaleOrDrop: () => {} },
      codexRoots: [codexRoot],
      cache: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      sessionsRepo: () => null,
      cacheMetadataRepo: () => null,
      managedSessionsRepo: () => null,
      findConversationByUuid: async () => null,
      broadcastConversationLines: () => {},
      ptyAttachedIds: () => new Set<string>(),
    } as unknown as SessionWatchersDeps);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(claudeProjectsDir(projectPath), { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(codexRoot, { recursive: true, force: true });
  });

  // Only Date is faked, so fs.watch and the Codex poll keep running for real
  // and the assertions wait on actual filesystem work rather than tick counts.
  function jumpClock(ms: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + ms));
  }

  async function waitFor<T>(read: () => T | undefined, budgetMs: number): Promise<T | undefined> {
    const until = performance.now() + budgetMs;
    while (performance.now() < until) {
      const value = read();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 20));
    }
    return read();
  }

  describe("watchForJsonl (Claude)", () => {
    it("wires {sessionId}.jsonl created five minutes after the spawn", async () => {
      watchers.watchForJsonl(SESSION_ID, projectPath);
      const jsonlPath = join(claudeProjectsDir(projectPath), `${SESSION_ID}.jsonl`);

      jumpClock(300_000);
      // The user finally sends their first prompt; Claude creates the transcript.
      writeFileSync(
        jsonlPath,
        `${JSON.stringify({ sessionId: SESSION_ID, cwd: projectPath, type: "user" })}\n`,
      );

      expect(await waitFor(() => sessionFileMap.get(SESSION_ID), 2000)).toBe(jsonlPath);
    });

    it("still refuses to wire once the PTY is gone, however late the file lands", async () => {
      watchers.watchForJsonl(SESSION_ID, projectPath);
      const jsonlPath = join(claudeProjectsDir(projectPath), `${SESSION_ID}.jsonl`);
      hasSession = false;

      jumpClock(300_000);
      writeFileSync(
        jsonlPath,
        `${JSON.stringify({ sessionId: SESSION_ID, cwd: projectPath, type: "user" })}\n`,
      );

      expect(await waitFor(() => sessionFileMap.get(SESSION_ID), 500)).toBeUndefined();
    });
  });

  describe("watchForCodexRollout", () => {
    // The date dir the poller scans is derived from the real clock at arm time,
    // so it is pinned here rather than recomputed under the faked one. The
    // mtime is set to the faked "now" the 10s recency filter compares against.
    function writeRollout(codexSessionId: string, dirDate: Date): void {
      const dateDir = join(
        codexRoot,
        String(dirDate.getFullYear()),
        String(dirDate.getMonth() + 1).padStart(2, "0"),
        String(dirDate.getDate()).padStart(2, "0"),
      );
      mkdirSync(dateDir, { recursive: true });
      const created = new Date();
      const file = join(dateDir, `rollout-2026-01-01T00-00-00-${codexSessionId}.jsonl`);
      writeFileSync(
        file,
        `${JSON.stringify({
          timestamp: created.toISOString(),
          type: "session_meta",
          payload: {
            id: codexSessionId,
            session_id: codexSessionId,
            cwd: projectPath,
            timestamp: created.toISOString(),
          },
        })}\n`,
      );
      utimesSync(file, created, created);
    }

    it("binds a rollout written long after the spawn, once the user has typed", async () => {
      const dirDate = new Date();
      // No rollout on disk yet: Codex creates it on the first turn, so the
      // synchronous tryWire() finds nothing and the 250ms poll arms.
      watchers.watchForCodexRollout(SESSION_ID, projectPath);
      expect(managed.boundConversationId).toBeUndefined();

      jumpClock(300_000);
      managed.promptCount = 1;
      writeRollout("codex-late-rollout-id", dirDate);

      expect(await waitFor(() => managed.boundConversationId, 2000)).toBe("codex-late-rollout-id");
    });

    it("gives up polling for a session that never got a turn", async () => {
      const dirDate = new Date();
      watchers.watchForCodexRollout(SESSION_ID, projectPath);

      jumpClock(300_000);
      // promptCount stays 0: nothing caused a rollout, so the poll must stop
      // rather than run for the life of the session.
      writeRollout("codex-abandoned-rollout-id", dirDate);

      expect(await waitFor(() => managed.boundConversationId, 800)).toBeUndefined();
    });
  });
});
