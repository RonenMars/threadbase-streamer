/**
 * Two counting questions a Codex conversation asks of `handleGetConversation`,
 * both downstream of the same fact: the offset index and the scanner count a
 * rollout in the PRE-filter space (`parseCodexJsonlLine` renders the AGENTS.md
 * and permissions dumps as `role: user`), while the response body is served in
 * the POST-filter space `isCodexInjectedContext` / `isServable` produce.
 *
 * 1. `meta.message_count` used to add a POST-filter prefix length to a
 *    PRE-filter own count, landing in neither space.
 * 2. The ETag reads `getIndexedMessageCount` unguarded by #824's
 *    `useOffsetIndex`. That is deliberate and safe, and these tests are what
 *    say so — there was no ETag coverage for a Codex conversation with a warm
 *    index at all.
 *
 * Copied from codex-offset-index-gate.test.ts on purpose: a REAL
 * ConversationCache, a REAL backfillIndex, a REAL readMessageWindow and a
 * `filePath` on the parsed page. The traps otherwise are that
 * inherited-history.test.ts stubs `readMessageWindow: () => null`, that a fake
 * page without `filePath` never reaches the index at all, and that a fixture
 * with no injected-context line cannot tell the two spaces apart and so passes
 * either way. Every fixture below carries injected context.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "tb-codex-meta-etag-"));
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

/** Captures the status AND the headers — the ETag is the whole subject here. */
function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  return {
    writeHead: vi.fn((code: number, h?: Record<string, string>) => {
      statusCode = code;
      headers = h ?? {};
    }),
    end: vi.fn((body?: string) => {
      if (body) chunks.push(body);
    }),
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get body() {
      return chunks.join("");
    },
  } as unknown as ServerResponse & {
    body: string;
    statusCode: number;
    headers: Record<string, string>;
  };
}

type ScannerMessage = { role: string; text: string; timestamp: string };

/**
 * The real cache with only the scanner's full-file parse stubbed. `messages` is
 * read at call time, so a test can grow the snapshot the way a rescan would.
 * `filePath` is present because the handler reads `conversation.filePath` when
 * deciding the fast path; without it the index is never consulted.
 */
function makeHandlers(
  paths: Record<string, string>,
  scannerMessages: () => ScannerMessage[],
  timestamp = () => "2026-09-06T17:32:10.000Z",
) {
  return new ConversationHandlers({
    scannerManager: {
      ready: null,
      current: undefined,
      projectsDirs: () => [],
      newScanner: () => ({
        parseSingleFilePage: async (fp: string) => ({
          conversation: {
            filePath: fp,
            messages: scannerMessages(),
            messageCount: scannerMessages().length,
            timestamp: timestamp(),
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

async function get(
  handlers: ConversationHandlers,
  id: string,
  opts: { query?: string; ifNoneMatch?: string } = {},
) {
  const res = makeRes();
  await handlers.handleGetConversation(
    id,
    new URL(`http://localhost/api/conversations/${id}?${opts.query ?? "msg_limit=80"}`),
    res,
    opts.ifNoneMatch,
  );
  return { res, etag: res.headers.ETag, body: res.body ? JSON.parse(res.body) : undefined };
}

const texts = (body: { messages: Array<{ text: string }> }) => body.messages.map((m) => m.text);

// ---------------------------------------------------------------------------
// Task 1: meta.message_count counts in the space the body is served in.
// ---------------------------------------------------------------------------

describe("meta.message_count counts in the served space", () => {
  const PARENT = "rollout-2026-09-06T11-20-26-meta-parent";
  const FORK = "rollout-2026-09-06T20-31-07-meta-fork";

  /** Two renderable turns before the cut at ordinal 8, one after it. */
  function writeParent(): string {
    const path = join(dir, `${PARENT}.jsonl`);
    writeFileSync(
      path,
      `${[
        codexLine(0, { type: "session_meta", payload: { id: "parent", cwd: "/tmp/p" } }),
        codexMessage(1, "user", "first question"),
        codexMessage(2, "assistant", "first answer"),
        codexLine(8, { type: "event_msg", payload: { type: "thread_settings_applied" } }),
        codexMessage(9, "user", "after the fork"),
      ].join("\n")}\n`,
    );
    return path;
  }

  /** The fork's own file carries an injected-context line — without one, a raw
   * count and a filtered count are the same number and this test proves
   * nothing. */
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
        codexMessage(8, "user", "<permissions instructions>sandbox</permissions instructions>"),
        codexMessage(9, "user", "continue with the merge"),
        codexMessage(10, "assistant", "merging"),
      ].join("\n")}\n`,
    );
    return path;
  }

  const own: ScannerMessage[] = [
    {
      role: "user",
      text: "<permissions instructions>sandbox</permissions instructions>",
      timestamp: "2026-09-06T17:31:50.000Z",
    },
    { role: "user", text: "continue with the merge", timestamp: "2026-09-06T17:32:00.000Z" },
    { role: "assistant", text: "merging", timestamp: "2026-09-06T17:32:10.000Z" },
  ];

  it("does not add a filtered prefix to an unfiltered own count", async () => {
    const parent = writeParent();
    const fork = writeFork();
    seedMeta(PARENT, parent, "codex-cli");
    seedMeta(FORK, fork, "codex-cli");
    await cache.backfillIndex(fork);

    // The index really is warm over the fork's own file and holds one MORE than
    // the handler may serve from it — the pre-filter space, in one assertion.
    expect(cache.getIndexedMessageCount(FORK)).toBe(2);
    expect(cache.readMessageWindow(fork, 0, 80)?.total).toBe(2);

    const { body } = await get(
      makeHandlers({ [PARENT]: parent, [FORK]: fork }, () => own),
      FORK,
    );

    // 2 inherited + 2 own, both halves post-`isServable`.
    expect(texts(body)).toEqual([
      "first question",
      "first answer",
      "continue with the merge",
      "merging",
    ]);
    // The old expression was `conv.messageCount (3, raw) + inheritedFiltered
    // (2)` = 5 against a body of 4. One number, one space.
    expect(body.meta.message_count).toBe(4);
    expect(body.message_pagination.total).toBe(4);
    expect(body.meta.message_count).toBe(body.messages.length);
  });

  it("still counts the prefix, so a fork never reports 0 against a full body", async () => {
    const parent = writeParent();
    const fork = writeFork();
    seedMeta(PARENT, parent, "codex-cli");
    seedMeta(FORK, fork, "codex-cli");

    // The property the old `+ inheritedFiltered.length` existed for: drop the
    // prefix from the count and this reads 2 while the body carries 4, and the
    // hub row disagrees with the open conversation.
    const { body } = await get(
      makeHandlers({ [PARENT]: parent, [FORK]: fork }, () => own),
      FORK,
    );

    expect(body.meta.message_count).toBeGreaterThan(
      body.meta.inherited_history.through_message_index,
    );
    expect(body.meta.message_count).toBe(4);
    expect(body.meta.inherited_history.through_message_index).toBe(2);
  });

  it("a plain Codex rollout counts its injected line out of meta too", async () => {
    const CONV = "rollout-2026-09-06T11-20-26-meta-plain";
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
    seedMeta(CONV, path, "codex-cli");
    await cache.backfillIndex(path);
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);

    const parsed: ScannerMessage[] = [
      {
        role: "user",
        text: "# AGENTS.md\n\nproject instructions",
        timestamp: "2026-09-06T11:00:00.000Z",
      },
      { role: "user", text: "real question", timestamp: "2026-09-06T11:00:01.000Z" },
      { role: "assistant", text: "real answer", timestamp: "2026-09-06T11:00:02.000Z" },
    ];
    const { body } = await get(
      makeHandlers({ [CONV]: path }, () => parsed),
      CONV,
    );

    expect(texts(body)).toEqual(["real question", "real answer"]);
    expect(body.meta.message_count).toBe(2);
    expect(body.message_pagination.total).toBe(2);
  });

  /**
   * The premise the fix rests on: after #824 `indexTotal` is unreachable for
   * Codex, so `metaMessageCount` never has to reconcile an index total with an
   * inherited prefix.
   *
   * Probed through `meta.last_updated_at`, which is the OTHER consumer of the
   * same `indexTotal != null && indexTotal > conv.messageCount` condition and
   * is untouched by this change. The scanner snapshot here is deliberately one
   * message behind the file, so a reachable index total would be strictly
   * greater and would swing `last_updated_at` to the newest SERVED message's
   * timestamp. It must stay on the scanner's conversation timestamp.
   */
  it("a plain Codex rollout is now served from the index, in the served space", async () => {
    const CONV = "rollout-2026-09-06T11-20-26-meta-stale";
    const path = join(dir, `${CONV}.jsonl`);
    writeFileSync(
      path,
      `${[
        codexLine(0, { type: "session_meta", payload: { id: "stale", cwd: "/tmp/p" } }),
        codexMessage(1, "user", "# AGENTS.md\n\nproject instructions"),
        codexMessage(2, "user", "real question"),
        codexMessage(3, "assistant", "real answer"),
      ].join("\n")}\n`,
    );
    seedMeta(CONV, path, "codex-cli");
    await cache.backfillIndex(path);

    // Index total 2 > the stale snapshot's 1, so the freshness condition fires —
    // and for a plain Codex rollout the window is now taken. The 2 is the point:
    // the index holds what the handler serves, not the 3 it used to hold with
    // the AGENTS.md line counted.
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);
    expect(cache.readMessageWindow(path, 0, 80)?.total).toBe(2);

    const stale: ScannerMessage[] = [
      { role: "user", text: "stale snapshot", timestamp: "2026-09-06T09:00:00.000Z" },
    ];
    const { body } = await get(
      makeHandlers(
        { [CONV]: path },
        () => stale,
        () => "2026-09-06T17:32:10.000Z",
      ),
      CONV,
    );

    // Served from the INDEX, which is fresher than the scanner's snapshot — the
    // case the index exists for. Before this, #824's gate forced Codex onto the
    // scanner and a live rollout served a stale body.
    //
    // The body is the real turns WITHOUT the AGENTS.md line: proof the index and
    // the handler now number this file the same way. If the writer's filter were
    // dropped, this would read ["# AGENTS.md…", "real question", "real answer"].
    expect(texts(body)).toEqual(["real question", "real answer"]);
    expect(body.messages.map((m: { message_index: number }) => m.message_index)).toEqual([0, 1]);
    expect(body.meta.message_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the ETag consumer #824's gate does not cover.
// ---------------------------------------------------------------------------

describe("the ETag stays change-sensitive for a Codex conversation with a warm index", () => {
  const CONV = "rollout-2026-09-06T11-20-26-etag";

  const injected = {
    role: "user",
    text: "# AGENTS.md\n\nproject instructions",
    timestamp: "2026-09-06T11:00:00.000Z",
  };
  const q = { role: "user", text: "real question", timestamp: "2026-09-06T11:00:01.000Z" };
  const a = { role: "assistant", text: "real answer", timestamp: "2026-09-06T11:00:02.000Z" };

  function writeRollout(): string {
    const path = join(dir, `${CONV}.jsonl`);
    writeFileSync(
      path,
      `${[
        codexLine(0, { type: "session_meta", payload: { id: "etag", cwd: "/tmp/p" } }),
        codexMessage(1, "user", "# AGENTS.md\n\nproject instructions"),
        codexMessage(2, "user", "real question"),
        codexMessage(3, "assistant", "real answer"),
      ].join("\n")}\n`,
    );
    return path;
  }

  it("changes on an append, and 304s only while nothing has changed", async () => {
    const path = writeRollout();
    seedMeta(CONV, path, "codex-cli");
    await cache.backfillIndex(path);

    // Warm, and now holding the SERVED count: the index writer drops this
    // rollout's leading AGENTS.md line the same way the handler does.
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);
    expect(cache.readMessageWindow(path, 0, 80)).not.toBeNull();

    // The scanner snapshot the handler will see, grown between requests the way
    // a rescan grows it.
    let snapshot: ScannerMessage[] = [injected, q, a];
    let convTimestamp = "2026-09-06T11:00:02.000Z";
    const handlers = makeHandlers(
      { [CONV]: path },
      () => snapshot,
      () => convTimestamp,
    );

    const first = await get(handlers, CONV);
    expect(first.res.statusCode).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(first.body.message_pagination.total).toBe(2);

    // Nothing changed: the validator must match and the handler must 304.
    const unchanged = await get(handlers, CONV, { ifNoneMatch: first.etag });
    expect(unchanged.res.statusCode).toBe(304);
    expect(unchanged.res.headers.ETag).toBe(first.etag);

    // Append a real turn, and move BOTH readers the way production does: the
    // watcher's onNewLineSpans extends the offset index with the same
    // parseCodexJsonlLine the backfill uses, and a rescan grows the snapshot.
    appendFileSync(path, `${codexMessage(4, "user", "one more question")}\n`);
    await cache.backfillIndex(path);
    snapshot = [
      injected,
      q,
      a,
      { role: "user", text: "one more question", timestamp: "2026-09-06T11:00:03.000Z" },
    ];
    convTimestamp = "2026-09-06T11:00:03.000Z";
    expect(cache.getIndexedMessageCount(CONV)).toBe(3);

    // The whole point of a validator: the client's old tag must NOT satisfy it.
    const grown = await get(handlers, CONV, { ifNoneMatch: first.etag });
    expect(grown.res.statusCode).toBe(200);
    expect(grown.etag).not.toBe(first.etag);
    expect(texts(grown.body)).toEqual(["real question", "real answer", "one more question"]);

    // And the new tag 304s in its turn, so the client settles again.
    const settled = await get(handlers, CONV, { ifNoneMatch: grown.etag });
    expect(settled.res.statusCode).toBe(304);
  });

  /**
   * The failure mode the inflated count would have to cause to matter: the
   * index frozen while the file grows. `max(scannerCount, indexedCount)` can
   * only mask a scanner increment while `indexedCount` is strictly greater and
   * stationary — so this is the adversarial case, with the index deliberately
   * NOT refreshed after the append.
   *
   * It passes because both ETag inputs live in the SAME pre-filter space: the
   * index's inflation over the SERVED body is matched by the scanner's, so the
   * scanner count is never behind the index by the injected-line offset and its
   * increment is never swallowed.
   */
  it("a frozen index cannot mask an append, because both inputs are pre-filter", async () => {
    const path = writeRollout();
    seedMeta(CONV, path, "codex-cli");
    await cache.backfillIndex(path);
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);

    let snapshot: ScannerMessage[] = [injected, q, a];
    let convTimestamp = "2026-09-06T11:00:02.000Z";
    const handlers = makeHandlers(
      { [CONV]: path },
      () => snapshot,
      () => convTimestamp,
    );

    const first = await get(handlers, CONV);
    expect(first.res.statusCode).toBe(200);

    // Append, and refresh ONLY the scanner. The index stays at 3.
    appendFileSync(path, `${codexMessage(4, "user", "one more question")}\n`);
    snapshot = [
      injected,
      q,
      a,
      { role: "user", text: "one more question", timestamp: "2026-09-06T11:00:03.000Z" },
    ];
    convTimestamp = "2026-09-06T11:00:03.000Z";
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);

    const grown = await get(handlers, CONV, { ifNoneMatch: first.etag });
    expect(grown.res.statusCode).toBe(200);
    expect(grown.etag).not.toBe(first.etag);
  });
});

// ---------------------------------------------------------------------------
// The OTHER half of Task 1: `metaMessageCount` must still prefer a fresher
// index. Adapted from the parallel attempt in
// tb-streamer-worktrees/meta-message-count, which had this case and this file
// did not.
//
// Without it, replacing the whole expression with a bare `total` — which
// silently drops the freshness property — passes every other test in this file,
// in codex-offset-index-gate and in inherited-history (31 green). Measured, not
// assumed: that is the exact reverse of the vacuity trap the Codex fixtures
// above guard against, and it is why this describe block exists.
// ---------------------------------------------------------------------------

describe("meta.message_count still follows a fresher offset index (Claude)", () => {
  const CONV = "claude-conv-meta-fresh";

  const claudeLine = (i: number, text: string) =>
    JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      uuid: `cl-${i}`,
      timestamp: `2026-09-06T10:00:0${i}.000Z`,
      sessionId: CONV,
      cwd: "/tmp/p",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
    });

  it("reports what the index served, not the stale scanner count", async () => {
    const path = join(dir, `${CONV}.jsonl`);
    writeFileSync(
      path,
      `${[
        claudeLine(0, "claude question"),
        claudeLine(1, "claude answer"),
        claudeLine(2, "claude follow-up"),
      ].join("\n")}\n`,
    );
    seedMeta(CONV, path, "claude-code");
    await cache.backfillIndex(path);

    // Claude keeps the fast path, so this index really does serve the window.
    expect(cache.getIndexedMessageCount(CONV)).toBe(3);
    expect(cache.readMessageWindow(path, 0, 80)?.total).toBe(3);

    // The scanner snapshot is deliberately one behind the file — the live/
    // appended case the index preference exists for.
    const stale: ScannerMessage[] = [
      { role: "user", text: "claude question", timestamp: "2026-09-06T10:00:00.000Z" },
      { role: "assistant", text: "claude answer", timestamp: "2026-09-06T10:00:01.000Z" },
    ];
    const { body } = await get(
      makeHandlers({ [CONV]: path }, () => stale),
      CONV,
    );

    // Served from the index: three messages, so meta must say three. A bare
    // `total` reports the snapshot's 2 and disagrees with its own body.
    expect(texts(body)).toEqual(["claude question", "claude answer", "claude follow-up"]);
    expect(body.message_pagination.total).toBe(3);
    expect(body.meta.message_count).toBe(3);
    expect(body.meta.message_count).toBe(body.messages.length);
    // The sibling consumer of the same freshness condition moves with it.
    expect(body.meta.last_updated_at).toBe("2026-09-06T10:00:02.000Z");
  });

  it("does not move when the index merely agrees with the snapshot", async () => {
    const path = join(dir, `${CONV}.jsonl`);
    writeFileSync(
      path,
      `${[claudeLine(0, "claude question"), claudeLine(1, "claude answer")].join("\n")}\n`,
    );
    seedMeta(CONV, path, "claude-code");
    await cache.backfillIndex(path);
    expect(cache.getIndexedMessageCount(CONV)).toBe(2);

    const fresh: ScannerMessage[] = [
      { role: "user", text: "claude question", timestamp: "2026-09-06T10:00:00.000Z" },
      { role: "assistant", text: "claude answer", timestamp: "2026-09-06T10:00:01.000Z" },
    ];
    const { body } = await get(
      makeHandlers({ [CONV]: path }, () => fresh),
      CONV,
    );

    // Index and snapshot agree, so the delta is 0 and meta is just `total`.
    expect(body.meta.message_count).toBe(2);
    expect(body.meta.last_updated_at).toBe("2026-09-06T17:32:10.000Z");
  });
});
