/**
 * The offset index numbers a Codex rollout in a different index space than
 * `handleGetConversation` serves it in.
 *
 * #818 made Codex rollouts indexable. The index is built with the scanner's
 * `parseCodexJsonlLine`, which renders the AGENTS.md / permissions dumps Codex
 * writes as `role: user`; the handler drops them with `isCodexInjectedContext`
 * before assigning indices. So the same request served two different
 * conversations depending only on whether the index happened to be warm — and
 * for a fork (#807) the index window covers the fork's OWN file, so taking it
 * discarded the inherited prefix entirely.
 *
 * These tests use a REAL ConversationCache with a REAL backfillIndex, because
 * the trap here is a test that passes vacuously: the fork suite in
 * inherited-history.test.ts stubs `readMessageWindow: () => null`, and a fake
 * `parseSingleFilePage` that omits `filePath` never reaches the fast path at
 * all (it reads `conversation.filePath`). Every test below asserts the index is
 * genuinely warm and WOULD have served this window before making the request.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import { ConversationCache } from "../src/conversation-cache";
import { clearInheritedPrefixCache } from "../src/services/conversations/inheritedHistory";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

let dir: string;
let cache: ConversationCache;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-codex-index-gate-"));
  mkdirSync(dir, { recursive: true });
  cache = ConversationCache.open(join(dir, "cache.db"));
  clearInheritedPrefixCache();
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedMeta(id: string, filePath: string, provider: string): void {
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, ?, 5, 1)",
    )
    .run(id, canonicalizeFilePath(filePath), provider);
}

const codexLine = (ordinal: number, entry: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-09-06T11:20:26.000Z", ordinal, ...entry });

const codexMessage = (ordinal: number, role: string, text: string) =>
  codexLine(ordinal, {
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });

const codexEvent = (ordinal: number, type: string) =>
  codexLine(ordinal, { type: "event_msg", payload: { type } });

const claudeLine = (i: number, text: string) =>
  JSON.stringify({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: `cl-${i}`,
    timestamp: `2026-09-06T10:00:0${i}.000Z`,
    sessionId: "claude-conv-gate",
    cwd: "/tmp/p",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text }],
    },
  });

function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  return {
    writeHead: vi.fn((code: number) => {
      statusCode = code;
    }),
    end: vi.fn((body?: string) => {
      if (body) chunks.push(body);
    }),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return chunks.join("");
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
}

type ScannerMessage = { role: string; text: string; timestamp: string };

/**
 * The real cache, with only the scanner's full-file parse stubbed — it stands
 * in for the parse of one file and returns what that file holds. `filePath` is
 * set because the fast path reads it; without it the index is never consulted
 * and every assertion below would pass for the wrong reason.
 */
function makeHandlers(paths: Record<string, string>, scannerMessages: ScannerMessage[]) {
  return new ConversationHandlers({
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
            timestamp: "2026-09-06T17:32:10.000Z",
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
    findLiveSessionFilePath: (id: string) => paths[id] ?? null,
    isBoundConversationLive: () => false,
    trackCacheWrite: () => {},
  } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);
}

async function get(handlers: ConversationHandlers, id: string, query = "msg_limit=80") {
  const res = makeRes();
  await handlers.handleGetConversation(
    id,
    new URL(`http://localhost/api/conversations/${id}?${query}`),
    res,
  );
  return { res, body: JSON.parse(res.body) };
}

const texts = (body: { messages: Array<{ text: string }> }) => body.messages.map((m) => m.text);
const indices = (body: { messages: Array<{ message_index: number }> }) =>
  body.messages.map((m) => m.message_index);

describe("a Codex rollout is served from the offset index, in the served space", () => {
  const CONV = "rollout-2026-09-06T11-20-26-injected";

  function writeRollout(): string {
    const path = join(dir, `${CONV}.jsonl`);
    writeFileSync(
      path,
      `${[
        codexLine(0, { type: "session_meta", payload: { id: "plain", cwd: "/tmp/p" } }),
        codexMessage(1, "user", "# AGENTS.md\n\nproject instructions"),
        codexMessage(2, "user", "real question"),
        codexMessage(3, "assistant", "real answer"),
      ].join("\n")}\n`,
    );
    return path;
  }

  // What a full parse hands the handler: the same three messages the file
  // holds, injected line included. `isServable` is what removes it.
  const parsed: ScannerMessage[] = [
    {
      role: "user",
      text: "# AGENTS.md\n\nproject instructions",
      timestamp: "2026-09-06T11:00:00.000Z",
    },
    { role: "user", text: "real question", timestamp: "2026-09-06T11:00:01.000Z" },
    { role: "assistant", text: "real answer", timestamp: "2026-09-06T11:00:02.000Z" },
  ];

  it("drops the injected-context line even when the index is warm and holds it", async () => {
    const path = writeRollout();
    seedMeta(CONV, path, "codex-cli");
    await cache.backfillIndex(path);

    // The index really does serve this window, and it now indexes the SAME
    // messages the handler serves: the AGENTS.md preamble is absent because the
    // index writer applies the leading-injected-context rule too. Before that it
    // held 3 rows with the dump at message_index 0, which is what forced #824 to
    // gate Codex off the index entirely.
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);
    expect(cache.readMessageWindow(path, 0, 80)?.messages.map((m) => m.text)).toEqual([
      "real question",
      "real answer",
    ]);

    const { body } = await get(makeHandlers({ [CONV]: path }, parsed), CONV);

    // The served space: injected line gone, and the real turns start at 0.
    expect(texts(body)).toEqual(["real question", "real answer"]);
    expect(indices(body)).toEqual([0, 1]);
    expect(body.message_pagination.total).toBe(2);
  });

  it("serves the same index space whether or not the index is warm", async () => {
    const path = writeRollout();
    seedMeta(CONV, path, "codex-cli");
    const cold = await get(makeHandlers({ [CONV]: path }, parsed), CONV);

    await cache.backfillIndex(path);
    expect(cache.readMessageWindow(path, 0, 80)).not.toBeNull();
    const warm = await get(makeHandlers({ [CONV]: path }, parsed), CONV);

    // Index warmth is a performance property. It must never change which
    // message a stored before_index / after_index / anchor_index refers to.
    expect(texts(warm.body)).toEqual(texts(cold.body));
    expect(indices(warm.body)).toEqual(indices(cold.body));
    expect(warm.body.message_pagination.total).toBe(cold.body.message_pagination.total);
  });
});

describe("a fork keeps its inherited history when its own file is indexed", () => {
  const PARENT = "rollout-2026-09-06T11-20-26-parent";
  const FORK = "rollout-2026-09-06T20-31-07-fork";

  /** Renders 4 messages before the cut at ordinal 8; more after it. */
  function writeParent(): string {
    const path = join(dir, `${PARENT}.jsonl`);
    writeFileSync(
      path,
      `${[
        codexLine(0, { type: "session_meta", payload: { id: "parent", cwd: "/tmp/p" } }),
        codexMessage(1, "user", "first question"),
        codexMessage(2, "assistant", "first answer"),
        // Neither of these renders: role `developer`, and an event line.
        codexMessage(3, "developer", "sandbox policy dump"),
        codexEvent(4, "token_count"),
        codexMessage(6, "user", "second question"),
        codexMessage(7, "assistant", "second answer"),
        codexEvent(8, "thread_settings_applied"),
        codexMessage(9, "user", "after the fork"),
      ].join("\n")}\n`,
    );
    return path;
  }

  function writeFork(): string {
    const path = join(dir, `${FORK}.jsonl`);
    writeFileSync(
      path,
      `${[
        codexLine(8, {
          type: "session_meta",
          payload: {
            id: "fork",
            forked_from_id: PARENT,
            forked_from_ordinal_exclusive: 8,
            timestamp: "2026-09-06T17:31:07.482Z",
            cwd: "/tmp/p",
          },
        }),
        // The fork's own file carries an injected-context line too, so both
        // halves of the bug are in play here: the index counts 3 where the
        // handler serves 2, on top of knowing nothing of the inherited prefix.
        codexMessage(8, "user", "<permissions instructions>sandbox</permissions instructions>"),
        codexMessage(9, "user", "continue with the merge"),
        codexMessage(10, "assistant", "merging"),
      ].join("\n")}\n`,
    );
    return path;
  }

  // What a full parse of the fork's own file yields, injected line included —
  // `isServable` is what removes it.
  const own: ScannerMessage[] = [
    {
      role: "user",
      text: "<permissions instructions>sandbox</permissions instructions>",
      timestamp: "2026-09-06T17:31:50.000Z",
    },
    { role: "user", text: "continue with the merge", timestamp: "2026-09-06T17:32:00.000Z" },
    { role: "assistant", text: "merging", timestamp: "2026-09-06T17:32:10.000Z" },
  ];

  it("serves prefix + own turns as one continuous space, not the index window", async () => {
    const parent = writeParent();
    const fork = writeFork();
    seedMeta(PARENT, parent, "codex-cli");
    seedMeta(FORK, fork, "codex-cli");
    await cache.backfillIndex(fork);

    // A warm index over the fork's own file is still the precondition for the
    // bug: its window covers the fork's own turns and knows nothing of the
    // inherited 4. It now holds 2 rather than 3 — the fork's own file carries an
    // injected-context line at ITS head, which the index writer drops the same
    // way the handler does, because Codex injects per rollout file.
    expect(cache.getIndexedMessageCount(FORK)).toBe(2);
    expect(cache.readMessageWindow(fork, 0, 80)?.total).toBe(2);

    const { body } = await get(makeHandlers({ [PARENT]: parent, [FORK]: fork }, own), FORK);

    expect(texts(body)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "continue with the merge",
      "merging",
    ]);
    // One continuous message_index space across the seam — every client cursor
    // depends on it.
    expect(indices(body)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(body.message_pagination.total).toBe(6);
    // Was 7 until the mixed-space count was fixed: `meta.message_count` added
    // the POST-filter prefix length to `conv.messageCount`, the scanner's raw
    // UNFILTERED count, so it over-reported by one per injected-context line in
    // the fork's own file. It now counts `filtered.length`, the one space this
    // response serves in — the same number as `message_pagination.total`.
    expect(body.meta.message_count).toBe(6);
    expect(body.meta.message_count).toBe(body.message_pagination.total);
    // The POST-filter boundary: the divider lands before the fork's own turns.
    expect(body.meta.inherited_history.through_message_index).toBe(4);
    expect(body.meta.inherited_history.unavailable_reason).toBeNull();
  });

  it("still degrades to source_missing with the fork's own turns intact", async () => {
    const fork = writeFork();
    seedMeta(FORK, fork, "codex-cli");
    await cache.backfillIndex(fork);
    // Warm, and covering only the fork's OWN file — so this test still fails if
    // the index window is taken in place of the stitched list, degrade path or
    // not. The count is the post-filter 2 now that the writer drops this file's
    // own leading preamble.
    expect(cache.readMessageWindow(fork, 0, 80)?.total).toBe(2);

    // The parent is not locatable — the degrade path, which must survive the
    // gate: a missing source is a diminished conversation, never a failure.
    const { res, body } = await get(makeHandlers({ [FORK]: fork }, own), FORK);

    expect(res.statusCode).toBe(200);
    expect(texts(body)).toEqual(["continue with the merge", "merging"]);
    expect(indices(body)).toEqual([0, 1]);
    expect(body.meta.inherited_history.unavailable_reason).toBe("source_missing");
    expect(body.meta.inherited_history.through_message_index).toBe(0);
  });
});

describe("Claude keeps the offset-index fast path", () => {
  const CONV = "claude-conv-gate";

  it("serves a Claude window from the index, not from the scanner snapshot", async () => {
    const path = join(dir, `${CONV}.jsonl`);
    writeFileSync(
      path,
      `${[claudeLine(0, "claude question"), claudeLine(1, "claude answer")].join("\n")}\n`,
    );
    seedMeta(CONV, path, "claude-code");
    await cache.backfillIndex(path);
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);

    // The discriminator: the scanner snapshot is deliberately STALE (one older
    // message). If the response carries the file's two messages, the index
    // served it; if it carries the stale one, the gate wrongly caught Claude.
    const stale: ScannerMessage[] = [
      { role: "user", text: "stale snapshot", timestamp: "2026-09-06T09:00:00.000Z" },
    ];
    const { body } = await get(makeHandlers({ [CONV]: path }, stale), CONV);

    expect(texts(body)).toEqual(["claude question", "claude answer"]);
    expect(body.message_pagination.total).toBe(2);
  });
});
