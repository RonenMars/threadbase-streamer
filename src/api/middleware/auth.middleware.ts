import type { MiddlewareHandler } from "hono";
import { validateApiKey } from "../../auth";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

function isLocalRequest(remoteAddr: string | undefined): boolean {
  const addr = remoteAddr ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const PUBLIC_PATHS = new Set(["/healthz"]);
// /api/__update uses HMAC signature auth instead of Bearer; skip the
// Bearer-token middleware so the route handler can validate the signature.
const PUBLIC_POST_PATHS = new Set(["/api/pair/exchange", "/api/__update"]);
// /internal/sessions/:sessionId/progress also uses HMAC (Progress webhook),
// and the sessionId is dynamic so we match by prefix.
const PUBLIC_POST_PREFIXES = ["/internal/sessions/"];

export const authMiddleware =
  (deps: Pick<ApiDeps, "apiKey" | "localNoAuth">): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    const isPublicPostPath =
      method === "POST" &&
      (PUBLIC_POST_PATHS.has(path) || PUBLIC_POST_PREFIXES.some((p) => path.startsWith(p)));
    if (PUBLIC_PATHS.has(path) || isPublicPostPath) {
      await next();
      return;
    }

    if (deps.localNoAuth) {
      const remoteAddr = c.env.incoming?.socket?.remoteAddress;
      if (isLocalRequest(remoteAddr)) {
        await next();
        return;
      }
    }

    const authorization = c.req.header("authorization");
    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      if (validateApiKey(token, deps.apiKey)) {
        await next();
        return;
      }
    }

    const key = c.req.query("key");
    if (key && validateApiKey(key, deps.apiKey)) {
      await next();
      return;
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
