/**
 * The live WS overlay bounds its injected-context filter to the leading turn,
 * exactly as REST does (#862).
 *
 * Before this, REST showed a mid-conversation pasted `# AGENTS.md` (a real turn
 * the user typed) while the live overlay dropped it — the message vanished
 * live and reappeared on reload.
 *
 * The trap is that the overlay sees a BATCH (one watcher read), which may
 * start anywhere in the file, so batch position is not conversation position.
 * Position comes from the offset index's seqs instead. These tests therefore
 * drive REAL watcher-shaped reads through a REAL ConversationCache, the real
 * server broadcast, and the real REST handler — a hand-written seqs array would
 * prove only that the test agrees with itself.
 */

import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexJsonlLine } from "@threadbase-sh/scanner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import { ConversationCache } from "../src/conversation-cache";
import { StreamerServer } from "../src/server";
import { clearInheritedPrefixCache } from "../src/services/conversations/inheritedHistory";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";
import { splitCompleteLines } from "../src/utils/fileIdentity";

const CONV = "rollout-2026-09-12T00-00-00-overlay";
const PASTED = "# AGENTS.md\n\nplease review these rules I pasted";

let dir: string;
let path: string;
let cache: ConversationCache;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-live-overlay-bound-"));
  path = join(dir, `${CONV}.jsonl`);
  cache = ConversationCache.open(join(dir, "cache.db"));
  clearInheritedPrefixCache();
  ordinal = 0;
  readOffset = 0;
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, 'codex-cli', 5, 1)",
    )
    .run(CONV, canonicalizeFilePath(path));
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

let ordinal = 0;
const codexLine = (entry: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: `2026-09-12T00:00:${String(ordinal++).padStart(2, "0")}Z`,
    ...entry,
  });
const message = (role: string, text: string) =>
  codexLine({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
const event = (type: string) => codexLine({ type: "event_msg", payload: { type } });

/** Codex's head: header, the injected AGENTS.md dump, then the first real turn. */
const HEAD = () => [
  codexLine({ type: "session_meta", payload: { id: "overlay", cwd: "/tmp/p" } }),
  message("user", "# AGENTS.md\n\nproject instructions"),
  event("user_message"),
  message("user", "real question"),
  message("assistant", "real answer"),
];

const write = (lines: string[]) => writeFileSync(path, `${lines.join("\n")}\n`);
const append = (lines: string[]) => appendFileSync(path, `${lines.join("\n")}\n`);

/**
 * One watcher read, as ConversationWatcher does it: bytes from `from` to EOF,
 * split into complete lines, handed to extendMessageIndex — which is where the
 * server's seqs come from (server-wiring.ts onNewLineSpans).
 */
let readOffset = 0;
function watcherRead(): { lines: string[]; seqs: (number | null)[] | null } {
  const size = statSync(path).size;
  const buf = Buffer.alloc(size - readOffset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, readOffset);
  } finally {
    closeSync(fd);
  }
  const { spans, consumed } = splitCompleteLines(buf, readOffset);
  const from = readOffset;
  readOffset += consumed;
  const seqs = cache.extendMessageIndex(path, spans, statSync(path), from, readOffset);
  return { lines: spans.map((s) => s.text), seqs };
}

/** The text of every bubble the real server broadcast sends for a batch. */
function live(lines: string[], seqs: (number | null)[] | null): string[] {
  const broadcast = vi.fn();
  // Private method, driven directly: this is the hunk that threads seqs through.
  (StreamerServer.prototype as any).broadcastConversationLines.call(
    { wsHub: { broadcast } },
    CONV,
    lines,
    seqs,
  );
  const batched = broadcast.mock.calls
    .map(([msg]) => msg)
    .find((m: { type: string }) => m.type === "conversation_events");
  return (batched?.lines ?? []).map((l: string) => JSON.parse(l).message.content[0].text);
}

/** What GET /api/conversations/:id serves for the same file. */
async function rest(): Promise<string[]> {
  const scannerMessages = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseCodexJsonlLine(l))
    .filter((m) => m !== null);
  const handlers = new ConversationHandlers({
    scannerManager: {
      ready: null,
      current: undefined,
      projectsDirs: () => [],
      newScanner: () => ({
        parseSingleFilePage: async (fp: string) => ({
          conversation: {
            filePath: fp,
            messages: scannerMessages,
            messageCount: scannerMessages.length,
            timestamp: "2026-09-12T00:00:00.000Z",
            projectPath: "/tmp/p",
          },
        }),
      }),
    },
    scanProfiles: undefined,
    sessionStore: { getManaged: () => null, listManaged: () => [] },
    ptyManager: { hasSession: () => false },
    cache: () => cache,
    log: () => ({ warn: vi.fn(), info: vi.fn() }),
    rejectIfWarmingUp: () => false,
    resolveConversationLookupId: (id: string) => id,
    findLiveSessionFilePath: (id: string) => (id === CONV ? path : null),
    isBoundConversationLive: () => false,
    trackCacheWrite: () => {},
  } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);

  const chunks: string[] = [];
  const res = {
    writeHead: vi.fn(),
    end: vi.fn((body?: string) => {
      if (body) chunks.push(body);
    }),
  } as unknown as ServerResponse;
  await handlers.handleGetConversation(
    CONV,
    new URL(`http://localhost/api/conversations/${CONV}?msg_limit=80`),
    res,
  );
  return JSON.parse(chunks.join("")).messages.map((m: { text: string }) => m.text);
}

describe("live overlay: leading-turn bound on injected context", () => {
  it("drops the injected preamble at conversation position 0 — no fake bubble at session start", () => {
    write(HEAD());
    const { lines, seqs } = watcherRead();

    expect(live(lines, seqs)).toEqual(["real question", "real answer"]);
  });

  it("broadcasts injected-looking text the user pastes later in the conversation", () => {
    write(HEAD());
    watcherRead();
    append([message("assistant", "anything else?"), message("user", PASTED), event("x")]);
    const { lines, seqs } = watcherRead();

    expect(live(lines, seqs)).toEqual(["anything else?", PASTED]);
  });

  // The trap. A batch is one watcher read, and this one starts with the pasted
  // message — so a bound on batch position would eat it.
  it("does not mis-bound a batch that starts past conversation position 0", () => {
    write(HEAD());
    watcherRead();
    append([message("user", PASTED), message("assistant", "reviewed")]);
    const { lines, seqs } = watcherRead();

    // Precondition, so this can't pass vacuously: the pasted line IS first in
    // its batch, and its conversation position is not 0.
    expect(JSON.parse(lines[0]).payload.content[0].text).toBe(PASTED);
    expect(seqs?.[0]).toBeGreaterThan(0);

    expect(live(lines, seqs)).toEqual([PASTED, "reviewed"]);
  });

  it("keeps the filter when a batch carries no positions", () => {
    // The index declines a read it cannot number (non-contiguous, unindexable
    // file, first read before the meta row exists). Unknown position must fall
    // back to leading, never to "show it" — that is the fake AGENTS.md bubble.
    write(HEAD());
    const { lines } = watcherRead();

    expect(live(lines, null)).toEqual(["real question", "real answer"]);
  });
});

describe("REST and live agree on the same rollout", () => {
  it("serves the same messages, in the same order, from both paths", async () => {
    write(HEAD());
    const first = watcherRead();
    append([message("user", PASTED), message("assistant", "reviewed")]);
    const second = watcherRead();

    const liveTexts = [...live(first.lines, first.seqs), ...live(second.lines, second.seqs)];
    const warm = await rest();
    cache.deleteFileIndex(path, CONV);
    const cold = await rest();

    expect(liveTexts).toEqual(warm);
    expect(liveTexts).toEqual(cold);
    // Non-vacuity: agreement on an empty list, or on a list missing either side
    // of the bound, would prove nothing.
    expect(liveTexts).toEqual(["real question", "real answer", PASTED, "reviewed"]);
  });
});
