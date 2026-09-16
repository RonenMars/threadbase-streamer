import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import {
  ConversationHandlers,
  type ConversationHandlersDeps,
} from "../src/api/handlers/conversations.handlers";
import { ConversationCache } from "../src/conversation-cache";

function response() {
  let code = 0;
  let body: unknown;
  return {
    writeHead: vi.fn((status: number) => {
      code = status;
    }),
    end: vi.fn((text?: string) => {
      if (text) body = JSON.parse(text);
    }),
    get code() {
      return code;
    },
    get body() {
      return body as Record<string, unknown>;
    },
  } as unknown as ServerResponse & { code: number; body: Record<string, unknown> };
}

describe("conversation list import flags and filters", () => {
  let dir: string;
  let cache: ConversationCache;
  let handlers: ConversationHandlers;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conversation-list-filters-"));
    cache = ConversationCache.open(join(dir, "cache.db"));
    const transcripts = join(dir, "agent-transcripts", "native-cursor");
    mkdirSync(join(transcripts, "subagents"), { recursive: true });
    const cursorLine = `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "hi" }] },
    })}\n`;
    const file = (rel: string) => {
      const p = join(transcripts, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, cursorLine);
      return p;
    };
    cache.upsertFromScannerMeta([
      {
        id: "native-cursor",
        sessionId: "native-cursor",
        filePath: file("native-cursor.jsonl"),
        projectPath: dir,
        projectName: "proj",
        messageCount: 2,
        timestamp: "2026-06-18T17:22:08.000Z",
        provider: "cursor",
      },
      {
        id: "from-claude",
        sessionId: "from-claude",
        filePath: file("from-claude.jsonl"),
        projectPath: dir,
        projectName: "proj",
        messageCount: 2,
        timestamp: "2026-06-18T17:23:08.000Z",
        provider: "cursor",
        isImportedFromClaude: true,
      },
      {
        id: "from-codex",
        sessionId: "from-codex",
        filePath: file("from-codex.jsonl"),
        projectPath: dir,
        projectName: "proj",
        messageCount: 2,
        timestamp: "2026-06-18T17:24:08.000Z",
        provider: "cursor",
        isImportedFromCodex: true,
      },
      {
        id: "cursor-child",
        sessionId: "native-cursor",
        filePath: file(join("subagents", "cursor-child.jsonl")),
        projectPath: dir,
        projectName: "proj",
        messageCount: 1,
        timestamp: "2026-06-18T17:25:08.000Z",
        provider: "cursor",
        isSubagent: true,
        parentSessionId: join(transcripts, "native-cursor.jsonl"),
      },
    ]);
    handlers = new ConversationHandlers({
      cache: () => cache,
      includeSubagentSessions: () => false,
      scannerManager: {
        get: async () => ({}),
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

  it("copies import flags onto the list HTTP payload", async () => {
    const res = response();
    await handlers.handleListConversations(
      new URL("http://localhost/api/conversations?provider=cursor&limit=20"),
      res,
    );
    const convs = res.body.conversations as Array<Record<string, unknown>>;
    expect(convs.every((c) => "isImportedFromClaude" in c)).toBe(true);
    const imported = convs.find((c) => c.id === "from-claude");
    expect(imported?.isImportedFromClaude).toBe(true);
    expect(imported?.isImportedFromCodex).toBe(false);
    expect(imported?.provider).toBe("cursor");
  });

  it("lists cursor conversations that are not imported from claude", async () => {
    const res = response();
    await handlers.handleListConversations(
      new URL("http://localhost/api/conversations?provider=cursor&isImportedFromClaude=0&limit=20"),
      res,
    );
    const ids = (res.body.conversations as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain("native-cursor");
    expect(ids).toContain("from-codex");
    expect(ids).not.toContain("from-claude");
    expect(ids).not.toContain("cursor-child");
  });

  it("counts cursor conversations imported from codex", async () => {
    const res = response();
    await handlers.handleConversationsCount(
      new URL("http://localhost/api/conversations/count?provider=cursor&isImportedFromCodex=1"),
      res,
    );
    expect(res.body.total).toBe(1);
  });

  it("includes cursor subagents when include=all", async () => {
    const res = response();
    await handlers.handleListConversations(
      new URL("http://localhost/api/conversations?provider=cursor&include=all&limit=20"),
      res,
    );
    const ids = (res.body.conversations as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain("cursor-child");
    expect(ids).toContain("native-cursor");
  });

  it("lists only cursor subagents when include=subagents", async () => {
    const res = response();
    await handlers.handleListConversations(
      new URL("http://localhost/api/conversations?provider=cursor&include=subagents&limit=20"),
      res,
    );
    const ids = (res.body.conversations as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(["cursor-child"]);
  });

  it("treats provider=cursor-cli as cursor", async () => {
    const res = response();
    await handlers.handleConversationsCount(
      new URL("http://localhost/api/conversations/count?provider=cursor-cli"),
      res,
    );
    expect(res.body.total).toBe(3);
  });
});
