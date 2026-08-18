import {
  type E2eeMsg2Payload,
  encodeE2eeMsg2Payload,
  parseE2eeMsg1Payload,
} from "../src/e2ee/pair-payload";
import type { E2eeRequestError } from "../src/e2ee/pair-request";

/**
 * The authenticated payloads inside the handshake (design.md §2.4, GATE 4).
 *
 * Being inside the AEAD makes these bytes authentic, not well-formed — the peer
 * really sent them, and they are still JSON of an arbitrary shape. So the msg1
 * parser is held to the same standard as the outer `e2ee` field's: it refuses
 * rather than defaults, because a defaulted `readOnly` grants a capability
 * preset the device never stated.
 */

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8");

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as E2eeRequestError).code;
  }
  // Reached only when the call did NOT throw — which is the failure this
  // guards, since an assertion made inside the catch above cannot tell
  // "rejected correctly" from "never ran".
  return "DID_NOT_THROW";
}

describe("parseE2eeMsg1Payload", () => {
  it("returns the authenticated registration inputs", () => {
    expect(
      parseE2eeMsg1Payload(encode({ v: 1, deviceName: "Ronen's iPhone", readOnly: false })),
    ).toEqual({ version: 1, deviceName: "Ronen's iPhone", readOnly: false });
  });

  it("carries readOnly true through unchanged", () => {
    expect(parseE2eeMsg1Payload(encode({ v: 1, readOnly: true }))).toEqual({
      version: 1,
      deviceName: null,
      readOnly: true,
    });
  });

  it("normalises an absent deviceName to null, so both paths register the same shape", () => {
    expect(parseE2eeMsg1Payload(encode({ v: 1, readOnly: false })).deviceName).toBeNull();
    expect(
      parseE2eeMsg1Payload(encode({ v: 1, deviceName: null, readOnly: false })).deviceName,
    ).toBeNull();
  });

  it("bounds deviceName at the legacy path's 100 characters", () => {
    const parsed = parseE2eeMsg1Payload(
      encode({ v: 1, deviceName: "x".repeat(500), readOnly: false }),
    );
    expect(parsed.deviceName).toHaveLength(100);
  });

  it("refuses a missing readOnly rather than defaulting it to the wider preset", () => {
    expect(codeOf(() => parseE2eeMsg1Payload(encode({ v: 1 })))).toBe("E2EE_MALFORMED");
    expect(codeOf(() => parseE2eeMsg1Payload(encode({ v: 1, readOnly: "false" })))).toBe(
      "E2EE_MALFORMED",
    );
  });

  it("refuses a non-string deviceName", () => {
    expect(
      codeOf(() => parseE2eeMsg1Payload(encode({ v: 1, deviceName: 7, readOnly: false }))),
    ).toBe("E2EE_MALFORMED");
  });

  it("refuses payloads that are not a JSON object", () => {
    expect(codeOf(() => parseE2eeMsg1Payload(Buffer.from("not json", "utf-8")))).toBe(
      "E2EE_MALFORMED",
    );
    expect(codeOf(() => parseE2eeMsg1Payload(encode([1, 2, 3])))).toBe("E2EE_MALFORMED");
    expect(codeOf(() => parseE2eeMsg1Payload(encode(null)))).toBe("E2EE_MALFORMED");
    expect(codeOf(() => parseE2eeMsg1Payload(Buffer.alloc(0)))).toBe("E2EE_MALFORMED");
  });

  it("separates an unsupported version from a malformed one", () => {
    // A client speaking v2 is not a broken v1 client, and telling it so is what
    // lets it fall back deliberately instead of retrying the same QR.
    expect(codeOf(() => parseE2eeMsg1Payload(encode({ v: 2, readOnly: false })))).toBe(
      "E2EE_VERSION_UNSUPPORTED",
    );
    expect(codeOf(() => parseE2eeMsg1Payload(encode({ v: "1", readOnly: false })))).toBe(
      "E2EE_MALFORMED",
    );
  });
});

describe("encodeE2eeMsg2Payload", () => {
  const fields = {
    deviceId: "dev_abc123",
    deviceToken: "tbd_0123456789abcdef",
    capabilities: ["sessions:read", "sessions:write"],
    publicUrl: "https://tb.example.test",
    machineName: "ronen-mbp",
    serverVersion: "1.61.0",
  };

  it("carries every field the contract lists, with e2eeRequired true", () => {
    const decoded = JSON.parse(encodeE2eeMsg2Payload(fields).toString("utf-8")) as E2eeMsg2Payload;

    expect(decoded).toEqual({ v: 1, ...fields, e2eeRequired: true });
    // Named individually as well as by shape: `toEqual` on a literal passes if
    // both sides lose the same field in a future edit, and a client that has to
    // fall back to the outer, unauthenticated copy of any one of these is not
    // authenticating it at all.
    for (const key of [
      "v",
      "deviceId",
      "deviceToken",
      "capabilities",
      "publicUrl",
      "machineName",
      "serverVersion",
      "e2eeRequired",
    ]) {
      expect(decoded).toHaveProperty(key);
    }
    expect(decoded.e2eeRequired).toBe(true);
  });

  it("keeps a null publicUrl as null rather than dropping the key", () => {
    const decoded = JSON.parse(
      encodeE2eeMsg2Payload({ ...fields, publicUrl: null }).toString("utf-8"),
    ) as E2eeMsg2Payload;

    expect(decoded).toHaveProperty("publicUrl");
    expect(decoded.publicUrl).toBeNull();
  });
});
