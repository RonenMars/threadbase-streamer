// watchForJsonl must bind the transcript even when fs.watch never delivers an
// event. macOS delivers them late under load (past the 15 s budget in
// transcript-watch-deadline.test.ts during a loaded `npm run deploy`), and a
// watch with no second chance lost the binding for good.
import { EventEmitter } from "events";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  CLAUDE_JSONL_POLL_MS,
  SessionWatchers,
  type SessionWatchersDeps,
} from "../src/session-watchers";

// A watch that opens fine and then never fires, like one whose events are stuck.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    watch: vi.fn(() => Object.assign(new EventEmitter(), { close: vi.fn() })),
  };
});

const SESSION_ID = "b1b1b1b1-0000-4000-8000-0000000000f1";

describe("watchForJsonl with a silent fs.watch", () => {
  let projectPath: string;
  let hasSession: boolean;
  let sessionFileMap: Map<string, string>;
  let watchers: SessionWatchers;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "tb-watch-poll-proj-"));
    hasSession = true;
    sessionFileMap = new Map();
    watchers = new SessionWatchers({
      ptyManager: { hasSession: () => hasSession },
      sessionStore: {
        getManaged: () => ({ startedAt: new Date(), promptCount: 1 }),
        listManaged: () => [],
        updateManaged: () => {},
        get: () => null,
      },
      wsHub: { broadcast: () => {} },
      fileWatcher: { watch: () => {} },
      sessionFileMap,
      scannerManager: { markStaleOrDrop: () => {} },
      codexRoots: [],
      cursorRoots: [],
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
    rmSync(join(homedir(), ".claude", "projects", projectPath.replace(/[/\\:.]/g, "-")), {
      recursive: true,
      force: true,
    });
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("binds the transcript on the poll", async () => {
    watchers.watchForJsonl(SESSION_ID, projectPath);
    const dir = join(homedir(), ".claude", "projects", projectPath.replace(/[/\\:.]/g, "-"));
    const jsonlPath = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(jsonlPath, `${JSON.stringify({ sessionId: SESSION_ID, type: "user" })}\n`);

    await vi.waitFor(() => expect(sessionFileMap.get(SESSION_ID)).toBe(jsonlPath), {
      timeout: CLAUDE_JSONL_POLL_MS * 5,
      interval: 20,
    });
  });
});
