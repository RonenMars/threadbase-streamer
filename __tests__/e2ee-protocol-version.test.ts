import { E2EE_PROTOCOL_VERSION as fromRoute } from "../src/api/routes/misc.routes";
import { E2EE_EXCHANGE_VERSION } from "../src/e2ee/pair-request";
import { E2EE_PROTOCOL_VERSION, E2EE_REJECTION_CODES } from "../src/e2ee/protocol";

/**
 * The envelope version had two hand-synced copies kept equal by a comment
 * (NONCE-DESIGN §4). The canonical value now lives in `src/e2ee/protocol.ts` —
 * the record layer needs it, and a crypto module importing a Hono route module
 * would invert the dependency direction — and both old names survive as
 * re-exports so `server.ts` and `pair-payload.ts`, which another track owns,
 * are untouched.
 *
 * This test is what makes the aliases safe rather than a second copy: a version
 * that can disagree with itself eventually does, and the symptom is
 * "decryption failed" pointing nowhere near the cause.
 */
describe("the protocol version is one value (§4)", () => {
  it("is the same number under every name that survives", () => {
    expect(E2EE_EXCHANGE_VERSION).toBe(E2EE_PROTOCOL_VERSION);
    expect(fromRoute).toBe(E2EE_PROTOCOL_VERSION);
  });

  it("is the byte the AAD carries", () => {
    expect(E2EE_PROTOCOL_VERSION).toBe(1);
    // A one-byte field: bumping past 255 is a wire change, not a version bump.
    expect(E2EE_PROTOCOL_VERSION).toBeLessThanOrEqual(0xff);
  });

  // The four strings are frozen at W1a's tag and tb-mobile consumes them (§9).
  it("freezes the four rejection codes", () => {
    expect(E2EE_REJECTION_CODES).toEqual([
      "E2EE_CTX_UNKNOWN",
      "E2EE_DEVICE_REVOKED",
      "E2EE_SEQUENCE_VIOLATION",
      "E2EE_SEAL_FAILED",
    ]);
  });
});
