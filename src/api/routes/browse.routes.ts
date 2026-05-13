import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

export const createBrowseRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/browse", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleBrowse(url, c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/browse/mkdir", async (c) => {
    await deps.handleMkdir(c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
