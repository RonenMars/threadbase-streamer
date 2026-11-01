import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

let dir: string;
let cache: ConversationCache;

beforeEach(() => {
  dir = join(tmpdir(), `tail-pop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cache = ConversationCache.open(join(dir, "cache.db"), 3);
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

const META = {
  projectPath: "/p",
  projectName: "p",
  title: "p",
  model: "m",
  account: "a",
  gitBranch: "main",
  messageCount: 1,
  timestamp: "2024-01-01T10:00:00.000Z",
  firstMessage: null,
  lastMessage: null,
  preview: "x",
};

/** Writes `content` as a JSONL file, upserts its meta row and runs the tail populate. */
function populate(id: string, content: string | Buffer) {
  const filePath = join(dir, `${id}.jsonl`);
  writeFileSync(filePath, content);
  cache.upsertFromScannerMeta([{ ...META, id, sessionId: id, filePath }] as any);
  const t0 = performance.now();
  const ok = cache.populateTailFromFile(id, filePath);
  const ms = performance.now() - t0;
  const row = cache
    .getDatabase()
    .prepare("SELECT messages_json FROM conversation_tail WHERE conversation_id = ?")
    .get(id) as { messages_json: string } | undefined;
  return { ok, ms, messages: row ? JSON.parse(row.messages_json) : null };
}

const claude = (role: string, text: string, i: number) =>
  JSON.stringify({
    type: role,
    timestamp: `2024-01-01T10:00:${String(i % 60).padStart(2, "0")}Z`,
    message: { role, content: role === "user" ? text : [{ type: "text", text }] },
  });
const codex = (type: string, i: number, extra: object = {}) =>
  JSON.stringify({
    timestamp: `2024-01-01T10:00:${String(i % 60).padStart(2, "0")}Z`,
    type,
    payload: { n: i },
    ...extra,
  });

describe("populateTailFromFile: tail content is unchanged", () => {
  // Snapshot recorded against the implementation before the bounded reader landed.
  it("matches the recorded tails for Claude- and Codex-shaped files", () => {
    const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
    const cases: Record<string, string> = {
      claude:
        many(25, (i) => claude(i % 2 ? "assistant" : "user", `message ${i}`, i)).join("\n") + "\n",
      codex: many(30, (i) => codex(i % 3 ? "response_item" : "event_msg", i)).join("\n") + "\n",
      noTrailingNewline: many(6, (i) => claude("user", `m${i}`, i)).join("\n"),
      blankAndCrlf: many(8, (i) => claude("user", `m${i}`, i)).join("\r\n\n\r\n") + "\n\n",
      junkTailPastLineCap:
        many(5, (i) => claude("user", `early${i}`, i)).join("\n") +
        "\n" +
        many(60, () => "j".repeat(1000)).join("\n") +
        "\n",
      noRoleLines: many(20, (i) => JSON.stringify({ n: i })).join("\n") + "\n",
      singleLine: claude("user", "only", 1),
      empty: "",
      bigLineUnderCap:
        [
          claude("user", "before", 1),
          claude("assistant", "x".repeat(300_000), 2),
          claude("user", "after", 3),
        ].join("\n") + "\n",
      multibyte:
        many(40, (i) => claude("user", `日本語🙂テキスト ${i} `.repeat(40), i)).join("\n") + "\n",
    };
    const out: Record<string, unknown> = {};
    for (const [name, content] of Object.entries(cases)) {
      const r = populate(name, content);
      out[name] = { ok: r.ok, messages: r.messages };
    }
    expect(out).toMatchSnapshot();
  });
});

describe("populateTailFromFile: cost per call is bounded", () => {
  // Before: a 24 MB trailing line took ~5 s here (chunk + partial re-copied per 8 KB step).
  it("a multi-megabyte last line neither stalls the call nor hides earlier messages", () => {
    const huge = claude("assistant", "y".repeat(24 * 1024 * 1024), 9);
    const content =
      [claude("user", "first", 1), claude("assistant", "second", 2), huge].join("\n") + "\n";
    const r = populate("huge-last", content);
    expect(r.ms).toBeLessThan(300);
    expect(r.ok).toBe(true);
    expect(r.messages.map((m: any) => m.text)).toEqual(["first", "second"]);
  });

  it("several multi-megabyte trailing lines stay bounded", () => {
    const big = (i: number) => claude("assistant", "z".repeat(6 * 1024 * 1024), i);
    const content = [claude("user", "kept", 1), big(2), big(3), big(4), big(5)].join("\n") + "\n";
    const r = populate("many-huge", content);
    expect(r.ms).toBeLessThan(300);
    expect(r.messages === null || r.messages.length <= 3).toBe(true);
  });

  it("reading stops at a byte budget instead of walking the line-count cap", () => {
    // 10 oversized lines (70 MB, fewer than the 12-line cap of a tailSize-3 cache) hide the
    // only message: it lies past the read budget.
    const junk = "q".repeat(7 * 1024 * 1024);
    const content =
      [claude("user", "hidden", 1), ...Array.from({ length: 10 }, () => junk)].join("\n") + "\n";
    const r = populate("budget", content);
    expect(r.ok).toBe(false);
    expect(r.messages).toBeNull();
  });
});
