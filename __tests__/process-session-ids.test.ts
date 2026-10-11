/**
 * Exact PID → session-id lookups for agent processes started outside the
 * streamer: Claude's ~/.claude/sessions/<pid>.json registry and the rollout a
 * Codex pid holds open. Both must be exact or say nothing — a wrong pairing
 * would let terminate/adopt act on someone else's conversation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionIds, type SessionIdResolvers } from "../src/process-discovery";
import {
  CLAUDE_REGISTRY_START_SLACK_MS,
  claudeConfigDir,
  codexRolloutIdForPid,
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
