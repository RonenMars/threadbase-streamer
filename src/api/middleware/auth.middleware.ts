import type { MiddlewareHandler } from "hono";
import { validateApiKey } from "../../auth";
import { parseCapabilities } from "../../db/repositories/devices.repository";
import {
  hasCapability,
  legacyPrincipal,
  type Principal,
  requiredCapability,
} from "../../services/security/capabilities";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

function isLocalRequest(remoteAddr: string | undefined): boolean {
  const addr = remoteAddr ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const PUBLIC_PATHS = new Set(["/healthz"]);
// Localhost-only unauthenticated paths (menubar logs viewer).
const LOCAL_ONLY_PATHS = new Set(["/api/logs", "/api/logs/meta"]);
// /api/__update uses HMAC signature auth instead of Bearer; skip the
// Bearer-token middleware so the route handler can validate the signature.
const PUBLIC_POST_PATHS = new Set(["/api/pair/exchange", "/api/__update"]);
// /internal/sessions/:sessionId/progress also uses HMAC (Progress webhook),
// and the sessionId is dynamic so we match by prefix.
const PUBLIC_POST_PREFIXES = ["/internal/sessions/"];

export const authMiddleware =
  (deps: Pick<ApiDeps, "apiKey" | "localNoAuth" | "devicesRepo">): MiddlewareHandler<AppEnv> =>
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

    const remoteAddr = c.env.incoming?.socket?.remoteAddress;
    if (LOCAL_ONLY_PATHS.has(path) && isLocalRequest(remoteAddr)) {
      await next();
      return;
    }

    if (deps.localNoAuth) {
      if (isLocalRequest(remoteAddr)) {
        await next();
        return;
      }
    }

    const authorization = c.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const queryKey = c.req.query("key") ?? undefined;
    const presented = bearer ?? queryKey;

    if (!presented) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Resolve the caller to a principal (C5).
    //
    // Device tokens are tried FIRST so a device credential is never mistaken
    // for the shared key, then the shared key falls back to a `legacy`
    // principal holding the full preset. Keeping the shared key working is what
    // lets this ship without breaking every already-paired device.
    let principal: Principal | null = null;

    const device = deps.devicesRepo()?.authenticate(presented) ?? null;
    if (device) {
      principal = {
        kind: "device",
        deviceId: device.device_id,
        capabilities: parseCapabilities(device.capabilities),
      };
      // Best-effort liveness stamp; a failure here must not deny a valid request.
      try {
        deps.devicesRepo()?.touch(device.device_id);
      } catch {
        // ignore
      }
    } else if (validateApiKey(presented, deps.apiKey)) {
      principal = legacyPrincipal();
    }

    if (!principal) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Capability check.
    const required = requiredCapability(path, method);
    if (required === null) {
      // Authenticated but unclassified. Fall through to the router rather than
      // denying: an unknown path must still 404, because answering 403 would
      // tell an authenticated caller that a route it cannot name might exist.
      //
      // This is NOT a hole — every mounted /api route is classified, and a test
      // asserts that. A genuinely new route added without a mapping reaches its
      // handler, so the fail-closed guarantee lives in that test rather than in
      // a runtime deny that would break 404s.
      await next();
      return;
    }
    if (!hasCapability(principal, required)) {
      return c.json({ error: "Forbidden", code: "MISSING_CAPABILITY", required }, 403);
    }

    c.set("principal", principal);
    await next();
  };
