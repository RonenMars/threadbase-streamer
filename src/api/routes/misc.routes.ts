import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { IncomingMessage } from "http";
import { hostname } from "os";
import { loadUpdateConfig } from "../../config/update-config";
import {
  DEFAULT_PUSH_TOKEN_KIND,
  isPushTokenKind,
  PUSH_TOKEN_KINDS,
} from "../../db/repositories/push.repository";
import { E2EE_PROTOCOL_VERSION } from "../../e2ee/protocol";
import type { FeatureFlagSource } from "../../feature-flags";
import { getLogger } from "../../logger";
import { serverIdentityPublicKey } from "../../server-identity";
import { describeMissingApnsCredentials } from "../../services/push/apnsClient";
import { getVersion } from "../../version";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

/**
 * Accept a finite timestamp, reject anything else.
 *
 * These arrive as JSON from a client, so a string, a NaN, or an Infinity is
 * reachable. Storing one would make a renewal deadline that never fires (or
 * fires immediately), so a bad value becomes "absent" rather than a poisoned
 * schedule.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function verifyWebhookSignature(body: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * What push this server can actually deliver.
 *
 * Reported on `GET /api/info` and `GET /api/push/health` so a client can hide an
 * affordance the server can never honour instead of registering tokens nothing
 * will ever send to. It cannot be inferred from `/api/push/health`'s `available`,
 * which reports whether the SQLite token store opened — that is `true` on a
 * server holding no APNs credentials at all.
 */
export interface PushCapability {
  /**
   * Live Activity (ActivityKit) push. True only when APNs credentials resolved
   * *and* the sender was wired, so it is the same fact the boot log reports as
   * `live_activity.enabled` / `live_activity.disabled`.
   */
  liveActivity: boolean;
  /**
   * Ordinary (non-Live-Activity) notifications. Always false: `expo-server-sdk`
   * is not a dependency and `PushRepository.listDeliverable()` has no caller, so
   * nothing sends them. Reported rather than omitted so a client cannot infer
   * that ordinary push works because Live Activity push happens to be configured.
   */
  notifications: boolean;
  /** Why `liveActivity` is false; absent when it is true. Names env vars, never values. */
  liveActivityReason?: string;
}

/**
 * Describe push capability for a client.
 *
 * `liveActivityEnabled` is the server's own wiring state rather than a re-read of
 * the environment: credentials alone are not enough, since the notifier is only
 * built when the push token store opened too.
 */
export function describePushCapability(
  liveActivityEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): PushCapability {
  if (liveActivityEnabled) return { liveActivity: true, notifications: false };
  return {
    liveActivity: false,
    notifications: false,
    // describeMissingApnsCredentials only explains a *credential* gap and
    // returns null once the credentials are complete — reachable here, because
    // an unavailable token store disables the feature with the key still set.
    liveActivityReason:
      describeMissingApnsCredentials(env) ??
      "APNs credentials are set but the push token store is unavailable, so Live Activity " +
        "push is disabled.",
  };
}

/**
 * Envelope version this build speaks. The same number the pair QR carries as `v`.
 *
 * @deprecated Re-exported from `src/e2ee/protocol.ts`, which is the canonical
 * home: the record layer needs this constant and a crypto module importing a
 * Hono route module would invert the dependency direction (NONCE-DESIGN §4).
 * The name stays here because released call sites and tests import it from this
 * module.
 */
export { E2EE_PROTOCOL_VERSION };

/**
 * Whether this build has the E2EE code path at all.
 *
 * Deliberately a constant rather than the `e2ee` feature flag. `supported` means
 * "this build speaks the envelope" (specs/end-to-end-encryption/design.md §6.2),
 * which is a property of the build; whether a given deployment offers it is the
 * flag's job, and `describeE2eeCapability` below requires both. Reporting the
 * flag here would let an operator who switches it on advertise a handshake the
 * build cannot perform — a client would offer to re-pair for encryption and then
 * fail, which is exactly the half-landed break this negotiation exists to remove.
 *
 * True since Phase 2 landed the handshake. Enabling it for a deployment is still
 * a separate, opt-in act: set `THREADBASE_FEATURE_E2EE=1`, `--feature e2ee=true`,
 * or `feature_flags:` in server.yaml.
 *
 * Typed `boolean` rather than inferred so the `&&` below stays a real branch
 * instead of narrowing to a constant.
 */
const E2EE_SUPPORTED: boolean = true;

/**
 * Whether a client should encrypt to this server, and why not when it should not.
 *
 * The contract is `push`'s: additive, and **absent means "older server,
 * unknown"** rather than "unsupported". A client reads `enabled` to decide
 * whether to attempt a handshake — never `supported` alone, which only says the
 * code path exists.
 *
 * `required` is the stage-3 bit (refuse plaintext from *any* client) and is
 * false until that is an explicit product decision. It is reported rather than
 * omitted because an absent field means "unknown", and "unknown" is the wrong
 * answer to a question this server can answer.
 */
export interface E2eeCapability {
  supported: boolean;
  enabled: boolean;
  version: number;
  required: boolean;
  /** Why `enabled` is false while `supported` is true; absent otherwise. */
  reason?: string;
}

export function describeE2eeCapability(
  flagEnabled: boolean,
  /**
   * Which rung of the precedence chain decided the flag, when the caller knows
   * it. An operator who typed `--no-e2ee` and reads "set --feature e2ee=true"
   * has been answered with the wrong question; naming the rung that actually
   * decided is the difference between a reason and a template.
   */
  flagSource?: FeatureFlagSource,
): E2eeCapability {
  const enabled = E2EE_SUPPORTED && flagEnabled;
  const base = {
    supported: E2EE_SUPPORTED,
    enabled,
    version: E2EE_PROTOCOL_VERSION,
    required: false,
  };
  if (enabled) return base;
  return {
    ...base,
    // Always says why, including when `supported` is false. An operator who set
    // the flag and saw nothing happen has exactly one question, and a field that
    // goes absent in the case they hit is the field not answering it.
    reason: E2EE_SUPPORTED ? disabledReason(flagSource) : NO_HANDSHAKE_REASON,
  };
}

const NO_HANDSHAKE_REASON =
  "this build carries the capability negotiation but not yet the handshake it gates";

/**
 * The switch that turned encryption off, in the operator's own terms — the
 * thing they typed or set, never the resolver's rung name. Shared by the boot
 * warning and `/api/info` so the two never describe one switch two ways.
 *
 * `cli` covers both spellings of one switch — `--no-e2ee` and
 * `--feature e2ee=false` land on the same rung. `override` is unreachable for
 * `e2ee` today (the only override rung is `codexSystemPromptEnabled`) but the
 * type demands an answer, and this one is at least true.
 */
export const E2EE_OFF_SWITCH: Record<Exclude<FeatureFlagSource, "default">, string> = {
  cli: "--no-e2ee (or --feature e2ee=false)",
  env: "the THREADBASE_FEATURE_E2EE environment variable",
  yaml: "feature_flags: in server.yaml",
  override: "an explicit server configuration override",
};

/**
 * Why encryption is off, in the operator's own terms — names the actual rung
 * that decided it rather than collapsing every non-`cli` source into one
 * generic line (D-8's resolution: the env var can't be hidden from the
 * resolver, so `/api/info` names it plainly instead). `cli` says "for this
 * run", because a CLI option cannot outlive the command that typed it; the
 * `default` rung keeps the original text, which names the ways to turn it on.
 */
function disabledReason(source?: FeatureFlagSource): string {
  if (source === "cli") return `disabled by ${E2EE_OFF_SWITCH.cli} for this run`;
  if (source !== undefined && source !== "default") return `disabled by ${E2EE_OFF_SWITCH[source]}`;
  return (
    "disabled by the e2ee feature flag — set THREADBASE_FEATURE_E2EE=1, --feature e2ee=true, " +
    "or feature_flags: in server.yaml"
  );
}

// One line per process, not one per request: `/api/info` is polled, and this
// module has a 261 MB unrotated-log precedent to respect (CLAUDE.md).
let identityKeyFailureLogged = false;

/**
 * This server's identity public key, or `undefined` when the key file cannot be
 * read — which `JSON.stringify` renders as an absent field, exactly what the
 * `/api/info` contract says absent means.
 *
 * Deliberately different from the CLI's answer to the same failure. `/api/info`
 * is how a client discovers capabilities and renders its server list, so a
 * corrupt key file must cost verification and nothing else; turning it into a
 * 500 would take down the whole endpoint over a file unrelated to the rest of
 * the response. The pair banner throws instead, because a QR that cannot carry
 * `spk` is a QR worth refusing to print — and `serve` already degrades that
 * into a warn plus a QR-less banner (`cli/index.ts`).
 */
export function describeServerIdentityKey(): string | undefined {
  try {
    return serverIdentityPublicKey();
  } catch (err) {
    if (!identityKeyFailureLogged) {
      identityKeyFailureLogged = true;
      // Safe to interpolate: every error this can throw carries the file path
      // and fixed text, never the file's contents.
      getLogger("identity").error(
        `Server identity key unavailable, so /api/info will omit it: ${err instanceof Error ? err.message : String(err)}`,
        { event: "identity.unavailable" },
      );
    }
    return undefined;
  }
}

const clientLog = getLogger("client");

type ClientLogEntry = {
  level?: "debug" | "info" | "warn" | "error";
  msg?: string;
  ts?: string;
  tag?: string;
  fields?: Record<string, unknown>;
};

export const createMiscRoutes = (
  deps: Pick<
    ApiDeps,
    | "publicUrl"
    | "sessionStore"
    | "ptyAttachedIds"
    | "rotateApiKey"
    | "localNoAuth"
    | "pushRepo"
    | "liveActivityPushEnabled"
    | "featureFlagsConfig"
  >,
) => {
  const app = new Hono<AppEnv>();

  app.get("/api/info", (c) => {
    const ptyIds = deps.ptyAttachedIds();
    return c.json({
      version: getVersion(),
      machineName: hostname(),
      platform: process.platform,
      activeSessions: deps.sessionStore.list(ptyIds).filter((s) => s.status === "running").length,
      publicUrl: deps.publicUrl,
      // Capability flag: this server serves /api/config/claude-flags. Additive —
      // older clients ignore it, and clients talking to an older server see it
      // absent and hide the UI rather than 404ing.
      claudeFlags: true,
      // Same contract: this server serves GET /api/config/feature-flags. Lives
      // here rather than behind /api/config (admin-only) so a read-only client
      // still learns the server supports flags even if it can't read values.
      featureFlags: true,
      // Same contract: this server serves GET /api/projects/summary, which the
      // Hub's grouped views need before they can draw a tree.
      projectSummary: true,
      // The paired-device registry lives in runtime.db, so it survives
      // `tb-streamer cache clear` and the integrity monitor's reset-and-rescan.
      // A client may only prefer its scoped device token over the shared API
      // key when this is true: on an older server the registry is inside
      // cache.db, where a documented troubleshooting step deletes it and every
      // device token with it. Absent means "old server, assume not durable".
      devicesDurable: true,
      // Delivery capability, not endpoint support: whether this server can
      // actually send a push, so mobile can hide an affordance instead of
      // registering tokens nothing will ever send to. Absent on older servers,
      // which a client should read as "unknown", not "unavailable".
      push: describePushCapability(deps.liveActivityPushEnabled()),
      // This server's long-term X25519 public key, base64url. The same value the
      // pair QR carries as `spk`, served here so an already-paired client can
      // learn it without re-scanning. Additive: absent means a server with no
      // readable identity key, which a client must read as "cannot verify this
      // server" — never as a reason to fail the rest of this response.
      serverIdentityKey: describeServerIdentityKey(),
      // Whether to encrypt to this server. Additive, same contract as `push`:
      // absent means an older server, which a client must read as "unknown" and
      // resolve as today's plaintext path — never as a reason to fail.
      e2ee: describeE2eeCapability(
        deps.featureFlagsConfig().values.e2ee,
        deps.featureFlagsConfig().sources.e2ee,
      ),
      // This build samples cheap host signals and pushes `host_pressure` when
      // the box is starved. Additive capability flag only — live readings stay
      // off this polled endpoint. Absent means an older server that never
      // samples. Informational: pressure never holds, kills, or refuses sessions.
      hostPressure: true,
      // Provider-neutral prompt contract: normalized prompt events, opaque ids
      // and the atomic /prompt/answer route. A prompt_snapshot on subscribe
      // carries RETAINED prompts, terminal ones included — render on `state`,
      // not on presence — and an answer retry after that retention window is
      // answered 404 prompt_not_found rather than the recorded outcome.
      promptContract: { schemaVersion: 1, atomicAnswer: true },
    });
  });

  app.get("/api/profiles", (c) => c.json([]));

  app.post("/api/auth/rotate", (c) => {
    // Block rotation when localNoAuth is on — any localhost process could
    // call this and lock out the legitimate owner.
    if (deps.localNoAuth) {
      return c.json({ error: "key rotation is disabled while localNoAuth is active" }, 403);
    }
    const { newKey, persisted } = deps.rotateApiKey();
    return c.json({
      apiKey: newKey,
      persisted,
      ...(persisted
        ? {}
        : {
            warning:
              "Key rotated in memory only. The server was started with --api-key, so the " +
              "old key will be restored on restart. Remove --api-key and let the server " +
              "manage the key via ~/.threadbase/server.yaml for rotation to survive restarts.",
          }),
    });
  });

  // Push registration (C7). This was a no-op returning { ok: true }: mobile
  // registered, got success, and nothing was stored — so no notification could
  // ever be delivered and no failure could be observed. The client had no way
  // to discover that its "successful" registration meant nothing.
  app.post("/api/push/register", async (c) => {
    // Read the raw Node request like the sibling routes do — Hono's c.req.json()
    // does not see a body on this server's request plumbing.
    const body = (await readJsonBody(c.env.incoming).catch(() => null)) as {
      token?: unknown;
      platform?: unknown;
      deviceId?: unknown;
      kind?: unknown;
      activityId?: unknown;
      sessionId?: unknown;
      expiresAt?: unknown;
      staleDate?: unknown;
      startedAt?: unknown;
    } | null;
    const token = body?.token;
    const platform = body?.platform;

    if (typeof token !== "string" || token.length === 0) {
      return c.json({ error: "Missing token" }, 400);
    }
    if (platform !== "ios" && platform !== "android") {
      return c.json({ error: "platform must be 'ios' or 'android'" }, 400);
    }

    // Omitted kind means a client that predates Live Activities, which can only
    // be registering an Expo relay token. Released clients cannot be
    // force-updated, so this default is what keeps them working.
    const kind = body?.kind === undefined ? DEFAULT_PUSH_TOKEN_KIND : body.kind;
    if (!isPushTokenKind(kind)) {
      // Reject rather than silently coercing to Expo: an ActivityKit token
      // stored as Expo is rejected by the relay at send time with nothing at
      // registration time to explain why.
      return c.json(
        { error: `kind must be one of ${PUSH_TOKEN_KINDS.join(", ")}`, code: "INVALID_KIND" },
        400,
      );
    }
    // A per-activity token without its activity id cannot be targeted for an
    // update or an end, so it would be stored and never usable.
    if (kind === "liveactivity_update" && typeof body?.activityId !== "string") {
      return c.json(
        {
          error: "activityId is required for kind 'liveactivity_update'",
          code: "MISSING_ACTIVITY",
        },
        400,
      );
    }

    const repo = deps.pushRepo();
    if (!repo) {
      // Report honestly rather than claiming success we cannot back — the exact
      // failure mode this endpoint used to have.
      return c.json({ error: "Push registration is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }

    repo.register({
      token,
      platform,
      deviceId: typeof body?.deviceId === "string" ? body.deviceId : null,
      kind,
      activityId: typeof body?.activityId === "string" ? body.activityId : null,
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : null,
      expiresAt: numberOrNull(body?.expiresAt),
      staleDate: numberOrNull(body?.staleDate),
      startedAt: numberOrNull(body?.startedAt),
    });
    return c.json({ ok: true });
  });

  // Delivery health for every registered token. Never echoes a token back — it
  // is a delivery credential, and this endpoint exists to explain state, not to
  // hand out secrets.
  app.get("/api/push/health", (c) => {
    // `available` keeps its original meaning — "the token store opened" — because
    // released mobile builds render it verbatim as "Push store is available /
    // unavailable (registration cannot persist)". Retargeting it at credentials
    // would make every credential-less server tell users their registrations do
    // not persist, which is false. Credential state is the additive `push` object.
    const push = describePushCapability(deps.liveActivityPushEnabled());
    const repo = deps.pushRepo();
    if (!repo) return c.json({ tokens: [], available: false, push });
    return c.json({ tokens: repo.listHealth(), available: true, push });
  });

  // Webhook for auto-update. Triggered by the release CI (or any caller that
  // knows webhook_secret) to make this server pull the new release without
  // waiting for the next poll. Enabled only when webhook_secret is set in
  // ~/.threadbase/update.yaml. HMAC-SHA256 of the raw body using that secret
  // must match the X-Threadbase-Signature header.
  app.post("/api/__update", async (c) => {
    const cfg = loadUpdateConfig();
    if (!cfg?.webhook_secret) {
      return c.json({ error: "webhook disabled" }, 404);
    }

    let body: string;
    try {
      body = await readRawBody(c.env.incoming);
    } catch {
      return c.json({ error: "could not read body" }, 400);
    }

    const sig = c.req.header("x-threadbase-signature");
    if (!verifyWebhookSignature(body, sig, cfg.webhook_secret)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const cliPath = process.argv[1];
    if (!cliPath) {
      return c.json({ error: "cannot resolve updater path" }, 500);
    }
    const child = spawn(process.execPath, [cliPath, "update", "--force"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return c.json({ accepted: true, pid: child.pid }, 202);
  });

  app.post("/api/__client-log", async (c) => {
    const ua = c.req.header("user-agent") ?? "";
    let body: { entries?: ClientLogEntry[] } = {};
    try {
      body = (await readJsonBody(c.env.incoming)) as { entries?: ClientLogEntry[] };
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    const entries = Array.isArray(body.entries) ? body.entries : [];
    for (const e of entries) {
      const level =
        e.level === "debug" || e.level === "warn" || e.level === "error" ? e.level : "info";
      clientLog[level](`[client] ${e.tag ?? "log"}: ${e.msg ?? ""}`, {
        clientTs: e.ts,
        tag: e.tag,
        ua,
        ...(e.fields ?? {}),
      });
    }
    return c.json({ ok: true, accepted: entries.length });
  });

  return app;
};
