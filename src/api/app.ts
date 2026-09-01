import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { ServerResponse } from "http";
import type { WebSocket } from "ws";
import type { E2eeContext } from "../e2ee/context";
import { getLogger } from "../logger";
import type { Principal } from "../services/security/capabilities";
import { authMiddleware } from "./middleware/auth.middleware";
import { corsMiddleware } from "./middleware/cors.middleware";
import { e2eeEnvelopeMiddleware } from "./middleware/e2ee-envelope.middleware";
import { errorMiddleware } from "./middleware/error.middleware";
import { createBackupRoutes } from "./routes/backup.routes";
import { createBrowseRoutes } from "./routes/browse.routes";
import { createCacheAlertRoutes } from "./routes/cacheAlert.routes";
import { createConfigRoutes } from "./routes/config.routes";
import { createConversationRoutes } from "./routes/conversations.routes";
import { createDeviceRoutes } from "./routes/devices.routes";
import { createDiagnosticsRoutes } from "./routes/diagnostics.routes";
import { createE2eeRoutes } from "./routes/e2ee.routes";
import { createHealthRoutes } from "./routes/health.routes";
import { createLogsRoutes } from "./routes/logs.routes";
import { createMiscRoutes } from "./routes/misc.routes";
import { createPairRoutes } from "./routes/pair.routes";
import { createProgressRoutes } from "./routes/progress.routes";
import { createProjectRoutes } from "./routes/projects.routes";
import { createProviderRoutes } from "./routes/providers.routes";
import { createScannerRoutes } from "./routes/scanner.routes";
import { createSessionRoutes } from "./routes/sessions.routes";
import { createWsRoutes } from "./routes/ws.routes";
import type { ApiDeps } from "./types/api-deps";

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: {
    requestId?: string;
    validatedBody?: unknown;
    validatedQuery?: unknown;
    /** Who is making this request (C5). Set by authMiddleware. */
    principal?: Principal;
    /**
     * The E2EE context this request authenticated under, if any.
     *
     * **ONE declaration, deliberately, for two setters.** W1b's `/ws` upgrade
     * and X-server's REST unseal both need this field, and both branches added
     * it independently; two declarations of the same optional key merge in
     * TypeScript and compile, right up until the two comments disagree about
     * what the field means. Set by `authMiddleware` when a `/ws` upgrade
     * presents a live ticket and read by the WebSocket route; set by
     * `e2eeEnvelopeMiddleware` when a REST request unseals under `X-TB-Ctx`.
     *
     * It is here rather than in a module-level map because the setter and the
     * reader are separated by an `await` — a shared variable would let two
     * concurrent upgrades swap contexts.
     *
     * Absent on every plaintext request, which is what `refuseUnsealedIfPinned`
     * reads as "this request was not sealed".
     */
    e2eeContext?: E2eeContext;
  };
};

/** Routes that write to `c.env.outgoing` themselves return this sentinel. */
const ALREADY_HANDLED = 597;

/**
 * Query parameters whose value is reduced REGARDLESS of its shape.
 *
 * The numeric rule below is a heuristic — it keeps pagination readable — and a
 * heuristic is the wrong thing to protect a credential with. `?ticket=` was
 * covered only by the accident that a base64url ticket is essentially never all
 * digits, and "essentially never" is exactly the probability-instead-of-
 * invariant argument the nonce design rejects (NONCE-DESIGN §10):
 *
 *     summarizeQuery({ ticket: "Xk9_2bQz-aR4" })   →  ticket=_
 *     summarizeQuery({ ticket: "84719203847192" })  →  ticket=84719203847192
 *
 * Listing the keys instead protects `?key=` and every future secret-bearing
 * parameter rather than one generator's alphabet. Matched case-insensitively so
 * a `?apiKey=` cannot slip past on capitalisation.
 */
const SENSITIVE_QUERY_KEYS = new Set(["ticket", "key", "token", "apikey", "api_key"]);

/**
 * The query string with only its numeric values kept.
 *
 * Pagination is the thing the log needs to show (`limit`, `offset`,
 * `before_index`, `msg_limit`), and those are numbers. Everything else —
 * `?path=/Users/...`, ids, search terms — is a value we deliberately do not
 * log, so the key is kept and the value is dropped. Returns undefined for a
 * bare path so the field stays absent rather than empty.
 *
 * Deliberately NOT blanket numeric redaction: `limit=50` must keep logging its
 * value, or the fix costs the diagnostics this field exists for.
 */
export function summarizeQuery(query: Record<string, string>): string | undefined {
  const keys = Object.keys(query).sort();
  if (keys.length === 0) return undefined;
  return keys
    .map((k) => {
      const keep = !SENSITIVE_QUERY_KEYS.has(k.toLowerCase()) && /^-?\d+$/.test(query[k]);
      return `${k}=${keep ? query[k] : "_"}`;
    })
    .join("&");
}

/**
 * Count the bytes a handler writes straight to the Node response.
 *
 * There is no Content-Length to read: the direct-write handlers stream JSON
 * into `c.env.outgoing` and Node uses chunked encoding. Patching write/end for
 * the life of the request is the only place the size is observable.
 */
function countResponseBytes(res: ServerResponse): () => number {
  let bytes = 0;
  const add = (chunk: unknown) => {
    if (typeof chunk === "string") bytes += Buffer.byteLength(chunk);
    else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
  };
  const write = res.write as (...args: unknown[]) => boolean;
  const end = res.end as (...args: unknown[]) => ServerResponse;
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    add(args[0]);
    return write.apply(this, args);
  } as typeof res.write;
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    add(args[0]);
    return end.apply(this, args);
  } as typeof res.end;
  return () => bytes;
}

export const createHonoApp = (deps: ApiDeps, upgradeWebSocket?: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();
  const httpLog = getLogger("http");

  app.use("*", async (c, next) => {
    const start = Date.now();
    const ua = c.req.header("user-agent") ?? "";
    // Absent only when the app is driven by Hono's test client rather than
    // served over Node; the request must still be logged, minus the size.
    const outgoing = c.env?.outgoing as ServerResponse | undefined;
    const bytesWritten = outgoing && countResponseBytes(outgoing);
    await next();
    if (!deps.logMenubarRequests && c.req.header("x-client") === "menubar") return;
    const ms = Date.now() - start;
    // A direct-write route's Hono status is the 597 sentinel, not the status
    // the client got — which is why 96% of these lines used to read `→ 597`.
    // The real one is on the Node response the handler wrote to.
    const handled = c.res.status === ALREADY_HANDLED && outgoing !== undefined;
    const status = handled ? (outgoing as ServerResponse).statusCode : c.res.status;
    const qs = summarizeQuery(c.req.query());
    // Only the direct-write path has finished writing by now; a Hono-piped
    // response is serialized after this middleware returns, so its size is not
    // knowable here. Omit the field rather than log a confident 0.
    const bytes = handled && bytesWritten ? bytesWritten() : undefined;
    httpLog.info(`[req] ${c.req.method} ${c.req.path} → ${status} ${ms}ms`, {
      method: c.req.method,
      path: c.req.path,
      status,
      ms,
      ua,
      ...(qs ? { qs } : {}),
      ...(bytes === undefined ? {} : { bytes }),
      event: "http.request",
    });
  });
  app.use("*", corsMiddleware(deps.browserCors));
  // AFTER cors, BEFORE auth. A preflight must be answerable without a context,
  // and D-9 puts the unseal ahead of authentication so the credential travels
  // sealed rather than in a plaintext header on every request.
  app.use("*", e2eeEnvelopeMiddleware(deps));
  app.use("*", authMiddleware(deps));
  app.onError(errorMiddleware);

  app.route("/healthz", createHealthRoutes(deps));
  app.route("/api/diagnostics", createDiagnosticsRoutes(deps));
  app.route("/", createMiscRoutes(deps));
  app.route("/api/sessions", createSessionRoutes(deps));
  app.route("/api/conversations", createConversationRoutes(deps));
  app.route("/api/cache/alert", createCacheAlertRoutes(deps));
  app.route("/api/config", createConfigRoutes(deps));
  app.route("/api/projects", createProjectRoutes(deps));
  app.route("/api/providers", createProviderRoutes());
  app.route("/api/devices", createDeviceRoutes(deps));
  app.route("/api/backup", createBackupRoutes(deps));
  app.route("/api/pair", createPairRoutes(deps));
  app.route("/api/e2ee", createE2eeRoutes(deps));
  app.route("/api", createBrowseRoutes(deps));
  app.route("/", createScannerRoutes(deps));
  app.route("/internal", createProgressRoutes(deps));
  app.route("/api/logs", createLogsRoutes());

  if (upgradeWebSocket) {
    app.route("/", createWsRoutes(deps, upgradeWebSocket));
  }

  return app;
};
