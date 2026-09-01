import { inspect } from "util";
import { type E2eeContext, E2eeContextRegistry, newCtxId } from "../src/e2ee/context";
import {
  generateKeyPair,
  OPEN_PROLOGUE,
  respond,
  type TrafficKeys,
  writeMessage1,
} from "../src/e2ee/noise";
import {
  CHANNEL_REST_REQUEST,
  CHANNEL_WS,
  createRecordState,
  DIRECTION_C2S,
  MAX_COUNTER,
  RecordError,
  RestResponseSealer,
  restTargetHash,
} from "../src/e2ee/record";
import { RestReceiveWindow } from "../src/e2ee/rest-window";

/**
 * The REST receive window (Phase 3), against NONCE-DESIGN §5, §9, §13 and
 * design.md §3.4.
 *
 * Everything context-level lives in this file rather than in
 * `e2ee-context.test.ts`: these tests exist *because of* this change — the
 * out-of-order one fails outright against the strict receive path — so keeping
 * them beside the window they exercise makes the slice reviewable in one place,
 * and leaves the context suite untouched for the track editing it in parallel.
 */

const WIDTH = BigInt(RestReceiveWindow.WINDOW_COUNTERS);

/** The code a `RecordError` carried, or the error itself if it was not one. */
function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (error) {
    if (error instanceof RecordError) return error.code;
    throw error;
  }
  return "no throw";
}

// ─── the window in isolation ────────────────────────────────────────

describe("RestReceiveWindow: acceptance (design.md §3.4)", () => {
  it("admits in-order counters", () => {
    const w = new RestReceiveWindow();
    for (let c = 0n; c < 3000n; c++) w.admit(c);
    // The control: the same counters cannot be admitted twice, so the loop
    // above recorded them rather than waving them through.
    expect(codeOf(() => w.admit(2999n))).toBe("E2EE_SEQUENCE_VIOLATION");
  });

  it("admits out-of-order arrivals inside the window — the reason it exists", () => {
    // React Query issues concurrent requests, so this arrival order is ordinary
    // on HTTP. Under the strict receive rule (§5 R2) every counter after the
    // first is a sequence violation and the client can never recover.
    const w = new RestReceiveWindow();
    for (const c of [5n, 3n, 4n, 1n, 2n, 0n]) w.admit(c);

    // Each one is now recorded on its own merits.
    for (const c of [0n, 1n, 2n, 3n, 4n, 5n]) {
      expect(codeOf(() => w.admit(c))).toBe("E2EE_SEQUENCE_VIOLATION");
    }
  });

  it("rejects an exact repeat as a sequence violation (§9)", () => {
    const w = new RestReceiveWindow();
    w.admit(7n);
    // Provably seen: the bit is this counter's own, not a wrapped neighbour's.
    // A claim about the peer, and true because the caller authenticated first.
    expect(codeOf(() => w.admit(7n))).toBe("E2EE_SEQUENCE_VIOLATION");
    // Above the mark, still fine.
    w.admit(8n);
  });

  it("rejects a counter below the window as recoverable, not as a violation (§9)", () => {
    const w = new RestReceiveWindow();
    w.admit(5000n);
    // It CANNOT be proven a replay — the bit that would say so now belongs to a
    // counter 1024 positions later — so it gets the recoverable code, matching
    // `RestResponseSealer.accept`'s own below-window edge. A dead end here is
    // the failure §13(a) forbids.
    expect(codeOf(() => w.admit(5000n - WIDTH))).toBe("E2EE_CTX_UNKNOWN");
  });

  it("decides below-window before it reads the bit", () => {
    // The ORDER of `admit`'s two rejection tests is load-bearing, and this is
    // the case that can tell them apart: counter 0 is below the window AND its
    // bitmap position is set — by counter 1024, which shares it.
    const w = new RestReceiveWindow();
    w.admit(0n);
    w.admit(WIDTH); // slides a full width, clearing position 0, then sets it again

    // 0 + 1024 <= 1024, so 0 is out of the window. The bit at its position says
    // "seen", but that bit is 1024's, not 0's — and only the range check knows
    // that. Reading the bit first answers `E2EE_SEQUENCE_VIOLATION`: an
    // unprovable claim about the peer where §9 requires the recoverable code.
    expect(codeOf(() => w.admit(0n))).toBe("E2EE_CTX_UNKNOWN");

    // And the refusal recorded nothing: the window is exactly as it was.
    expect(codeOf(() => w.admit(WIDTH))).toBe("E2EE_SEQUENCE_VIOLATION");
    expect(() => w.admit(2n)).not.toThrow();

    // The order decides which §9 code this case gets, not whether it is
    // rejected; §9 requires the recoverable one.
  });

  it("puts the boundary at exactly highWater - 1023", () => {
    const w = new RestReceiveWindow();
    w.admit(5000n);

    // 1023 behind is the oldest counter still inside.
    w.admit(5000n - 1023n);
    // 1024 behind is out.
    expect(codeOf(() => w.admit(5000n - 1024n))).toBe("E2EE_CTX_UNKNOWN");
    // …and one that was admitted while inside falls out when the mark moves on.
    w.admit(5001n);
    expect(codeOf(() => w.admit(5000n - 1023n))).toBe("E2EE_CTX_UNKNOWN");
  });

  it("rejects a counter no record nonce can carry", () => {
    const w = new RestReceiveWindow();
    expect(codeOf(() => w.admit(-1n))).toBe("E2EE_SEQUENCE_VIOLATION");
    expect(codeOf(() => w.admit(MAX_COUNTER + 1n))).toBe("E2EE_SEQUENCE_VIOLATION");
    // The control: the ceiling itself is a legal counter (§7 refuses to SEND at
    // it; a received one is in range).
    w.admit(MAX_COUNTER);
  });
});

describe("RestReceiveWindow: sliding (§13, the clear-on-slide)", () => {
  it("judges a wrapped index on its own merits after a slide, not on a stale bit", () => {
    // THE case the clear exists for. Bits are indexed modulo 1024, so counter
    // 1024 shares position 0 with counter 0. Without the clear it reads the bit
    // 0 set and is refused as a replay of a request it has nothing to do with —
    // a legitimate request rejected, and rejected for good.
    const w = new RestReceiveWindow();
    w.admit(0n);
    w.admit(2000n); // slides more than a full width: the whole bitmap is cleared

    // 1024 is inside the window (2000 - 1024 = 976 < 1024) and shares position
    // 0 with the counter admitted before the slide.
    expect(Number(1024n % WIDTH)).toBe(Number(0n % WIDTH));
    expect(() => w.admit(1024n)).not.toThrow();

    // Recorded on its own merits: a second arrival IS a replay…
    expect(codeOf(() => w.admit(1024n))).toBe("E2EE_SEQUENCE_VIOLATION");
    // …and the slide did not clear the bit of the counter that caused it.
    expect(codeOf(() => w.admit(2000n))).toBe("E2EE_SEQUENCE_VIOLATION");
    // …while 0 itself is now out of the window, which is the range check
    // answering, not the bit.
    expect(codeOf(() => w.admit(0n))).toBe("E2EE_CTX_UNKNOWN");
  });

  it("clears wrapped positions on a partial slide too, not only on a full one", () => {
    // The other branch: a slide of less than one width walks the positions it
    // newly covers. 1027 wraps onto position 3, which counter 3 set.
    const w = new RestReceiveWindow();
    w.admit(3n);
    w.admit(1000n);
    // 3 is still inside the window here and still remembered.
    expect(codeOf(() => w.admit(3n))).toBe("E2EE_SEQUENCE_VIOLATION");

    w.admit(1027n); // clears 1001..1027, and 1027 % 1024 === 3
    expect(Number(1027n % WIDTH)).toBe(3);
    // 1027 is remembered as itself…
    expect(codeOf(() => w.admit(1027n))).toBe("E2EE_SEQUENCE_VIOLATION");
    // …and 3 is answered by the range check, since 3 + 1024 <= 1027.
    expect(codeOf(() => w.admit(3n))).toBe("E2EE_CTX_UNKNOWN");
    // A fresh counter inside the window whose bit was cleared by that walk.
    w.admit(1010n);
  });

  it("costs O(min(delta, width)) on a jump, not O(delta)", () => {
    // Asserted with a TIMING BOUND. A per-counter loop over 10^9 BigInt
    // increments takes minutes; the bound is three orders of magnitude above
    // what the clamped version needs and three below what the loop would.
    const w = new RestReceiveWindow();
    w.admit(0n);
    const started = process.hrtime.bigint();
    w.admit(1_000_000_000n);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(100);

    // And the bitmap is CLEAR afterwards: every position in the new window is
    // free, which is what the fill(0) shortcut has to guarantee to be
    // equivalent to the walk it replaces.
    for (let i = 1n; i < WIDTH; i++) w.admit(1_000_000_000n - i);
    expect(codeOf(() => w.admit(1_000_000_000n))).toBe("E2EE_SEQUENCE_VIOLATION");
  });

  it("keeps the same width as the response sealer, by reference", () => {
    // §13(a): a counter this window still accepts must be one the sealer can
    // still answer. Two literals would drift; this is the coupling asserted.
    expect(RestReceiveWindow.WINDOW_COUNTERS).toBe(RestResponseSealer.WINDOW_COUNTERS);
    expect(RestReceiveWindow.WINDOW_COUNTERS).toBe(1024);
  });
});

describe("RestReceiveWindow: the state is unreachable (§13)", () => {
  it("exposes neither the high-water mark nor the bitmap to any rendering mode", () => {
    const w = new RestReceiveWindow();
    // A needle a renderer would have to print if the mark were a property.
    w.admit(123456789n);

    const renderings = [
      inspect(w),
      inspect(w, { showHidden: true, depth: 12 }),
      inspect(w, { customInspect: false, depth: 12 }),
      inspect(w, { showHidden: true, getters: true, customInspect: false, depth: 12 }),
      inspect({ wrapped: w }, { showHidden: true, getters: true, customInspect: false, depth: 12 }),
      inspect(Object.getOwnPropertyDescriptors(w), { showHidden: true, depth: 12 }),
      inspect({ ...w }, { showHidden: true, depth: 12 }),
      String(JSON.stringify(w)),
      Object.keys(w).join(","),
      `${w}`,
    ];
    for (const rendering of renderings) {
      expect(rendering).not.toContain("123456789");
      expect(rendering).not.toContain("highWater");
      expect(rendering).not.toContain("seenBits");
    }

    // THE CONTROL: the same needle in a plain container IS found, so the
    // assertions above are about the window and not about a search that can
    // never match.
    expect(inspect({ highWater: 123456789n }, { showHidden: true })).toContain("123456789");

    expect(Object.keys(w)).toHaveLength(0);
    expect(Object.getOwnPropertyNames(w)).not.toContain("highWater");
    expect(Object.getOwnPropertyNames(w)).not.toContain("seenBits");
  });

  it("cannot be re-armed by assignment", () => {
    const w = new RestReceiveWindow();
    w.admit(9n);

    // The attack: an untyped consumer rewinds the mark and clears the bitmap,
    // and every counter this context has already answered becomes admissible
    // again — a second sealed response under `(k_s2c, 2‖counter)`, which is
    // keystream reuse reached without touching a key. `#private` makes each
    // assignment land on a NEW ordinary property instead.
    const reachable = w as unknown as {
      highWater?: bigint;
      seenBits?: Uint8Array;
      advanceTo?: (c: bigint) => void;
      markSeen?: (c: bigint) => void;
    };
    reachable.highWater = -1n;
    reachable.seenBits = new Uint8Array(128);
    expect(reachable.advanceTo).toBeUndefined();
    expect(reachable.markSeen).toBeUndefined();

    expect(codeOf(() => w.admit(9n))).toBe("E2EE_SEQUENCE_VIOLATION");
  });
});

// ─── the context, end to end ────────────────────────────────────────

/** One complete `/open` handshake: psk-less IK, the open prologue (§11). */
function handshakeKeys(): TrafficKeys {
  const server = generateKeyPair();
  const client = generateKeyPair();
  const { message } = writeMessage1({
    staticKeyPair: client,
    responderStaticPub: server.publicKeyRaw,
    pattern: "IK",
    payload: Buffer.from(JSON.stringify({ v: 1, kind: "rest" }), "utf-8"),
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

const opened = new Map<string, TrafficKeys>();

function open(registry: E2eeContextRegistry, kind: "ws" | "rest"): E2eeContext {
  const { raw, id } = newCtxId();
  const keys = handshakeKeys();
  opened.set(id, keys);
  return registry.open({ deviceId: "device-1", kind, ctxIdRaw: raw, ctxId: id, keys });
}

/** The client half of a sealed REST request, from the context's own keys. */
function clientRequest(
  context: E2eeContext,
  target: Buffer,
  counter: bigint,
  body: string,
): Buffer {
  const keys = opened.get(context.ctxId) as TrafficKeys;
  return createRecordState({
    key: keys.clientToServer,
    ctxId: context.ctxIdRaw,
    direction: DIRECTION_C2S,
    channel: CHANNEL_REST_REQUEST,
    initialCounter: counter,
  }).seal(Buffer.from(body), target);
}

/** The client half of a sealed WebSocket frame. */
function clientFrame(context: E2eeContext, counter: bigint, body: string): Buffer {
  const keys = opened.get(context.ctxId) as TrafficKeys;
  return createRecordState({
    key: keys.clientToServer,
    ctxId: context.ctxIdRaw,
    direction: DIRECTION_C2S,
    channel: CHANNEL_WS,
    initialCounter: counter,
  }).seal(Buffer.from(body));
}

describe("a REST context is windowed and a socket context is not", () => {
  let registry: E2eeContextRegistry;
  beforeEach(() => {
    registry = new E2eeContextRegistry();
  });

  it("unseals two requests that arrive out of order", () => {
    // THE reason this change exists. Under the strict receive rule the second
    // call throws `E2EE_SEQUENCE_VIOLATION`, and a client that issues two
    // concurrent requests — which React Query does by default — can never make
    // progress.
    const rest = open(registry, "rest");
    const target = restTargetHash("GET", "/api/sessions", "limit=50");

    const second = clientRequest(rest, target, 1n, '{"q":"second"}');
    const first = clientRequest(rest, target, 0n, '{"q":"first"}');

    expect(rest.unsealRequest(second, target).toString()).toBe('{"q":"second"}');
    expect(rest.unsealRequest(first, target).toString()).toBe('{"q":"first"}');
  });

  it("rejects a replayed request frame as a sequence violation", () => {
    const rest = open(registry, "rest");
    const target = restTargetHash("POST", "/api/sessions/a/input", "");
    const frame = clientRequest(rest, target, 0n, '{"text":"ls"}');

    expect(rest.unsealRequest(frame, target).toString()).toBe('{"text":"ls"}');
    // The identical bytes again: authenticated — so the verdict is a true claim
    // about the peer (§9) — and refused by the window, not by the AEAD.
    expect(codeOf(() => rest.unsealRequest(frame, target))).toBe("E2EE_SEQUENCE_VIOLATION");
  });

  it("still seals exactly one response for the original request after a replay is refused", () => {
    // §13(a) survives the change: at most one sealed response per accepted
    // request counter. The replay above must not arm a second one, or two
    // records share `(k_s2c, 2‖counter)`.
    const rest = open(registry, "rest");
    const target = restTargetHash("POST", "/api/sessions/a/input", "");
    const frame = clientRequest(rest, target, 0n, '{"text":"ls"}');

    rest.unsealRequest(frame, target);
    expect(codeOf(() => rest.unsealRequest(frame, target))).toBe("E2EE_SEQUENCE_VIOLATION");

    // The one response the original request is owed…
    expect(rest.sealResponse(0n, Buffer.from('{"ok":true}'), target).length).toBeGreaterThan(0);
    // …and never a second, whatever the replay did.
    expect(codeOf(() => rest.sealResponse(0n, Buffer.from('{"ok":true}'), target))).toBe(
      "E2EE_SEAL_FAILED",
    );
  });

  it("keeps the socket's counter strictly monotonic (§5 R2)", () => {
    // THE most dangerous version of this change is one that relaxes the
    // WebSocket to share an implementation. A window there forfeits the
    // property that makes replay structurally impossible on the highest-volume
    // channel, and §14 forbids it outright.
    const ws = open(registry, "ws");
    const receive = ws.receiveState(CHANNEL_WS);

    // Out of order: counter 1 before counter 0.
    expect(codeOf(() => receive.unseal(clientFrame(ws, 1n, "second")))).toBe(
      "E2EE_SEQUENCE_VIOLATION",
    );
    // Nothing advanced (§5 R3), so the frame it WAS expecting still works…
    expect(receive.unseal(clientFrame(ws, 0n, "first")).toString()).toBe("first");
    // …and a repeat of that one is a violation too.
    expect(codeOf(() => receive.unseal(clientFrame(ws, 0n, "first")))).toBe(
      "E2EE_SEQUENCE_VIOLATION",
    );

    // The seam itself is closed: the window's only entry point refuses the
    // socket channel, so a REST-shaped receive cannot be reached from here.
    expect(codeOf(() => receive.unsealUnchecked(clientFrame(ws, 1n, "x"), Buffer.alloc(32)))).toBe(
      "E2EE_SEAL_FAILED",
    );
  });
});
