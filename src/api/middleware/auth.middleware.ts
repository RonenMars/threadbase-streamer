import type { MiddlewareHandler } from "hono";
import { validateApiKey } from "../../auth";
import { parseCapabilities } from "../../db/repositories/devices.repository";
import { authenticateContext, contextRegistry, TICKET_HEADER } from "../../e2ee/context";
import { E2EE_DEVICE_REVOKED } from "../../e2ee/protocol";
import { getLogger } from "../../logger";
import {
  hasCapability,
  legacyPrincipal,
  type Principal,
  requiredCapability,
} from "../../services/security/capabilities";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const log = getLogger("e2ee");

/** The one path a WebSocket ticket authenticates. */
const WS_PATH = "/ws";

function isLocalRequest(remoteAddr: string | undefined): boolean {
  const addr = remoteAddr ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const PUBLIC_PATHS = new Set(["/healthz"]);
// Localhost-only unauthenticated paths (menubar logs viewer).
const LOCAL_ONLY_PATHS = new Set(["/api/logs", "/api/logs/meta"]);
// /api/__update uses HMAC signature auth instead of Bearer; skip the
// Bearer-token middleware so the route handler can validate the signature.
// /api/e2ee/open is public for the same reason /api/pair/exchange is: the
// handshake IS the authentication, and the credential the middleware would look
// for only exists inside it (design.md §3.5, NONCE-DESIGN §10).
const PUBLIC_POST_PATHS = new Set(["/api/pair/exchange", "/api/__update", "/api/e2ee/open"]);
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

    // `--local-no-auth` gives any loopback caller the owner's authority. It used
    // to grant that by returning next() right here — before the capability check
    // below and before c.set("principal") — so the capability layer saw no
    // principal at all, and the WebSocket guard took its null-principal path
    // instead of an authorization decision. Resolving the caller to the owner
    // principal leaves the access identical and puts it through the same checks
    // as every other caller.
    const loopbackOwner = deps.localNoAuth && isLocalRequest(remoteAddr);

    const authorization = c.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const queryKey = c.req.query("key") ?? undefined;
    const presented = bearer ?? queryKey;

    // ─── A ticketed WebSocket upgrade authenticates by its ticket ───────
    //
    // NONCE-DESIGN §13: **no `Authorization` travels on a ticketed upgrade.**
    // The ticket came out of a Noise handshake against the device's own static
    // key and resolves to a context that names the device, so the long-term
    // credential has nothing left to prove — and sending it anyway would put a
    // device token on the wire on every reconnect, which is the exact leak the
    // sealed-credential ordering exists to close.
    //
    // **The consume is a synchronous map delete with no `await` in front of
    // it** (§14). Nothing above this line awaits, and `consumeTicket` reads and
    // deletes in one uninterrupted turn — so two concurrent upgrades presenting
    // one ticket cannot both see it, whatever order Node runs them in.
    //
    // A ticket that does not resolve — spent, expired, or lost to a restart —
    // is terminal for THIS upgrade. Falling through to a bearer or `?key=`
    // would turn a failed sealed attempt into a legacy plaintext socket. The
    // client recovers by opening a new context and ticket.
    // Mirror @hono/node-ws's upgrade predicate exactly: looser spends a ticket
    // without a socket; stricter can downgrade an upgrade to legacy auth.
    const isWsUpgrade =
      method === "GET" &&
      path === WS_PATH &&
      c.req.header("upgrade")?.toLowerCase() === "websocket";
    const ticket = isWsUpgrade ? c.req.header(TICKET_HEADER) : undefined;
    if (ticket !== undefined) {
      const registry = contextRegistry();
      const ctxId = registry.consumeTicket(ticket);
      const context = ctxId ? registry.get(ctxId) : null;
      if (!context) return c.json({ error: "Unauthorized" }, 401);
      // The shared tail, in `context.ts` because the REST unseal middleware
      // runs exactly the same decision off `X-TB-Ctx`: device row, per-request
      // `revoked_at`, credential-must-name-the-same-device, principal built
      // from the CONTEXT. The helper returns a pure verdict; each caller maps
      // the reason to its own response and applies the permitted lifecycle
      // effect.
      const auth = authenticateContext({
        context,
        devicesRepo: deps.devicesRepo(),
        presented,
      });
      if (!auth.ok) {
        // **Mapping the verdict to an answer is the CALLER's job**, which is
        // why the helper returns a `reason` and no status: the REST
        // middleware maps the same three onto HTTP, this maps them onto an
        // upgrade refusal, and neither imposes its policy on the other.
        //
        // **Destroy only on the unforgeable trigger.** `revoked_at` (and a
        // missing row) is a fact in our own database; a mismatched credential
        // is a header an attacker chose, and destroying on it turns the
        // safeguard into the weapon — on the REST channel `ctxId` travels in
        // a plaintext header, so anyone on path could forge a credential
        // beside an observed id and kill that device's context on repeat.
        //
        // Destroying here on a mismatch would in fact be harmless, since this
        // ticket is already spent and there is no second attempt to deny. It
        // is still not done, for SYMMETRY with the REST caller: a helper
        // whose two consumers apply different effects to one verdict is how
        // the dangerous behaviour gets copied from the harmless one later.
        if (auth.reason === "device-revoked") registry.destroy(context.ctxId);
        log.warn("[e2ee] upgrade refused by context authentication", {
          event: "e2ee.upgrade_refused",
          reason: auth.reason,
        });
        if (auth.reason === "device-revoked") {
          return c.json({ error: "This device is not paired", code: E2EE_DEVICE_REVOKED }, 403);
        }
        if (auth.reason === "no-device-store") {
          // Transient, and deliberately NOT `E2EE_DEVICE_REVOKED`: §9 defines
          // that code as a hard failure the client must never retry, and a
          // registry that could not be read says nothing about the pairing.
          // Same shape `/api/devices` already uses when its repo is missing.
          return c.json(
            { error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" },
            503,
          );
        }
        return c.json({ error: "Unauthorized" }, 401);
      }

      c.set("e2eeContext", context);
      // A ticket AUTHENTICATES; it does not authorize. The capability check is
      // the same one every other caller passes.
      const required = requiredCapability(path, method);
      if (required !== null && !hasCapability(auth.principal, required)) {
        // **Destroy the context this refusal orphans.** `consumeTicket`
        // already spent the ticket AND called `markUsed`, which promotes the
        // context out of provisional and moves its deadline from the 30 s
        // ticket TTL to the full 24 h lifetime. Refusing without destroying
        // therefore leaves a context nobody can ever attach to — the ticket is
        // gone — sitting for a day and counting against the device's cap,
        // which is the opposite of what promoting it was for.
        //
        // Safe on this channel: the trigger is our own capability table, not
        // a header an attacker chose, and the ticket is already spent so
        // there is no second attempt to deny.
        registry.destroy(context.ctxId);
        return c.json({ error: "Forbidden", code: "MISSING_CAPABILITY", required }, 403);
      }
      try {
        deps.devicesRepo()?.touch(auth.principal.deviceId);
      } catch {
        // A liveness stamp must never deny a valid upgrade.
      }
      c.set("principal", auth.principal);
      await next();
      return;
    }

    if (!presented && !loopbackOwner) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Resolve the caller to a principal (C5).
    //
    // Device tokens are tried FIRST so a device credential is never mistaken
    // for the shared key, then the shared key falls back to a `legacy`
    // principal holding the full preset. Keeping the shared key working is what
    // lets this ship without breaking every already-paired device.
    let principal: Principal | null = null;

    const device = presented ? (deps.devicesRepo()?.authenticate(presented) ?? null) : null;
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
    } else if (presented && validateApiKey(presented, deps.apiKey)) {
      principal = legacyPrincipal();
    } else if (loopbackOwner) {
      // No credential needed from loopback under the flag — and a wrong one does
      // not demote it either, which is what the old unconditional bypass did.
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
