import { ConversationScanner } from "@threadbase-sh/scanner";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import {
  ConversationHandlers,
  type ConversationHandlersDeps,
} from "../src/api/handlers/conversations.handlers";
import { ConversationCache } from "../src/conversation-cache";
import { SessionStore } from "../src/session-store";

// A Claude sub-agent transcript carries its parent's sessionId, and the scanner
// resolves a uuid to the newest file with that sessionId. Once `?parent=` has
// fed the children into the scanner, a parent's detail served a child instead.
const PARENT = "7c8e4916-5266-4bce-88a4-61b13f02b2e8";
const CHILD = "agent-a1b2c3d4e5f6a7b8c";
let dir: string;
let cache: ConversationCache;
let handlers: ConversationHandlers;

const line = (text: string, timestamp: string, extra = {}) =>
  `${JSON.stringify({
    type: "user",
    sessionId: PARENT,
    uuid: `${text}-uuid`,
    cwd: dir,
    timestamp,
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  })}\n`;

async function call(run: (res: ServerResponse) => Promise<void>): Promise<any> {
  let body: any;
  const res = {
    writeHead: vi.fn(),
    end: vi.fn((text) => {
      if (text) body = JSON.parse(text);
    }),
  } as unknown as ServerResponse;
  await run(res);
  return body;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "parent-detail-subagents-"));
  cache = ConversationCache.open(join(dir, "cache.db"), 10, undefined, {
    includeSubagentSessions: true,
  });
  const project = join(dir, "projects", "fixture");
  mkdirSync(join(project, PARENT, "subagents"), { recursive: true });
  const parentFile = join(project, `${PARENT}.jsonl`);
  const childFile = join(project, PARENT, "subagents", `${CHILD}.jsonl`);
  writeFileSync(parentFile, line("parent prompt", "2026-10-29T10:00:00.000Z"));
  writeFileSync(
    childFile,
    line("You are demo agent 4 of 8", "2026-10-29T11:00:00.000Z", {
      isSidechain: true,
      agentId: CHILD.slice(6),
      cwd: `${dir}-worktree`,
    }),
  );
  const scanner = new ConversationScanner({ persistent: false });
  const metas = [await scanner.refreshFile(parentFile), await scanner.refreshFile(childFile)];
  cache.upsertFromScannerMeta(metas as never[]);

  handlers = new ConversationHandlers({
    cache: () => cache,
    sessionStore: new SessionStore(() => true),
    ptyManager: { hasSession: () => false },
    isBoundConversationLive: () => false,
    includeSubagentSessions: () => true,
    scannerManager: {
      ready: true,
      get: async () => scanner,
      isConversationSnapshotStale: () => false,
      codexScanOpts: () => ({}),
      reconcileMode: () => null,
    },
    resolveConversationLookupId: (id: string) => id,
    rejectIfWarmingUp: () => false,
    findLiveSessionFilePath: () => null,
    log: () => ({ warn: vi.fn() }),
  } as unknown as ConversationHandlersDeps);
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

it("serves the parent's own transcript after a newer child is indexed", async () => {
  const body = await call((res) =>
    handlers.handleGetConversation(
      PARENT,
      new URL(`http://localhost/api/conversations/${PARENT}`),
      res,
    ),
  );

  expect(JSON.stringify(body.messages)).toContain("parent prompt");
  expect(JSON.stringify(body.messages)).not.toContain("demo agent");
});

it("titles a sub-agent row with its parent's list title", async () => {
  const body = await call((res) =>
    handlers.handleListConversations(
      new URL("http://localhost/api/conversations?include=all"),
      res,
    ),
  );
  const byId = new Map(body.conversations.map((c: any) => [c.id, c]));
  const parent = byId.get(PARENT) as any;
  const child = byId.get(CHILD) as any;

  expect(child.parentConversationId).toBe(PARENT);
  expect(parent.title).toBeTruthy();
  expect(child.parentTitle).toBe(parent.title);
  expect(parent).not.toHaveProperty("parentTitle");
});

it("gives a sub-agent row its parent's project path, not its own cwd", async () => {
  const body = await call((res) =>
    handlers.handleListConversations(
      new URL("http://localhost/api/conversations?include=all"),
      res,
    ),
  );
  const byId = new Map(body.conversations.map((c: any) => [c.id, c]));
  const parent = byId.get(PARENT) as any;
  const child = byId.get(CHILD) as any;

  expect(child.projectPath).not.toBe(parent.projectPath);
  expect(child.parentProjectPath).toBe(parent.projectPath);
  expect(parent).not.toHaveProperty("parentProjectPath");
});
