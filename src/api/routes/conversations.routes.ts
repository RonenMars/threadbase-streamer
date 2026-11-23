import type Database from "better-sqlite3";
import { Hono } from "hono";
import {
  ConversationReadsRepository,
  messageKey,
} from "../../db/repositories/conversation-reads.repository";
import type { AppEnv } from "../app";
import { BodyTooLargeError } from "../handlers/http-helpers";
import type { ApiDeps } from "../types/api-deps";
import { readJsonBody } from "./misc.routes";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

/** Most messages one ack request records; the client sends the rest again. */
export const READ_ACK_CAP = 500;

const readsRepos = new WeakMap<Database.Database, ConversationReadsRepository>();

const parseTs = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

export const createConversationRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/count", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleConversationsCount(url, c.env.outgoing);
    return alreadyHandled();
  });

  // QUERY (RFC 10008): safe + idempotent + cacheable like GET, but the query
  // travels in a JSON body instead of ?q= — this endpoint's input is a single
  // search string, exactly what QUERY was designed to carry. Must be
  // registered before the greedy "/:id{.+}" catch-all or Hono would swallow
  // "<id>/search-target" as a conversation id.
  app.on("QUERY", "/:id{.+}/search-target", async (c) => {
    const id = c.req.param("id");
    if (await deps.isExcludedSubagent?.(id))
      return c.json({ error: "Conversation not found" }, 404);
    await deps.handleSearchTarget(id, c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  // Range ack for the unread dot: the client reports the stretch of replies it
  // rendered, the server expands it from its own index. docs/plans/unread-messages-plan.md §4.3.
  app.put("/:id{.+}/read", async (c) => {
    const db = deps.runtimeStore()?.getDatabase();
    const cache = deps.cache();
    if (!db || !cache) {
      return c.json({ error: "Read state is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.env.incoming);
    } catch (err) {
      return c.json({ error: "Invalid JSON body" }, err instanceof BodyTooLargeError ? 413 : 400);
    }
    const { from: rawFrom, through: rawThrough } = (body ?? {}) as Record<string, unknown>;
    const from = parseTs(rawFrom);
    const through = parseTs(rawThrough);
    if (from === null || through === null) {
      return c.json({ error: "from and through must be ISO timestamps" }, 400);
    }
    if (from > through) return c.json({ error: "from is after through" }, 400);

    let repo = readsRepos.get(db);
    if (!repo) {
      repo = new ConversationReadsRepository(db);
      readsRepos.set(db, repo);
    }
    const rawId = c.req.param("id");
    const id = deps.resolveConversationLookupId?.(rawId) ?? rawId;

    // Only messages not yet acked count against the cap, so resending the same
    // range after `truncated` always makes progress.
    const inRange = cache
      .listCountable(id, { from, through })
      .map((m) => ({ key: messageKey(m.uuid, m.ts), ts: m.ts }));
    const acked = repo.acksFor(
      id,
      inRange.map((m) => m.key),
    );
    const pending = inRange.filter((m) => !acked.has(m.key));
    const truncated = pending.length > READ_ACK_CAP;
    const batch = pending.slice(0, READ_ACK_CAP);
    const fresh = repo.recordAcks(id, batch, c.get("principal")?.deviceId ?? null);
    const frontier = repo.advance(
      id,
      cache
        .listCountable(id, { above: repo.frontier(id) })
        .map((m) => ({ key: messageKey(m.uuid, m.ts), ts: m.ts })),
    );
    const lastCountable = cache.getLastCountableTs(id);
    const unread = lastCountable !== null && lastCountable > frontier;
    const readThrough = new Date(frontier).toISOString();

    if (fresh.length > 0) {
      deps.wsHub.broadcast({
        type: "read_state_changed",
        conversationId: id,
        readThrough,
        unread,
        read: fresh,
      });
    }
    return c.json({ conversationId: id, readThrough, unread, acked: fresh.length, truncated });
  });

  app.get("/:id{.+}", async (c) => {
    const id = c.req.param("id");
    const url = new URL(c.req.url);
    const ifNoneMatch = c.req.header("if-none-match");
    await deps.handleGetConversation(id, url, c.env.outgoing, ifNoneMatch);
    return alreadyHandled();
  });

  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleListConversations(url, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
