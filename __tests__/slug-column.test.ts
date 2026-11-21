import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

describe("conversation_meta slug", () => {
  let dir: string;
  let dbPath: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slug-column-"));
    dbPath = join(dir, "cache.db");
    cache = ConversationCache.open(dbPath);
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string) => {
    const projDir = join(dir, "projects", "widget");
    mkdirSync(projDir, { recursive: true });
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

  const meta = (id: string, nameSlots?: Record<string, string>) => ({
    id,
    sessionId: id,
    filePath: write(`${id}.jsonl`),
    projectPath: "/tmp/widget",
    projectName: "widget",
    messageCount: 2,
    timestamp: "2026-11-21T08:00:00.000Z",
    ...(nameSlots && { nameSlots }),
  });

  const slugOf = (id: string): string | null => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT slug FROM conversation_meta WHERE id = ?").get(id) as
        | { slug: string | null }
        | undefined;
      return row ? row.slug : null;
    } finally {
      db.close();
    }
  };

  it("stores the scanner's slug and leaves it null when the transcript has none", () => {
    cache.upsertFromScannerMeta([
      meta("with-slug", { slug: "witty-tinkering-fox", toolTitle: "A title" }),
      meta("without-slug", { toolTitle: "Only a title" }),
      meta("no-slots"),
    ]);

    expect(slugOf("with-slug")).toBe("witty-tinkering-fox");
    expect(slugOf("without-slug")).toBeNull();
    expect(slugOf("no-slots")).toBeNull();
  });

  it("backfills existing rows from scanner_meta_json (migration 030)", () => {
    cache.upsertFromScannerMeta([meta("old-row", { slug: "calm-brewing-owl" })]);
    const db = new Database(dbPath);
    try {
      db.prepare("UPDATE conversation_meta SET slug = NULL WHERE id = 'old-row'").run();
      const sql = readFileSync(join(__dirname, "../src/db/migrations/030_add_slug.sql"), "utf8");
      db.exec(sql.slice(sql.indexOf("UPDATE")));
      const row = db.prepare("SELECT slug FROM conversation_meta WHERE id = 'old-row'").get() as {
        slug: string | null;
      };
      expect(row.slug).toBe("calm-brewing-owl");
    } finally {
      db.close();
    }
  });
});
