import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";
import { splitCompleteLines } from "../src/utils/fileIdentity";

let dbDir: string;
let cache: ConversationCache;
let jsonlPath: string;

const line = (
  type: "user" | "assistant",
  uuid: string,
  ts: string | null,
  content: unknown[],
  extra = {},
) =>
  JSON.stringify({
    type,
    uuid,
    ...(ts ? { timestamp: ts } : {}),
    sessionId: "sess",
    cwd: "/project",
    message: { role: type, content },
    ...extra,
  });
const text = (t: string) => [{ type: "text", text: t }];

function extend(lines: string[]): void {
  const content = `${lines.join("\n")}\n`;
  writeFileSync(jsonlPath, content);
  const { spans, consumed } = splitCompleteLines(Buffer.from(content, "utf-8"), 0);
  cache.extendMessageIndex(jsonlPath, spans, statSync(jsonlPath), 0, consumed);
}

const countable = (uuid: string): number | undefined =>
  (
    cache
      .getDatabase()
      .prepare("SELECT counts_for_unread AS c FROM conversation_message_index WHERE uuid = ?")
      .get(uuid) as { c: number } | undefined
  )?.c;

const lastCountableTs = (): number | null =>
  (
    cache
      .getDatabase()
      .prepare("SELECT last_countable_ts AS t FROM conversation_meta WHERE id = 'the-conv-id'")
      .get() as { t: number | null }
  ).t;

beforeEach(() => {
  dbDir = join(tmpdir(), `unread-elig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  jsonlPath = join(dbDir, "the-conv-id.jsonl");
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, 'claude-code', 1, 1)",
    )
    .run("the-conv-id", canonicalizeFilePath(jsonlPath));
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("counts_for_unread on indexed messages", () => {
  it("is 1 for an assistant line with text (positive control)", () => {
    extend([line("assistant", "a1", "2026-01-01T00:00:01.000Z", text("done"))]);
    expect(countable("a1")).toBe(1);
  });

  it("is 0 for every line that is not a reply the user can read", () => {
    extend([
      line("user", "u1", "2026-01-01T00:00:00.000Z", text("please")),
      line("assistant", "a-tool", "2026-01-01T00:00:01.000Z", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]),
      line("assistant", "a-think", "2026-01-01T00:00:02.000Z", [
        { type: "thinking", thinking: "hmm", signature: "s" },
      ]),
      line("assistant", "a-side", "2026-01-01T00:00:03.000Z", text("sub"), { isSidechain: true }),
      line("assistant", "a-empty", "2026-01-01T00:00:04.000Z", text("   ")),
      line("assistant", "a-nots", null, text("no timestamp")),
    ]);
    for (const id of ["u1", "a-tool", "a-think", "a-side", "a-empty", "a-nots"]) {
      // A line the scanner drops has no index row at all, which is just as uncountable.
      expect(countable(id) ?? 0, id).toBe(0);
    }
  });

  it("a line holding thinking and text is still a reply", () => {
    extend([
      line("assistant", "a-both", "2026-01-01T00:00:01.000Z", [
        { type: "thinking", thinking: "hmm", signature: "s" },
        { type: "text", text: "the answer" },
      ]),
    ]);
    expect(countable("a-both")).toBe(1);
  });

  it("a tool result (user line) is not countable", () => {
    extend([
      line("user", "u-res", "2026-01-01T00:00:01.000Z", [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
      ]),
    ]);
    expect(countable("u-res")).toBe(0);
  });
});

describe("conversation_meta.last_countable_ts", () => {
  it("is the newest countable timestamp, ignoring later non-countable lines", () => {
    extend([
      line("assistant", "a1", "2026-01-01T00:00:01.000Z", text("one")),
      line("assistant", "a2", "2026-01-01T00:00:05.000Z", text("two")),
      line("user", "u1", "2026-01-01T00:00:09.000Z", text("thanks")),
    ]);
    expect(lastCountableTs()).toBe(Date.parse("2026-01-01T00:00:05.000Z"));
  });

  it("is NULL when nothing countable exists", () => {
    extend([line("user", "u1", "2026-01-01T00:00:00.000Z", text("hi"))]);
    expect(lastCountableTs()).toBeNull();
  });

  it("is set by a backfill alone, with no earlier incremental extend", async () => {
    writeFileSync(
      jsonlPath,
      `${line("assistant", "a1", "2026-01-01T00:00:01.000Z", text("one"))}\n`,
    );
    expect(lastCountableTs()).toBeNull();
    await cache.backfillIndex(jsonlPath);
    expect(lastCountableTs()).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
    expect(countable("a1")).toBe(1);
  });

  it("survives a rebuild of the index", async () => {
    extend([line("assistant", "a1", "2026-01-01T00:00:01.000Z", text("one"))]);
    await cache.backfillIndex(jsonlPath);
    expect(lastCountableTs()).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
    expect(countable("a1")).toBe(1);
  });
});
