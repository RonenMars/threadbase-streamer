import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

export const createProjectRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  // Retired: the Hub reads /summary. 410 rather than 404 so a stale client sees
  // that the route was removed on purpose and where to go instead.
  app.get("/", (c) =>
    c.json({ error: "GET /api/projects is retired; use GET /api/projects/summary" }, 410),
  );

  app.get("/popular", (c) => {
    const url = new URL(c.req.url);
    deps.handleGetPopularProjects(url, c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/summary", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleGetProjectSummaries(url, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
