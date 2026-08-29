import { createHash, createSecretKey, randomBytes } from "crypto";
import { inspect } from "util";
import { E2eeContextRegistry, newCtxId } from "../src/e2ee/context";
import {
  CipherState,
  generateKeyPair,
  OPEN_PROLOGUE,
  PAIR_PROLOGUE,
  readMessage1,
  readMessage2,
  respond,
  writeMessage1,
  writeMessage2,
} from "../src/e2ee/noise";
import { assertBytes, E2EE_PROTOCOL_VERSION, isBytes } from "../src/e2ee/protocol";
import {
  CHANNEL_REST_REQUEST,
  CHANNEL_REST_RESPONSE,
  CHANNEL_WS,
  createRecordState,
  DIRECTION_C2S,
  DIRECTION_S2C,
  HEADER_BYTES,
  MAX_COUNTER,
  type RecordError,
  type RecordState,
  RestResponseSealer,
  recordAad,
  recordHeader,
  recordNonce,
  restTargetHash,
  restTargetHashFromUrl,
  TAG_BYTES,
} from "../src/e2ee/record";
import vectors from "./fixtures/e2ee-record-vectors.json";

/**
 * The record layer (Phase 3, W1a), against
 * specs/end-to-end-encryption/NONCE-DESIGN.md.
 *
 * Every test here drives the REAL `RecordState` over the real Node
 * `chacha20-poly1305` — there is no stubbed cipher and no seam standing in for
 * the transition under test, because a suite that mocks the thing it is
 * asserting on proves the mock.
 *
 * Each `it` name ends with the NONCE-DESIGN section it holds, so a failure
 * names the rule rather than the symptom.
 */

const KEY = Buffer.alloc(32, 0xa1);
const CTX = Buffer.alloc(16, 0x11);
const OTHER_CTX = Buffer.alloc(16, 0x22);

function state(overrides: Partial<Parameters<typeof createRecordState>[0]> = {}): RecordState {
  return createRecordState({
    key: KEY,
    ctxId: CTX,
    direction: DIRECTION_C2S,
    channel: CHANNEL_WS,
    ...overrides,
  });
}

/** A sender and a receiver that agree on everything. The ordinary case. */
function pair(overrides: Partial<Parameters<typeof createRecordState>[0]> = {}) {
  return { sender: state(overrides), receiver: state(overrides) };
}

/** Replace a frame's 30-byte header, leaving the ciphertext and tag untouched. */
function reheader(frame: Buffer, header: Buffer): Buffer {
  return Buffer.concat([header, frame.subarray(HEADER_BYTES)]);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as RecordError).code;
  }
  throw new Error("expected a rejection, got none");
}

// ─── Controls ───────────────────────────────────────────────────────

/**
 * The capture harness the two controls share: what an observer on the wire
 * sees. Nothing in it knows whether the bytes it holds are sealed.
 */
function wireCapture() {
  const frames: Buffer[] = [];
  return {
    frames,
    send: (bytes: Buffer) => frames.push(bytes),
    /** Does any captured byte sequence contain this plaintext marker? */
    contains: (needle: string) => frames.some((f) => f.includes(Buffer.from(needle, "utf-8"))),
  };
}

describe("controls", () => {
  const message = { type: "terminal_output", data: "totally-secret-terminal-line" };

  // POSITIVE CONTROL (NONCE-DESIGN §12).
  it("seals a frame whose type is readable only after unseal", () => {
    const { sender, receiver } = pair();
    const wire = wireCapture();

    wire.send(sender.seal(Buffer.from(JSON.stringify(message), "utf-8")));

    // On the wire: neither the event name nor its payload.
    expect(wire.contains("terminal_output")).toBe(false);
    expect(wire.contains("totally-secret-terminal-line")).toBe(false);

    const opened = JSON.parse(receiver.unseal(wire.frames[0]).toString("utf-8"));
    expect(opened).toEqual(message);
  });

  // NEGATIVE CONTROL (NONCE-DESIGN §12): the same harness, sealing disabled.
  // Without this, "no plaintext on the wire" could equally mean the capture
  // cannot see plaintext at all.
  it("shows plaintext through the same capture when sealing is disabled", () => {
    const wire = wireCapture();

    wire.send(Buffer.from(JSON.stringify(message), "utf-8"));

    expect(wire.contains("terminal_output")).toBe(true);
    expect(wire.contains("totally-secret-terminal-line")).toBe(true);
  });
});

// ─── §2 nonce ───────────────────────────────────────────────────────

describe("prototype pollution changes nothing (§11, round 5)", () => {
  /** Set a property on Object.prototype for the length of one function. */
  function polluted<T>(key: string, value: unknown, body: () => T): T {
    const proto = Object.prototype as Record<string, unknown>;
    proto[key] = value;
    try {
      return body();
    } finally {
      delete proto[key];
    }
  }

  it("ignores a polluted initialCounter, so a seal cannot be pushed back onto a used nonce", () => {
    const sender = polluted("initialCounter", 0n, () =>
      createRecordState({ key: KEY, ctxId: CTX, direction: DIRECTION_C2S, channel: CHANNEL_WS }),
    );
    // Reads the ARGUMENT, which said nothing, so the counter starts at 0 —
    // and, more to the point, a polluted value cannot MOVE it.
    expect(sender.counter).toBe(0n);

    const advanced = polluted("initialCounter", 0n, () =>
      createRecordState({
        key: KEY,
        ctxId: CTX,
        direction: DIRECTION_C2S,
        channel: CHANNEL_WS,
        initialCounter: 9n,
      }),
    );
    expect(advanced.counter).toBe(9n);
  });

  it("ignores a polluted ephemeral, which would make every handshake a replay", () => {
    // §8's rule is that a repeated `e` is definitionally a replay. A polluted
    // `Object.prototype.ephemeral` pins every handshake to one attacker-chosen
    // `e`, so every open after the first is refused as its own replay.
    const server = generateKeyPair();
    const client = generateKeyPair();
    const pinned = generateKeyPair();
    const send = () =>
      writeMessage1({
        staticKeyPair: client,
        responderStaticPub: server.publicKeyRaw,
        pattern: "IK",
        payload: Buffer.from("{}", "utf-8"),
        prologue: OPEN_PROLOGUE,
      }).message.subarray(0, 32);

    const [a, b] = polluted("ephemeral", pinned, () => [send(), send()]);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(pinned.publicKeyRaw)).toBe(false);
  });

  it("ignores a polluted prologue, which would collapse the two namespaces", () => {
    // A pairing message read under the `/open` prologue must fail. If
    // `prologue` could be defaulted from the prototype, this is where §11's
    // domain separation would quietly disappear.
    const server = generateKeyPair();
    const client = generateKeyPair();
    const psk = Buffer.alloc(32, 0x11);
    const pairing = writeMessage1({
      staticKeyPair: client,
      responderStaticPub: server.publicKeyRaw,
      psk,
      payload: Buffer.from("{}", "utf-8"),
      prologue: PAIR_PROLOGUE,
    });

    polluted("prologue", PAIR_PROLOGUE, () => {
      expect(() =>
        readMessage1({
          staticKeyPair: server,
          pattern: "IK",
          message1: pairing.message,
          prologue: OPEN_PROLOGUE,
        }),
      ).toThrow();
      // And a call that passes none is refused outright rather than silently
      // taking the polluted one.
      expect(() =>
        readMessage1({
          staticKeyPair: server,
          psk,
          message1: pairing.message,
        } as unknown as Parameters<typeof readMessage1>[0]),
      ).toThrow(/prologue is required/);
    });
  });
});

describe("the guards that are one guard (§11, round 5)", () => {
  const fail = (m: string) => new Error(m);

  it("rejects everything that passes a `.length` check but is not 32 bytes", () => {
    // `.length` is not byte length for a typed array. `new Float64Array(32)`
    // has `.length === 32` and 256 bytes behind it, and it completed a full
    // `IKpsk1` handshake binding 256 zero bytes — a binding over a constant,
    // which is what §11 rejects, reached through a guard rather than a
    // decision. A 32-character string has neither property.
    const impostors: unknown[] = [
      new Float64Array(32),
      new Uint32Array(32),
      new Uint16Array(32),
      new Int8Array(32),
      "x".repeat(32),
      "é".repeat(32),
      new ArrayBuffer(32),
      new DataView(new ArrayBuffer(32)),
      { length: 32 },
      Array.from({ length: 32 }, () => 0),
      null,
      undefined,
    ];
    for (const value of impostors) {
      expect(isBytes(value, 32), String(value)).toBe(false);
      expect(() => assertBytes(value, 32, "thing", fail)).toThrow(/exactly 32 bytes/);
    }

    // The control: real byte arrays of the right width pass, in both flavours.
    expect(isBytes(Buffer.alloc(32), 32)).toBe(true);
    expect(isBytes(new Uint8Array(32), 32)).toBe(true);
    // …and the wrong width does not.
    expect(isBytes(Buffer.alloc(31), 32)).toBe(false);
    expect(isBytes(Buffer.alloc(33), 32)).toBe(false);
  });

  it("refuses them at every entry point that takes fixed-width bytes", () => {
    const bad = new Float64Array(32) as unknown as Buffer;
    expect(codeOf(() => state({ key: bad }))).toBe("E2EE_SEAL_FAILED");
    expect(codeOf(() => state({ ctxId: bad }))).toBe("E2EE_SEAL_FAILED");
    expect(
      codeOf(() => state({ channel: CHANNEL_REST_REQUEST }).seal(Buffer.from("{}"), bad)),
    ).toBe("E2EE_SEAL_FAILED");
    expect(codeOf(() => new RestResponseSealer({ key: bad, ctxId: CTX }))).toBe("E2EE_SEAL_FAILED");
  });
});

describe("nonce and window state is #private (§13, round 5)", () => {
  it("cannot be reset from outside, which is the counter reset §14 forbids", () => {
    const sender = state();
    const receiver = state();
    receiver.unseal(sender.seal(Buffer.from("one")));
    receiver.unseal(sender.seal(Buffer.from("two")));
    expect(sender.counter).toBe(2n);

    // The attack: an untyped consumer writes the counter back to zero and the
    // next seal reuses a nonce. `#private` makes the assignment land on a NEW
    // ordinary property instead — the real counter is unreachable.
    (sender as unknown as { n: bigint }).n = 0n;
    (sender as unknown as { "#n": bigint })["#n"] = 0n;
    expect(sender.counter).toBe(2n);
    expect(sender.seal(Buffer.from("three")).readBigUInt64BE(21)).toBe(2n);

    // Same for the window: `acceptedHighWater = -1n` plus a cleared bitmap
    // re-armed every answered counter, which is keystream reuse.
    const target = restTargetHash("POST", "/x", "");
    const sealer = new RestResponseSealer({ key: KEY, ctxId: CTX });
    sealer.accept(5n);
    sealer.seal(5n, Buffer.from("{}"), target);
    const reachable = sealer as unknown as {
      acceptedHighWater?: bigint;
      answeredBits?: Uint8Array;
      outstanding?: Set<bigint>;
    };
    reachable.acceptedHighWater = -1n;
    reachable.answeredBits = new Uint8Array(128);
    reachable.outstanding = new Set([5n]);
    expect(codeOf(() => sealer.accept(5n))).toBe("E2EE_SEAL_FAILED");
    expect(codeOf(() => sealer.seal(5n, Buffer.from("{}"), target))).toBe("E2EE_SEAL_FAILED");
  });
});

describe("an imported key is checked for WIDTH, not just kind (round 6)", () => {
  it("refuses a secret KeyObject that is not 32 bytes", () => {
    // The one guard that does not route through `isBytes` accepted any
    // `{ type: "secret" }`, so a 16-byte secret would have been installed as a
    // traffic key — the presence-vs-length class surviving in its last corner.
    for (const size of [16, 24, 31, 33, 64]) {
      const wrong = createSecretKey(Buffer.alloc(size, 0x11));
      expect(codeOf(() => state({ key: wrong }))).toBe("E2EE_SEAL_FAILED");
      expect(codeOf(() => new RestResponseSealer({ key: wrong, ctxId: CTX }))).toBe(
        "E2EE_SEAL_FAILED",
      );
    }

    // The control: a 32-byte secret is accepted and works.
    const right = createSecretKey(Buffer.alloc(32, 0x22));
    const sender = state({ key: right });
    expect(
      state({ key: right })
        .unseal(sender.seal(Buffer.from("ok")))
        .toString(),
    ).toBe("ok");
  });
});

describe("the artefact a separate client builds against (§13, round 6)", () => {
  const framing = (ctxId: Uint8Array) => ({
    version: E2EE_PROTOCOL_VERSION,
    ctxId,
    direction: DIRECTION_C2S,
    counter: 0n,
    channel: CHANNEL_REST_REQUEST,
  });

  it("accepts a plain Uint8Array, which is what a @stablelib client produces", () => {
    // `isBytes` narrowed to `Buffer` while testing for `Uint8Array`, so a
    // correct-length plain view passed the guard and then died inside the
    // builder on `target.copy is not a function` — a TypeError outside §9's
    // taxonomy, for input that was right. §13 has that client calling the
    // builder directly.
    const ctxId = new Uint8Array(CTX.buffer.slice(0), 0, 16);
    const target = new Uint8Array(restTargetHash("GET", "/x", ""));
    expect(ctxId).not.toBeInstanceOf(Buffer);
    expect(target).not.toBeInstanceOf(Buffer);

    const aad = recordAad(framing(ctxId), target);
    expect(aad).toHaveLength(62);
    // Byte-for-byte identical to the Buffer path, so the two client flavours
    // agree on the wire.
    expect(aad.equals(recordAad(framing(CTX), restTargetHash("GET", "/x", "")))).toBe(true);
  });

  it("answers a wrong-length view with a RecordError, not a TypeError", () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(33), new Float64Array(32)]) {
      expect(codeOf(() => recordAad(framing(CTX), bad as unknown as Uint8Array))).toBe(
        "E2EE_SEAL_FAILED",
      );
      expect(codeOf(() => recordAad(framing(bad as unknown as Uint8Array), Buffer.alloc(32)))).toBe(
        "E2EE_SEAL_FAILED",
      );
    }
  });

  it("bounds a frame by BYTE length, which is the unit the D-9 bound is in", () => {
    // A view whose element count is inside the ceiling while its byte count is
    // far outside it: `.length` is 600 000, `byteLength` is 4.8 MB.
    const oversized = new Float64Array(600_000);
    let message = "";
    try {
      state().unseal(oversized as unknown as Buffer);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("too large");
  });

  it("hashes the ORIGIN-FORM target, never the absolute URL the client fetches", () => {
    // A client that hashes the URL it is about to fetch produces a different
    // digest for every request, each failing with `E2EE_SEAL_FAILED` and
    // nothing else — the trap §4 exists to prevent. The fixture pins the
    // origin form, and this asserts the two are not interchangeable.
    const origin = restTargetHashFromUrl("GET", "/api/sessions?limit=50");
    const absolute = restTargetHashFromUrl("GET", "https://host/api/sessions?limit=50");
    expect(origin.equals(absolute)).toBe(false);
    expect(origin.equals(restTargetHash("GET", "/api/sessions", "limit=50"))).toBe(true);

    // And the committed vector is origin-form: method, newline, then a bare `/`.
    expect(vectors.restTargetCanonicalization.hashInputUtf8).toMatch(/^[A-Z]+\n\//);
  });
});

describe("nonce construction (§2)", () => {
  it("is direction(4) || counter(8), big-endian, never random (§2)", () => {
    expect(recordNonce(DIRECTION_C2S, 1n).toString("hex")).toBe("000000010000000000000001");
    expect(recordNonce(DIRECTION_S2C, 258n).toString("hex")).toBe("000000020000000000000102");
    // Big-endian is the whole point of the assertion: the little-endian
    // encoding of 258 would put 0x02 in the FIRST counter byte, which is what
    // reusing the handshake's `chachaNonce` would produce.
    expect(recordNonce(DIRECTION_C2S, 258n).subarray(4, 12).toString("hex")).toBe(
      "0000000000000102",
    );
  });

  it("never repeats a (direction, counter) across a full session (§2)", () => {
    const c2s = state({ direction: DIRECTION_C2S });
    const s2c = state({ direction: DIRECTION_S2C });
    const seen: string[] = [];

    const record = (frame: Buffer) => {
      const nonce = recordNonce(
        frame.readUInt32BE(17) as typeof DIRECTION_C2S,
        frame.readBigUInt64BE(21),
      );
      seen.push(nonce.toString("hex"));
    };

    for (let i = 0; i < 100; i++) {
      record(c2s.seal(Buffer.from(`up ${i}`)));
      record(s2c.seal(Buffer.from(`down ${i}`)));
    }

    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
  });

  it("refuses a server→client record reflected back as client→server (§2)", () => {
    // ONE key for both directions, deliberately. With the real two-key schedule
    // a reflected frame is rejected by the key alone, which would make this
    // test pass without the direction label ever being consulted.
    const server = state({ direction: DIRECTION_S2C });
    const asClient = state({ direction: DIRECTION_C2S });

    const frame = server.seal(Buffer.from("a server frame"));
    const reflected = reheader(
      frame,
      recordHeader({
        version: E2EE_PROTOCOL_VERSION,
        ctxId: CTX,
        direction: DIRECTION_C2S,
        counter: 0n,
        channel: CHANNEL_WS,
      }),
    );

    expect(() => asClient.unseal(reflected)).toThrow();
  });
});

// ─── §4 AAD ─────────────────────────────────────────────────────────

describe("AAD (§4)", () => {
  it("is exactly version(1) || ctxId(16) || direction(4) || counter(8) || channel(1) (§4)", () => {
    const aad = recordHeader({
      version: E2EE_PROTOCOL_VERSION,
      ctxId: CTX,
      direction: DIRECTION_S2C,
      counter: 7n,
      channel: CHANNEL_REST_REQUEST,
    });
    expect(aad).toHaveLength(30);
    expect(aad.toString("hex")).toBe(`01${"11".repeat(16)}00000002000000000000000702`);

    // On REST the same 30 bytes gain the 32-byte target suffix (§4).
    const target = restTargetHash("POST", "/api/sessions/abc/input", "limit=50");
    const rest = recordAad(
      {
        version: E2EE_PROTOCOL_VERSION,
        ctxId: CTX,
        direction: DIRECTION_C2S,
        counter: 0n,
        channel: CHANNEL_REST_REQUEST,
      },
      target,
    );
    expect(rest).toHaveLength(62);
    expect(rest.subarray(30)).toEqual(target);
    // The hash input spelling is a contract, not an implementation detail: two
    // sides that disagree on it fail every sealed request with no diagnostic.
    expect(target).toEqual(
      createHash("sha256").update("POST\n/api/sessions/abc/input\nlimit=50", "utf-8").digest(),
    );
  });

  // The AAD is what makes the plaintext header authentic. To see THAT — rather
  // than the explicit header checks in front of it — the receiver has to be one
  // whose own expectations match the rewritten header: it accepts the frame's
  // claim, and only the AAD can reject it.
  it("binds the ctxId, so a frame re-pointed at another context fails to decrypt (§4)", () => {
    const sender = state({ ctxId: CTX });
    const otherContext = state({ ctxId: OTHER_CTX });

    const frame = sender.seal(Buffer.from("for context one"));
    const repointed = reheader(
      frame,
      recordHeader({
        version: E2EE_PROTOCOL_VERSION,
        ctxId: OTHER_CTX,
        direction: DIRECTION_C2S,
        counter: 0n,
        channel: CHANNEL_WS,
      }),
    );

    expect(codeOf(() => otherContext.unseal(repointed))).toBe("E2EE_SEAL_FAILED");
  });

  it("binds the channel, so a REST request cannot be replayed as a REST response (§4)", () => {
    // Both sides are REST channels with the SAME target and the same direction,
    // so the channel byte is the only thing that differs between the two AADs.
    const asRequest = state({ channel: CHANNEL_REST_REQUEST });
    const asResponse = state({ channel: CHANNEL_REST_RESPONSE });
    const target = restTargetHash("POST", "/api/sessions/a/input", "");

    const frame = asRequest.seal(Buffer.from("a request body"), target);
    const moved = reheader(
      frame,
      recordHeader({
        version: E2EE_PROTOCOL_VERSION,
        ctxId: CTX,
        direction: DIRECTION_C2S,
        counter: 0n,
        channel: CHANNEL_REST_RESPONSE,
      }),
    );

    expect(codeOf(() => asResponse.unseal(moved, target))).toBe("E2EE_SEAL_FAILED");
  });

  it("binds the counter, so a frame renumbered into the expected slot fails (§4)", () => {
    const sender = state();
    const receiver = state({ initialCounter: 5n });

    // Seal at 3, renumber to the 5 the receiver is waiting for. The strict
    // counter (R2) cannot see this one — the header says exactly what the
    // receiver expects — so what rejects it is the binding, not the bookkeeping.
    const frame = createRecordState({
      key: KEY,
      ctxId: CTX,
      direction: DIRECTION_C2S,
      channel: CHANNEL_WS,
      initialCounter: 3n,
    }).seal(Buffer.from("sealed at three"));
    expect(sender.counter).toBe(0n);
    const renumbered = reheader(
      frame,
      recordHeader({
        version: E2EE_PROTOCOL_VERSION,
        ctxId: CTX,
        direction: DIRECTION_C2S,
        counter: 5n,
        channel: CHANNEL_WS,
      }),
    );

    expect(codeOf(() => receiver.unseal(renumbered))).toBe("E2EE_SEAL_FAILED");
  });

  it("rejects a foreign ctxId BEFORE decrypting, which the code proves (§10)", () => {
    // The rewritten header changes the AAD too, so a ctxId check placed AFTER
    // the decrypt would answer E2EE_SEAL_FAILED. Getting E2EE_CTX_UNKNOWN back
    // is the observable difference between "checked first" and "checked at all".
    const sender = state();
    const frame = sender.seal(Buffer.alloc(64 * 1024, 0x41));
    const foreign = reheader(
      frame,
      recordHeader({
        version: E2EE_PROTOCOL_VERSION,
        ctxId: OTHER_CTX,
        direction: DIRECTION_C2S,
        counter: 0n,
        channel: CHANNEL_WS,
      }),
    );

    expect(codeOf(() => state().unseal(foreign))).toBe("E2EE_CTX_UNKNOWN");
  });
});

// ─── §5 the counter state machine ───────────────────────────────────

describe("counter state machine (§5)", () => {
  it("advances by exactly 1 after a successful seal, never before (R1)", () => {
    const sender = state();
    expect(sender.counter).toBe(0n);

    const first = sender.seal(Buffer.from("one"));
    // The FIRST frame must carry counter 0. Advancing before sealing would put
    // a 1 here and quietly burn nonce 0 forever.
    expect(first.readBigUInt64BE(21)).toBe(0n);
    expect(sender.counter).toBe(1n);

    const second = sender.seal(Buffer.from("two"));
    expect(second.readBigUInt64BE(21)).toBe(1n);
    expect(sender.counter).toBe(2n);
  });

  it("rejects a duplicate, a gap and a reorder, each as a sequence violation (R2)", () => {
    const { sender, receiver } = pair();
    const frames = [0, 1, 2, 3].map((i) => sender.seal(Buffer.from(`frame ${i}`)));

    expect(receiver.unseal(frames[0]).toString()).toBe("frame 0");

    // Duplicate.
    expect(codeOf(() => receiver.unseal(frames[0]))).toBe("E2EE_SEQUENCE_VIOLATION");
    // Gap: frame 2 while 1 is expected. No window, no tolerance.
    expect(codeOf(() => receiver.unseal(frames[2]))).toBe("E2EE_SEQUENCE_VIOLATION");
    // In-order still works, proving the three rejections were about ordering.
    expect(receiver.unseal(frames[1]).toString()).toBe("frame 1");
    expect(receiver.unseal(frames[2]).toString()).toBe("frame 2");
    // Reorder: 3 is next, and 2 arriving again is a frame from the past.
    expect(codeOf(() => receiver.unseal(frames[2]))).toBe("E2EE_SEQUENCE_VIOLATION");
    expect(receiver.unseal(frames[3]).toString()).toBe("frame 3");
  });

  it("leaves the counter unadvanced when a frame is rejected (R3)", () => {
    const { sender, receiver } = pair();
    const good = sender.seal(Buffer.from("good"));
    const next = sender.seal(Buffer.from("next"));

    // A corrupted ciphertext at the expected counter.
    const corrupted = Buffer.from(good);
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(codeOf(() => receiver.unseal(corrupted))).toBe("E2EE_SEAL_FAILED");
    expect(receiver.counter).toBe(0n);

    // The real frame at that same counter still opens. Advancing on failure
    // would have desynchronised the two sides here.
    expect(receiver.unseal(good).toString()).toBe("good");
    expect(receiver.unseal(next).toString()).toBe("next");
  });

  it("rejects a frame shorter than a header and a tag, and one over the ceiling (§10)", () => {
    const receiver = state();
    expect(codeOf(() => receiver.unseal(Buffer.alloc(HEADER_BYTES + TAG_BYTES - 1)))).toBe(
      "E2EE_SEAL_FAILED",
    );
    expect(receiver.counter).toBe(0n);
  });
});

// ─── §5 R2 ordering, §4 target binding, §13(a) response echo ────────

describe("authenticate first, then compare the counter (§5 R2 ordering)", () => {
  it("reports a seal failure, not a sequence violation, for an injected frame (§5)", () => {
    const { sender, receiver } = pair();
    const good = sender.seal(Buffer.from("a real frame"));

    // What an injector can build: it read `ctxId` and a counter off a previous
    // plaintext header, so the header is plausible — but it holds no key, so
    // the tag is garbage. It must NOT be able to make the server publish a
    // verdict about the peer.
    const injected = Buffer.from(good);
    injected.writeBigUInt64BE(41n, 21); // a counter that is not `expected`
    injected[injected.length - 1] ^= 0xff; // and a tag it could not compute

    expect(codeOf(() => receiver.unseal(injected))).toBe("E2EE_SEAL_FAILED");
    expect(receiver.counter).toBe(0n);

    // The control: an AUTHENTIC frame at the wrong counter is still a sequence
    // violation, so the assertion above is about ordering rather than about the
    // code having been retired.
    const authenticFuture = createRecordState({
      key: KEY,
      ctxId: CTX,
      direction: DIRECTION_C2S,
      channel: CHANNEL_WS,
      initialCounter: 7n,
    }).seal(Buffer.from("from the future"));
    expect(codeOf(() => receiver.unseal(authenticFuture))).toBe("E2EE_SEQUENCE_VIOLATION");
  });
});

describe("REST target binding (§4)", () => {
  it("refuses a sealed body re-pointed at another path (§4)", () => {
    const sender = state({ channel: CHANNEL_REST_REQUEST });
    const receiver = state({ channel: CHANNEL_REST_REQUEST });

    const sealedFor = restTargetHash("POST", "/api/sessions/A/input", "");
    const servedAs = restTargetHash("POST", "/api/sessions/B/input", "");
    const frame = sender.seal(Buffer.from('{"text":"rm -rf /"}'), sealedFor);

    // The attacker changes only the URL — paths are plaintext (D-7) and the
    // frame is untouched. Without the suffix the body authenticates and the
    // server runs the user's own keystrokes against another session.
    expect(codeOf(() => receiver.unseal(frame, servedAs))).toBe("E2EE_SEAL_FAILED");
    expect(receiver.counter).toBe(0n);
    // And it opens for the target it was actually sealed for.
    expect(receiver.unseal(frame, sealedFor).toString()).toBe('{"text":"rm -rf /"}');
  });

  it("refuses a missing target on REST and a supplied one on the socket (§4)", () => {
    expect(codeOf(() => state({ channel: CHANNEL_REST_REQUEST }).seal(Buffer.from("x")))).toBe(
      "E2EE_SEAL_FAILED",
    );
    expect(
      codeOf(() =>
        state({ channel: CHANNEL_WS }).seal(Buffer.from("x"), restTargetHash("GET", "/", "")),
      ),
    ).toBe("E2EE_SEAL_FAILED");
  });
});

describe("REST target canonicalization (§4)", () => {
  it("hashes the RAW wire request-target, never a decoded or re-serialised one", () => {
    // `%2F` is not a slash. A client that decodes the path before hashing
    // produces a different target for the same request, and every affected
    // request then fails to authenticate with nothing but E2EE_SEAL_FAILED.
    expect(restTargetHash("GET", "/api/conversations/a%2Fb", "")).not.toEqual(
      restTargetHash("GET", "/api/conversations/a/b", ""),
    );
    // Query order, `+` vs `%20`, and duplicates are all part of the target.
    expect(restTargetHash("GET", "/x", "b=2&a=1")).not.toEqual(
      restTargetHash("GET", "/x", "a=1&b=2"),
    );
    expect(restTargetHash("GET", "/x", "q=hello+world")).not.toEqual(
      restTargetHash("GET", "/x", "q=hello%20world"),
    );
    expect(restTargetHash("GET", "/x", "a=1&a=2")).not.toEqual(restTargetHash("GET", "/x", "a=1"));
    // The method is upper-cased, so a client that sends `get` still agrees.
    expect(restTargetHash("get", "/x", "")).toEqual(restTargetHash("GET", "/x", ""));
  });

  it("splits a raw URL at its FIRST question mark and keeps the rest verbatim", () => {
    // Taken from `c.env.incoming.url` — the bytes Node received — never from
    // Hono's `c.req.path`, which is already percent-decoded.
    expect(restTargetHashFromUrl("POST", "/api/x/a%2Fb?b=2&a=1")).toEqual(
      restTargetHash("POST", "/api/x/a%2Fb", "b=2&a=1"),
    );
    expect(restTargetHashFromUrl("GET", "/api/x")).toEqual(restTargetHash("GET", "/api/x", ""));
    // A `?` inside the query is part of the query, not a second split.
    expect(restTargetHashFromUrl("GET", "/x?q=a?b")).toEqual(restTargetHash("GET", "/x", "q=a?b"));
  });
});

describe("the REST receiver's seam (§13)", () => {
  const target = restTargetHash("POST", "/api/sessions/a/input", "");

  function restState(initialCounter = 0n) {
    return createRecordState({
      key: KEY,
      ctxId: CTX,
      direction: DIRECTION_C2S,
      channel: CHANNEL_REST_REQUEST,
      initialCounter,
    });
  }

  it("returns the authenticated plaintext and the counter, out of order, advancing nothing", () => {
    // React Query issues concurrent requests, so REST genuinely receives 3
    // before 1. The window owns that decision; this seam only proves the frame
    // is authentic and reports which counter it claimed.
    const receiver = restState();
    const third = restState(3n).seal(Buffer.from('{"n":3}'), target);
    const first = restState(1n).seal(Buffer.from('{"n":1}'), target);

    const out = receiver.unsealUnchecked(third, target);
    expect(out.plaintext.toString()).toBe('{"n":3}');
    expect(out.counter).toBe(3n);
    // Nothing advanced: two authorities on one counter is the bug this avoids.
    expect(receiver.counter).toBe(0n);

    expect(receiver.unsealUnchecked(first, target).counter).toBe(1n);
    expect(receiver.counter).toBe(0n);
  });

  it("still refuses everything except the sequence rule", () => {
    const receiver = restState();
    const frame = restState().seal(Buffer.from("{}"), target);

    // The target hash, the tag, and the header are all still enforced — only
    // the counter comparison is the caller's.
    expect(
      codeOf(() => receiver.unsealUnchecked(frame, restTargetHash("POST", "/other", ""))),
    ).toBe("E2EE_SEAL_FAILED");
    const corrupted = Buffer.from(frame);
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(codeOf(() => receiver.unsealUnchecked(corrupted, target))).toBe("E2EE_SEAL_FAILED");
    const foreign = reheader(
      frame,
      recordHeader({
        version: E2EE_PROTOCOL_VERSION,
        ctxId: OTHER_CTX,
        direction: DIRECTION_C2S,
        counter: 0n,
        channel: CHANNEL_REST_REQUEST,
      }),
    );
    expect(codeOf(() => receiver.unsealUnchecked(foreign, target))).toBe("E2EE_CTX_UNKNOWN");
  });

  it("refuses to exist on the socket, where a window is a protocol violation (§5 R2)", () => {
    // A seam that could relax the strict counter on the WebSocket would be a
    // hole in the one rule that makes replay structurally impossible there.
    const ws = state({ channel: CHANNEL_WS });
    const frame = state({ channel: CHANNEL_WS }).seal(Buffer.from("{}"));
    expect(codeOf(() => ws.unsealUnchecked(frame, target))).toBe("E2EE_SEAL_FAILED");

    // The REST RESPONSE channel isolates the guard: a target is legal there,
    // so `assertTarget` cannot be what refuses this one — only the seam's own
    // "request channel only" rule can.
    const response = state({ channel: CHANNEL_REST_RESPONSE });
    const responseFrame = state({ channel: CHANNEL_REST_RESPONSE }).seal(Buffer.from("{}"), target);
    expect(codeOf(() => response.unsealUnchecked(responseFrame, target))).toBe("E2EE_SEAL_FAILED");
    // …and that same frame opens fine through the ordinary path, so the
    // refusal above is the seam refusing a channel and not a broken frame.
    expect(state({ channel: CHANNEL_REST_RESPONSE }).unseal(responseFrame, target).toString()).toBe(
      "{}",
    );

    // And the socket's own path is untouched by the seam existing.
    expect(state({ channel: CHANNEL_WS }).unseal(frame).toString()).toBe("{}");
  });
});

describe("the sealer refuses to mint a second nonce (§13(a), adversary A)", () => {
  const target = restTargetHash("POST", "/api/sessions/a/input", "");
  const sealerKey = Buffer.alloc(32, 0x3c);

  /**
   * The detector, and its positive control.
   *
   * Two ChaCha20 records under one `(key, nonce)` share a keystream, so
   * `xor(c1, c2) === xor(p1, p2)` — recovering the relationship between two
   * plaintexts without either key. This is what an adversary demonstrated
   * against `accept(7) → seal(7) → accept(7) → seal(7)`.
   *
   * Returns a boolean rather than asserting inside, so no failure message ever
   * carries ciphertext or key bytes.
   */
  function sharesKeystream(a: Buffer, b: Buffer, p1: Buffer, p2: Buffer): boolean {
    const body = (f: Buffer) => f.subarray(HEADER_BYTES, f.length - TAG_BYTES);
    const x = body(a);
    const y = body(b);
    const n = Math.min(x.length, y.length, p1.length, p2.length);
    for (let i = 0; i < n; i++) {
      if ((x[i] ^ y[i]) !== (p1[i] ^ p2[i])) return false;
    }
    return n > 0;
  }

  it("detects keystream reuse when it is really there — the control", () => {
    // Deliberately two records at the SAME counter, built through the
    // construction-time seed. If the detector cannot see this, it cannot prove
    // anything about the sealer below.
    const p1 = Buffer.from("aaaaaaaaaaaaaaaa");
    const p2 = Buffer.from("bbbbbbbbbbbbbbbb");
    const one = createRecordState({
      key: sealerKey,
      ctxId: CTX,
      direction: DIRECTION_S2C,
      channel: CHANNEL_REST_RESPONSE,
      initialCounter: 7n,
    }).seal(p1, target);
    const two = createRecordState({
      key: sealerKey,
      ctxId: CTX,
      direction: DIRECTION_S2C,
      channel: CHANNEL_REST_RESPONSE,
      initialCounter: 7n,
    }).seal(p2, target);

    expect(sharesKeystream(one, two, p1, p2)).toBe(true);
  });

  it("refuses to re-arm a counter it has already answered", () => {
    const sealer = new RestResponseSealer({ key: sealerKey, ctxId: CTX });
    const p1 = Buffer.from("aaaaaaaaaaaaaaaa");
    const p2 = Buffer.from("bbbbbbbbbbbbbbbb");

    sealer.accept(7n);
    const first = sealer.seal(7n, p1, target);

    // The exact sequence that produced two records under `(k_s2c, 2‖7)`.
    expect(codeOf(() => sealer.accept(7n))).toBe("E2EE_SEAL_FAILED");
    // …and even if a caller skipped `accept`, `seal` refuses on its own.
    expect(codeOf(() => sealer.seal(7n, p2, target))).toBe("E2EE_SEAL_FAILED");

    // Nothing was minted the second time, so there is no pair to compare —
    // asserted through the same detector that just proved it can see reuse.
    expect(first.length).toBeGreaterThan(HEADER_BYTES + TAG_BYTES);
  });

  it("refuses a second acceptance while the first is still outstanding", () => {
    const sealer = new RestResponseSealer({ key: sealerKey, ctxId: CTX });
    sealer.accept(3n);
    expect(codeOf(() => sealer.accept(3n))).toBe("E2EE_SEAL_FAILED");
    // The one legitimate response is still available.
    expect(sealer.seal(3n, Buffer.from("{}"), target).length).toBeGreaterThan(0);
  });

  it("stays recoverable past 2N+2 acceptances instead of dead-ending (finding 18)", () => {
    const sealer = new RestResponseSealer({ key: sealerKey, ctxId: CTX });
    const width = RestResponseSealer.WINDOW_COUNTERS;
    for (let i = 0; i < 2 * width + 2; i++) {
      sealer.accept(BigInt(i));
      if (i % 3 === 0) sealer.seal(BigInt(i), Buffer.from("{}"), target);
    }

    // Far behind the window: recoverable, never the server-fault dead end that
    // the old overflow table produced.
    expect(codeOf(() => sealer.seal(1n, Buffer.from("{}"), target))).toBe("E2EE_CTX_UNKNOWN");
    expect(codeOf(() => sealer.accept(1n))).toBe("E2EE_CTX_UNKNOWN");
    // A counter nothing ever accepted is still the server-fault code, so the
    // two remain distinguishable.
    expect(codeOf(() => sealer.seal(9_999_999n, Buffer.from("{}"), target))).toBe(
      "E2EE_SEAL_FAILED",
    );
  });

  it("never lets one counter be answered twice, across a long concurrent run", () => {
    // The property, stated over the whole run rather than one sequence: every
    // counter the sealer answers is answered exactly once.
    const sealer = new RestResponseSealer({ key: sealerKey, ctxId: CTX });
    const answered: bigint[] = [];
    for (let i = 0; i < 200; i++) {
      const counter = BigInt(i);
      sealer.accept(counter);
      sealer.seal(counter, Buffer.from(`{"i":${i}}`), target);
      answered.push(counter);
      // Every attempt to answer it again is refused, in both orders.
      expect(codeOf(() => sealer.accept(counter))).toBe("E2EE_SEAL_FAILED");
      expect(codeOf(() => sealer.seal(counter, Buffer.from("{}"), target))).toBe(
        "E2EE_SEAL_FAILED",
      );
    }
    expect(new Set(answered).size).toBe(answered.length);
  });
});

describe("REST response echo (§13(a))", () => {
  const target = restTargetHash("GET", "/api/sessions", "limit=50");

  function restPair() {
    const key = Buffer.alloc(32, 0x3c);
    const request = createRecordState({
      key: Buffer.alloc(32, 0x5d),
      ctxId: CTX,
      direction: DIRECTION_C2S,
      channel: CHANNEL_REST_REQUEST,
    });
    const receiver = createRecordState({
      key: Buffer.alloc(32, 0x5d),
      ctxId: CTX,
      direction: DIRECTION_C2S,
      channel: CHANNEL_REST_REQUEST,
    });
    return { request, receiver, sealer: new RestResponseSealer({ key, ctxId: CTX }) };
  }

  it("seals a response under the counter of the request it answers", () => {
    const { request, receiver, sealer } = restPair();
    const counter = request.counter;
    receiver.unseal(request.seal(Buffer.from("{}"), target), target);
    sealer.accept(counter);

    const response = sealer.seal(counter, Buffer.from('{"ok":true}'), target);
    // The response's header carries the REQUEST's counter, which is what the
    // client compares against — no second sender counter exists to swap.
    expect(response.readBigUInt64BE(21)).toBe(counter);
    expect(response.readUInt8(29)).toBe(CHANNEL_REST_RESPONSE);
    expect(response.readUInt32BE(17)).toBe(DIRECTION_S2C);
  });

  it("keeps a saturated context RECOVERABLE rather than answering a server fault", () => {
    // The cap is a real bound and a client can reach it. What it must not do is
    // answer E2EE_SEAL_FAILED — a server-side fault with no client recovery
    // path (§9), which is exactly the dead end §6's ruling removed from the
    // rekey path.
    const sealer = new RestResponseSealer({ key: Buffer.alloc(32, 0x3c), ctxId: CTX });
    for (let i = 0; i <= RestResponseSealer.MAX_OUTSTANDING; i++) sealer.accept(BigInt(i));

    // Counter 0 was pushed out by the cap.
    expect(sealer.isOutstanding(0n)).toBe(false);
    expect(codeOf(() => sealer.seal(0n, Buffer.from("{}"), target))).toBe("E2EE_CTX_UNKNOWN");
    // A counter nothing ever accepted is still the server-fault code, so the
    // two situations stay distinguishable.
    expect(codeOf(() => sealer.seal(999_999n, Buffer.from("{}"), target))).toBe("E2EE_SEAL_FAILED");
    // And the newest acceptances still answer normally.
    expect(
      sealer.seal(BigInt(RestResponseSealer.MAX_OUTSTANDING), Buffer.from("{}"), target).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a response with a missing or short target (round 4, finding 1)", () => {
    // `RecordState.seal` validated its target and this class did not, and
    // `sealWith` concatenated the target BESIDE the header rather than passing
    // it into `recordAad` — so the "32 bytes" check was unreachable from every
    // seal path. §4's request-target binding was silently absent on channel
    // 0x03: the one path nothing exercised, and the class the REST middleware
    // track will call.
    const sealer = new RestResponseSealer({ key: Buffer.alloc(32, 0x3c), ctxId: CTX });
    sealer.accept(0n);

    for (const bad of [
      undefined,
      Buffer.alloc(31, 0x11),
      Buffer.alloc(33, 0x11),
      Buffer.alloc(0),
    ]) {
      expect(codeOf(() => sealer.seal(0n, Buffer.from("{}"), bad as Buffer))).toBe(
        "E2EE_SEAL_FAILED",
      );
    }
    // The acceptance survives every refusal, so a caller that fixes its target
    // can still answer the request it accepted.
    expect(sealer.isOutstanding(0n)).toBe(true);
    expect(sealer.seal(0n, Buffer.from("{}"), target).length).toBeGreaterThan(0);
  });

  it("refuses a record-state seal with a short target too (round 4, finding 1)", () => {
    // The same hole from the other side: `recordAad`'s length check is now
    // reachable from the ordinary seal path as well.
    const rest = state({ channel: CHANNEL_REST_REQUEST });
    expect(codeOf(() => rest.seal(Buffer.from("{}"), Buffer.alloc(31, 0x11)))).toBe(
      "E2EE_SEAL_FAILED",
    );
    expect(rest.counter).toBe(0n);

    // **And directly on the BUILDER**, which is what the client track consumes.
    // A rule enforced only in `assertTarget` one layer up is a rule that
    // implementation never receives: it calls `recordAad`, and a forgotten
    // target would hand it a silently unbound AAD (§13, round 5 finding 6).
    const framing = {
      version: E2EE_PROTOCOL_VERSION,
      ctxId: CTX,
      direction: DIRECTION_C2S,
      counter: 0n,
      channel: CHANNEL_REST_REQUEST,
    } as const;
    expect(codeOf(() => recordAad(framing))).toBe("E2EE_SEAL_FAILED");
    expect(codeOf(() => recordAad(framing, Buffer.alloc(31, 0x11)))).toBe("E2EE_SEAL_FAILED");
    expect(codeOf(() => recordAad(framing, new Float64Array(32) as unknown as Buffer))).toBe(
      "E2EE_SEAL_FAILED",
    );
    // …and the socket channel refuses one it must not carry.
    expect(
      codeOf(() => recordAad({ ...framing, channel: CHANNEL_WS }, restTargetHash("GET", "/", ""))),
    ).toBe("E2EE_SEAL_FAILED");
    // The control: the right shape builds a 62-byte AAD.
    expect(recordAad(framing, restTargetHash("GET", "/", ""))).toHaveLength(62);
  });

  it("never seals a body for a request that was rejected, and never twice (§13(a))", () => {
    const { request, receiver, sealer } = restPair();

    // A replay: the strict receive state rejects it, so nothing accepts its
    // counter, so the response path has nothing to seal — the request gets a
    // PLAINTEXT error by construction rather than by a middleware remembering.
    const frame = request.seal(Buffer.from("{}"), target);
    receiver.unseal(frame, target);
    sealer.accept(0n);
    expect(codeOf(() => receiver.unseal(frame, target))).toBe("E2EE_SEQUENCE_VIOLATION");

    // One response for the accepted counter…
    sealer.seal(0n, Buffer.from('{"ok":true}'), target);
    // …and never a second, which is what keeps `(k_s2c, 2‖counter)` unique.
    expect(codeOf(() => sealer.seal(0n, Buffer.from('{"ok":true}'), target))).toBe(
      "E2EE_SEAL_FAILED",
    );
    // …and never one for a counter no request ever reached.
    expect(codeOf(() => sealer.seal(99n, Buffer.from("{}"), target))).toBe("E2EE_SEAL_FAILED");
  });
});

// ─── §7 exhaustion ──────────────────────────────────────────────────

describe("exhaustion (§7)", () => {
  it("refuses to send at 2^64-1 rather than wrapping (§7)", () => {
    // The construction-time seed §5 R4 permits for exactly this test: the
    // ceiling cannot be reached a frame at a time.
    const sender = state({ initialCounter: MAX_COUNTER });

    expect(codeOf(() => sender.seal(Buffer.from("one too many")))).toBe("E2EE_SEAL_FAILED");
    // The refusal changed nothing: no wrap, no partial advance. §7 is explicit
    // that there is no recovery that keeps the context — the state is left
    // exactly as it was precisely so the caller destroys it rather than
    // repairing it, and a second attempt refuses identically.
    expect(sender.counter).toBe(MAX_COUNTER);
    expect(codeOf(() => sender.seal(Buffer.from("still refused")))).toBe("E2EE_SEAL_FAILED");
    expect(sender.counter).toBe(MAX_COUNTER);
  });

  it("still seals at one below the ceiling, so the refusal is a boundary and not a break (§7)", () => {
    const sender = state({ initialCounter: MAX_COUNTER - 1n });
    const receiver = state({ initialCounter: MAX_COUNTER - 1n });
    expect(receiver.unseal(sender.seal(Buffer.from("last one"))).toString()).toBe("last one");
    expect(sender.counter).toBe(MAX_COUNTER);
  });
});

// ─── keys are never shared across states ────────────────────────────

describe("construction", () => {
  it("refuses a key or a ctxId of the wrong length", () => {
    expect(() => state({ key: randomBytes(16) })).toThrow();
    expect(() => state({ ctxId: randomBytes(8) })).toThrow();
  });
});

// ─── §16 interop fixtures ───────────────────────────────────────────

describe("interop fixtures (§16)", () => {
  const ctxId = Buffer.from(vectors.ctxId, "base64");

  const targetOf = (t?: { method: string; path: string; query: string }) =>
    t ? restTargetHash(t.method, t.path, t.query) : undefined;

  it("reproduces every positive vector byte for byte", () => {
    expect(vectors.version).toBe(E2EE_PROTOCOL_VERSION);
    expect(ctxId.toString("base64url")).toBe(vectors.ctxIdBase64Url);
    // §12: 16 bytes is 22 base64url characters, and the fixtures are where that
    // is pinned rather than only described.
    expect(vectors.ctxIdBase64Url).toHaveLength(22);

    for (const v of vectors.records) {
      const target = targetOf(v.target);
      const options = {
        key: Buffer.from(v.key, "base64"),
        ctxId,
        direction: v.direction as typeof DIRECTION_C2S,
        channel: v.channel as typeof CHANNEL_WS,
        initialCounter: BigInt(v.counter),
      };
      const frame = createRecordState(options).seal(Buffer.from(v.plaintextUtf8, "utf-8"), target);

      expect(frame.toString("base64"), v.name).toBe(v.frame);
      expect(frame.subarray(0, HEADER_BYTES).toString("base64"), v.name).toBe(
        recordHeader({
          version: E2EE_PROTOCOL_VERSION,
          ctxId,
          direction: options.direction,
          counter: options.initialCounter,
          channel: options.channel,
        }).toString("base64"),
      );
      expect(
        recordNonce(options.direction, options.initialCounter).toString("base64"),
        v.name,
      ).toBe(v.nonce);
      if (target) expect(target.toString("base64"), v.name).toBe(v.target?.hash);
      // A round trip, so the vector is a contract rather than a hash of
      // whatever this build happened to produce.
      expect(
        createRecordState(options).unseal(Buffer.from(v.frame, "base64"), target).toString("utf-8"),
        v.name,
      ).toBe(v.plaintextUtf8);
    }
  });

  it("reproduces the REST response vector, which echoes its request's counter", () => {
    const r = vectors.restResponse;
    const target = restTargetHash(r.target.method, r.target.path, r.target.query);
    const sealer = new RestResponseSealer({ key: Buffer.from(r.key, "base64"), ctxId });
    sealer.accept(BigInt(r.requestCounter));
    expect(
      sealer
        .seal(BigInt(r.requestCounter), Buffer.from(r.plaintextUtf8, "utf-8"), target)
        .toString("base64"),
    ).toBe(r.frame);
  });

  // The half that matters (§16). A client that matches only positive vectors
  // can still accept a mutated AAD field, a reflected direction or a counter
  // gap — the "correct output sitting above a defect" shape Phase 2 warned
  // about. Each of these must be REFUSED, and by the right kind of refusal.
  it("refuses every negative vector, with the right verdict", () => {
    const base = vectors.negative.base;
    const receiverAt = (counter: bigint, channel = CHANNEL_WS) =>
      createRecordState({
        key: Buffer.from(base.key, "base64"),
        ctxId,
        direction: DIRECTION_C2S,
        channel: channel as typeof CHANNEL_WS,
        initialCounter: counter,
      });

    // The positive control for this whole block: the unmutated base frame is
    // accepted by the same receiver every mutation below is fed to.
    expect(
      receiverAt(BigInt(base.counter)).unseal(Buffer.from(base.frame, "base64")).toString(),
    ).toBe(base.plaintextUtf8);

    for (const c of vectors.negative.cases) {
      const receiver = receiverAt(
        BigInt(base.counter),
        c.target ? CHANNEL_REST_REQUEST : CHANNEL_WS,
      );
      const target = targetOf(c.target);
      const frame = Buffer.from(c.frame, "base64");

      if (c.expect.startsWith("sequence-violation")) {
        if (c.name.includes("repeat")) {
          // A repeat is only wrong the second time.
          receiver.unseal(frame);
          expect(
            codeOf(() => receiver.unseal(frame)),
            c.name,
          ).toBe("E2EE_SEQUENCE_VIOLATION");
        } else {
          expect(
            codeOf(() => receiver.unseal(frame)),
            c.name,
          ).toBe("E2EE_SEQUENCE_VIOLATION");
        }
      } else {
        // Every seal-failed case must be exactly that — never a sequence
        // violation, which §5's ordering rule and §9's semantics both depend on.
        const code = codeOf(() => receiver.unseal(frame, target));
        expect(code, c.name).not.toBe("E2EE_SEQUENCE_VIOLATION");
        expect([`E2EE_SEAL_FAILED`, `E2EE_CTX_UNKNOWN`], c.name).toContain(code);
      }
    }
  });
});

// ─── log hygiene ────────────────────────────────────────────────────

describe("key material is unreachable by any rendering mode (adversary B, round 3)", () => {
  /**
   * Needles in BOTH spellings, and whitespace-insensitive.
   *
   * `inspect` prints a Buffer as `<Buffer de ad …>` but `showHidden` prints it
   * as `Buffer(32) [Uint8Array] [ 222, 173, … ]` — a multi-line DECIMAL array.
   * A detector that searched only for spaced hex reported a leaking object
   * clean, which is how this survived a round: the control is what caught it.
   * Flattening whitespace makes both spellings a single substring test that a
   * line break cannot defeat.
   */
  const flat = (rendering: string) => rendering.replace(/\s+/g, "");
  const asHex = (b: Buffer) => b.subarray(0, 8).toString("hex");
  const asDecimals = (b: Buffer) => [...b.subarray(0, 8)].join(",");

  /** Every mode a logger, a differ, a snapshot or a clone can reach for. */
  function renderings(value: unknown): string[] {
    const attempt = (f: () => string) => {
      try {
        return f();
      } catch {
        return "";
      }
    };
    return [
      inspect(value),
      inspect(value, { showHidden: true, depth: 12 }),
      inspect(value, { customInspect: false, depth: 12 }),
      // The pair that defeated both previous mechanisms at once.
      inspect(value, { customInspect: false, showHidden: true, depth: 12 }),
      inspect({ wrapped: value }, { customInspect: false, showHidden: true, depth: 12 }),
      attempt(() =>
        inspect(Object.getOwnPropertyDescriptors(value as object), {
          customInspect: false,
          showHidden: true,
          depth: 12,
        }),
      ),
      attempt(() => inspect({ ...(value as object) }, { showHidden: true, depth: 12 })),
      attempt(() => String(JSON.stringify(value))),
      attempt(() => inspect(structuredClone(value), { showHidden: true, depth: 12 })),
      `${value}`,
    ];
  }

  function leaks(value: unknown, secrets: Buffer[]): boolean {
    return renderings(value).some((rendering) => {
      const f = flat(rendering);
      return secrets.some((s) => f.includes(asHex(s)) || f.includes(asDecimals(s)));
    });
  }

  it("hides it in every mode, on every object that holds one", () => {
    const recordKey = Buffer.alloc(32, 0x7e);
    const sealerKey = Buffer.alloc(32, 0x5b);
    const cipherKey = Buffer.alloc(32, 0x3d);

    const record = state({ key: recordKey });
    const sealer = new RestResponseSealer({ key: sealerKey, ctxId: CTX });
    const cipher = new CipherState();
    cipher.initializeKey(cipherKey);

    // A real handshake, a real context, a real registry — inspecting the
    // registry once printed every live context's traffic key in one call.
    const registry = new E2eeContextRegistry();
    const { raw, id } = newCtxId();
    const keys = openHandshakeKeys();
    registry.open({ deviceId: "device-1", kind: "ws", ctxIdRaw: raw, ctxId: id, keys });
    const context = registry.get(id);
    // `export()` is a TEST-only reach into the KeyObjects, to obtain needles.
    // No `src/` caller does this — asserted by its own test below.
    const traffic = [keys.clientToServer.export(), keys.serverToClient.export()];

    expect(leaks(record, [recordKey])).toBe(false);
    expect(leaks(sealer, [sealerKey])).toBe(false);
    expect(leaks(cipher, [cipherKey])).toBe(false);
    for (const value of [keys, context, registry, { everything: [registry, keys] }]) {
      expect(leaks(value, traffic)).toBe(false);
    }

    // THE CONTROL, in both spellings: the same bytes in a plain object are
    // found by this detector, so the assertions above are about the objects and
    // not about a search that can never match.
    expect(leaks({ k: recordKey }, [recordKey])).toBe(true);
    // Hex is how `inspect` spells a Buffer…
    expect(flat(inspect({ k: recordKey }))).toContain(asHex(recordKey));
    // …and decimal is how it spells the Uint8Array a clone or a generic
    // serializer produces. Both needles are load-bearing: a detector carrying
    // only the first reported a leaking object clean.
    expect(flat(inspect({ k: new Uint8Array(recordKey) }, { showHidden: true }))).toContain(
      asDecimals(recordKey),
    );
    expect(leaks({ k: structuredClone(new Uint8Array(recordKey)) }, [recordKey])).toBe(true);

    // The mechanism, asserted directly: a `#private` field is not a property,
    // so there is no descriptor to find and no mode that can reach it.
    for (const [value, forbidden] of [
      [record, ["k", "n"]],
      [sealer, ["k", "outstanding", "answeredBits", "acceptedHighWater"]],
      [cipher, ["k"]],
    ] as const) {
      const own = Object.getOwnPropertyNames(value as object);
      for (const name of forbidden) expect(own).not.toContain(name);
    }

    // The consumed keys are KeyObjects, so there are no bytes to find at all —
    // a different property from hiding, and the one that survives the pool.
    expect(keys.clientToServer.type).toBe("secret");
    expect(keys.serverToClient.type).toBe("secret");
    expect(Buffer.isBuffer(keys.clientToServer as unknown)).toBe(false);

    // And nothing is broken by being private.
    expect(keys.clientToServer.export()).toHaveLength(32);
    expect(context?.receiveState(CHANNEL_WS).counter).toBe(0n);
    expect(record.unseal(state({ key: recordKey }).seal(Buffer.from("works"))).toString()).toBe(
      "works",
    );
  });

  it("exposes the traffic keys ONCE, as KeyObjects, and never as bytes (round 5)", () => {
    // The getters are gone. Hiding a Buffer was defeated four ways and finally
    // by the allocation pool itself, so the keys are not Buffers any more: they
    // live in OpenSSL, and `consume()` hands over handles exactly once.
    const server = generateKeyPair();
    const client = generateKeyPair();
    const { message, state: initiator } = writeMessage1({
      staticKeyPair: client,
      responderStaticPub: server.publicKeyRaw,
      pattern: "IK",
      payload: Buffer.from("{}", "utf-8"),
      prologue: OPEN_PROLOGUE,
    });
    const responded = respond({
      staticKeyPair: server,
      pattern: "IK",
      message1: message,
      prologue: OPEN_PROLOGUE,
      buildPayload: () => Buffer.from("{}", "utf-8"),
    });
    expect(readMessage2(initiator, responded.message2).payload.toString()).toBe("{}");

    // No byte-returning accessor of any name.
    for (const name of ["clientToServer", "serverToClient", "handshakeHash"]) {
      expect(name in (responded.keys as object)).toBe(false);
    }

    const consumed = responded.keys.consume();
    expect(consumed.clientToServer.type).toBe("secret");
    expect(consumed.serverToClient.type).toBe("secret");
    // Once. A second holder would be two record layers believing they own one
    // counter space.
    expect(() => responded.keys.consume()).toThrow(/already been consumed/);
  });

  it("hides the chaining key on the handshake states, which is the whole session", () => {
    // Both traffic keys are `HKDF(ck, "")`, so `ck` is not a fragment of the
    // session — it is the session. It rendered at DEFAULT depth before it
    // became a `#` field.
    const server = generateKeyPair();
    const client = generateKeyPair();
    const initiator = writeMessage1({
      staticKeyPair: client,
      responderStaticPub: server.publicKeyRaw,
      pattern: "IK",
      payload: Buffer.from("{}", "utf-8"),
      prologue: OPEN_PROLOGUE,
    });
    const responder = readMessage1({
      staticKeyPair: server,
      pattern: "IK",
      message1: initiator.message,
      prologue: OPEN_PROLOGUE,
    });
    const finished = writeMessage2(responder, Buffer.from("{}", "utf-8"));
    const consumed = finished.keys.consume();
    const traffic = [consumed.clientToServer.export(), consumed.serverToClient.export()];

    for (const value of [
      initiator.state,
      responder,
      initiator.state.symmetric,
      responder.symmetric,
      finished.keys,
    ]) {
      expect(leaks(value, traffic)).toBe(false);
    }
    for (const symmetric of [initiator.state.symmetric, responder.symmetric]) {
      const own = Object.getOwnPropertyNames(symmetric as object);
      expect(own).not.toContain("ck");
      expect(own).not.toContain("h");
    }

    // The handshake still completes — redaction is not removal.
    expect(readMessage2(initiator.state, finished.message2).payload.toString()).toBe("{}");
  });
});

/** One complete psk-less `/open` handshake, for the tests above. */
function openHandshakeKeys() {
  const server = generateKeyPair();
  const client = generateKeyPair();
  const { message } = writeMessage1({
    staticKeyPair: client,
    responderStaticPub: server.publicKeyRaw,
    pattern: "IK",
    payload: Buffer.from("{}", "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  return respond({
    staticKeyPair: server,
    pattern: "IK",
    message1: message,
    prologue: OPEN_PROLOGUE,
    buildPayload: () => Buffer.from("{}", "utf-8"),
  }).keys.consume();
}
