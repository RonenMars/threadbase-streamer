/**
 * Exact PID → session-id lookups for agent processes started outside the
 * streamer: Claude's ~/.claude/sessions/<pid>.json registry and the rollout a
 * Codex pid holds open. Both must be exact or say nothing — a wrong pairing
 * would let terminate/adopt act on someone else's conversation.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSessionIds,
  type SessionIdResolvers,
  teammateFromArgs,
} from "../src/process-discovery";
import {
  CLAUDE_REGISTRY_START_SLACK_MS,
  claudeConfigDir,
  codexRolloutIdForPid,
  findTeammateSessionId,
  parseClaudeRegistryEntry,
  parseLsofRolloutIds,
  procStartFromStat,
  readClaudeSessionRegistry,
} from "../src/services/sessions/processSessionIds";
import type { DiscoveredProcess } from "../src/types";

const SESSION = "f5619e7a-0ee5-4fbe-9620-a4f0619d0917";
const ROLLOUT = "01a06e20-75ff-7cb2-8cc2-14fb76121928";
const PID = 293_707;

function registry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: PID,
    sessionId: SESSION,
    cwd: "/Users/someone/dev/foo",
    kind: "interactive",
    entrypoint: "claude",
    name: "some-session",
    startedAt: Date.parse("2026-10-02T10:00:01Z"),
    ...overrides,
  });
}

describe("parseClaudeRegistryEntry", () => {
  it("reads the session id, cwd and name for the pid it is named after", () => {
    expect(parseClaudeRegistryEntry(registry(), PID)).toMatchObject({
      pid: PID,
      sessionId: SESSION,
      cwd: "/Users/someone/dev/foo",
      name: "some-session",
      kind: "interactive",
    });
  });

  it("rejects a file whose content names a different pid", () => {
    expect(parseClaudeRegistryEntry(registry({ pid: PID + 1 }), PID)).toBeNull();
  });

  it("rejects a session id that is not a uuid", () => {
    expect(parseClaudeRegistryEntry(registry({ sessionId: "not-a-uuid" }), PID)).toBeNull();
    expect(parseClaudeRegistryEntry(registry({ sessionId: 42 }), PID)).toBeNull();
  });

  it("rejects malformed json and non-objects", () => {
    expect(parseClaudeRegistryEntry("{nope", PID)).toBeNull();
    expect(parseClaudeRegistryEntry("null", PID)).toBeNull();
  });

  it("rejects an entry left behind by an earlier process with the same pid", () => {
    const processStart = new Date("2026-10-02T12:00:00Z");
    const stale = registry({
      startedAt: processStart.getTime() - CLAUDE_REGISTRY_START_SLACK_MS - 1,
    });
    expect(parseClaudeRegistryEntry(stale, PID, processStart)).toBeNull();
  });

  it("accepts an entry written shortly after the process started", () => {
    const processStart = new Date("2026-10-02T10:00:00Z");
    expect(parseClaudeRegistryEntry(registry(), PID, processStart)?.sessionId).toBe(SESSION);
  });

  it("rejects an entry whose procStart is a different process's start tick", () => {
    expect(
      parseClaudeRegistryEntry(registry({ procStart: "447" }), PID, undefined, "448"),
    ).toBeNull();
    expect(
      parseClaudeRegistryEntry(registry({ procStart: "447" }), PID, undefined, "447")?.sessionId,
    ).toBe(SESSION);
  });

  it("reads the start tick out of /proc/<pid>/stat, even with spaces in comm", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    fields[19] = "447"; // field 22
    expect(procStartFromStat(`120 (claude code) ${fields.join(" ")}`)).toBe("447");
  });

  it("does not need startedAt on either side", () => {
    expect(parseClaudeRegistryEntry(registry({ startedAt: undefined }), PID)?.sessionId).toBe(
      SESSION,
    );
  });
});

describe("readClaudeSessionRegistry", () => {
  it("reads <configDir>/sessions/<pid>.json", async () => {
    const paths: string[] = [];
    const entry = await readClaudeSessionRegistry(PID, {
      configDir: "/cfg",
      read: async (p) => {
        paths.push(p);
        if (p.startsWith("/proc/")) throw new Error("ENOENT");
        return registry();
      },
    });
    expect(paths[0]).toBe(join("/cfg", "sessions", `${PID}.json`));
    expect(entry?.sessionId).toBe(SESSION);
  });

  it("returns null when the file is absent", async () => {
    const entry = await readClaudeSessionRegistry(PID, {
      configDir: "/cfg",
      read: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(entry).toBeNull();
  });

  it("honours CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/elsewhere" })).toBe("/elsewhere");
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });
});

describe("codexRolloutIdForPid", () => {
  const rolloutPath = `/Users/someone/.codex/sessions/2026/10/02/rollout-2026-10-02T08-05-49-${ROLLOUT}.jsonl`;

  it("parses rollout uuids out of lsof -F n output", () => {
    const out = ["p4242", "n/dev/ttys003", `n${rolloutPath}`, "n/usr/lib/libz.dylib"].join("\n");
    expect(parseLsofRolloutIds(out)).toEqual([ROLLOUT]);
  });

  it("returns the one rollout the pid holds open", async () => {
    const calls: string[][] = [];
    const id = await codexRolloutIdForPid(4242, {
      platform: "darwin",
      run: async (args) => {
        calls.push(args);
        return `p4242\nn${rolloutPath}\n`;
      },
    });
    expect(id).toBe(ROLLOUT);
    expect(calls[0]).toEqual(expect.arrayContaining(["-p", "4242"]));
  });

  it("refuses to choose when more than one rollout is open", async () => {
    const other = rolloutPath.replace(ROLLOUT, "11111111-2222-4333-8444-555555555555");
    const id = await codexRolloutIdForPid(4242, {
      platform: "linux",
      run: async () => `p4242\nn${rolloutPath}\nn${other}\n`,
    });
    expect(id).toBeNull();
  });

  it("is no evidence on Windows or when lsof fails", async () => {
    const run = vi.fn(async () => `n${rolloutPath}`);
    expect(await codexRolloutIdForPid(4242, { platform: "win32", run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(
      await codexRolloutIdForPid(4242, {
        platform: "linux",
        run: async () => {
          throw new Error("lsof timed out");
        },
      }),
    ).toBeNull();
  });
});

describe("resolveSessionIds", () => {
  let emptyDir: string;
  beforeAll(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "threadbase-resolve-ids-"));
  });
  afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

  function proc(overrides: Partial<DiscoveredProcess>): DiscoveredProcess {
    return {
      pid: PID,
      provider: "claude-code",
      projectPath: "/Users/someone/dev/foo",
      projectName: "foo",
      branch: "main",
      conversationId: null,
      startedAt: new Date("2026-10-02T10:00:00Z"),
      ...overrides,
    };
  }

  function resolvers(overrides: Partial<SessionIdResolvers> = {}): SessionIdResolvers {
    return {
      claude: async () => null,
      codex: async () => null,
      teammate: async () => null,
      ...overrides,
    };
  }

  it("gives a plain `claude` its session id from the registry", async () => {
    const [out] = await resolveSessionIds(
      [proc({})],
      new Map(),
      resolvers({ claude: async () => ({ pid: PID, sessionId: SESSION }) }),
    );
    expect(out.conversationId).toBe(SESSION);
    expect(out.projectPath).toBe("/Users/someone/dev/foo");
  });

  it("prefers the registry over a launch-time --resume id", async () => {
    const [out] = await resolveSessionIds(
      [proc({ conversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })],
      new Map(),
      resolvers({ claude: async () => ({ pid: PID, sessionId: SESSION }) }),
    );
    expect(out.conversationId).toBe(SESSION);
  });

  it("fills a missing cwd (Windows) from the registry", async () => {
    const [out] = await resolveSessionIds(
      [proc({ projectPath: "", projectName: "", branch: "" })],
      new Map(),
      resolvers({ claude: async () => ({ pid: PID, sessionId: SESSION, cwd: emptyDir }) }),
    );
    expect(out.projectPath).toBe(emptyDir);
    expect(out.projectName).toBe(emptyDir.split(/[\\/]/).pop());
  });

  it("passes the OS start time through for the stale-entry check", async () => {
    const start = new Date("2026-10-02T09:59:59Z");
    const claude = vi.fn(async () => null);
    await resolveSessionIds([proc({})], new Map([[PID, start]]), resolvers({ claude }));
    expect(claude).toHaveBeenCalledWith(PID, start);
  });

  it("gives a plain `codex` the id of the rollout it holds open", async () => {
    const [out] = await resolveSessionIds(
      [proc({ provider: "codex-cli" })],
      new Map(),
      resolvers({ codex: async () => ROLLOUT }),
    );
    expect(out.conversationId).toBe(ROLLOUT);
  });

  it("keeps a Codex id stated in argv without probing", async () => {
    const codex = vi.fn(async () => "11111111-2222-4333-8444-555555555555");
    const [out] = await resolveSessionIds(
      [proc({ provider: "codex-cli", conversationId: ROLLOUT })],
      new Map(),
      resolvers({ codex }),
    );
    expect(out.conversationId).toBe(ROLLOUT);
    expect(codex).not.toHaveBeenCalled();
  });

  it("leaves a process untouched when a lookup finds nothing or throws", async () => {
    const out = await resolveSessionIds(
      [proc({}), proc({ pid: PID + 1, provider: "codex-cli" }), proc({ provider: "cursor" })],
      new Map(),
      resolvers({
        claude: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out.map((p) => p.conversationId)).toEqual([null, null, null]);
  });
});

// ─── Teammates: `claude --agent-id … --agent-name … --team-name …` ───────────
//
// A teammate is a separate `claude` process the lead spawned. It writes no
// ~/.claude/sessions/<pid>.json and its argv names no session, so the only
// exact evidence of its session is its own transcript, which records the
// agentName and teamName it was launched with.

const TEAMMATE_ARGS =
  "/opt/homebrew/Caskroom/claude-code@latest/2.1.316/claude --agent-id cold-start@session-c4717b02 " +
  "--agent-name cold-start --team-name session-c4717b02 --agent-color blue " +
  "--parent-session-id c4717b02-545b-462b-b34c-0dc2e84cb553 --agent-type general-purpose";

describe("teammateFromArgs", () => {
  it("reads the agent and team name, and ignores the lead's --parent-session-id", () => {
    expect(teammateFromArgs(TEAMMATE_ARGS)).toEqual({
      agentName: "cold-start",
      teamName: "session-c4717b02",
    });
  });

  it("is null for a plain claude and when either name is missing", () => {
    expect(teammateFromArgs("claude --dangerously-skip-permissions")).toBeNull();
    expect(teammateFromArgs("claude --agent-name solo")).toBeNull();
    expect(teammateFromArgs("claude --team-name t --agent-name")).toBeNull();
    expect(teammateFromArgs("claude --agent-name --team-name t")).toBeNull();
  });
});

describe("findTeammateSessionId", () => {
  const MINE = "74d3fb6a-bc09-42cc-a887-cf75a3dda782";
  const OTHER = "230d3794-7f03-4249-83f1-ae6cd6dbfbfc";
  const CWD = "/Users/someone/dev/my.repo";
  const START = new Date("2026-11-01T18:00:00Z");
  let configDir: string;
  let projectDir: string;

  function transcript(
    name: string,
    id: string,
    who: { agentName: string; teamName: string } | null,
    mtime: Date,
  ): void {
    const lines = [
      JSON.stringify({ type: "summary", note: "no agent fields here" }),
      JSON.stringify({ type: "user", ...(who ?? {}), sessionId: id }),
    ];
    writeFileSync(join(projectDir, name), `${lines.join("\n")}\n`);
    utimesSync(join(projectDir, name), mtime, mtime);
  }
  const after = new Date("2026-11-01T18:05:00Z");
  const me = { agentName: "cold-start", teamName: "session-c4717b02" };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "threadbase-teammate-"));
    // Claude names a project's directory by replacing every non-alphanumeric.
    projectDir = join(configDir, "projects", "-Users-someone-dev-my-repo");
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  const find = (processStartedAt: Date | undefined = START) =>
    findTeammateSessionId(CWD, "cold-start", "session-c4717b02", { configDir, processStartedAt });

  it("returns the id of the one transcript carrying this agent and team", async () => {
    transcript(`${MINE}.jsonl`, MINE, me, after);
    transcript(`${OTHER}.jsonl`, OTHER, { ...me, agentName: "someone-else" }, after);
    await expect(find()).resolves.toBe(MINE);
  });

  it("ignores a transcript from a different team with the same agent name", async () => {
    transcript(`${OTHER}.jsonl`, OTHER, { ...me, teamName: "session-other" }, after);
    await expect(find()).resolves.toBeNull();
  });

  it("ignores a transcript last written before the process started", async () => {
    transcript(`${MINE}.jsonl`, MINE, me, new Date("2026-11-01T10:00:00Z"));
    await expect(find()).resolves.toBeNull();
  });

  it("refuses to choose when two transcripts both match", async () => {
    transcript(`${MINE}.jsonl`, MINE, me, after);
    transcript(`${OTHER}.jsonl`, OTHER, me, after);
    await expect(find()).resolves.toBeNull();
  });

  it("ignores a file whose name is not a session uuid", async () => {
    transcript("notes.jsonl", MINE, me, after);
    await expect(find()).resolves.toBeNull();
  });

  it("is null when the project directory does not exist", async () => {
    await expect(
      findTeammateSessionId("/nowhere/at/all", "cold-start", "session-c4717b02", { configDir }),
    ).resolves.toBeNull();
  });
});

describe("resolveSessionIds for a teammate", () => {
  const TEAM = { agentName: "cold-start", teamName: "session-c4717b02" };
  const TEAMMATE_ID = "74d3fb6a-bc09-42cc-a887-cf75a3dda782";
  const base: DiscoveredProcess = {
    pid: PID,
    provider: "claude-code",
    projectPath: "/Users/someone/dev/foo",
    projectName: "foo",
    branch: "main",
    conversationId: null,
    startedAt: new Date("2026-10-02T10:00:00Z"),
  };
  const none: SessionIdResolvers = {
    claude: async () => null,
    codex: async () => null,
    teammate: async () => null,
  };

  it("gives a teammate with no registry entry the id of its own transcript", async () => {
    const teammate = vi.fn(async () => TEAMMATE_ID);
    const [out] = await resolveSessionIds(
      [{ ...base, teammate: TEAM }],
      new Map([[PID, base.startedAt]]),
      { ...none, teammate },
    );
    expect(out.conversationId).toBe(TEAMMATE_ID);
    expect(teammate).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: base.projectPath, teammate: TEAM }),
      base.startedAt,
    );
  });

  it("lets the registry win over the transcript lookup", async () => {
    const teammate = vi.fn(async () => TEAMMATE_ID);
    const [out] = await resolveSessionIds([{ ...base, teammate: TEAM }], new Map(), {
      ...none,
      claude: async () => ({ pid: PID, sessionId: SESSION }),
      teammate,
    });
    expect(out.conversationId).toBe(SESSION);
    expect(teammate).not.toHaveBeenCalled();
  });

  it("keeps an id the teammate's argv already states", async () => {
    const teammate = vi.fn(async () => TEAMMATE_ID);
    const [out] = await resolveSessionIds(
      [{ ...base, teammate: TEAM, conversationId: SESSION }],
      new Map(),
      { ...none, teammate },
    );
    expect(out.conversationId).toBe(SESSION);
    expect(teammate).not.toHaveBeenCalled();
  });

  it("never runs the transcript lookup for a process that is not a teammate", async () => {
    const teammate = vi.fn(async () => TEAMMATE_ID);
    const [out] = await resolveSessionIds([base], new Map(), { ...none, teammate });
    expect(out.conversationId).toBeNull();
    expect(teammate).not.toHaveBeenCalled();
  });
});
