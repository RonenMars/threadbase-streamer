import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { HEADER_CTX, HEADER_ENVELOPE, HEADER_MARKER, HEADER_SEQ } from "./e2ee-envelope.middleware";

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
      const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": allowedOrigin,
        Vary: "Origin",
        // tb-mobile's api-client issues PUT and DELETE too, sealed or not.
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, QUERY, OPTIONS",
        // X-Client-Id rides on every tb-mobile REST call; without it here a
        // browser cancels the request after the preflight ("Failed to fetch").
        // The four envelope headers are what a sealed request sends instead of
        // Authorization — named from the envelope middleware, not retyped.
        "Access-Control-Allow-Headers": [
          "Authorization",
          "Content-Type",
          "If-None-Match",
          "X-Client-Id",
          HEADER_MARKER,
          HEADER_CTX,
          HEADER_SEQ,
          HEADER_ENVELOPE,
        ].join(", "),
        // A sealed response is recognised by its marker, and a bodiless one
        // (204/304) carries its record in X-TB-Env: a browser hides both
        // unless they are exposed, and the client then refuses the response.
        "Access-Control-Expose-Headers": [
          "ETag",
          "Accept-Query",
          HEADER_MARKER,
          HEADER_ENVELOPE,
        ].join(", "),
      };
      // Set on the raw ServerResponse too: many handlers write directly to
      // c.env.outgoing and return the ALREADY_HANDLED sentinel, so Hono never
      // pipes c.res.headers onto the actual response. writeHead() merges (does
      // not clear) setHeader()-set headers, so these survive the direct write.
      // A WebSocket upgrade has no ServerResponse: @hono/node-ws runs it through
      // the app with `outgoing: undefined`, and browsers always send Origin on
      // one, so an unguarded setHeader turned every browser socket into a 500.
      for (const [name, value] of Object.entries(headers)) {
        c.env.outgoing?.setHeader(name, value);
        c.res.headers.set(name, value);
      }
    }

    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, allowedOrigin ? 204 : 403);
    }

    await next();
  };
};
