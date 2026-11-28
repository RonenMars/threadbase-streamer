import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import { tmpdir } from "os";
import { join } from "path";
import { parseTtl, runExternalControlGrant } from "../cli/externalControl";
import type { AppEnv } from "../src/api/app";
import { mountExternalControlRoutes } from "../src/api/routes/external-control.routes";
import { resolveMigrationsDir, runSqliteMigrations } from "../src/db/sqlite-migrate";
import { ExternalControlGrantsRepository } from "../src/services/external-control/repository";
import { type ResolverDeps, resolveBinding } from "../src/services/external-control/resolver";
import { ExternalControlService } from "../src/services/external-control/service";
import { type Principal, requiredCapability } from "../src/services/security/capabilities";
import {
  hexKeyArgs,
  isSafeLiteral,
  parseTmuxVersion,
  tmuxVersionSupported,
} from "../src/tmux/client";
import { parsePaneList } from "../src/tmux/pane-inventory";
import { type ProcRow, parsePsTable, verifyForeground } from "../src/tmux/process-table";
import { boundLines, sanitizeScreenLine } from "../src/tmux/screen";
import type { DiscoveredProcess } from "../src/types";

const SID = "11111111-2222-4333-8444-555555555555";

function proc(over: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid: 500,
    provider: "claude-code",
    projectPath: "/w",
    projectName: "w",
    branch: "",
    conversationId: SID,
    startedAt: new Date(0),
    ...over,
  };
}

function row(pid: number, ppid: number, pgid: number, tpgid: number, tty: string): ProcRow {
  return { pid, ppid, pgid, tpgid, tty };
}

/** A process table: pane shell 400 on pts/7, agent 500 in the foreground. */
function table(extra: ProcRow[] = []): Map<number, ProcRow> {
  const rows = [row(400, 1, 400, 500, "pts/7"), row(500, 400, 500, 500, "pts/7"), ...extra];
  return new Map(rows.map((r) => [r.pid, r]));
}

/** A fake tmux that serves one server and the given panes. */
function fakeExec(panes: string, opts: { failCapture?: boolean } = {}) {
  const calls: string[][] = [];
  const exec = async (_sock: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "display-message" && args.includes("#{pid}|#{start_time}")) return "77|1700\n";
    if (args[0] === "display-message") return "80|24|3|5\n";
    if (args[0] === "list-panes") return panes;
    if (args[0] === "capture-pane") {
      if (opts.failCapture) throw new Error("boom");
      return "hello\u001b]52;c;ZXZpbA==\u0007\nworld\n";
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  return { exec, calls };
}

function deps(over: Partial<ResolverDeps> = {}, panes = "%3|400|/dev/pts/7|0|0\n"): ResolverDeps {
  return {
    exec: fakeExec(panes).exec,
    sockets: [],
    bootId: async () => "boot",
    processTable: async () => table(),
    startToken: async () => "linux:123",
    currentConversation: async () => SID,
    otherAgentPids: () => [],
    ...over,
  };
}

// resolveBinding checks the socket on disk; point it at nothing and inject one.
vi.mock("../src/tmux/server-registry", async (orig) => {
  const real = await orig<typeof import("../src/tmux/server-registry")>();
  return {
    ...real,
    checkSocket: () => ({ ok: true, realPath: "/tmp/tmux-1/default", devIno: "1:2" }),
  };
});

describe("tmux primitives", () => {
  it("parses versions and enforces the floor", () => {
    expect(parseTmuxVersion("tmux 3.3a")).toEqual({ major: 3, minor: 3 });
    expect(parseTmuxVersion("tmux next-3.5")).toEqual({ major: 3, minor: 5 });
    expect(tmuxVersionSupported(parseTmuxVersion("tmux 3.1c"))).toBe(false);
    expect(tmuxVersionSupported(parseTmuxVersion("tmux 3.2"))).toBe(true);
    expect(tmuxVersionSupported(parseTmuxVersion("tmux 4.0"))).toBe(true);
    expect(tmuxVersionSupported(null)).toBe(false);
  });

  it("accepts only bounded, control-free literals", () => {
    expect(isSafeLiteral("Review the diff; then stop")).toBe(true);
    expect(isSafeLiteral("")).toBe(false);
    expect(isSafeLiteral("a\nb")).toBe(false);
    expect(isSafeLiteral("a\u0000")).toBe(false);
    expect(isSafeLiteral("\u001b[2J")).toBe(false);
    expect(isSafeLiteral("\u009b")).toBe(false);
    expect(isSafeLiteral("\ud800")).toBe(false);
    expect(isSafeLiteral("x".repeat(4097))).toBe(false);
    expect(isSafeLiteral("🙂")).toBe(true);
  });

  it("emits only hex tokens after the pane id", () => {
    expect(hexKeyArgs("%3", "a;")).toEqual(["send-keys", "-H", "-t", "%3", "61", "3b"]);
    expect(() => hexKeyArgs("%3;" as `%${number}`, "a")).toThrow();
    expect(() => hexKeyArgs("%3", "a\r")).toThrow();
  });

  it("parses panes by numeric fields only and dedupes linked windows", () => {
    const panes = parsePaneList(
      [
        "%1|10|/dev/pts/1|0|0",
        "%1|10|/dev/pts/1|0|0",
        "%2|11|/dev/ttys004|1|1",
        "%x|12|/dev/pts/2|0|0",
        "%3|13|/dev/pts/3;rm|0|0",
        "%4|14|/dev/pts/4|0",
        "",
      ].join("\n"),
    );
    expect(panes).toEqual([
      { paneId: "%1", panePid: 10, paneTty: "pts/1", dead: false, inMode: false },
      { paneId: "%2", panePid: 11, paneTty: "ttys004", dead: true, inMode: true },
    ]);
  });

  it("reads a ps table", () => {
    const t = parsePsTable("  1     0     1    -1 ?\n 500   400   500   500 pts/7\nbad\n");
    expect(t.get(500)).toEqual(row(500, 400, 500, 500, "pts/7"));
    expect(t.get(1)?.tty).toBe("?");
  });

  it("verifies foreground ownership", () => {
    const pane = { panePid: 400, paneTty: "pts/7" };
    expect(verifyForeground(table(), 500, pane)).toEqual({ ok: true });
    expect(verifyForeground(table(), 999, pane)).toEqual({ ok: false, reason: "process_gone" });
    expect(verifyForeground(table([row(600, 400, 600, 500, "pts/7")]), 600, pane)).toEqual({
      ok: false,
      reason: "background",
    });
    expect(verifyForeground(table([row(700, 1, 700, 700, "pts/7")]), 700, pane)).toEqual({
      ok: false,
      reason: "not_descendant",
    });
    expect(verifyForeground(table(), 500, { panePid: 400, paneTty: "pts/8" })).toEqual({
      ok: false,
      reason: "tty_mismatch",
    });
  });

  it("strips terminal controls and keeps the newest lines within the byte cap", () => {
    expect(sanitizeScreenLine("a\u001b]52;c;eA==\u0007b\tc\u009bd")).toBe("a]52;c;eA==b\tcd");
    expect(boundLines(["old", "mid", "new"], 8)).toEqual({
      lines: ["mid", "new"],
      truncated: true,
    });
    expect(boundLines(["a"], 8)).toEqual({ lines: ["a"], truncated: false });
  });
});

describe("resolveBinding", () => {
  it("binds the single foreground pane", async () => {
    const r = await resolveBinding(proc(), SID, deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.binding.pane.paneId).toBe("%3");
      expect(r.binding.bindingId).toMatch(/^ext_[0-9a-f]{16}$/);
    }
  });

  it("refuses providers it cannot identify exactly, and teammates", async () => {
    expect(await resolveBinding(proc({ provider: "cursor" }), SID, deps())).toEqual({
      ok: false,
      reason: "PROVIDER_UNSUPPORTED",
    });
    expect(
      await resolveBinding(proc({ teammate: { agentName: "a", teamName: "t" } }), SID, deps()),
    ).toEqual({ ok: false, reason: "PROVIDER_UNSUPPORTED" });
  });

  it("refuses an unverifiable start or conversation, and an in-TUI switch", async () => {
    expect(await resolveBinding(proc(), SID, deps({ startToken: async () => null }))).toEqual({
      ok: false,
      reason: "IDENTITY_UNVERIFIED",
    });
    expect(
      await resolveBinding(proc(), SID, deps({ currentConversation: async () => null })),
    ).toEqual({ ok: false, reason: "IDENTITY_UNVERIFIED" });
    expect(
      await resolveBinding(proc(), SID, deps({ currentConversation: async () => "other" })),
    ).toEqual({ ok: false, reason: "CONVERSATION_CHANGED" });
  });

  it("is ambiguous when two panes or two agents qualify", async () => {
    // Two agents in one foreground group would both receive the keys.
    const twoAgents = deps({
      processTable: async () => table([row(501, 400, 500, 500, "pts/7")]),
      otherAgentPids: () => [501],
    });
    expect(await resolveBinding(proc(), SID, twoAgents)).toEqual({
      ok: false,
      reason: "AMBIGUOUS",
    });
  });

  it("reports a background agent distinctly from one outside tmux", async () => {
    const bg = deps({ processTable: async () => table([row(500, 400, 500, 400, "pts/7")]) });
    expect(await resolveBinding(proc(), SID, bg)).toEqual({ ok: false, reason: "NOT_FOREGROUND" });
    expect(await resolveBinding(proc(), SID, deps({}, "%9|900|/dev/pts/9|0|0\n"))).toEqual({
      ok: false,
      reason: "NOT_IN_TMUX",
    });
    expect(await resolveBinding(proc(), SID, deps({}, "%3|400|/dev/pts/7|1|0\n"))).toEqual({
      ok: false,
      reason: "NOT_IN_TMUX",
    });
  });

  it("pins a different binding when pid start or pane changes", async () => {
    const a = await resolveBinding(proc(), SID, deps());
    const b = await resolveBinding(proc(), SID, deps({ startToken: async () => "linux:999" }));
    expect(a.ok && b.ok && a.binding.fingerprint !== b.binding.fingerprint).toBe(true);
  });
});

describe("grants repository", () => {
  let db: Database.Database;
  let repo: ExternalControlGrantsRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    runSqliteMigrations(db, resolveMigrationsDir("runtime-migrations"));
    repo = new ExternalControlGrantsRepository(db);
  });
  afterEach(() => db.close());

  it("finds an active grant only for its device, binding and scope", () => {
    const g = repo.create(
      { deviceId: "d1", sessionId: SID, bindingFingerprint: "fp", scopes: ["screen"], ttlMs: 1000 },
      0,
    );
    expect(repo.findActive("d1", "fp", "screen", 10)?.grantId).toBe(g.grantId);
    expect(repo.findActive("d2", "fp", "screen", 10)).toBeNull();
    expect(repo.findActive("d1", "other", "screen", 10)).toBeNull();
    expect(repo.findActive("d1", "fp", "screen", 1000)).toBeNull();
  });

  it("revokes one grant, or every grant of a device", () => {
    const g = repo.create(
      { deviceId: "d1", sessionId: SID, bindingFingerprint: "fp", scopes: ["screen"], ttlMs: 1e6 },
      0,
    );
    repo.create(
      { deviceId: "d1", sessionId: SID, bindingFingerprint: "fp2", scopes: ["screen"], ttlMs: 1e6 },
      0,
    );
    expect(repo.revoke(g.grantId, 1)).toBe(true);
    expect(repo.revoke(g.grantId, 2)).toBe(false);
    expect(repo.revokeForDevice("d1", 3)).toBe(1);
    expect(repo.listActive(4)).toEqual([]);
  });

  it("rejects a TTL over a day", () => {
    expect(() =>
      repo.create({
        deviceId: "d",
        sessionId: SID,
        bindingFingerprint: "fp",
        scopes: ["screen"],
        ttlMs: 25 * 3600_000,
      }),
    ).toThrow();
  });
});

describe("routes and service", () => {
  let db: Database.Database;
  let grants: ExternalControlGrantsRepository;
  let flag: boolean;
  let principal: Principal | undefined;
  let resolver: ResolverDeps;

  const device: Principal = { kind: "device", deviceId: "dev1", capabilities: ["session:control"] };

  function app() {
    const service = new ExternalControlService({
      config: () => ({ enabled: true, tmuxPath: "/bin/tmux", sockets: [] }),
      sessionStore: {
        externalFor: (id: string) => (id === SID ? proc() : null),
        externalProcesses: () => [proc()],
      },
      grants: () => grants,
      resolverDeps: () => resolver,
      versionCheck: async () => true,
    });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      if (principal) c.set("principal", principal);
      await next();
    });
    mountExternalControlRoutes(a, {
      featureFlagsConfig: () => ({ values: { externalControl: flag } }) as never,
      sessionStore: {} as never,
      runtimeStore: () => null,
      externalControlService: service,
    });
    return a;
  }

  async function grantCurrent() {
    const r = await resolveBinding(proc(), SID, resolver);
    if (!r.ok) throw new Error("unbound");
    grants.create({
      deviceId: "dev1",
      sessionId: SID,
      bindingFingerprint: r.binding.fingerprint,
      scopes: ["screen"],
      ttlMs: 60_000,
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    runSqliteMigrations(db, resolveMigrationsDir("runtime-migrations"));
    grants = new ExternalControlGrantsRepository(db);
    flag = true;
    principal = device;
    resolver = deps();
  });
  afterEach(() => db.close());

  it("answers 404 for every route while the flag is off", async () => {
    flag = false;
    for (const path of ["", "/screen"]) {
      const res = await app().request(`/${SID}/external-control${path}`);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("EXTERNAL_CONTROL_DISABLED");
    }
  });

  it("reports eligibility without identities until the device holds a grant", async () => {
    const res = await app().request(`/${SID}/external-control`);
    const body = await res.json();
    expect(body).toEqual({
      available: false,
      reason: "CONTROL_NOT_GRANTED",
      runtime: "tmux",
      capabilities: { screen: false, input: false },
    });
    const screen = await app().request(`/${SID}/external-control/screen`);
    expect(screen.status).toBe(403);
    expect(await screen.json()).toMatchObject({ code: "CONTROL_NOT_GRANTED" });
  });

  it("never serves the shared API key, which names no device", async () => {
    await grantCurrent();
    principal = { kind: "legacy", capabilities: ["session:control"] };
    const res = await app().request(`/${SID}/external-control/screen`);
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("DEVICE_CREDENTIAL_REQUIRED");
  });

  it("serves a sanitized screen to a granted device, and only to it", async () => {
    await grantCurrent();
    const status = await (await app().request(`/${SID}/external-control`)).json();
    expect(status).toMatchObject({ available: true, capabilities: { screen: true, input: false } });
    expect(JSON.stringify(status)).not.toMatch(/pts|\/tmp|"%3"|500/);

    const res = await app().request(`/${SID}/external-control/screen`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.lines).toEqual(["hello]52;c;ZXZpbA==", "world"]);
    expect(body).toMatchObject({ cols: 80, rows: 24, cursor: { x: 3, y: 5 }, truncated: false });

    principal = { kind: "device", deviceId: "dev2", capabilities: ["session:control"] };
    expect((await app().request(`/${SID}/external-control/screen`)).status).toBe(403);
  });

  it("drops the grant's effect the moment the agent's identity changes", async () => {
    await grantCurrent();
    resolver = deps({ startToken: async () => "linux:reused" });
    const res = await app().request(`/${SID}/external-control/screen`);
    expect(res.status).toBe(403);
    resolver = deps({ currentConversation: async () => "switched" });
    const stale = await app().request(`/${SID}/external-control/screen`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "EXTERNAL_BINDING_STALE",
      reason: "CONVERSATION_CHANGED",
    });
  });

  it("refuses a screen when the agent left the pane during capture", async () => {
    await grantCurrent();
    let n = 0;
    resolver = deps({
      // First read (bind) sees the agent; the post-capture recheck does not.
      processTable: async () =>
        n++ === 0 ? table() : new Map([[400, row(400, 1, 400, 400, "pts/7")]]),
    });
    const res = await app().request(`/${SID}/external-control/screen`);
    expect(res.status).toBe(409);
  });

  it("treats a session with no external process as not external", async () => {
    const res = await app().request(`/other/external-control`);
    expect((await res.json()).reason).toBe("NOT_EXTERNAL");
  });

  it("requires session:control for every method, GET included", () => {
    expect(requiredCapability(`/api/sessions/${SID}/external-control`, "GET")).toBe(
      "session:control",
    );
    expect(requiredCapability(`/api/sessions/${SID}/external-control/screen`, "GET")).toBe(
      "session:control",
    );
    expect(requiredCapability(`/api/sessions/${SID}/output`, "GET")).toBe("history:read");
  });
});

describe("CLI grant", () => {
  it("parses TTLs", () => {
    expect(parseTtl("1h")).toBe(3_600_000);
    expect(parseTtl("2h30m")).toBe(9_000_000);
    expect(parseTtl("90s")).toBe(90_000);
    expect(parseTtl("25h")).toBeNull();
    expect(parseTtl("1d")).toBeNull();
    expect(parseTtl("")).toBeNull();
    expect(parseTtl("1h junk")).toBeNull();
  });

  const base = () => {
    const logs: string[] = [];
    const created: unknown[] = [];
    return {
      logs,
      created,
      deps: {
        log: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(`E:${m}`) },
        device: () => ({ name: "Phone", usable: true }),
        resolve: () => resolveBinding(proc(), SID, deps()),
        createGrant: (input: { deviceId: string; ttlMs: number }) => {
          created.push(input);
          return {
            grantId: "gr_x",
            deviceId: input.deviceId,
            sessionId: SID,
            bindingFingerprint: "fp",
            scopes: ["screen" as const],
            createdAt: 0,
            expiresAt: input.ttlMs,
            revokedAt: null,
          };
        },
      },
    };
  };

  it("grants only after a local yes", async () => {
    const t = base();
    const no = await runExternalControlGrant(
      { session: SID, device: "d", ttl: "1h" },
      { ...t.deps, ask: async () => "" },
    );
    expect(no).toBe(1);
    expect(t.created).toEqual([]);
    const yes = await runExternalControlGrant(
      { session: SID, device: "d", ttl: "1h" },
      { ...t.deps, ask: async () => "y" },
    );
    expect(yes).toBe(0);
    expect(t.created).toHaveLength(1);
  });

  it("refuses an unusable device or an unbindable session", async () => {
    const t = base();
    expect(
      await runExternalControlGrant(
        { session: SID, device: "d", ttl: "1h", yes: true },
        { ...t.deps, device: () => ({ name: null, usable: false, reason: "revoked" }) },
      ),
    ).toBe(1);
    expect(
      await runExternalControlGrant(
        { session: SID, device: "d", ttl: "1h", yes: true },
        { ...t.deps, resolve: async () => ({ ok: false, reason: "AMBIGUOUS" }) },
      ),
    ).toBe(1);
    expect(t.created).toEqual([]);
  });
});

describe("migration", () => {
  it("creates the grants table in runtime.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-extctl-mig-"));
    try {
      const db = new Database(join(dir, "runtime.db"));
      runSqliteMigrations(db, resolveMigrationsDir("runtime-migrations"));
      const cols = db.prepare("PRAGMA table_info(external_control_grants)").all();
      expect(cols.length).toBe(8);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
