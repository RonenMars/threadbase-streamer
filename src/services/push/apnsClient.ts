import { createSign } from "node:crypto";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import { getLogger } from "../../logger";

/**
 * Direct APNs sender for ActivityKit Live Activities.
 *
 * ActivityKit cannot go through Expo's push relay: Live Activity updates need a
 * different token type, a `.push-type.liveactivity` topic, and a p8 signing
 * credential. That rules out `expo-server-sdk` and any relay, so this speaks
 * HTTP/2 to APNs directly.
 *
 * Built on `node:http2` and `node:crypto` rather than an APNs SDK — the whole
 * protocol surface used here is one POST with five headers and an ES256 JWT, and
 * a dependency for that would be larger than the code it replaced.
 *
 * Credentials come from the environment only. The signing key is PEM material in
 * `APNS_KEY` (the operator supplies it from 1Password), never a path on disk and
 * never written to a temp file. Neither the key nor any device token is logged.
 */

const log = getLogger("apns");

/** Sandbox default: the app's `aps-environment` is still `development`. */
export const APNS_HOST_SANDBOX = "api.sandbox.push.apple.com";
export const APNS_HOST_PRODUCTION = "api.push.apple.com";

/**
 * APNs rejects a payload over 4 KB.
 *
 * Checked before sending rather than after a rejection, so an oversized payload
 * is a diagnosable local error instead of an opaque 413 from Apple.
 */
export const APNS_MAX_PAYLOAD_BYTES = 4096;

/**
 * JWT lifetime. Apple rejects a token older than 1 hour, and reusing one is
 * expected — minting per request would be wasteful and can trip APNs' own
 * "too many provider token updates" throttle.
 */
const JWT_TTL_SECONDS = 3000;

export interface ApnsCredentials {
  /** p8 PEM contents. Never a filesystem path. */
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  host: string;
}

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  /** APNs `reason`, e.g. `BadDeviceToken` / `ExpiredToken`. */
  reason?: string;
  /**
   * True when APNs says this token will never work again. The caller must stop
   * using it rather than retrying — retrying a dead token fails forever and
   * makes the health report read "failing" instead of "this device is gone".
   */
  tokenDead: boolean;
}

/**
 * APNs reasons meaning the token is permanently unusable.
 *
 * Distinguished from transient failures (503, timeouts) because the two need
 * opposite handling: a dead token must be retired, a transient one must not be.
 */
const DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
  "ExpiredToken",
]);

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Read APNs credentials from the environment.
 *
 * Returns null when `APNS_KEY` is absent, which is the normal case for a
 * developer machine and for CI. Callers treat null as "Live Activity push is
 * off" and skip sending — the server must not fail to boot because an optional
 * push credential is missing.
 *
 * Non-secret identifiers have defaults (key id BX4B6855WV, team GUW6BN8X57,
 * bundle com.ronenmars.threadbase). The key itself never does.
 */
export function readApnsCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApnsCredentials | null {
  const key = env.APNS_KEY;
  if (!key || key.trim().length === 0) return null;

  const keyId = env.APNS_KEY_ID ?? "BX4B6855WV";
  const teamId = env.APNS_TEAM_ID ?? "GUW6BN8X57";
  const bundleId = env.APNS_BUNDLE_ID ?? "com.ronenmars.threadbase";
  const host = env.APNS_HOST ?? APNS_HOST_SANDBOX;

  return { key, keyId, teamId, bundleId, host };
}

/**
 * Why Live Activity push is unavailable, as a message safe to log.
 *
 * Says which variable is missing and nothing about its value, so a boot log can
 * explain the feature being off without becoming a place secrets leak.
 */
export function describeMissingApnsCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.APNS_KEY && env.APNS_KEY.trim().length > 0) return null;
  return (
    "APNS_KEY is not set, so Live Activity push is disabled. " +
    "Set it to the p8 key contents (not a path) to enable it."
  );
}

export class ApnsClient {
  private session: ClientHttp2Session | null = null;
  private cachedJwt: { token: string; expiresAt: number } | null = null;

  constructor(private readonly creds: ApnsCredentials) {}

  /**
   * The `apns-topic` for Live Activity pushes.
   *
   * The `.push-type.liveactivity` suffix is mandatory and is why the signing key
   * must be Team Scoped (All Topics) — a key scoped to the bundle id alone
   * cannot sign this topic.
   */
  get topic(): string {
    return `${this.creds.bundleId}.push-type.liveactivity`;
  }

  /**
   * Mint or reuse the provider JWT.
   *
   * ES256 over the p8 key. Cached until shortly before expiry: Apple rejects a
   * token older than an hour, but minting one per request is wasteful and can
   * trip APNs' provider-token-update throttle.
   */
  private getJwt(now: number = Date.now()): string {
    const nowSeconds = Math.floor(now / 1000);
    if (this.cachedJwt && this.cachedJwt.expiresAt > nowSeconds + 60) {
      return this.cachedJwt.token;
    }

    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.creds.keyId, typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iss: this.creds.teamId, iat: nowSeconds }));
    const signingInput = `${header}.${payload}`;

    // dsaEncoding: "ieee-p1363" produces the raw r||s form JWS requires. Node's
    // default is DER, which APNs rejects as an invalid token — and the error
    // ("InvalidProviderToken") does not hint at the encoding.
    const signature = createSign("SHA256")
      .update(signingInput)
      .sign({ key: this.creds.key, dsaEncoding: "ieee-p1363" });

    const token = `${signingInput}.${base64url(signature)}`;
    this.cachedJwt = { token, expiresAt: nowSeconds + JWT_TTL_SECONDS };
    return token;
  }

  /**
   * Reuse one HTTP/2 session across sends.
   *
   * APNs expects a long-lived connection; a fresh TLS handshake per push is slow
   * and Apple treats connection churn as abuse.
   */
  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = connect(`https://${this.creds.host}`);
    // A connection-level error must not reach the process as an unhandled
    // 'error' event, which would take the server down over a push failure.
    session.on("error", (err) => {
      log.warn("apns.session_error", { event: "apns.session_error", err: String(err) });
    });
    this.session = session;
    return session;
  }

  /**
   * Send one push.
   *
   * Resolves with a result rather than rejecting on an APNs rejection: a
   * rejected push is an expected outcome the caller must act on (retire the
   * token), not an exception. Only a genuinely unexpected local failure throws,
   * and the caller logs it.
   */
  async send(args: {
    deviceToken: string;
    payload: unknown;
    /** 10 for a user-visible change, 5 to let iOS batch. */
    priority?: 5 | 10;
    /** Seconds since epoch after which APNs stops trying. */
    expirationSeconds?: number;
    timeoutMs?: number;
  }): Promise<ApnsSendResult> {
    const body = Buffer.from(JSON.stringify(args.payload), "utf-8");
    if (body.byteLength > APNS_MAX_PAYLOAD_BYTES) {
      // Fail locally with a diagnosable message instead of shipping a payload
      // Apple will reject with a bare 413.
      throw new Error(
        `APNs payload is ${body.byteLength} bytes, over the ${APNS_MAX_PAYLOAD_BYTES} byte limit`,
      );
    }

    const session = this.getSession();
    const headers = {
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${args.deviceToken}`,
      [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.getJwt()}`,
      "apns-push-type": "liveactivity",
      "apns-topic": this.topic,
      "apns-priority": String(args.priority ?? 10),
      ...(args.expirationSeconds != null && {
        "apns-expiration": String(args.expirationSeconds),
      }),
      [constants.HTTP2_HEADER_CONTENT_TYPE]: "application/json",
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: String(body.byteLength),
    };

    return new Promise<ApnsSendResult>((resolve, reject) => {
      const req = session.request(headers);
      req.setTimeout(args.timeoutMs ?? 10_000, () => {
        req.close(constants.NGHTTP2_CANCEL);
        // A timeout is transient — the token stays usable, so tokenDead is
        // false and the caller must not retire it.
        resolve({ ok: false, status: 0, reason: "Timeout", tokenDead: false });
      });

      let status = 0;
      req.on("response", (resHeaders) => {
        status = Number(resHeaders[constants.HTTP2_HEADER_STATUS] ?? 0);
      });

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", reject);
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        // APNs sends an empty body on success and { reason } on failure.
        let reason: string | undefined;
        if (raw.length > 0) {
          try {
            reason = (JSON.parse(raw) as { reason?: string }).reason;
          } catch {
            // A non-JSON error body is still worth surfacing verbatim rather
            // than discarding — it is all we would have to diagnose with.
            reason = raw.slice(0, 200);
          }
        }
        resolve({
          ok: status === 200,
          status,
          reason,
          tokenDead: reason != null && DEAD_TOKEN_REASONS.has(reason),
        });
      });

      req.end(body);
    });
  }

  /** Close the shared connection. Called on server shutdown. */
  close(): void {
    this.session?.close();
    this.session = null;
  }
}
