import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

let dbDir: string;
let cache: ConversationCache;

beforeEach(() => {
  dbDir = join(tmpdir(), `conv-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"), 3);
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const BASE_META = {
  id: "abc-123",
  sessionId: "abc-123",
  filePath: "/home/.claude/projects/proj/abc-123.jsonl",
  projectPath: "/home/proj",
  projectName: "My Project",
  title: "My Project",
  model: "claude-3-5-sonnet",
  account: "acc1",
  gitBranch: "main",
  messageCount: 2,
  timestamp: "2024-01-01T10:00:00.000Z",
  firstMessage: null,
  lastMessage: null,
  preview: "Hello",
};

describe("open()", () => {
  it("creates tables idempotently (opening same db twice does not throw)", () => {
    const cache2 = ConversationCache.open(join(dbDir, "cache.db"), 3);
    cache2.close();
  });
});

describe("upsertFromScannerMeta()", () => {
  it("inserts a new row", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
  });

  it("inserts multiple rows in batch", () => {
    const metas = [
      { ...BASE_META, id: "id-1", sessionId: "id-1", filePath: "/p/id-1.jsonl" },
      { ...BASE_META, id: "id-2", sessionId: "id-2", filePath: "/p/id-2.jsonl" },
      { ...BASE_META, id: "id-3", sessionId: "id-3", filePath: "/p/id-3.jsonl" },
    ];
    cache.upsertFromScannerMeta(metas as any);
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("does not overwrite a row updated within 24h", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:01:00.000Z",
        content: [{ type: "text", text: "new message" }],
      }),
    );
    cache.upsertFromScannerMeta([BASE_META as any]);
    const result = cache.listConversations({ limit: 10, offset: 0 });
    expect(result.conversations[0].messageCount).toBe(3);
  });
});

describe("updateFromLine()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([BASE_META as any]);
  });

  it("increments message_count by 1", () => {
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:01:00.000Z",
        content: [{ type: "text", text: "hi" }],
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(3);
  });

  it("updates last_activity to the line timestamp", () => {
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "assistant",
        timestamp: "2024-06-15T08:30:00.000Z",
        content: [{ type: "text", text: "reply" }],
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].lastActivity).toBe("2024-06-15T08:30:00.000Z");
  });

  it("appends messages to tail and trims to tailSize (3)", () => {
    for (let i = 0; i < 5; i++) {
      cache.updateFromLine(
        BASE_META.filePath,
        JSON.stringify({
          role: "user",
          timestamp: `2024-01-0${i + 2}T00:00:00.000Z`,
          content: [{ type: "text", text: `msg ${i}` }],
        }),
      );
    }
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail?.messages).toHaveLength(3);
    expect(tail?.messages[2].text).toContain("msg 4");
  });

  it("ignores lines that are not valid JSON", () => {
    cache.updateFromLine(BASE_META.filePath, "not json at all");
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(2);
  });

  it("does not throw for an unknown file path", () => {
    expect(() => {
      cache.updateFromLine(
        "/unknown/path.jsonl",
        JSON.stringify({
          role: "user",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: [{ type: "text", text: "msg" }],
        }),
      );
    }).not.toThrow();
  });
});

describe("listConversations()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([
      {
        ...BASE_META,
        id: "conv-a",
        sessionId: "conv-a",
        filePath: "/p/a.jsonl",
        projectPath: "/proj/alpha",
        projectName: "Alpha",
        timestamp: "2024-03-01T00:00:00.000Z",
      },
      {
        ...BASE_META,
        id: "conv-b",
        sessionId: "conv-b",
        filePath: "/p/b.jsonl",
        projectPath: "/proj/beta",
        projectName: "Beta",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        ...BASE_META,
        id: "conv-c",
        sessionId: "conv-c",
        filePath: "/p/c.jsonl",
        projectPath: "/proj/alpha",
        projectName: "Alpha",
        timestamp: "2024-06-01T00:00:00.000Z",
      },
    ] as any);
  });

  it("returns total count", () => {
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("returns total without rows when limit is 0", () => {
    const r = cache.listConversations({ limit: 0, offset: 0 });
    expect(r.total).toBe(3);
    expect(r.conversations).toHaveLength(0);
  });

  it("filters by project", () => {
    const r = cache.listConversations({ limit: 10, offset: 0, project: "/proj/alpha" });
    expect(r.total).toBe(2);
    expect(r.conversations.every((c) => c.projectPath === "/proj/alpha")).toBe(true);
  });

  it("paginates correctly", () => {
    const page1 = cache.listConversations({ limit: 2, offset: 0 });
    const page2 = cache.listConversations({ limit: 2, offset: 2 });
    expect(page1.conversations).toHaveLength(2);
    expect(page2.conversations).toHaveLength(1);
  });

  it("sorts by last_activity descending by default", () => {
    const r = cache.listConversations({ limit: 10, offset: 0 });
    const times = r.conversations.map((c) => new Date(c.lastActivity).getTime());
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });
});

describe("getConversationTail()", () => {
  it("returns null for unknown id", () => {
    expect(cache.getConversationTail("nonexistent")).toBeNull();
  });

  it("returns null when conversation exists but has no tail", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.getConversationTail("abc-123")).toBeNull();
  });

  it("returns messages after updateFromLine calls", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:00:00.000Z",
        content: [{ type: "text", text: "hello" }],
      }),
    );
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail?.messages).toHaveLength(1);
    expect(tail?.messages[0].role).toBe("user");
    expect(tail?.messages[0].text).toBe("hello");
  });
});

describe("hasConversation()", () => {
  it("returns false for unknown id", () => {
    expect(cache.hasConversation("unknown")).toBe(false);
  });

  it("returns true after upsert", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
  });
});

describe("invalidate()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "inv-1", sessionId: "inv-1", filePath: "/p/inv-1.jsonl" },
      { ...BASE_META, id: "inv-2", sessionId: "inv-2", filePath: "/p/inv-2.jsonl" },
    ] as any);
  });

  it("with no args clears all rows", () => {
    cache.invalidate();
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("with id removes only that row", () => {
    cache.invalidate("inv-1");
    expect(cache.hasConversation("inv-1")).toBe(false);
    expect(cache.hasConversation("inv-2")).toBe(true);
  });
});
