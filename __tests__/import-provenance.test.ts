import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

describe("conversation_meta import provenance", () => {
  let dir: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "import-provenance-"));
    cache = ConversationCache.open(join(dir, "cache.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores scanner import flags on list rows", () => {
    const projDir = join(dir, "projects", "widget");
    mkdirSync(projDir, { recursive: true });
    const filePath = join(projDir, "imported.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        role: "user",
        importedFrom: "claude-code",
        message: { content: [{ type: "text", text: "<user_query>hello</user_query>" }] },
      })}\n`,
    );

    cache.upsertFromScannerMeta([
      {
        id: "imported-claude",
        sessionId: "imported-claude",
        filePath,
        projectPath: "/tmp/widget",
        projectName: "widget",
        messageCount: 2,
        timestamp: "2026-06-18T17:22:08.000Z",
        provider: "cursor",
        isImportedFromClaude: true,
      },
    ]);

    const listed = cache.listConversations({ limit: 10, offset: 0 }).conversations[0];
    expect(listed.isImportedFromClaude).toBe(true);
    expect(listed.isImportedFromCodex).toBe(false);
    expect(listed.isImportedFromCursor).toBe(false);

    const byId = cache.getMetaById("imported-claude");
    expect(byId?.isImportedFromClaude).toBe(true);
    expect(byId?.isImportedFromCodex).toBe(false);
  });
});
