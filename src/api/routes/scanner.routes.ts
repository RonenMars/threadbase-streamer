import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

export const createScannerRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/api/search", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleSearch(url, c.env.outgoing);
    return alreadyHandled();
  });

  // QUERY (RFC 10008) twin of the GET above; GET stays because released clients
  // cannot be force-updated.
  app.on("QUERY", "/api/search", async (c) => {
    await deps.handleSearchQuery(c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
