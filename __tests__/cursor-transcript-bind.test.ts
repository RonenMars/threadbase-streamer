// Cursor late-bind: the CLI mints its own run id under agent-transcripts/, so
// a fresh managed session must discover that file and set boundConversationId
// the same way Codex does for rollouts. Kept in its own file so the Claude
// fs.watch deadline suite is not under extra poll pressure (#827).
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cursorAgentTranscriptsDir, cursorProjectSlug } from "../src/cursor-transcript-watch";
import { SessionWatchers, type SessionWatchersDeps } from "../src/session-watchers";

const SESSION_ID = "b1b1b1b1-0000-4000-8000-000000000001";
const BIND_BUDGET_MS = 15_000;

describe("watchForCursorTranscript", () => {
  let projectPath: string;
  let cursorRoot: string;
  let sessionFileMap: Map<string, string>;
  let managed: { startedAt: Date; promptCount: number; boundConversationId?: string };
  let hasSession: boolean;
  let watchers: SessionWatchers;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "tb-cursor-bind-proj-"));
    cursorRoot = mkdtempSync(join(tmpdir(), "tb-cursor-bind-root-"));
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
      codexRoots: [],
      cursorRoots: [cursorRoot],
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
    hasSession = false;
    vi.useRealTimers();
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(cursorRoot, { recursive: true, force: true });
  });

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

  function captureExpiry(): () => string | undefined {
    let sessionId: string | undefined;
    const log = (
      watchers as unknown as {
        log: {
          warn: (msg: string, fields?: Record<string, unknown>, dest?: string) => void;
        };
      }
    ).log;
    const original = log.warn.bind(log);
    log.warn = (msg, fields, dest) => {
      if (fields?.event === "session.transcript_watch_expired") {
        sessionId = fields.sessionId as string;
      }
      original(msg, fields, dest);
    };
    return () => sessionId;
  }

  function writeCursorTranscript(runId: string, body: string, mtime: Date = new Date()): string {
    const dir = join(cursorAgentTranscriptsDir(cursorRoot, projectPath), runId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${runId}.jsonl`);
    writeFileSync(file, body);
    utimesSync(file, mtime, mtime);
    return file;
  }

  it("binds a run-id transcript written after the first turn", async () => {
    watchers.watchForCursorTranscript(SESSION_ID, projectPath);
    expect(managed.boundConversationId).toBeUndefined();

    jumpClock(300_000);
    managed.promptCount = 1;
    const runId = "c1c1c1c1-0000-4000-8000-0000000000c1";
    const file = writeCursorTranscript(
      runId,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello from cursor" }] },
      })}\n`,
    );

    expect(await waitFor(() => managed.boundConversationId, BIND_BUDGET_MS)).toBe(runId);
    expect(sessionFileMap.get(SESSION_ID)).toBe(file);
  });

  it("prefers a transcript that mentions this session's upload path", async () => {
    watchers.watchForCursorTranscript(SESSION_ID, projectPath);
    managed.promptCount = 1;

    const otherId = "d2d2d2d2-0000-4000-8000-0000000000d2";
    const ours = "e3e3e3e3-0000-4000-8000-0000000000e3";
    // Older-but-matching upload marker must beat a newer unrelated chat in
    // the same project slug (the production failure mode: scanner indexes
    // Cursor's run id while mobile deep-links the streamer placeholder).
    writeCursorTranscript(
      otherId,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "unrelated chat" }] },
      })}\n`,
      new Date(),
    );
    const oursFile = writeCursorTranscript(
      ours,
      `${JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `see .threadbase-uploads/${SESSION_ID}/shot.jpg and fix the FAB`,
            },
          ],
        },
      })}\n`,
      new Date(Date.now() - 1_000),
    );

    expect(await waitFor(() => managed.boundConversationId, BIND_BUDGET_MS)).toBe(ours);
    expect(sessionFileMap.get(SESSION_ID)).toBe(oursFile);
  });

  it("does not expire before the first turn, then binds", async () => {
    // Claude-style: prompts === 0 must not close the watch. Jumping past the
    // initial deadline and only then sending a turn still has to bind.
    watchers.watchForCursorTranscript(SESSION_ID, projectPath);

    jumpClock(300_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(managed.boundConversationId).toBeUndefined();

    managed.promptCount = 1;
    const runId = "f4f4f4f4-0000-4000-8000-0000000000f4";
    writeCursorTranscript(
      runId,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "late first turn" }] },
      })}\n`,
    );

    expect(await waitFor(() => managed.boundConversationId, BIND_BUDGET_MS)).toBe(runId);
  });

  it("gives up once a prompted session goes overdue with no file", async () => {
    const expired = captureExpiry();
    watchers.watchForCursorTranscript(SESSION_ID, projectPath);
    managed.promptCount = 1;

    // Force a poll tick so the re-armed deadline is observed, then jump past it.
    await new Promise((r) => setTimeout(r, 300));
    jumpClock(300_000);
    expect(await waitFor(expired, BIND_BUDGET_MS)).toBe(SESSION_ID);

    writeCursorTranscript(
      "a5a5a5a5-0000-4000-8000-0000000000a5",
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "too late" }] },
      })}\n`,
    );
    expect(await waitFor(() => managed.boundConversationId, 800)).toBeUndefined();
  });
});

describe("cursorProjectSlug", () => {
  it("encodes POSIX absolute paths the way Cursor names project dirs", () => {
    expect(cursorProjectSlug("/Users/me/dev/app")).toBe("Users-me-dev-app");
  });

  it("encodes Windows paths without leaving a drive colon", () => {
    expect(cursorProjectSlug("C:\\Users\\me\\app")).toBe("C-Users-me-app");
  });
});
