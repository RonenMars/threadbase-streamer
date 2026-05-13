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

  app.get("/:id{.+}", async (c) => {
    const id = c.req.param("id");
    const url = new URL(c.req.url);
    await deps.handleGetConversation(id, url, c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleListConversations(url, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
