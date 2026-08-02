import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any; dest?: string }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any, dest?: string) =>
    h.calls.push({ level, msg, fields, dest });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const eventsOf = (event: string) => h.calls.filter((c) => c.fields?.event === event);

let dbDir: string;
let cache: ConversationCache;
let jsonlPath: string;

function writeConversation(n: number): void {
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      type: "user",
      uuid: `u${i}`,
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      sessionId: "sess",
      cwd: "/project",
      message: { role: "user", content: [{ type: "text", text: `msg ${i}` }] },
    }),
  );
  writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
}

beforeEach(() => {
  h.calls.length = 0;
  dbDir = join(tmpdir(), `cold-path-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  jsonlPath = join(dbDir, "cold-conv.jsonl");
  // The offset index only touches files whose cached meta says claude-code.
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, 'claude-code', 1, 1)",
    )
    .run("cold-conv", canonicalizeFilePath(jsonlPath));
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("offset-index backfill logging", () => {
  // Before this, only `offset_index.backfill_failed` was ever logged: a
  // full-file re-parse that SUCCEEDED — the difference between a 20ms detail
  // fetch and a multi-second one — left no trace at all.
  it("reports duration, rows and bytes when a backfill succeeds", async () => {
    writeConversation(5);
    await cache.backfillIndex(jsonlPath);

    const [line] = eventsOf("offset_index.backfill_ok");
    expect(line.level).toBe("info");
    expect(line.fields).toMatchObject({ conversationId: "cold-conv", rows: 5 });
    expect(line.fields.bytes).toBe(statSync(jsonlPath).size);
    expect(line.fields.ms).toBeGreaterThanOrEqual(0);
  });

  it("writes structured-only so the unrotated prod log gets one line, not two", async () => {
    writeConversation(2);
    await cache.backfillIndex(jsonlPath);
    expect(eventsOf("offset_index.backfill_ok")[0].dest).toBe("pino");
  });

  it("stays quiet for a file the index does not cover", async () => {
    const other = join(dbDir, "not-indexable.jsonl");
    writeFileSync(other, "{}\n");
    await cache.backfillIndex(other);
    expect(eventsOf("offset_index.backfill_ok")).toHaveLength(0);
  });

  it("logs once per backfill, not once per single-flighted caller", async () => {
    writeConversation(3);
    await Promise.all([cache.backfillIndex(jsonlPath), cache.backfillIndex(jsonlPath)]);
    expect(eventsOf("offset_index.backfill_ok")).toHaveLength(1);
  });
});
