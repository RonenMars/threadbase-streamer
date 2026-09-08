import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { parseFeatureFlagArgs, resolveFeatureFlags } from "../src/feature-flags";
import { classifyConversationFile } from "../src/services/conversations/classification";
import { rowToStubSession } from "../src/services/sessions/rehydrateSessions";
import { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

let dir: string;
let cache: ConversationCache;
const text = (role = "user") => ({ type: role, message: { role, content: "hello" } });
const codex = (content = "hello", role = "user") => ({
  type: "response_item",
  payload: { type: "message", role, content: [{ type: "input_text", text: content }] },
});
const child = (id: string) => ({ ...text(), isSidechain: true, agentId: id, sessionId: "parent" });
function file(id: string, entries: unknown[]) {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}
function scan(id: string, entries: unknown[], sessionId = id) {
  const filePath = file(id, entries);
  cache.upsertFromScannerMeta([
    { id, sessionId, filePath, projectPath: "/repo", projectName: "repo", messageCount: 99 },
  ]);
  return filePath;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conversation-classification-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

it("classifies metadata-only Claude history as empty, independently of message_count", () => {
  scan("empty", [{ type: "system", cwd: "/repo" }]);
  expect(cache.getMetaById("empty")).toMatchObject({ hasMessages: false, messageCount: 99 });
  expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(0);
});

it.each(["user", "assistant"])(
  "atomically promotes the first renderable Claude %s message",
  (role) => {
    const path = scan("live", [{ type: "system" }]);
    cache.updateFromLines(path, [JSON.stringify(text(role))]);
    expect(cache.getMetaById("live")?.hasMessages).toBe(true);
    cache.updateFromLines(path, [JSON.stringify({ type: "progress" })]);
    expect(cache.getMetaById("live")?.hasMessages).toBe(true);
  },
);

it("does not count attachments, meta messages, or tool bookkeeping", () => {
  const entries = [
    { type: "attachment", attachment: { type: "file", content: "file body" } },
    { type: "progress", data: { type: "tool_progress", text: "working" } },
    { ...text(), isMeta: true },
    {
      type: "user",
      message: { content: [{ type: "image", source: { type: "base64", data: "AA==" } }] },
    },
  ];
  const path = scan("bookkeeping", entries);
  cache.updateFromLines(
    path,
    entries.map((e) => JSON.stringify(e)),
  );
  expect(cache.getMetaById("bookkeeping")?.hasMessages).toBe(false);
});

it("classifies Codex metadata and injected instructions as empty, then promotes response_item", () => {
  const path = scan("rollout-test", [
    { type: "session_meta", payload: { id: "codex-id", source: "cli" } },
    { type: "turn_context", payload: { cwd: "/repo" } },
    codex("# AGENTS.md\n<INSTRUCTIONS>rules</INSTRUCTIONS>"),
    codex("developer instructions", "developer"),
    { type: "event_msg", payload: { type: "agent_message", message: "duplicate" } },
  ]);
  expect(cache.getMetaById("codex-id")).toMatchObject({ hasMessages: false, isSubagent: false });
  cache.updateFromLine(path, JSON.stringify(codex()));
  expect(cache.getMetaById("codex-id")?.hasMessages).toBe(true);
});

it("full scans can change presence in both directions after replacement", () => {
  scan("replace", [text()]);
  scan("replace", [{ type: "system" }]);
  expect(cache.getMetaById("replace")?.hasMessages).toBe(false);
  scan("replace", [text("assistant")]);
  expect(cache.getMetaById("replace")?.hasMessages).toBe(true);
});

it("reconciles an empty replacement omitted from the scanner metadata index", () => {
  const path = scan("replace", [text()]);
  writeFileSync(path, "");
  cache.reconcileDeletions(new Set());
  expect(cache.getMetaById("replace")?.hasMessages).toBe(false);
});

it("keeps legacy NULL rows visible until classified without relying on the lazy index", () => {
  cache.upsertFromScannerMeta([{ id: "legacy", filePath: join(dir, "legacy.jsonl") }]);
  expect(cache.getMetaById("legacy")).toMatchObject({ hasMessages: null, isSubagent: null });
  expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(1);
  scan("legacy", [{ type: "system" }]);
  expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(0);
  scan("valid", [text()]);
  expect(
    cache.getDatabase().prepare("SELECT COUNT(*) AS n FROM conversation_message_index").get(),
  ).toEqual({ n: 0 });
  expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(1);
});

it("keeps two Claude child identities separate from their parent and repairs an old alias", () => {
  const path = file("agent-one", [child("one")]);
  cache.upsertFromScannerMeta([{ id: "parent", filePath: join(dir, "missing.jsonl") }]);
  // Cache keys are canonical (forward slashes); `path` is native. Writing the
  // native form here would key the alias off a path the repair never looks up,
  // and the miss is invisible on POSIX, where the two forms are identical.
  cache
    .getDatabase()
    .prepare("UPDATE conversation_meta SET file_path = ? WHERE id = 'parent'")
    .run(canonicalizeFilePath(path));
  expect(cache.getIdByFilePath(path)).toBe("parent"); // the alias really is keyed here
  scan("agent-one", [child("one")], "parent");
  scan("agent-two", [child("two")], "parent");
  expect(cache.getMetaById("parent")).toBeNull();
  for (const id of ["agent-one", "agent-two"]) {
    expect(cache.getMetaById(id)).toMatchObject({
      isSubagent: true,
      parentConversationId: "parent",
      hasMessages: true,
    });
  }
  cache.updateFromLine(path, JSON.stringify(child("one")));
  expect(cache.getIdByFilePath(path)).toBe("agent-one");
});

it("detects explicit Claude children outside subagents paths", () => {
  const path = file("agent-outside", [child("outside")]);
  cache.updateFromLine(path, JSON.stringify(child("outside")));
  expect(cache.getMetaById("agent-outside")).toMatchObject({
    isSubagent: true,
    parentConversationId: "parent",
  });
});

it.each(["scan", "append"])("repairs simultaneous parent and child cache rows via %s", (mode) => {
  const path = scan("agent-one", [child("one")], "parent");
  cache
    .getDatabase()
    .prepare("INSERT INTO conversation_meta (id, file_path, updated_at) VALUES ('parent', ?, 0)")
    .run(canonicalizeFilePath(path));
  // Both rows must actually share one cache key, or the repair below asserts
  // on a collision that never existed.
  expect(
    cache
      .getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM conversation_meta WHERE file_path = ?")
      .get(canonicalizeFilePath(path)),
  ).toMatchObject({ n: 2 });
  if (mode === "scan") scan("agent-one", [child("one")], "parent");
  else cache.updateFromLine(path, JSON.stringify(child("one")));
  expect(cache.getMetaById("parent")).toBeNull();
  expect(cache.getMetaById("agent-one")?.parentConversationId).toBe("parent");
});

it.each(["cli", "vscode", "exec"])(
  "does not classify Codex %s entrypoints as children",
  (source) => {
    const path = file("rollout", [
      { type: "session_meta", payload: { id: "ordinary", source } },
      codex(),
    ]);
    expect(classifyConversationFile(path)).toMatchObject({
      isSubagent: false,
      parentConversationId: null,
    });
  },
);

// Real shapes seen in a survey of ~680 rollouts: the `subagent` key marks a
// provider-created child even when its value names no parent.
it.each([
  ["a string value", "review"],
  ["an unrecognised object value", { other: "guardian" }],
])("classifies a Codex subagent source carrying %s as a child", (_label, subagent) => {
  const path = file("rollout", [
    { type: "session_meta", payload: { id: "odd-child", source: { subagent } } },
    codex(),
  ]);
  expect(classifyConversationFile(path)).toMatchObject({
    isSubagent: true,
    parentConversationId: null,
  });
});

it("detects Codex thread_spawn and keeps the payload child ID", () => {
  scan("rollout", [
    {
      type: "session_meta",
      payload: {
        id: "codex-child",
        source: { subagent: { thread_spawn: { parent_thread_id: "codex-parent" } } },
      },
    },
    codex(),
  ]);
  expect(cache.getMetaById("codex-child")).toMatchObject({
    isSubagent: true,
    parentConversationId: "codex-parent",
  });
  expect(cache.isExcludedSubagent("codex-child")).toBe(true);
});

it("uses the same filtered corpus for pages, counts, projects, and provider lists", () => {
  scan("ordinary", [text()]);
  scan("ordinary-two", [text()]);
  scan("empty", [{ type: "system" }]);
  scan("agent-child", [child("child")], "parent");
  for (const options of [{}, { project: "/repo" }, { provider: "claude-code" }]) {
    expect(cache.listConversations({ ...options, limit: 0, offset: 0 }).total).toBe(2);
    const first = cache.listConversations({ ...options, limit: 1, offset: 0 });
    const second = cache.listConversations({ ...options, limit: 1, offset: 1 });
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(new Set([...first.conversations, ...second.conversations].map((c) => c.id)).size).toBe(
      2,
    );
    expect(cache.listConversations({ ...options, limit: 1, offset: 2 }).conversations).toEqual([]);
  }
  expect(cache.getPopularProjects(10)[0].sessionCount).toBe(2);
  expect(cache.listProjectSummaries({ limit: 10, offset: 0 })).toMatchObject({
    total: 1,
    projects: [{ conversationCount: 2 }],
  });
  expect(cache.getMetaById("ordinary")?.isSubagent).toBe(false);
  cache.close();
  cache = ConversationCache.open(join(dir, "cache.db"), 10, undefined, {
    includeSubagentSessions: true,
  });
  expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
});

it("resolves subagentSessions through default, YAML, CLI, and environment precedence", () => {
  expect(resolveFeatureFlags({ env: {} }).values.subagentSessions).toBe(false);
  expect(
    resolveFeatureFlags({ env: {}, yaml: { subagentSessions: true } }).values.subagentSessions,
  ).toBe(true);
  const cli = parseFeatureFlagArgs(["subagentSessions=true"]).values;
  expect(
    resolveFeatureFlags({ env: {}, yaml: { subagentSessions: false }, cli }).values
      .subagentSessions,
  ).toBe(true);
  expect(
    resolveFeatureFlags({ env: { THREADBASE_FEATURE_SUBAGENT_SESSIONS: "false" }, cli }).values
      .subagentSessions,
  ).toBe(false);
  expect(
    resolveFeatureFlags({
      env: { THREADBASE_FEATURE_SUBAGENT_SESSIONS: "true" },
      cli: { subagentSessions: false },
    }).values.subagentSessions,
  ).toBe(true);
});

it("persists and rehydrates child metadata; zero prompt_count does not hide real history", () => {
  scan("ordinary", [text()]);
  const session: ManagedSession = {
    id: "ordinary",
    projectPath: dir,
    projectName: "test",
    branch: "main",
    status: "idle",
    startedAt: new Date(),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
  };
  const sessions = new SessionStore((id, s) => !s?.isSubagent && cache.isVisible(id));
  sessions.addManaged(session);
  expect(sessions.list(new Set())).toHaveLength(1);
  const runtime = RuntimeStore.open(join(dir, "runtime.db"));
  try {
    const repo = new ManagedSessionsRepository(runtime.getDatabase());
    repo.recordSpawn({
      session: { ...session, id: "agent-child", isSubagent: true, parentConversationId: "parent" },
      pid: null,
      cmdline: null,
      streamerInstanceId: "test",
    });
    const row = repo.get("agent-child");
    if (!row) throw new Error("Missing persisted child");
    expect(row).toMatchObject({ is_subagent: 1, parent_conversation_id: "parent" });
    const stub = rowToStubSession(row);
    expect(stub).toMatchObject({ isSubagent: true, parentConversationId: "parent" });
    sessions.addManaged(stub);
    expect(
      sessions.paginate(new Set(), { limit: 10, sortBy: "startedAt", order: "desc" }).total,
    ).toBe(1);
    expect(repo.listRecoverable({ sinceMs: 0, limit: 10, includeSubagents: false })).toEqual([]);
    expect(repo.listRecoverable({ sinceMs: 0, limit: 10, includeSubagents: true })).toHaveLength(1);
  } finally {
    runtime.close();
  }
});
