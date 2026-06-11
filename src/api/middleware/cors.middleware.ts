import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";

export const corsMiddleware = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match");
  c.res.headers.set("Access-Control-Expose-Headers", "ETag");

  if (c.req.method === "OPTIONS") {
    return c.newResponse(null, 204);
  }

  await next();
};
