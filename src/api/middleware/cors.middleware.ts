import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";

// Allow browser-originated requests only from known local dev origins.
// Mobile app requests are not browser-originated and don't send an Origin header
// so they are unaffected. Wildcard (*) would let any page make authenticated
// requests if the caller obtains the API key out-of-band.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8081",
  "http://localhost:19006",
  "http://localhost:3000",
]);

export const corsMiddleware = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const origin = c.req.header("origin");
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;

  if (allowedOrigin) {
    c.res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    c.res.headers.set("Vary", "Origin");
    c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    c.res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match");
    c.res.headers.set("Access-Control-Expose-Headers", "ETag");
  }

  if (c.req.method === "OPTIONS") {
    return c.newResponse(null, allowedOrigin ? 204 : 403);
  }

  await next();
};
