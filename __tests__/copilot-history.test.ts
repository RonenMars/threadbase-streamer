import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationScanner } from "@threadbase-sh/scanner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ScannerManager } from "../src/scanner-manager";
import { classifyConversationFile } from "../src/services/conversations/classification";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

// Copilot CLI history is `<root>/<sessionId>/events.jsonl`. Real-shape lines
// (placeholders only) live in the scanner's fixtures; this file keeps its own
// small session so the test does not reach into another repo.
const SESSION = "11111111-2222-4333-8444-555555555555";

const event = (type: string, data: unknown, n: number) =>
  JSON.stringify({
    type,
    data,
    id: `evt-${n}`,
    timestamp: `2026-09-01T10:00:0${n}.000Z`,
    parentId: n === 0 ? null : `evt-${n - 1}`,
  });

const lines = [
  event("session.start", { sessionId: SESSION, context: { cwd: "/work/app", branch: "main" } }, 0),
  event("user.message", { content: "list files" }, 1),
  event("model.message", { role: "assistant", content: "side-channel, never shown" }, 2),
  event(
    "assistant.message",
    {
      messageId: "m-tools",
      content: "",
      toolRequests: [{ toolCallId: "t1", name: "bash", arguments: { command: "ls" } }],
    },
    3,
  ),
  event("tool.execution_complete", { toolCallId: "t1" }, 4),
  event("assistant.message", { messageId: "m-text", content: "README.md and package.json" }, 5),
];

let root: string;
let file: string;

beforeEach(() => {
  // `session-state` in the path is what the cache-miss classifier recognises.
  root = mkdtempSync(join(tmpdir(), "tb-copilot-history-"));
  mkdirSync(join(root, "session-state", SESSION), { recursive: true });
  file = join(root, "session-state", SESSION, "events.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function manager(copilotRoots: string[]) {
  return new ScannerManager({
    scanProfiles: [],
    codexRoots: [],
    cursorRoots: [],
    copilotRoots,
    directoryDebounceMs: 0,
    persistenceDisabled: true,
    cache: () => null,
    cacheMonitor: () => null,
    projectsRepo: () => null,
    conversationsRepo: () => null,
    cacheMetadataRepo: () => null,
    trackCacheWrite: () => {},
  });
}

describe("Copilot history indexing", () => {
  it("scans Copilot sessions through ScannerManager's scan options, and not when copilotRoots is empty", async () => {
    for (const [roots, expected] of [
      [[join(root, "session-state")], 1],
      [[], 0],
    ] as const) {
      const scanner = new ConversationScanner({ persistent: false });
      await scanner.scan({ profiles: [], ...manager([...roots]).codexScanOpts() });
      const found = [...scanner.getMetadataCache().values()].filter(
        (m) => m.provider === "copilot",
      );
      expect(found).toHaveLength(expected);
      if (expected) expect(found[0]).toMatchObject({ sessionId: SESSION, messageCount: 2 });
    }
  });

  it("classifies a Copilot file by path on a cache miss and by provider on a hit", () => {
    for (const provider of [undefined, "copilot" as const]) {
      const c = classifyConversationFile(file, provider);
      expect(c.provider).toBe("copilot");
      expect(c.hasMessages).toBe(true);
    }
  });

  it("does not count a session with no user or assistant message", () => {
    writeFileSync(file, `${lines.slice(0, 1).join("\n")}\n`);
    expect(classifyConversationFile(file, "copilot").hasMessages).toBe(false);
  });

  describe("offset index", () => {
    let cache: ConversationCache;
    beforeEach(() => {
      cache = ConversationCache.open(join(root, "cache.db"));
      cache
        .getDatabase()
        .prepare(
          "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, 'copilot', 3, 1)",
        )
        .run(SESSION, canonicalizeFilePath(file));
    });
    afterEach(() => cache.close());

    it("indexes the messages the scanner serves, tool-only steps included", async () => {
      await cache.backfillIndex(file);

      const window = cache.readMessageWindow(file, 0, 80);
      const scanner = new ConversationScanner({ persistent: false });
      await scanner.scan({
        profiles: [],
        ...manager([join(root, "session-state")]).codexScanOpts(),
      });
      const served = await scanner.getConversation(SESSION);
      // The index and the detail view must number the same file the same way.
      expect(window?.messages.map((m) => m.uuid)).toEqual(served?.messages.map((m) => m.uuid));
      expect(window?.total).toBe(3);
      expect(window?.messages.map((m) => m.text)).toEqual([
        "list files",
        "",
        "README.md and package.json",
      ]);
    });
  });
});
