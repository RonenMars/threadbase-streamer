import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

describe("conversation_meta team_name", () => {
  let dir: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-name-"));
    cache = ConversationCache.open(join(dir, "cache.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the scanner's teamName on list rows and null elsewhere", () => {
    const projDir = join(dir, "projects", "widget");
    mkdirSync(projDir, { recursive: true });
    const write = (name: string) => {
      const filePath = join(projDir, name);
      writeFileSync(
        filePath,
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })}\n`,
      );
      return filePath;
    };

    cache.upsertFromScannerMeta([
      {
        id: "teammate",
        sessionId: "teammate",
        filePath: write("teammate.jsonl"),
        projectPath: "/tmp/widget",
        projectName: "widget",
        messageCount: 2,
        timestamp: "2026-11-07T19:14:19.000Z",
        teamName: "session-74928b3e",
      },
      {
        id: "lead",
        sessionId: "lead",
        filePath: write("lead.jsonl"),
        projectPath: "/tmp/widget",
        projectName: "widget",
        messageCount: 2,
        timestamp: "2026-11-07T19:14:18.000Z",
        teamName: null,
      },
    ]);

    const byId = Object.fromEntries(
      cache.listConversations({ limit: 10, offset: 0 }).conversations.map((c) => [c.id, c]),
    );
    expect(byId.teammate.teamName).toBe("session-74928b3e");
    expect(byId.lead.teamName).toBeNull();
    expect(cache.getMetaById("teammate")?.teamName).toBe("session-74928b3e");
    expect(cache.getMetaById("lead")?.teamName).toBeNull();
  });
});
