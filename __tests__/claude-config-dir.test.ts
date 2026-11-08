// Claude Code keeps everything under `$CLAUDE_CONFIG_DIR`, defaulting to
// `~/.claude`. The streamer used to hard-code `~/.claude` in five places, so a
// streamer started with CLAUDE_CONFIG_DIR set spawned Claude into that dir
// while watching, listing and diagnosing another one (#1074, plan phase 1).
// Each test points CLAUDE_CONFIG_DIR at a temp dir and asserts the site reads
// from it; the sandboxed `~/.claude/projects` (see setup/sandbox-home.ts) is
// the wrong answer, so a site that still hard-codes it fails.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { defaultClaudeConfigDir, defaultClaudeProjectsDir } from "../src/claude-accounts/resolve";
import { handleListProjects } from "../src/handlers/handleListProjects";
import { ScannerManager } from "../src/scanner-manager";
import { shouldRefreshProjectsFromHdd } from "../src/services/conversations/shouldRefreshProjectsFromHdd";
import { SessionWatchers, type SessionWatchersDeps } from "../src/session-watchers";

let configDir: string;
let origConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tb-claude-config-dir-"));
  mkdirSync(join(configDir, "projects"), { recursive: true });
  origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe("defaultClaudeConfigDir", () => {
  it("prefers CLAUDE_CONFIG_DIR", () => {
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/elsewhere" })).toBe("/elsewhere");
    expect(defaultClaudeProjectsDir({ CLAUDE_CONFIG_DIR: "/elsewhere" })).toBe(
      join("/elsewhere", "projects"),
    );
  });

  it("falls back to ~/.claude when unset or empty", () => {
    expect(defaultClaudeConfigDir({})).toBe(join(homedir(), ".claude"));
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "" })).toBe(join(homedir(), ".claude"));
  });
});

describe("sites that used to hard-code ~/.claude", () => {
  it("handleListProjects lists the projects under CLAUDE_CONFIG_DIR", () => {
    mkdirSync(join(configDir, "projects", "-tmp-from-config-dir"));
    let body = "";
    const res = {
      writeHead: () => {},
      end: (b: string) => {
        body = b;
      },
    } as unknown as ServerResponse;

    handleListProjects(new URL("http://x/api/projects"), res);

    expect(body).toContain("from-config-dir");
  });

  it("ScannerManager.projectsDirs() walks CLAUDE_CONFIG_DIR/projects with no profiles", () => {
    const manager = new ScannerManager({
      scanProfiles: [],
      codexRoots: [],
      cursorRoots: [],
      directoryDebounceMs: 0,
      persistenceDisabled: true,
      cache: () => null,
      cacheMonitor: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      cacheMetadataRepo: () => null,
      trackCacheWrite: () => {},
    });

    expect(manager.projectsDirs()).toEqual([join(configDir, "projects")]);
  });

  it("shouldRefreshProjectsFromHdd checks CLAUDE_CONFIG_DIR/projects for drift", () => {
    // The index claims to be current as of one hour from now. Only a projects
    // dir touched after that reads as drift, so the sandboxed ~/.claude/projects
    // (touched at suite start) answers false and CLAUDE_CONFIG_DIR's answers true.
    const indexedAt = new Date(Date.now() + 3_600_000);
    const touched = new Date(Date.now() + 7_200_000);
    utimesSync(join(configDir, "projects"), touched, touched);
    const noOrphans = { hasOrphanRows: () => false } as never;
    const metadata = {
      getCacheMetadata: (key: string) =>
        key === "conversations_last_indexed_at" ? indexedAt.toISOString() : null,
    } as never;

    expect(shouldRefreshProjectsFromHdd(noOrphans, metadata)).toBe(true);
  });

  it("watchForJsonl binds the transcript Claude writes under CLAUDE_CONFIG_DIR", async () => {
    const sessionId = "c1c1c1c1-0000-4000-8000-000000000074";
    const projectPath = mkdtempSync(join(tmpdir(), "tb-claude-config-dir-proj-"));
    const sessionFileMap = new Map<string, string>();
    const managed = { startedAt: new Date(), promptCount: 0 };
    let alive = true;
    const watchers = new SessionWatchers({
      ptyManager: { hasSession: () => alive },
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

    try {
      watchers.watchForJsonl(sessionId, projectPath);
      const dir = join(configDir, "projects", projectPath.replace(/[/\\:.]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const jsonlPath = join(dir, `${sessionId}.jsonl`);
      writeFileSync(
        jsonlPath,
        `${JSON.stringify({ sessionId, cwd: projectPath, type: "user" })}\n`,
      );

      await vi.waitFor(() => expect(sessionFileMap.get(sessionId)).toBe(jsonlPath), {
        timeout: 15_000,
      });
    } finally {
      alive = false;
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
