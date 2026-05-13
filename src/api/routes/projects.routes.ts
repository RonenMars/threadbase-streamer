import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

export const createProjectRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/popular", (c) => {
    const url = new URL(c.req.url);
    deps.handleGetPopularProjects(url, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
