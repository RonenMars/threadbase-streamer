import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

export const createPairRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.post("/start", (c) => {
    deps.handlePairStart(c.env.outgoing);
    return alreadyHandled();
  });

  // /api/pair/exchange is public — auth middleware skips it
  app.post("/exchange", async (c) => {
    await deps.handlePairExchange(c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
