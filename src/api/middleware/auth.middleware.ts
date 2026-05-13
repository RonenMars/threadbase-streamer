import type { MiddlewareHandler } from "hono";
import { validateApiKey } from "../../auth";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

function isLocalRequest(remoteAddr: string | undefined): boolean {
  const addr = remoteAddr ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const PUBLIC_PATHS = new Set(["/healthz"]);
const PUBLIC_POST_PATHS = new Set(["/api/pair/exchange"]);

export const authMiddleware =
  (deps: Pick<ApiDeps, "apiKey" | "localNoAuth">): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    if (PUBLIC_PATHS.has(path) || (method === "POST" && PUBLIC_POST_PATHS.has(path))) {
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
