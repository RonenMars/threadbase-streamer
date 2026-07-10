import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";

// Local dev origins allowed when browser CORS is enabled.
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:8081",
  "http://localhost:19006",
  "http://localhost:3000",
];

// Browser CORS is OFF by default: without an Origin allow-list, no web page can
// make authenticated requests even if it obtains the API key out-of-band. Set
// THREADBASE_ALLOW_BROWSER_CORS to enable (any of: 1, true, yes, on), and
// optionally to a comma-separated origin list to allow origins beyond the
// localhost dev defaults, e.g. THREADBASE_ALLOW_BROWSER_CORS=https://app.example.com
// Mobile requests aren't browser-originated (no Origin header) and are unaffected.
export function resolveAllowedOrigins(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off" || trimmed === "") {
    return null;
  }

  const origins = new Set(DEFAULT_DEV_ORIGINS);
  // Treat plain on/off tokens as "just enable the defaults"; anything else is an
  // explicit origin list to add on top.
  if (!["1", "true", "yes", "on"].includes(lower)) {
    for (const o of trimmed.split(",")) {
      const origin = o.trim();
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

// `configValue` is the resolved server.yaml `browser_cors:` setting (if any);
// THREADBASE_ALLOW_BROWSER_CORS always takes precedence, matching the
// env-over-yaml precedence used for browseRoot/publicUrl/etc. in server.ts.
export const corsMiddleware = (configValue?: string): MiddlewareHandler<AppEnv> => {
  const allowedOrigins = resolveAllowedOrigins(
    process.env.THREADBASE_ALLOW_BROWSER_CORS ?? configValue,
  );

  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowedOrigin = allowedOrigins && origin && allowedOrigins.has(origin) ? origin : null;

    if (allowedOrigin) {
      // Set on the raw ServerResponse too: many handlers write directly to
      // c.env.outgoing and return the ALREADY_HANDLED sentinel, so Hono never
      // pipes c.res.headers onto the actual response. writeHead() merges (does
      // not clear) setHeader()-set headers, so these survive the direct write.
      const raw = c.env.outgoing;
      raw.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      raw.setHeader("Vary", "Origin");
      raw.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, QUERY, OPTIONS");
      raw.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match");
      raw.setHeader("Access-Control-Expose-Headers", "ETag, Accept-Query");

      c.res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
      c.res.headers.set("Vary", "Origin");
      c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, QUERY, OPTIONS");
      c.res.headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, If-None-Match",
      );
      c.res.headers.set("Access-Control-Expose-Headers", "ETag, Accept-Query");
    }

    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, allowedOrigin ? 204 : 403);
    }

    await next();
  };
};
