// Parsing the additive `e2ee` field of a pair-exchange request.
//
// `POST /api/pair/exchange` is public and unauthenticated (`PUBLIC_POST_PATHS`
// in api/middleware/auth.middleware.ts), so everything here runs on bytes an
// attacker chose, before anything has authenticated them. D-9 states the rule
// for the Phase 4 unseal middleware and it reaches back to here: reject before
// allocating, and never size a buffer from an attacker-supplied length.
//
// The field is OPTIONAL and its absence is not an error. A released tb-mobile
// build sends `{ token, clientPublicKey }` and nothing else, cannot be
// force-updated, and must keep pairing exactly as it does today
// (docs/compatibility/tb-mobile.md). "No `e2ee` key" therefore means "an older
// client", never "a malformed request".

import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

/** Envelope version this build speaks. Matches `E2EE_PROTOCOL_VERSION`. */
export const E2EE_EXCHANGE_VERSION = 1;

/**
 * Cap on the base64 text before it is decoded.
 *
 * Checked against the *encoded* length rather than the decoded one, because
 * `Buffer.from(s, "base64")` allocates in proportion to `s` — testing the
 * result would mean doing the allocation this bound exists to prevent. base64
 * is 4 characters per 3 bytes; the padding allowance is slack, not precision.
 */
const MAX_BASE64_CHARS = Math.ceil((NOISE_MAX_MESSAGE_BYTES * 4) / 3) + 4;

export class E2eeRequestError extends Error {
  /** Stable code for the client, so a version mismatch is not a parse failure. */
  readonly code: "E2EE_MALFORMED" | "E2EE_VERSION_UNSUPPORTED";

  constructor(code: E2eeRequestError["code"], message: string) {
    super(message);
    this.name = "E2eeRequestError";
    this.code = code;
  }
}

export interface E2eeExchangeRequest {
  version: number;
  /** Noise `IK` message 1, decoded. */
  message1: Buffer;
}

/**
 * `null` for a client that did not ask for encryption; a parsed request for one
 * that did; a throw for one that asked incoherently.
 *
 * The three are deliberately distinct. Collapsing "absent" into "malformed"
 * breaks every released client, and collapsing "malformed" into "absent" would
 * silently pair a client that believed it was encrypting — which is the
 * downgrade the whole negotiation exists to prevent, arrived at through a
 * parser rather than an attacker.
 */
export function parseE2eeRequest(raw: unknown): E2eeExchangeRequest | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee must be an object");
  }

  const { v, noise } = raw as { v?: unknown; noise?: unknown };

  // Version first: a client speaking v2 is not a malformed v1 client, and
  // telling it so is what lets it fall back deliberately rather than retrying.
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee.v must be an integer");
  }
  if (v !== E2EE_EXCHANGE_VERSION) {
    throw new E2eeRequestError(
      "E2EE_VERSION_UNSUPPORTED",
      `e2ee.v ${v} is not supported; this server speaks ${E2EE_EXCHANGE_VERSION}`,
    );
  }

  if (typeof noise !== "string") {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee.noise must be a base64 string");
  }
  // Before the decode, not after.
  if (noise.length > MAX_BASE64_CHARS) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee.noise is too large");
  }

  const message1 = Buffer.from(noise, "base64");
  // `Buffer.from` never throws on base64 — it discards anything it cannot
  // decode, so garbage silently becomes a short buffer rather than an error.
  // An empty result from a non-empty string is that failure, and it has to be
  // caught here or it surfaces later as a confusing handshake error.
  if (message1.length === 0) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee.noise is not valid base64");
  }

  return { version: v, message1 };
}
