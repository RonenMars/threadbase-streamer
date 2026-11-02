// The Codex rollout replay (SessionWatchers.watchForCodexRollout) hands the live
// overlay the WHOLE file at wiring time. The offset index supplies no position
// for that dump, so the overlay used to filter it unbounded and drop a pasted,
// injected-looking user message that sits later in the conversation (#867).
// The replay starts at byte 0, so it numbers its own lines.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionWatchers, type SessionWatchersDeps } from "../src/session-watchers";
import { toClientConversationLines } from "../src/utils/codexConversationLine";

const SESSION_ID = "b2b2b2b2-0000-4000-8000-000000000002";
const CODEX_ID = "codex-replay-position-id";
const PASTED = "# AGENTS.md\n\nplease review these rules I pasted";

describe("codex rollout replay: injected-context bound", () => {
  let projectPath: string;
  let codexRoot: string;
  let hasSession: boolean;
  let watchers: SessionWatchers;
  let broadcasts: { lines: string[]; seqs?: (number | null)[] | null }[];

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "tb-replay-pos-proj-"));
    codexRoot = mkdtempSync(join(tmpdir(), "tb-replay-pos-codex-"));
    hasSession = true;
    broadcasts = [];
    const managed = { startedAt: new Date(), promptCount: 1 } as Record<string, unknown>;
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
      sessionFileMap: new Map(),
      scannerManager: { markStaleOrDrop: () => {} },
      codexRoots: [codexRoot],
      cursorRoots: [],
      cache: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      sessionsRepo: () => null,
      cacheMetadataRepo: () => null,
      managedSessionsRepo: () => null,
      findConversationByUuid: async () => null,
      broadcastConversationLines: (_id: string, lines: string[], seqs?: (number | null)[] | null) =>
        broadcasts.push({ lines, seqs }),
      ptyAttachedIds: () => new Set<string>(),
    } as unknown as SessionWatchersDeps);
  });

  afterEach(() => {
    hasSession = false;
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(codexRoot, { recursive: true, force: true });
  });

  const message = (role: string, text: string) =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });

  function writeRollout(body: string[]): void {
    const now = new Date();
    const dir = join(
      codexRoot,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-01-01T00-00-00-${CODEX_ID}.jsonl`);
    const meta = JSON.stringify({
      timestamp: now.toISOString(),
      type: "session_meta",
      payload: {
        id: CODEX_ID,
        session_id: CODEX_ID,
        cwd: projectPath,
        timestamp: now.toISOString(),
      },
    });
    writeFileSync(file, `${[meta, ...body].join("\n")}\n`);
    utimesSync(file, now, now);
  }

  /** What the real overlay filter turns the replay broadcast into. */
  function replayedTexts(): string[] {
    expect(broadcasts).toHaveLength(1);
    const { lines, seqs } = broadcasts[0];
    return toClientConversationLines(lines, seqs).lines.map(
      (l) => JSON.parse(l).message.content[0].text,
    );
  }

  async function bound(): Promise<void> {
    const until = performance.now() + 15_000;
    while (broadcasts.length === 0 && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("keeps a pasted AGENTS.md later in the conversation and drops the leading preamble", async () => {
    writeRollout([
      message("user", "# AGENTS.md\n\nproject instructions"),
      message("user", "real question"),
      message("assistant", "real answer"),
      message("user", PASTED),
      message("assistant", "reviewed"),
    ]);
    watchers.watchForCodexRollout(SESSION_ID, projectPath);
    await bound();

    expect(replayedTexts()).toEqual(["real question", "real answer", PASTED, "reviewed"]);
  });

  it("still drops the leading preamble when nothing else is pasted", async () => {
    writeRollout([
      message("user", "# AGENTS.md\n\nproject instructions"),
      message("user", "real question"),
    ]);
    watchers.watchForCodexRollout(SESSION_ID, projectPath);
    await bound();

    expect(replayedTexts()).toEqual(["real question"]);
  });
});
