import { describe, expect, it } from "vitest";
import { NOISE_MAX_MESSAGE_BYTES } from "../src/e2ee/noise";
import { E2eeRequestError, parseE2eeRequest } from "../src/e2ee/pair-request";

/**
 * Parsing the `e2ee` field of a pair-exchange request (#590, Phase 2).
 *
 * This runs on a public, unauthenticated endpoint, before anything has
 * authenticated the caller — the position D-9 describes for the Phase 4 unseal
 * middleware, reached early. Everything here is about the three outcomes being
 * distinct: absent, parsed, and refused.
 */
describe("parseE2eeRequest", () => {
  /**
   * The compatibility floor, and the one that breaks the most if it moves.
   * Every released tb-mobile build sends no `e2ee` key at all.
   */
  it("treats an absent field as an older client, not as an error", () => {
    expect(parseE2eeRequest(undefined)).toBeNull();
    expect(parseE2eeRequest(null)).toBeNull();
  });

  it("parses a well-formed envelope", () => {
    const parsed = parseE2eeRequest({ v: 1, noise: Buffer.from("hello").toString("base64") });
    expect(parsed?.version).toBe(1);
    expect(parsed?.message1.toString()).toBe("hello");
  });

  /**
   * A version this build does not speak is not a parse failure, and saying so
   * is what lets a newer client fall back deliberately instead of retrying a
   * request that can never succeed.
   */
  it("separates an unsupported version from a malformed one", () => {
    expect(() => parseE2eeRequest({ v: 2, noise: "AAAA" })).toThrow(
      expect.objectContaining({ code: "E2EE_VERSION_UNSUPPORTED" }),
    );
    expect(() => parseE2eeRequest({ v: "1", noise: "AAAA" })).toThrow(
      expect.objectContaining({ code: "E2EE_MALFORMED" }),
    );
  });

  it("refuses shapes that are not an envelope at all", () => {
    for (const raw of [42, "e2ee", [], { noise: "AAAA" }, { v: 1 }, { v: 1, noise: 7 }]) {
      expect(() => parseE2eeRequest(raw)).toThrow(E2eeRequestError);
    }
  });

  /**
   * D-9's rule, at the earliest point it applies: bounded before decryption,
   * and never allocating in proportion to an attacker's length.
   *
   * The check is on the ENCODED length on purpose — `Buffer.from(s, "base64")`
   * allocates in proportion to `s`, so testing the decoded result would first
   * perform the allocation the bound exists to prevent.
   */
  it("rejects an oversized envelope without decoding it", () => {
    const huge = "A".repeat(NOISE_MAX_MESSAGE_BYTES * 2);
    expect(() => parseE2eeRequest({ v: 1, noise: huge })).toThrow(/too large/);
  });

  it("accepts a message right at the size bound", () => {
    // The positive control for the bound: without it, a bound of zero would
    // pass the test above and reject every real handshake.
    const atLimit = Buffer.alloc(NOISE_MAX_MESSAGE_BYTES).toString("base64");
    expect(parseE2eeRequest({ v: 1, noise: atLimit })?.message1.length).toBe(
      NOISE_MAX_MESSAGE_BYTES,
    );
  });

  /**
   * `Buffer.from(s, "base64")` never throws — it silently discards anything it
   * cannot decode, so garbage becomes a short buffer rather than an error. That
   * has to be caught here or it surfaces later as a confusing handshake failure
   * pointing at the wrong thing.
   */
  it("refuses base64 that decodes to nothing", () => {
    expect(() => parseE2eeRequest({ v: 1, noise: "!!!!" })).toThrow(/valid base64/);
    expect(() => parseE2eeRequest({ v: 1, noise: "" })).toThrow(/valid base64/);
  });
});
