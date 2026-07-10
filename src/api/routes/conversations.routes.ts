import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

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
    await deps.handleSearchTarget(id, c.env.incoming, c.env.outgoing);
    return alreadyHandled();
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
