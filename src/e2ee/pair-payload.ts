// The authenticated payloads inside the pair handshake's two Noise messages.
//
// Distinct from `pair-request.ts`, which parses the *outer*, unauthenticated
// `e2ee` field of the HTTP body. Everything here sits inside the AEAD: message
// 1's payload decrypted only because the initiator held the right static key
// and the PSK derived from this QR's pair token, and message 2's payload
// encrypted so only that same initiator can read it.
//
// That is the whole reason these exist as a separate contract (design.md §2.4,
// GATE 4). The outer JSON is attacker-modifiable — an intermediary can rename a
// device or widen `readOnly` on the way past — so on the E2EE path the values
// that reach the device row come from message 1's payload, and every result a
// new client persists or presents as verified comes from message 2's.
//
// Being inside the AEAD makes the bytes authentic, NOT well-formed. A payload
// that decrypts is one the peer really sent; it is still JSON of an arbitrary
// shape, so it is parsed with the same suspicion as the outer field.

import { E2EE_EXCHANGE_VERSION, E2eeRequestError } from "./pair-request";

/**
 * The device-registration inputs message 1 authenticates.
 *
 * `deviceName` is the one optional field in the contract, and is normalised to
 * `null` when absent so both pairing paths hand `devicesRepo.register` the same
 * shape. The 100-character bound is the legacy path's, kept identical rather
 * than re-chosen: authenticating a value is not a reason to stop bounding it.
 */
export interface E2eePairRegistration {
  version: number;
  deviceName: string | null;
  readOnly: boolean;
}

/** Matches the legacy path's `body.deviceName.slice(0, 100)`. */
const MAX_DEVICE_NAME_CHARS = 100;

/**
 * Parse message 1's decrypted payload.
 *
 * Throws rather than defaulting. A client that completed the handshake and then
 * sent an unreadable payload is a protocol violation, not an older client — an
 * older client cannot reach this function at all, because it sends no `e2ee`
 * field and no handshake is performed. Defaulting a missing `readOnly` to
 * `false` would silently grant the wider capability preset off a payload the
 * device never actually stated, which is the exact substitution this contract
 * exists to prevent, arrived at through a parser instead of an intermediary.
 *
 * `v` is checked against the same version and with the same ordering as
 * `parseE2eeRequest`: a version mismatch is not a malformed payload, and saying
 * so is what lets a future client fall back deliberately.
 */
export function parseE2eeMsg1Payload(payload: Buffer): E2eePairRegistration {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf-8"));
  } catch {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee message 1 payload is not valid JSON");
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee message 1 payload must be an object");
  }

  const { v, deviceName, readOnly } = raw as {
    v?: unknown;
    deviceName?: unknown;
    readOnly?: unknown;
  };

  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee message 1 payload v must be an integer");
  }
  if (v !== E2EE_EXCHANGE_VERSION) {
    throw new E2eeRequestError(
      "E2EE_VERSION_UNSUPPORTED",
      `e2ee message 1 payload v ${v} is not supported; this server speaks ${E2EE_EXCHANGE_VERSION}`,
    );
  }

  if (typeof readOnly !== "boolean") {
    throw new E2eeRequestError(
      "E2EE_MALFORMED",
      "e2ee message 1 payload readOnly must be a boolean",
    );
  }

  if (deviceName !== undefined && deviceName !== null && typeof deviceName !== "string") {
    throw new E2eeRequestError(
      "E2EE_MALFORMED",
      "e2ee message 1 payload deviceName must be a string when present",
    );
  }

  return {
    version: v,
    deviceName: typeof deviceName === "string" ? deviceName.slice(0, MAX_DEVICE_NAME_CHARS) : null,
    readOnly,
  };
}

/**
 * Every pairing result a new client persists or presents as verified.
 *
 * The outer response still carries compatibility copies of `deviceId`,
 * `deviceToken`, `capabilities`, `publicUrl` and `machineName` for released
 * clients that can read nothing else, and a new client ignores all of them —
 * so this shape is the one that has to be complete. A field missing here is a
 * field the new client would have to take from the unauthenticated outer copy,
 * which is the same as not authenticating it at all.
 *
 * `deviceId` and `deviceToken` are non-nullable on purpose: an E2EE pairing
 * that cannot produce them is a failed pairing, not a success carrying nulls.
 */
export interface E2eeMsg2Payload {
  v: number;
  deviceId: string;
  deviceToken: string;
  capabilities: string[];
  publicUrl: string | null;
  machineName: string;
  serverVersion: string;
  /**
   * Always `true`. Completing a handshake is what pins the device, and
   * design.md §6.3 says nothing a client sends ever clears it — so this is a
   * literal here rather than an argument, and there is no call site that can
   * pass `false` by accident.
   */
  e2eeRequired: true;
}

export function encodeE2eeMsg2Payload(fields: Omit<E2eeMsg2Payload, "v" | "e2eeRequired">): Buffer {
  const payload: E2eeMsg2Payload = {
    v: E2EE_EXCHANGE_VERSION,
    ...fields,
    e2eeRequired: true,
  };
  return Buffer.from(JSON.stringify(payload), "utf-8");
}
