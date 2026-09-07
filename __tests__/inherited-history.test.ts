/**
 * A `codex fork` rollout carries no history of its own.
 *
 * It holds one `session_meta` naming `forked_from_id` and
 * `forked_from_ordinal_exclusive`; the turns it continues stay in the parent
 * file. Serving the fork therefore means reading someone else's file up to a
 * cut — and the cut is the trap this suite exists to pin.
 *
 * `forked_from_ordinal_exclusive` counts LINES, not messages. On the real pair
 * that produced this work (parent `01a075cd-…`, fork `01a077c6-…`, 2026-09-06)
 * the cut is ordinal 297 in a 331-line file that renders 27 messages, and the
 * correct answer is 21. Three plausible numbers, two of them wrong in ways that
 * render a perfectly believable conversation:
 *
 *   297  the raw ordinal
 *   27   the parent's whole-file message count
 *   24   message-shaped lines before the cut, counted without the role and
 *        empty-text filters the scanner applies
 *   21   correct
 *
 * The fixture below reproduces every one of those discriminators in miniature.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import {
  clearInheritedPrefixCache,
  readForkLinkFromLine,
  readMessagesBeforeOrdinal,
  resolveInheritedHistory,
} from "../src/services/conversations/inheritedHistory";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-inherited-"));
  clearInheritedPrefixCache();
});

function line(ordinal: number, entry: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-09-06T11:20:26.000Z", ordinal, ...entry });
}

function message(ordinal: number, role: string, text: string): string {
  return line(ordinal, {
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

function event(ordinal: number, type: string): string {
  return line(ordinal, { type: "event_msg", payload: { type } });
}

/**
 * Ordinals 0-9, of which exactly 4 render as messages before the cut at 8:
 * a user and an assistant turn, plus one of each again — and NOT the developer
 * line, the system-tag-only line, the event, or anything at/after the cut.
 */
function writeParent(): string {
  const path = join(dir, "rollout-2026-09-06T11-20-26-parent.jsonl");
  writeFileSync(
    path,
    `${[
      line(0, { type: "session_meta", payload: { id: "parent", cwd: "/tmp/p" } }),
      message(1, "user", "first question"),
      message(2, "assistant", "first answer"),
      // Sandbox boilerplate Codex writes as a message. Never rendered.
      message(3, "developer", "sandbox policy dump"),
      event(4, "token_count"),
      // Whole body is a system tag, so it renders as nothing.
      message(5, "user", "<system-reminder>internal</system-reminder>"),
      message(6, "user", "second question"),
      message(7, "assistant", "second answer"),
      event(8, "thread_settings_applied"),
      // Past the cut: the parent kept going after the fork was taken.
      message(9, "user", "after the fork"),
      message(10, "assistant", "still going"),
    ].join("\n")}\n`,
  );
  return path;
}

function writeFork(parentId: string, cut: number, ownTurns: string[] = []): string {
  const path = join(dir, `rollout-2026-09-06T20-31-07-fork-${cut}.jsonl`);
  writeFileSync(
    path,
    `${[
      line(cut, {
        type: "session_meta",
        payload: {
          id: "fork",
          forked_from_id: parentId,
          forked_from_ordinal_exclusive: cut,
          timestamp: "2026-09-06T17:31:07.482Z",
          cwd: "/tmp/p",
        },
      }),
      ...ownTurns,
    ].join("\n")}\n`,
  );
  return path;
}

describe("reading the fork link", () => {
  it("reads the source and the cut off a session_meta line", () => {
    const link = readForkLinkFromLine(
      line(297, {
        type: "session_meta",
        payload: {
          forked_from_id: "01a075cd-f290-7d63-9bd8-b37f70c2ef5f",
          forked_from_ordinal_exclusive: 297,
          timestamp: "2026-09-06T17:31:07.482Z",
        },
      }),
    );
    expect(link).toEqual({
      sourceId: "01a075cd-f290-7d63-9bd8-b37f70c2ef5f",
      ordinalExclusive: 297,
      forkedAt: "2026-09-06T17:31:07.482Z",
    });
  });

  it("returns null for the ordinary case: a session_meta that is not a fork", () => {
    expect(
      readForkLinkFromLine(line(0, { type: "session_meta", payload: { id: "plain" } })),
    ).toBeNull();
  });

  it.each([
    ["not JSON at all", "}{ broken"],
    // Valid JSON that is not an object: asRecord answers null for both, which
    // is the branch the type check has to survive rather than throw on.
    ["a bare JSON null", "null"],
    ["a bare JSON number", "42"],
    ["a non-session_meta line", line(1, { type: "event_msg", payload: { type: "token_count" } })],
    [
      "an id with no ordinal",
      line(0, { type: "session_meta", payload: { forked_from_id: "parent" } }),
    ],
    [
      "an ordinal with no id",
      line(0, { type: "session_meta", payload: { forked_from_ordinal_exclusive: 12 } }),
    ],
    [
      "a non-numeric ordinal",
      line(0, {
        type: "session_meta",
        payload: { forked_from_id: "parent", forked_from_ordinal_exclusive: "12" },
      }),
    ],
  ])("returns null, without throwing, for %s", (_label, raw) => {
    expect(readForkLinkFromLine(raw)).toBeNull();
  });
});

describe("translating the cut", () => {
  it("counts rendered messages before the ordinal, not lines and not message-shaped lines", async () => {
    const parent = writeParent();

    const before = await readMessagesBeforeOrdinal(parent, 8);

    // 4 — not 8 (the raw ordinal), not 6 (all rendered messages in the file),
    // and not 6 either from counting message-shaped lines before the cut, which
    // would wrongly include the developer line and the system-tag-only one.
    expect(before?.map((m) => m.text)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
  });

  it("excludes the message exactly AT the cut — the ordinal is exclusive", async () => {
    const parent = writeParent();

    expect((await readMessagesBeforeOrdinal(parent, 2))?.map((m) => m.text)).toEqual([
      "first question",
    ]);
  });

  it("falls back to the line counter when a writer omits ordinals", async () => {
    const path = join(dir, "rollout-no-ordinals.jsonl");
    writeFileSync(
      path,
      `${[
        JSON.stringify({ type: "session_meta", payload: { id: "p" } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "b" }] },
        }),
      ].join("\n")}\n`,
    );

    expect((await readMessagesBeforeOrdinal(path, 2))?.map((m) => m.text)).toEqual(["a"]);
  });
});

describe("resolving a fork's inherited history", () => {
  const locate = (paths: Record<string, string>) => async (id: string) => paths[id] ?? null;

  it("returns null for a conversation that inherits nothing", async () => {
    const parent = writeParent();
    expect(
      await resolveInheritedHistory({ filePath: parent, locateSource: locate({}) }),
    ).toBeNull();
  });

  it("resolves the prefix a fork continues from", async () => {
    const parent = writeParent();
    const fork = writeFork("parent", 8);

    const inherited = await resolveInheritedHistory({
      filePath: fork,
      locateSource: locate({ parent }),
    });

    expect(inherited?.sourceId).toBe("parent");
    expect(inherited?.forkedAt).toBe("2026-09-06T17:31:07.482Z");
    expect(inherited?.unavailableReason).toBeNull();
    expect(inherited?.messages).toHaveLength(4);
    // The parent's turns after the cut belong to the parent, not to the fork.
    expect(inherited?.messages.map((m) => m.text)).not.toContain("after the fork");
  });

  it("degrades to source_missing rather than failing when the source is gone", async () => {
    const fork = writeFork("parent", 8);

    const inherited = await resolveInheritedHistory({
      filePath: fork,
      locateSource: locate({}),
    });

    expect(inherited?.unavailableReason).toBe("source_missing");
    expect(inherited?.messages).toEqual([]);
    // Still reports WHAT it could not read, so a client can say so.
    expect(inherited?.sourceId).toBe("parent");
  });

  it("chains a fork of a fork, oldest history first", async () => {
    const parent = writeParent();
    // Middle forked from the parent at 8, then took two turns of its own at
    // ordinals 8 and 9 — Codex continues the parent's numbering across a fork.
    const middle = writeFork("parent", 8, [
      message(8, "user", "middle question"),
      message(9, "assistant", "middle answer"),
    ]);
    const leaf = join(dir, "rollout-leaf.jsonl");
    writeFileSync(
      leaf,
      `${line(10, {
        type: "session_meta",
        payload: { id: "leaf", forked_from_id: "middle", forked_from_ordinal_exclusive: 10 },
      })}\n`,
    );

    const inherited = await resolveInheritedHistory({
      filePath: leaf,
      locateSource: locate({ parent, middle }),
    });

    expect(inherited?.messages.map((m) => m.text)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "middle question",
      "middle answer",
    ]);
  });

  it("refuses a cycle instead of recursing", async () => {
    const a = join(dir, "rollout-a.jsonl");
    const b = join(dir, "rollout-b.jsonl");
    writeFileSync(
      a,
      `${line(5, {
        type: "session_meta",
        payload: { id: "a", forked_from_id: "b", forked_from_ordinal_exclusive: 5 },
      })}\n`,
    );
    writeFileSync(
      b,
      `${line(5, {
        type: "session_meta",
        payload: { id: "b", forked_from_id: "a", forked_from_ordinal_exclusive: 5 },
      })}\n`,
    );

    const inherited = await resolveInheritedHistory({
      filePath: a,
      locateSource: locate({ a, b }),
    });

    expect(inherited?.unavailableReason).toBe("source_missing");
  });
});

/**
 * The end-to-end shape of the bug this feature was built for: a fork with no
 * turns of its own, asked for by the bound rollout id the streamer just handed
 * the client, which today renders as an empty conversation.
 */
describe("GET /api/conversations/:id for a fork", () => {
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

  function makeHandlers(paths: Record<string, string>, ownMessages: unknown[] | null = null) {
    return new ConversationHandlers({
      // ready:null + no scan profiles = the cold-start path, which resolves the
      // file directly and parses just that one file.
      scannerManager: {
        ready: null,
        current: undefined,
        projectsDirs: () => [],
        newScanner: () => ({
          // A rollout holding only session_meta parses to no conversation at
          // all — which is exactly why the fork reads as empty today.
          parseSingleFilePage: async () =>
            ownMessages ? { conversation: { messages: ownMessages } } : null,
        }),
      },
      scanProfiles: undefined,
      sessionStore: {
        getManaged: () => null,
        listManaged: () => [
          {
            id: "sess-fork",
            boundConversationId: "fork",
            promptCount: 0,
            projectPath: "/tmp/p",
            projectName: "p",
            account: "default",
            startedAt: new Date("2026-09-06T17:31:07.000Z"),
          },
        ],
      },
      ptyManager: { hasSession: () => false },
      cache: () => ({
        getMetaById: () => null,
        getConversationTail: () => null,
        invalidate: vi.fn(),
        getIndexedMessageCount: () => 0,
        readMessageWindow: () => null,
        backfillIndex: async () => {},
      }),
      log: () => ({ warn: vi.fn(), info: vi.fn() }),
      rejectIfWarmingUp: () => false,
      resolveConversationLookupId: (id: string) => id,
      findLiveSessionFilePath: (id: string) => paths[id] ?? null,
      isBoundConversationLive: () => false,
      trackCacheWrite: () => {},
    } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);
  }

  it("serves the inherited history instead of an empty conversation", async () => {
    const parent = writeParent();
    const fork = writeFork("parent", 8);
    const res = makeRes();

    await makeHandlers({ parent, fork }).handleGetConversation(
      "fork",
      new URL("http://localhost/api/conversations/fork?msg_limit=80"),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
    // Meta must agree with the body, or the hub row says "no messages" about a
    // conversation the detail view is showing four of.
    expect(body.meta.message_count).toBe(4);
    expect(body.meta.inherited_history).toMatchObject({
      source_id: "parent",
      through_message_index: 4,
      unavailable_reason: null,
    });
  });

  it("puts the seam after the inherited half once the fork has its own turns", async () => {
    const parent = writeParent();
    const fork = writeFork("parent", 8);
    const res = makeRes();

    await makeHandlers({ parent, fork }, [
      { role: "user", text: "continue with the merge", timestamp: "2026-09-06T17:32:00.000Z" },
    ]).handleGetConversation(
      "fork",
      new URL("http://localhost/api/conversations/fork?msg_limit=80"),
      res,
    );

    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(5);
    // Indices are continuous across the seam: the client pages one space.
    expect(body.messages.map((m: { message_index: number }) => m.message_index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(body.messages[4].text).toBe("continue with the merge");
    expect(body.meta.inherited_history.through_message_index).toBe(4);
  });

  it("leaves a conversation that inherits nothing completely untouched", async () => {
    const parent = writeParent();
    const res = makeRes();

    await makeHandlers({ parent }, [
      { role: "user", text: "plain", timestamp: "2026-09-06T11:20:26.000Z" },
    ]).handleGetConversation(
      "parent",
      new URL("http://localhost/api/conversations/parent?msg_limit=80"),
      res,
    );

    const body = JSON.parse(res.body);
    expect(body.meta.inherited_history).toBeUndefined();
    expect(body.messages).toHaveLength(1);
  });
});
