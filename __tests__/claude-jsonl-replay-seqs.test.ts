// watchForJsonl replays the whole file at wiring time. Like the Codex and
// Cursor replays it starts at byte 0, so it numbers its own lines: the
// message_index the offset index and REST use. Without seqs the client cannot
// match the replay against its history copies (#867).

import { createJsonlParseState, parseJsonlLine } from "@threadbase-sh/scanner";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionWatchers, type SessionWatchersDeps } from "../src/session-watchers";

const SESSION_ID = "b3b3b3b3-0000-4000-8000-000000000003";

describe("claude transcript replay: seqs", () => {
  let projectPath: string;
  let configDir: string;
  let origConfigDir: string | undefined;
  let hasSession: boolean;
  let broadcasts: { lines: string[]; seqs?: (number | null)[] | null }[];
  let watchers: SessionWatchers;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "tb-claude-seq-proj-"));
    configDir = mkdtempSync(join(tmpdir(), "tb-claude-seq-cfg-"));
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    hasSession = true;
    broadcasts = [];
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
      sessionFileMap: new Map(),
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
      broadcastConversationLines: (_id: string, lines: string[], seqs?: (number | null)[] | null) =>
        broadcasts.push({ lines, seqs }),
      ptyAttachedIds: () => new Set<string>(),
    } as unknown as SessionWatchersDeps);
  });

  afterEach(() => {
    hasSession = false;
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const msg = (type: "user" | "assistant", text: string, n: number) =>
    JSON.stringify({
      type,
      uuid: `u-${n}`,
      sessionId: SESSION_ID,
      timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
      message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
    });

  it("numbers the replayed lines by message position, null for non-messages", async () => {
    const lines = [
      JSON.stringify({ type: "summary", summary: "s", leafUuid: "x" }),
      msg("user", "first", 1),
      "not json",
      msg("assistant", "second", 2),
      msg("user", "third", 3),
    ];
    const encoded = projectPath.replace(/[/\\:.]/g, "-");
    const dir = join(configDir, "projects", encoded);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION_ID}.jsonl`), `${lines.join("\n")}\n`);

    watchers.watchForJsonl(SESSION_ID, projectPath);

    expect(broadcasts).toHaveLength(1);
    // Expected positions come from the same reducer the offset index uses.
    const state = createJsonlParseState();
    let next = 0;
    const expected = lines.map((l) => (parseJsonlLine(l, state) ? next++ : null));
    expect(expected.filter((s) => s !== null).length).toBeGreaterThanOrEqual(3);
    expect(broadcasts[0].seqs).toEqual(expected);
  });
});
