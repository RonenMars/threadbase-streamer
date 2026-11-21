import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

describe("conversation_meta title_user / title_tool / last_prompt", () => {
  let dir: string;
  let dbPath: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "title-slots-"));
    dbPath = join(dir, "cache.db");
    cache = ConversationCache.open(dbPath);
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const meta = (id: string, provider: string, nameSlots?: Record<string, string>) => {
    const projDir = join(dir, "projects", "widget");
    mkdirSync(projDir, { recursive: true });
    const filePath = join(projDir, `${id}.jsonl`);
    writeFileSync(
      filePath,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
    );
    return {
      id,
      sessionId: id,
      filePath,
      projectPath: "/tmp/widget",
      projectName: "widget",
      messageCount: 2,
      timestamp: "2026-11-21T08:00:00.000Z",
      provider,
      ...(nameSlots && { nameSlots }),
    };
  };

  const rowOf = (id: string) => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db
        .prepare("SELECT title_user, title_tool, last_prompt FROM conversation_meta WHERE id = ?")
        .get(id) as {
        title_user: string | null;
        title_tool: string | null;
        last_prompt: string | null;
      };
    } finally {
      db.close();
    }
  };

  it("stores the scanner's name slots for every provider and null where absent", () => {
    cache.upsertFromScannerMeta([
      meta("claude", "claude-code", {
        userTitle: "Renamed",
        toolTitle: "Generated",
        lastPrompt: "last one",
      }),
      meta("codex", "codex-cli", { toolTitle: "Codex title", lastPrompt: "codex prompt" }),
      meta("cursor", "cursor", { toolTitle: "Cursor title" }),
      meta("copilot", "copilot", { userTitle: "Named in copilot" }),
      meta("none", "claude-code"),
    ]);

    expect(rowOf("claude")).toEqual({
      title_user: "Renamed",
      title_tool: "Generated",
      last_prompt: "last one",
    });
    expect(rowOf("codex")).toEqual({
      title_user: null,
      title_tool: "Codex title",
      last_prompt: "codex prompt",
    });
    expect(rowOf("cursor")).toEqual({
      title_user: null,
      title_tool: "Cursor title",
      last_prompt: null,
    });
    expect(rowOf("copilot")).toEqual({
      title_user: "Named in copilot",
      title_tool: null,
      last_prompt: null,
    });
    expect(rowOf("none")).toEqual({ title_user: null, title_tool: null, last_prompt: null });
  });

  it("updates the slots when a later scan of the same conversation changes them", async () => {
    cache.upsertFromScannerMeta([
      meta("c", "claude-code", { toolTitle: "Generated", lastPrompt: "one" }),
    ]);
    await new Promise((r) => setTimeout(r, 5));
    cache.upsertFromScannerMeta([
      meta("c", "claude-code", {
        userTitle: "Renamed",
        toolTitle: "Regenerated",
        lastPrompt: "two",
      }),
    ]);

    expect(rowOf("c")).toEqual({
      title_user: "Renamed",
      title_tool: "Regenerated",
      last_prompt: "two",
    });
  });
});
