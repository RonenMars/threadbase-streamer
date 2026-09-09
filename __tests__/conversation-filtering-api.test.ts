import { search } from "@threadbase-sh/scanner";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import {
  ConversationHandlers,
  type ConversationHandlersDeps,
} from "../src/api/handlers/conversations.handlers";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { createSessionRoutes } from "../src/api/routes/sessions.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { ConversationCache, type ScannerMeta } from "../src/conversation-cache";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { type ApiDepsWiring, createApiDeps } from "../src/server-wiring";
import { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";

vi.mock("@threadbase-sh/scanner", async (original) => ({
  ...(await original<typeof import("@threadbase-sh/scanner")>()),
  search: vi.fn(),
}));
const CHILD = "agent-ab22e887a11a1ba50";
let dir: string;
let cache: ConversationCache;
let metas: ScannerMeta[];
let handlers: ConversationHandlers;
let sessions: SessionStore;
let enabled: boolean;
function response() {
  let code = 0;
  let body: any;
  return {
    writeHead: vi.fn((status) => {
      code = status;
    }),
    end: vi.fn((text) => {
      if (text) body = JSON.parse(text);
    }),
    get code() {
      return code;
    },
    get body() {
      return body;
    },
  } as unknown as ServerResponse & { code: number; body: any };
}
function open(enabled: boolean) {
  cache = ConversationCache.open(join(dir, "cache.db"), 10, undefined, {
    includeSubagentSessions: enabled,
  });
}
beforeEach(() => {
  enabled = false;
  dir = mkdtempSync(join(tmpdir(), "conversation-filtering-api-"));
  open(false);
  metas = ["ordinary", "empty", CHILD].map((id) => {
    const entry =
      id === "empty"
        ? { type: "system" }
        : {
            type: "user",
            message: { content: "needle" },
            ...(id === CHILD
              ? { isSidechain: true, agentId: CHILD.slice(6), sessionId: "parent" }
              : {}),
          };
    const filePath = join(dir, `${id}.jsonl`);
    writeFileSync(filePath, `${JSON.stringify(entry)}\n`);
    return {
      id: filePath,
      sessionId: id === CHILD ? "parent" : id,
      filePath,
      projectPath: dir,
      projectName: "project",
      preview: "needle",
      timestamp: new Date().toISOString(),
      messageCount: 1,
    };
  });
  cache.upsertFromScannerMeta(metas);
  sessions = new SessionStore((id, s) => (enabled || !s?.isSubagent) && cache.isVisible(id));
  handlers = new ConversationHandlers({
    cache: () => cache,
    sessionStore: sessions,
    includeSubagentSessions: () => enabled,
    scannerManager: { get: async () => ({}), codexScanOpts: () => ({}), reconcileMode: () => null },
    resolveConversationLookupId: (id: string) => id,
    rejectIfWarmingUp: () => false,
    findLiveSessionFilePath: () => null,
    log: () => ({ warn: vi.fn() }),
  } as unknown as ConversationHandlersDeps);
  vi.mocked(search).mockResolvedValue(
    metas.map((meta) => ({ meta, score: 1, matches: [] })) as any,
  );
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("filters WebSocket snapshots and refuses child subscriptions and holds", async () => {
  for (const id of ["ordinary", "empty", CHILD]) {
    sessions.addManaged({
      id,
      projectPath: dir,
      projectName: "project",
      branch: "main",
      status: "idle",
      startedAt: new Date(),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
      isSubagent: id === CHILD,
    });
  }
  const unicast = vi.fn();
  const subscribe = vi.fn();
  const hold = vi.fn();
  const deps = createApiDeps({
    conversationHandlers: handlers,
    sessionStore: sessions,
    ptyAttachedIds: () => new Set(),
    withReconciledLifecycle: (s: unknown) => s,
    wsHub: {
      addClient: vi.fn(),
      unicast,
      receive: (_ws: unknown, raw: unknown) => raw,
      subscribeSession: subscribe,
    },
    currentWarmupState: () => null,
    cacheMonitor: () => null,
    hostPressureMonitor: () => null,
    holdSession: hold,
  } as unknown as ApiDepsWiring);
  const socket = {} as Parameters<ApiDeps["handleWsOpen"]>[0];
  deps.handleWsOpen(socket);
  expect(unicast.mock.calls[0][1]).toMatchObject({
    type: "session_list",
    sessions: [{ id: "ordinary" }],
  });
  expect(unicast.mock.calls[0][1].sessions).toHaveLength(1);
  for (const type of ["subscribe_session", "hold_session"]) {
    await deps.handleWsMessage(socket, JSON.stringify({ type, sessionId: CHILD }), null);
  }
  expect(subscribe).not.toHaveBeenCalled();
  expect(hold).not.toHaveBeenCalled();
});

it("filters search before pagination and returns the corrected child ID only when enabled", async () => {
  const first = response();
  await handlers.handleSearch(new URL("http://localhost/api/search?q=needle&limit=1"), first);
  expect(first.body).toMatchObject({
    total: 1,
    hasMore: false,
    conversations: [{ id: "ordinary" }],
  });
  cache.close();
  enabled = true;
  open(true);
  const included = response();
  await handlers.handleSearch(new URL("http://localhost/api/search?q=needle&limit=10"), included);
  expect(included.body.total).toBe(2);
  expect(included.body.conversations.map((c: any) => c.id)).toEqual(["ordinary", CHILD]);
});

it("keeps list totals, hasMore, recents, and count consistent", async () => {
  const list = response();
  await handlers.handleListConversations(
    new URL("http://localhost/api/conversations?limit=1"),
    list,
  );
  expect(list.body).toMatchObject({
    total: 1,
    hasMore: false,
    conversations: [{ id: "ordinary" }],
  });
  const count = response();
  await handlers.handleConversationsCount(
    new URL("http://localhost/api/conversations/count"),
    count,
  );
  expect(count.body.total).toBe(1);
  const recents = response();
  handlers.handleGetRecentSessions(new URL("http://localhost/api/sessions/recents"), recents);
  expect(recents.body.sessions.map((s: any) => s.id)).toEqual(["ordinary"]);
});

it("refuses direct child detail and every session control before reaching the handler", async () => {
  const detail = response();
  await handlers.handleGetConversation(
    CHILD,
    new URL(`http://localhost/api/conversations/${CHILD}`),
    detail,
  );
  expect(detail.code).toBe(404);
  const reached = vi.fn();
  const routes = createSessionRoutes({
    isExcludedSubagent: (id: string) => handlers.isExcludedSubagent(id),
    handleGetSession: reached,
    handleSendInput: reached,
    handleRawKey: reached,
    handleCancel: reached,
    handleStopSession: reached,
    handleFork: reached,
  } as unknown as ApiDeps);
  for (const [suffix, method] of [
    ["", "GET"],
    ["/input", "POST"],
    ["/raw-key", "POST"],
    ["/cancel", "POST"],
    ["/fork", "POST"],
  ]) {
    const res = await routes.request(`/${CHILD}${suffix}`, { method });
    expect(res.status).toBe(404);
  }
  expect(reached).not.toHaveBeenCalled();
});

it("refuses resume before the already-running fast path and preserves metadata on enabled resume", async () => {
  const started: ManagedSession = {
    id: CHILD,
    provider: "claude-code",
    projectPath: dir,
    projectName: "project",
    branch: "main",
    status: "idle",
    startedAt: new Date(),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
  };
  const start = vi.fn(async () => started);
  const hasSession = vi.fn(() => true);
  const runtime = RuntimeStore.open(join(dir, "runtime.db"));
  const repo = new ManagedSessionsRepository(runtime.getDatabase());
  const sessionHandlers = new SessionHandlers({
    cache: () => cache,
    sessionStore: sessions,
    ptyManager: { hasSession, start },
    resolveConversationTarget: async () => ({
      ok: true,
      historyId: CHILD,
      jsonlPath: null,
      historyPath: null,
      conv: {},
      projectPath: dir,
      provider: "claude-code",
    }),
    discoveryCache: () => ({ entries: [], fetchedAt: Date.now() }),
    setDiscoveryCache: vi.fn(),
    claudeFlags: () => ({}),
    claudeExtraArgs: () => undefined,
    spawnFlagOverrides: () => ({}),
    registryBoot: {
      recordSessionSpawn: (session: ManagedSession) =>
        repo.recordSpawn({ session, pid: null, cmdline: null, streamerInstanceId: "test" }),
    },
    sessionWatchers: { watchConversationFile: vi.fn() },
    enrichResumedSessionAsync: vi.fn(),
    ptyAttachedIds: () => new Set(),
    selfPtyEndedAt: new Map(),
  } as unknown as SessionHandlersDeps);
  try {
    expect(await sessionHandlers.resumeSession({ sessionId: CHILD, force: true })).toMatchObject({
      ok: false,
      reason: "history_file_missing",
    });
    expect(start).not.toHaveBeenCalled();
    hasSession.mockReturnValue(false);
    cache.close();
    enabled = true;
    open(true);
    expect(await sessionHandlers.resumeSession({ sessionId: CHILD })).toMatchObject({
      ok: true,
      response: { isSubagent: true, parentConversationId: "parent" },
    });
    expect(repo.get(CHILD)).toMatchObject({ is_subagent: 1, parent_conversation_id: "parent" });
    expect(start).toHaveBeenCalledOnce();
  } finally {
    runtime.close();
  }
});
