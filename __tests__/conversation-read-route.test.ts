import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationRoutes } from "../src/api/routes/conversations.routes";
import { ConversationCache } from "../src/conversation-cache";
import { RuntimeStore } from "../src/db/runtime-store";
import type { WSMessage } from "../src/types";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";
import { splitCompleteLines } from "../src/utils/fileIdentity";

const CONV = "conv-1";
let dir: string;
let cache: ConversationCache;
let store: RuntimeStore | null;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let broadcasts: WSMessage[];
let jsonlPath: string;
let t0: number;

const iso = (offsetSec: number) => new Date(t0 + offsetSec * 1000).toISOString();
const asst = (n: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a${n}`,
    timestamp: iso(n),
    sessionId: "s",
    cwd: "/p",
    message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }] },
  });

/** Index `count` countable replies, one second apart, starting one second after t0. */
function seed(count: number): void {
  const content = `${Array.from({ length: count }, (_, i) => asst(i + 1)).join("\n")}\n`;
  writeFileSync(jsonlPath, content);
  const { spans, consumed } = splitCompleteLines(Buffer.from(content, "utf-8"), 0);
  cache.extendMessageIndex(jsonlPath, spans, statSync(jsonlPath), 0, consumed);
}

const put = (id: string, body: unknown) =>
  fetch(`${baseUrl}/api/conversations/${id}/read`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const range = (from: number, through: number) => ({ from: iso(from), through: iso(through) });

async function start(withStore = true) {
  const app = new Hono();
  app.route(
    "/api/conversations",
    createConversationRoutes({
      cache: () => cache,
      runtimeStore: () => (withStore ? store : null),
      resolveConversationLookupId: (id: string) => (id === "placeholder" ? CONV : id),
      wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    } as never),
  );
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const stop = () => new Promise((r) => server.close(() => r(null)));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tb-read-route-"));
  jsonlPath = join(dir, `${CONV}.jsonl`);
  cache = ConversationCache.open(join(dir, "cache.db"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  broadcasts = [];
  // Replies must be newer than the migration baseline to count as unread.
  t0 = Date.now() + 60_000;
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, 'claude-code', 1, 1)",
    )
    .run(CONV, canonicalizeFilePath(jsonlPath));
  await start();
});
afterEach(async () => {
  await stop();
  store?.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PUT /api/conversations/:id/read", () => {
  it("acks a range and reports the frontier (positive control for every test below)", async () => {
    seed(3);
    const res = await put(CONV, range(1, 3));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversationId: CONV,
      readThrough: iso(3),
      unread: false,
      acked: 3,
      truncated: false,
    });
  });

  it("144 replies, last 50 acked: still unread until the gap is acked", async () => {
    seed(144);
    const tail = await (await put(CONV, range(95, 144))).json();
    expect(tail).toMatchObject({ acked: 50, unread: true });
    expect(new Date(tail.readThrough).getTime()).toBeLessThan(t0); // frontier did not move
    const head = await (await put(CONV, range(1, 94))).json();
    expect(head).toMatchObject({ acked: 94, unread: false, readThrough: iso(144) });
  });

  it("a retry acks nothing new and does not broadcast again", async () => {
    seed(2);
    await put(CONV, range(1, 2));
    broadcasts.length = 0;
    expect(await (await put(CONV, range(1, 2))).json()).toMatchObject({ acked: 0, unread: false });
    expect(broadcasts).toEqual([]);
  });

  it("a range with no indexed message records nothing", async () => {
    seed(2);
    expect(await (await put(CONV, range(100, 200))).json()).toMatchObject({
      acked: 0,
      unread: true,
    });
    expect(broadcasts).toEqual([]);
  });

  it("caps one request at 500 and says so", async () => {
    seed(501);
    const first = await (await put(CONV, range(1, 501))).json();
    expect(first).toMatchObject({ acked: 500, truncated: true, unread: true });
    const second = await (await put(CONV, range(1, 501))).json();
    expect(second).toMatchObject({ acked: 1, truncated: false, unread: false });
  });

  it("broadcasts read_state_changed with the server-computed unread", async () => {
    seed(3);
    await put(CONV, range(1, 2));
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: "read_state_changed",
      conversationId: CONV,
      readThrough: iso(2),
      unread: true,
    });
    const read = (broadcasts[0] as { read: { key: string }[] }).read;
    expect(read.map((r) => r.key)).toEqual(["a1", "a2"]);
  });

  it("resolves a Codex placeholder id to the bound conversation", async () => {
    seed(1);
    const res = await (await put("placeholder", range(1, 1))).json();
    expect(res).toMatchObject({ conversationId: CONV, acked: 1, unread: false });
  });

  it("rejects bad input with 400", async () => {
    seed(1);
    expect((await put(CONV, "not json")).status).toBe(400);
    expect((await put(CONV, { from: iso(1) })).status).toBe(400);
    expect((await put(CONV, { from: "nope", through: iso(1) })).status).toBe(400);
    expect((await put(CONV, { from: iso(2), through: iso(1) })).status).toBe(400);
  });

  it("survives a restart of the runtime store", async () => {
    seed(2);
    await put(CONV, range(1, 2));
    await stop();
    store?.close();
    store = RuntimeStore.open(join(dir, "runtime.db"));
    await start();
    expect(await (await put(CONV, range(1, 2))).json()).toMatchObject({
      acked: 0,
      unread: false,
      readThrough: iso(2),
    });
  });

  it("survives a cache clear: the rebuilt index still reads as read", async () => {
    seed(2);
    await put(CONV, range(1, 2));
    cache.getDatabase().prepare("DELETE FROM conversation_message_index").run();
    cache.getDatabase().prepare("UPDATE conversation_meta SET last_countable_ts = NULL").run();
    seed(2); // rescan
    expect(await (await put(CONV, range(1, 2))).json()).toMatchObject({
      acked: 0,
      unread: false,
      readThrough: iso(2),
    });
  });

  it("answers 503 STORE_UNAVAILABLE without a runtime store", async () => {
    await stop();
    await start(false);
    const res = await put(CONV, range(1, 1));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "STORE_UNAVAILABLE" });
  });
});
