// The REST envelope: unseal on the way in, seal on the way out.
//
// Written against specs/end-to-end-encryption/NONCE-DESIGN.md §4, §5, §9, §10
// and §13, design.md §3.2/§3.4/§3.6, and dilemmas D-7 and D-9.
//
// **It sits between `corsMiddleware` and `authMiddleware`** (`api/app.ts`).
// After CORS, because a preflight must be answerable without a context — an
// `OPTIONS` carries no `X-TB-Ctx` and never will. Before auth, because that is
// the whole point of the ordering: the credential travels *inside* the envelope
// (D-9, §13(b)), so authentication cannot run until the body is plaintext.
//
// That places it on the pre-authentication attack surface, which is what the
// ladder below is for. **The one line everything follows from:**
//
//   > every refusal before a successful `unsealRequest` is plaintext;
//   > everything from a successful `unsealRequest` onward is sealed.
//
// A rejection must never carry a sealed body, because a sealed body would mean
// spending a response counter on a request that was never accepted — and §13(a)
// makes "at most one sealed response per accepted request counter" the rule
// nonce uniqueness for `(k_s2c, 2‖counter)` rests on.
//
// **This middleware never touches `sealer.accept`.** `Context.unsealRequest` is
// its sole caller, and that is what keeps the receive window's high-water mark
// and the response sealer's acceptance set in lockstep. A second caller
// anywhere produces requests that are accepted and can never be answered.

import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "http";
import { authenticateContext, contextRegistry, type E2eeContextRegistry } from "../../e2ee/context";
import {
  E2EE_CTX_UNKNOWN,
  E2EE_DEVICE_REVOKED,
  E2EE_SEAL_FAILED,
  E2EE_SEQUENCE_VIOLATION,
  type E2eeRejectionCode,
} from "../../e2ee/protocol";
import {
  CTX_ID_BYTES,
  MAX_RECORD_BYTES,
  RecordError,
  restTargetHashFromUrl,
} from "../../e2ee/record";
import { getLogger } from "../../logger";
import { hasCapability, requiredCapability } from "../../services/security/capabilities";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";
import { errorMiddleware } from "./error.middleware";

const log = getLogger("e2ee");

/** Routes that write to `c.env.outgoing` themselves return this sentinel. */
const ALREADY_HANDLED = 597;

/** Pure marker: its presence says "this request is sealed", nothing more. */
const HEADER_MARKER = "x-tb-e2ee";
/** The `ctxId`, base64url unpadded — 16 bytes is exactly 22 characters. */
const HEADER_CTX = "x-tb-ctx";
/** The request counter, decimal. Read early (§9 needs it), acted on late (§5). */
const HEADER_SEQ = "x-tb-seq";
/**
 * A sealed record whose HTTP framing cannot carry a body, base64url.
 *
 * The rule is one rule in both directions: bodiless requests (React Native
 * drops a `GET` body) and the one bodiless response (`304`) put the record
 * here; everything whose framing allows a body puts it in the body.
 */
const HEADER_ENVELOPE = "x-tb-env";

/** 16 raw bytes, base64url unpadded. Checked as a shape, never decoded. */
const CTX_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((CTX_ID_BYTES * 4) / 3)}}$`);

/**
 * A decimal counter that can fit `2^64 - 1`, checked before `BigInt` sees it.
 *
 * `BigInt("1e999")` and `BigInt(" 12 ")` both succeed, and `BigInt` on a long
 * digit string is not free — 20 digits is the width of the largest `uint64`, so
 * anything longer cannot be a counter and is refused without the conversion.
 */
const SEQ_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const MAX_SEQ = 2n ** 64n - 1n;

/**
 * Ceiling on the header-carried envelope, in ENCODED characters.
 *
 * A header-carried record answers a bodiless request, whose plaintext is empty
 * or near it: header(30) + tag(16) is 46 bytes, 62 base64url characters. 1024
 * is generous slack and still an order of magnitude under Node's 16 KiB header
 * limit, so this bound is the one that fires rather than a 431 from the parser
 * — which is what makes it testable, and testable is the only way it stays
 * true.
 *
 * **Bounded on the encoded length, not the decoded one**, exactly as
 * `pair-request.ts` argues: `Buffer.from(s, "base64url")` allocates in
 * proportion to `s`, so measuring the result performs the allocation the bound
 * exists to prevent.
 */
export const MAX_ENVELOPE_HEADER_CHARS = 1024;

/**
 * Ceiling on the body-carried envelope, taken from the record layer rather than
 * repeated: a frame over `MAX_RECORD_BYTES` is refused by `openFrame` anyway,
 * and a second literal is how the two drift into disagreement.
 */
export const MAX_ENVELOPE_BODY_BYTES = MAX_RECORD_BYTES;

/** Where the counter sits in a record header (§4): version, ctxId, direction. */
const COUNTER_OFFSET = 1 + CTX_ID_BYTES + 4;

/** The §9 code → HTTP status map, in one place so no call site invents one. */
function statusFor(code: E2eeRejectionCode): ContentfulStatusCode {
  switch (code) {
    // Recoverable: the client re-handshakes once and retries. 409 rather than
    // 401, which would send mobile round its re-auth UI for a context that
    // simply expired.
    case E2EE_CTX_UNKNOWN:
      return 409;
    case E2EE_DEVICE_REVOKED:
      return 403;
    default:
      return 400;
  }
}

/**
 * Whether a response with this status can carry a body at all.
 *
 * `304` and `204` cannot, and Node will silently drop anything written to one.
 * A sealed record for such a response therefore travels in `X-TB-Env` — the
 * same frozen rule the request side uses for a bodiless `GET`. The CORS
 * preflight's `204` never reaches here: `corsMiddleware` answers it first.
 */
function canCarryBody(status: number): boolean {
  return status !== 204 && status !== 304 && status >= 200;
}

/**
 * Read the body, refusing one that grows past `maxBytes`, memory flat.
 *
 * The same shape `e2ee.routes.ts` uses on `/api/e2ee/open` and for the same
 * reason (§10): the shared `readBody` concatenates every chunk before anything
 * looks at a size, so on a pre-authentication path a multi-GB POST is fully
 * buffered before any bound applies. `Content-Length` refuses the honest
 * oversized body before a byte arrives; the running total refuses the dishonest
 * one, and past the cap the chunks are DROPPED as they arrive rather than
 * collected — the connection stays healthy enough to carry the 413 back.
 */
class BodyTooLarge extends Error {}

function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBytes) {
        refused = true;
        chunks = [];
        reject(new BodyTooLarge("sealed request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/**
 * Hand the plaintext to BOTH body-read paths in this codebase.
 *
 * There are two, and a middleware that satisfies one and not the other ships a
 * hole shaped like whichever route it did not test:
 *
 *   1. ~15 handlers read the raw Node request — `readBody(c.env.incoming)` in
 *      `sessions.handlers.ts` and friends. The original `IncomingMessage` has
 *      already been drained to ciphertext by the time we get here and cannot be
 *      re-pushed after `end`, so `c.env.incoming` is REPLACED by a real
 *      `IncomingMessage` carrying the plaintext. `env` is a fresh object
 *      literal per request inside `@hono/node-server`, so the assignment is
 *      local to this request.
 *   2. three routes read `c.req.arrayBuffer()`. Hono answers that from
 *      `HonoRequest.bodyCache`, which short-circuits `raw` entirely — so
 *      seeding the cache is what makes `arrayBuffer()`, `text()` and `json()`
 *      all resolve to the plaintext (`#cachedBody` converts between them
 *      through `new Response(body)[key]()`).
 *
 * `Content-Length` is restated and `Transfer-Encoding` dropped, because the
 * plaintext is a different length from the record that carried it and a handler
 * that trusts the header would otherwise be told the ciphertext's size.
 */
function replaceRequestBody(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  original: IncomingMessage,
  plaintext: Buffer,
): void {
  const replacement = new IncomingMessage(original.socket);
  replacement.url = original.url;
  replacement.method = original.method;
  replacement.httpVersion = original.httpVersion;
  replacement.httpVersionMajor = original.httpVersionMajor;
  replacement.httpVersionMinor = original.httpVersionMinor;
  replacement.rawHeaders = original.rawHeaders;
  // Spread copies OWN enumerable properties only, so this carries nothing down
  // from a polluted `Object.prototype` (measured). `url`, `method`,
  // `httpVersion*` and `rawHeaders` above are own properties of a live
  // `IncomingMessage` and are read directly for the same reason.
  const headers = { ...original.headers };
  delete headers["transfer-encoding"];
  headers["content-length"] = String(plaintext.byteLength);
  replacement.headers = headers;
  // Everything this stream will ever hold is pushed below, so there is nothing
  // to pull. `IncomingMessage.prototype._read` resumes the underlying socket,
  // which this object does not own — it is the real request's socket, already
  // drained and managed by the http parser.
  (replacement as unknown as { _read: () => void })._read = () => {};
  replacement.push(plaintext);
  replacement.push(null);
  // **`complete` is load-bearing, not cosmetic.** `IncomingMessage._destroy`
  // reads it as "was this message fully received", and a stream that ends
  // without it is treated as ABORTED — which destroys `this.socket`, and this
  // object's socket is the real connection. The symptom is a socket hang up on
  // exactly the requests whose handler read the body through `c.env.incoming`,
  // with the response already written; everything else passes.
  replacement.complete = true;
  c.env.incoming = replacement;

  // `bodyCache` is typed `Partial<Body>`, so its `arrayBuffer` slot types as
  // the METHOD; at runtime `#cachedBody` stores and awaits a PROMISE there.
  // The cast is to the runtime contract, not around it.
  const cache = c.req.bodyCache as { arrayBuffer?: Promise<ArrayBuffer> };
  cache.arrayBuffer = Promise.resolve(
    plaintext.buffer.slice(
      plaintext.byteOffset,
      plaintext.byteOffset + plaintext.byteLength,
    ) as ArrayBuffer,
  );
}

/**
 * Buffer everything a direct-write handler produces and seal it once, at `end`.
 *
 * ~34 routes write straight to `c.env.outgoing` and return the 597
 * `ALREADY_HANDLED` sentinel, so Hono never sees their response at all. The
 * `write`/`end` pair is the same seam `countResponseBytes` already patches in
 * `app.ts` — that one only counts, this one has to buffer and rewrite the
 * framing (§13's "not settled here" list names exactly this).
 *
 * The patches are installed BEFORE `next()`, because a handler can write and
 * end before `next()` returns (several routes do not even await their handler).
 *
 * **The ndjson `stop` stream is buffered like everything else, deliberately.**
 * `POST /api/sessions/:id/stop` is the only `application/x-ndjson` in the tree;
 * it writes a `stopping` line, waits up to 5 s, then writes `stopped` or
 * `timeout`. Sealing per line is NOT available: the AAD is fixed-width with no
 * index field (§4), and the sealer permits exactly one seal per accepted
 * counter (§13(a)) — so a second line would either reuse `(k_s2c, 2‖counter)`
 * or be refused. There is no added wall-clock latency, since the response
 * completes when the handler ends either way. What is lost is the EARLY ARRIVAL
 * of the intermediate `stopping` line: the client learns the stop began only
 * when it learns how it finished. Multi-record ndjson needs an envelope version
 * with an index field, which is a protocol change and not this one.
 */
function interceptDirectWrite(
  outgoing: ServerResponse,
  seal: (
    status: number,
    headers: OutgoingHttpHeaders,
    plaintext: Buffer,
  ) => { status: number; headers: OutgoingHttpHeaders; body?: Buffer },
): () => void {
  let status = 200;
  let headers: OutgoingHttpHeaders = {};
  const chunks: Buffer[] = [];
  let done = false;

  // The PREVIOUS functions, not the prototype's: `countResponseBytes` in
  // `app.ts` has already patched `write`/`end` by the time this runs, and its
  // byte count has to keep seeing what actually goes out — which is the sealed
  // record, since that is what the client receives.
  const prevWriteHead = outgoing.writeHead;
  const prevWrite = outgoing.write;
  const prevEnd = outgoing.end;
  const prevSetHeader = outgoing.setHeader;

  const collect = (chunk: unknown) => {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  };

  outgoing.writeHead = function (this: ServerResponse, code: number, ...rest: unknown[]) {
    status = code;
    for (const arg of rest) {
      if (arg && typeof arg === "object") headers = { ...headers, ...(arg as OutgoingHttpHeaders) };
    }
    return this;
  } as typeof outgoing.writeHead;

  // Only the three framing headers are swallowed. Everything else — `ETag`,
  // `Accept-Query`, the CORS headers `corsMiddleware` already set — is metadata
  // that stays plaintext by design (§3.2) and must reach the wire unchanged.
  outgoing.setHeader = function (this: ServerResponse, name: string, value: never) {
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "content-length" || lower === "transfer-encoding") {
      return this;
    }
    return (prevSetHeader as (n: string, v: never) => ServerResponse).call(this, name, value);
  } as typeof outgoing.setHeader;

  outgoing.write = function (this: ServerResponse, ...args: unknown[]) {
    collect(args[0]);
    const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
    cb?.();
    return true;
  } as typeof outgoing.write;

  outgoing.end = function (this: ServerResponse, ...args: unknown[]) {
    // A second `end()` is a no-op, not a second seal.
    //
    // **This fires on every direct-write route, not on a hypothetical handler
    // that ends twice.** `responseViaResponseObject` in `@hono/node-server`
    // takes the 597 sentinel `Response(null, …)`, finds no body and no
    // `x-already-sent`, and calls `outgoing.writeHead(597, …)` then
    // `outgoing.end()` — after the handler has already written and ended.
    // Today that second `writeHead` throws `ERR_HTTP_HEADERS_SENT` and
    // node-server swallows it in `handleResponseError`; through this patch it
    // would instead ask the sealer for a SECOND record under a counter already
    // spent. Removing this line turns every sealed direct-write response into
    // an unhandled `ERR_HTTP_HEADERS_SENT` (measured: the mutation leaves all
    // assertions green and the suite exits non-zero on four such rejections).
    if (done) return this;
    done = true;
    collect(args[0]);
    const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
    const out = seal(status, headers, Buffer.concat(chunks));
    (prevWriteHead as (s: number, h: OutgoingHttpHeaders) => ServerResponse).call(
      this,
      out.status,
      out.headers,
    );
    const end = prevEnd as (...a: unknown[]) => ServerResponse;
    if (out.body) end.call(this, out.body, cb);
    else end.call(this, cb);
    return this;
  } as typeof outgoing.end;

  /**
   * Take the patches back off.
   *
   * A Hono-PIPED response is written to `outgoing` by `@hono/node-server` after
   * this middleware has returned, and it is written through exactly these four
   * methods. Left installed, they would buffer the response this middleware had
   * already sealed and ask the sealer for a SECOND record under a counter it
   * has spent — which the sealer refuses, turning a served request into a 500.
   * The piped path seals `c.res` instead, and takes these off first.
   */
  return () => {
    outgoing.writeHead = prevWriteHead;
    outgoing.write = prevWrite;
    outgoing.end = prevEnd;
    outgoing.setHeader = prevSetHeader;
  };
}

export const e2eeEnvelopeMiddleware = (
  /**
   * The device registry, for §13(b)'s per-request `revoked_at` re-check.
   *
   * Read through `deps.devicesRepo()` on every request rather than captured
   * once: the repository is rebuilt when the database is reopened, and a
   * captured handle would keep re-checking revocation against a store that is
   * no longer the live one — which fails OPEN, since a revoked device would
   * still read as live in the stale copy.
   */
  deps: Pick<ApiDeps, "devicesRepo">,
  /** Overridden by tests so a suite gets its own registry rather than the process one. */
  registry: E2eeContextRegistry = contextRegistry(),
): MiddlewareHandler<AppEnv> =>
  async function e2eeEnvelope(c, next) {
    // ── Rung 1: not a sealed request ────────────────────────────────
    //
    // One header read, and then this middleware is not in the picture. An
    // unpinned device with the shared API key does exactly what it does today:
    // nothing below has run, no body has been touched, no response method has
    // been patched.
    if (c.req.header(HEADER_MARKER) === undefined) return next();

    const refuse = (code: E2eeRejectionCode, message: string, status = statusFor(code)) => {
      // Plaintext, always: a refusal here is a refusal BEFORE a successful
      // unseal, so no counter was accepted and no sealed body is owed (§13(a)).
      // The body carries the code and nothing about what was sent.
      log.warn(`[e2ee] sealed request refused: ${code}`, { event: "e2ee.rest_refused", code });
      return c.json({ error: message, code }, status);
    };

    // Not a rung — a precondition. The target hash must come from the raw wire
    // URL, which only the Node request has; under Hono's test client there is
    // no `incoming` and no honest way to compute it.
    const incoming = c.env?.incoming;
    const outgoing = c.env?.outgoing;
    if (!incoming || !outgoing) {
      return refuse(E2EE_SEAL_FAILED, "sealed requests require the Node request seam", 400);
    }

    // ── Rung 2: the ctxId's shape ───────────────────────────────────
    // Length and charset. Nothing is decoded and nothing is looked up.
    const ctxId = c.req.header(HEADER_CTX);
    if (!ctxId || !CTX_ID_PATTERN.test(ctxId)) {
      return refuse(E2EE_CTX_UNKNOWN, "X-TB-Ctx is not a context id");
    }

    // ── Rung 3: the registry lookup ─────────────────────────────────
    //
    // **THE D-9 property.** An unknown `ctxId` costs one `Map.get` and nothing
    // else: no allocation, and the body is never read. That is why this sits
    // above every line that touches the request stream rather than below them,
    // and why the ladder is written as a ladder at all.
    //
    // Read it off the structure rather than trusting this sentence: between
    // rung 1 and this line there is one header read, one `refuse` closure and
    // two `c.env` property reads. `incoming` is a REFERENCE here and nothing
    // more — the only call that touches the stream is `readBoundedBody` at rung
    // 7, and every header this ladder consults is read through `c.req.header`,
    // which reads the parsed header table and never the stream.
    const context = registry.get(ctxId);
    if (!context) return refuse(E2EE_CTX_UNKNOWN, "no such encrypted context");

    // ── Rung 4: the channel ─────────────────────────────────────────
    // A socket context has no window and no response sealer; asking it to
    // unseal a REST request is a misaddressed frame, not a malformed one.
    if (context.kind !== "rest") {
      return refuse(E2EE_CTX_UNKNOWN, "that context is not a REST context");
    }

    // ── Rung 5: the counter's shape ─────────────────────────────────
    //
    // Read here, ACTED ON at rung 9 — after the AEAD. §5's ordering rule: a
    // pre-authentication counter check makes `E2EE_SEQUENCE_VIOLATION` an
    // unauthenticated verdict about the peer and buys no protection, because
    // the same attacker can as cheaply send garbage carrying the right counter.
    const seqHeader = c.req.header(HEADER_SEQ);
    if (!seqHeader || !SEQ_PATTERN.test(seqHeader)) {
      return refuse(E2EE_SEQUENCE_VIOLATION, "X-TB-Seq is not a counter");
    }
    const claimedSeq = BigInt(seqHeader);
    if (claimedSeq > MAX_SEQ) {
      return refuse(E2EE_SEQUENCE_VIOLATION, "X-TB-Seq is outside the range of a record nonce");
    }

    // ── Rung 5a: exactly one envelope source ────────────────────────
    //
    // A presence test, no read. Two sources is not a client this contract
    // describes: it is someone hoping the two halves are checked by different
    // code, so that the bound applied to one is skipped on the other. There is
    // no "prefer the body" tie-break, because a tie-break is a choice an
    // attacker gets to make.
    //
    // **Both framing headers are read through `c.req.header`, and that is not
    // decoration.** Node builds `req.headers` with `Object.prototype`, and a
    // header absent from the wire is absent as an OWN property, so a bare
    // `incoming.headers["content-length"]` is a prototype-chain read —
    // measured on a live request, not reasoned about. Either half of that is an
    // unauthenticated denial of the whole REST envelope. Both vectors were
    // MEASURED against a live server rather than reasoned about, and both are
    // stated at the width they were measured at:
    //
    //   - a polluted `transfer-encoding` makes `hasBodyFraming` true for a
    //     bodiless `GET`, which carries neither framing header on the wire, so
    //     a legitimate sealed `GET` in `X-TB-Env` is refused as carrying two
    //     envelopes (400 `E2EE_SEAL_FAILED`);
    //   - a polluted `content-length` reaches rung 6 for a CHUNKED sealed
    //     request, which sends no `content-length` at all, and a forged
    //     declaration over the bound is a 413 before a byte is read.
    //
    // Note what is NOT claimed: a request that declares its own
    // `content-length` is unaffected, because an own property shadows the
    // prototype. The reachable half is the absent half, which is the general
    // shape of this bug and the reason it hides — you cannot poison a header
    // that is there.
    //
    // Neither is a bypass; the AEAD and the window are both still below. But
    // the channel is off the air, it is reachable from any prototype-pollution
    // sink anywhere in the process by an attacker who never touches the
    // crypto, and denial is not the lesser outcome.
    //
    // The remedy is the framework accessor, not our `own()` helper, and the
    // difference is that `c.req.header` cannot be refactored back into a
    // prototype read. `@hono/node-server` 2.1.1 `RequestHeaders#lookupHttp1`
    // gates on `Object.hasOwn(headers, lowerName)` and returns `null` when the
    // header is not an own property (`dist/index.mjs:84`); on the paths it
    // declines — HTTP/2, `set-cookie`, `__proto__`, a non-string raw value — it
    // falls through to a scan of the raw wire header array, which has no
    // prototype to poison either. So absence reads as absence by construction
    // at both layers. `own()` remains correct but is one edit away from being
    // wrong; this is zero edits away.
    const envelopeHeader = c.req.header(HEADER_ENVELOPE);
    const declaredLength = c.req.header("content-length");
    const hasBodyFraming =
      c.req.header("transfer-encoding") !== undefined ||
      (declaredLength !== undefined && declaredLength !== "0");
    if (envelopeHeader !== undefined && hasBodyFraming) {
      return refuse(E2EE_SEAL_FAILED, "a sealed request carries one envelope, not two");
    }
    if (envelopeHeader === undefined && !hasBodyFraming) {
      return refuse(E2EE_SEAL_FAILED, "a sealed request carries an envelope");
    }

    // ── Rungs 6 and 7: the bounds, then the read ────────────────────
    let frame: Buffer;
    if (envelopeHeader !== undefined) {
      // Rung 6, header form: the ENCODED length, before any base64url decode.
      if (envelopeHeader.length > MAX_ENVELOPE_HEADER_CHARS) {
        return refuse(E2EE_SEAL_FAILED, "X-TB-Env is too large", 413);
      }
      frame = Buffer.from(envelopeHeader, "base64url");
      // `Buffer.from` never throws on base64url — it discards what it cannot
      // decode, so garbage becomes a short buffer rather than an error.
      if (frame.byteLength === 0) {
        return refuse(E2EE_SEAL_FAILED, "X-TB-Env is not valid base64url");
      }
    } else {
      // Rung 6, body form: the declared length, before a byte is read.
      const declared = Number(declaredLength);
      if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BODY_BYTES) {
        return refuse(E2EE_SEAL_FAILED, "sealed request body is too large", 413);
      }
      try {
        // Rung 7: and the running total, for a sender that lied.
        frame = await readBoundedBody(incoming, MAX_ENVELOPE_BODY_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          return refuse(E2EE_SEAL_FAILED, err.message, 413);
        }
        return refuse(E2EE_SEAL_FAILED, "could not read the sealed request body", 400);
      }
    }

    // ── Rung 8: the AEAD ────────────────────────────────────────────
    //
    // **The target comes from the RAW wire URL** — the bytes Node received —
    // and never from `c.req.path`, which is percent-decoded, nor from a
    // re-serialised query, whose order and escaping do not round-trip (§4).
    // `/api/conversations/a%2Fb` and `/api/conversations/a/b` are different
    // targets and must hash differently; the fixture
    // `restTargetCanonicalization.decodedPathMustDiffer` is the authority.
    const target = restTargetHashFromUrl(incoming.method ?? c.req.method, incoming.url ?? "");
    let plaintext: Buffer;
    try {
      // `unsealRequest` runs the AEAD, then the window, then the sealer's
      // acceptance — and it is the SOLE caller of `sealer.accept`. This
      // middleware never reaches for the sealer itself: the window's high-water
      // mark and the sealer's acceptance set stay in lockstep only because one
      // call site advances both.
      plaintext = context.unsealRequest(frame, target);
    } catch (err) {
      if (err instanceof RecordError) return refuse(err.code, "could not unseal the request");
      throw err;
    }

    // ── Rung 9: the AUTHENTICATED counter against the claimed one ───
    //
    // Now, and not before. The counter read here comes out of a frame the AEAD
    // has already proven came from the peer — it is a field of the AAD, so a
    // rewrite would have failed the tag — which is what makes
    // `E2EE_SEQUENCE_VIOLATION` a true claim about the peer rather than a
    // verdict on anyone who can inject bytes (§9).
    const counter = frame.readBigUInt64BE(COUNTER_OFFSET);
    if (counter !== claimedSeq) {
      return refuse(E2EE_SEQUENCE_VIOLATION, "X-TB-Seq does not match the sealed counter");
    }

    replaceRequestBody(c, incoming, plaintext);
    c.set("e2eeContext", context);

    /** The one seal this request is owed, and the framing it goes out in. */
    let spent = false;
    const sealOnce = (
      status: number,
      inHeaders: OutgoingHttpHeaders,
      body: Buffer,
    ): { status: number; headers: OutgoingHttpHeaders; body?: Buffer } => {
      const headers: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(inHeaders)) {
        const lower = k.toLowerCase();
        if (lower === "content-type" || lower === "content-length") continue;
        if (lower === "transfer-encoding") continue;
        headers[k] = v;
      }
      let record: Buffer;
      try {
        if (spent) throw new RecordError(E2EE_SEAL_FAILED, "this request was already answered");
        spent = true;
        record = context.sealResponse(counter, body, target);
      } catch {
        // A server-side fault (§9). Plaintext, because the alternative is a
        // second seal under a counter already spent — the one failure §13
        // exists to prevent — and because a client that cannot unseal an error
        // has no way to learn what happened.
        const payload = Buffer.from(
          JSON.stringify({ error: "Could not seal the response", code: E2EE_SEAL_FAILED }),
        );
        return {
          status: 500,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Content-Length": payload.byteLength,
          },
          body: payload,
        };
      }
      headers[HEADER_MARKER] = "1";
      if (!canCarryBody(status)) {
        // The frozen rule, response side: a record whose framing cannot carry a
        // body travels base64url in `X-TB-Env`. The only such response in the
        // tree is the `304` at `conversations.handlers.ts`, and it still owes
        // the one sealed record its counter was accepted for.
        headers[HEADER_ENVELOPE] = record.toString("base64url");
        return { status, headers };
      }
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = record.byteLength;
      return { status, headers, body: record };
    };

    /**
     * Answer this request with the ONE sealed record its counter is owed.
     *
     * Every refusal from here down goes through here and never through
     * `refuse`. That is §13(a) read from the far side: above the unseal,
     * plaintext only; below it, sealed only. `unsealRequest` has succeeded, so
     * the counter is committed and exactly one sealed response is owed — and a
     * plaintext answer at this point would be an unauthenticated party's word
     * about an authenticated request.
     */
    const refuseSealed = (status: number, payload: Record<string, unknown>): Response => {
      // Deliberately NOT logged. `refuse` above logs its code because a
      // pre-unseal refusal says nothing about anyone; these three say who was
      // refused and why, which is a claim about an identified device, and the
      // program rule is that no context state reaches a log line.
      const out = sealOnce(status, {}, Buffer.from(JSON.stringify(payload), "utf-8"));
      const headers = new Headers();
      for (const [k, v] of Object.entries(out.headers)) {
        if (v !== undefined) headers.set(k, String(v));
      }
      return new Response(out.body ? new Uint8Array(out.body) : null, {
        status: out.status,
        headers,
      });
    };

    // ── Rung 12: the context principal (§13(b), design.md §4.4) ─────
    //
    // The credential presented BESIDE the context, if any. §13(b) says a
    // sealed request carries none — the context already names the device — so
    // `undefined` is the ordinary case and an ordinary success. Read the same
    // two places `authMiddleware` reads, or a device could dodge the mismatch
    // check by moving its token from the header to the query string.
    const authorization = c.req.header("authorization");
    const presented =
      (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined) ??
      c.req.query("key") ??
      undefined;

    // A PURE verdict. The helper states the fact it found; the HTTP mapping and
    // the lifecycle effect below are this caller's policy, and the WebSocket
    // caller maps the same three reasons onto close reasons instead.
    const auth = authenticateContext({
      context,
      devicesRepo: deps.devicesRepo(),
      presented,
    });

    if (!auth.ok) {
      // **Seal FIRST, with the still-live context. Destroy after, and only on
      // `device-revoked`.**
      //
      // This ordering is load-bearing at v1.72.0 and was not at v1.71.0.
      // W1b shipped real invalidation (streamer #743): `registry.destroy()`
      // runs `contextInvalidators`, which nulls the context's response sealer,
      // and `sealResponse` throws through `requireRest()` the moment it is
      // null. So destroying first does not merely risk a future problem — it
      // turns this refusal into a 500 the phone cannot decrypt, on the one
      // code (§9 `E2EE_DEVICE_REVOKED`) the client is told never to retry.
      const sealed =
        auth.reason === "device-revoked"
          ? refuseSealed(403, { error: "This device is not paired", code: E2EE_DEVICE_REVOKED })
          : auth.reason === "no-device-store"
            ? // Transient, and deliberately NOT `E2EE_DEVICE_REVOKED`: §9 makes
              // that a hard failure the client must never retry, and a registry
              // we could not read says nothing about the pairing. A 403 here
              // would tell the phone its device was revoked because our disk
              // faulted. Byte-identical to the WS caller's answer
              // (`auth.middleware.ts`) and to `devices.routes.ts`.
              refuseSealed(503, {
                error: "Device registry is unavailable",
                code: "STORE_UNAVAILABLE",
              })
            : // `credential-mismatch`, including the shared API key, which names
              // no device and is a mismatch rather than an exemption.
              refuseSealed(401, { error: "Unauthorized" });

      // **Only `device-revoked` destroys, and the discriminator generalises:
      // destroy on a fact in our own database that an attacker cannot forge,
      // never on a header an attacker supplied.** `X-TB-Ctx` travels in
      // plaintext on every sealed request, so a destroy reachable through a
      // mismatched credential would let anyone who reads one request kill that
      // device's context on repeat — forge a credential beside the observed id,
      // watch the victim re-open, read the new id, repeat. `no-device-store`
      // says nothing about the device either, and its context also survives.
      if (auth.reason === "device-revoked") registry.destroy(ctxId);
      return sealed;
    }

    // The principal is built from the CONTEXT's device id, never from the
    // credential and never from the row — `principal.deviceId ===
    // context.deviceId` by construction, which is stronger than checking that
    // they agree.
    c.set("principal", auth.principal);

    // ── Rung 13: authority, not just identity ───────────────────────
    //
    // A context AUTHENTICATES; it does not authorize. `authMiddleware` skips
    // only credential RESOLUTION when a principal is already set and still runs
    // this same check itself, so the two are defence in depth rather than one
    // check in two places — see the note on the campaign row: neither mutation
    // reddens alone, by design, and the safeguard is the pair.
    const required = requiredCapability(new URL(c.req.url).pathname, c.req.method);
    if (required !== null && !hasCapability(auth.principal, required)) {
      // Sealed, like every other answer this counter is owed — and the context
      // SURVIVES. Unlike the WebSocket caller, which destroys here because its
      // ticket is already spent and the context it promoted would otherwise be
      // orphaned for 24 h, a REST context is long-lived and addressable again
      // on the very next request. A read-only device that touches one write
      // route must not lose the channel it is entitled to use.
      return refuseSealed(403, { error: "Forbidden", code: "MISSING_CAPABILITY", required });
    }

    // Installed BEFORE `next()`: several direct-write routes do not await their
    // handler, so `end` can fire after `next()` has already returned.
    const restoreDirectWrite = interceptDirectWrite(outgoing, sealOnce);

    try {
      await next();
    } catch (err) {
      // **A thrown handler still owes its one sealed response.** Hono's
      // `onError` runs OUTSIDE this middleware — by the time it produces a
      // response, `next()` has already thrown past here and there is nothing
      // left to seal it. So the same handler is invoked here and its answer
      // goes out through the same seal. One implementation of the error shape,
      // not two.
      c.res = await errorMiddleware(err as Error, c);
    }

    // A direct-write route returns the 597 sentinel and has written (or will
    // write) to `outgoing`; the patched `end` seals it. Nothing to do here —
    // and the patches stay on, because several routes do not await their
    // handler and `end` may still be ahead of us.
    if (c.res.status === ALREADY_HANDLED) return;

    // ── The Hono-piped path ─────────────────────────────────────────
    //
    // `@hono/node-server` will write `c.res` to `outgoing` through the same
    // four methods, so they come off first or the response is sealed twice.
    restoreDirectWrite();
    const body = Buffer.from(await c.res.arrayBuffer());
    const headers: OutgoingHttpHeaders = {};
    c.res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const out = sealOnce(c.res.status, headers, body);
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(out.headers)) {
      if (v !== undefined) outHeaders.set(k, String(v));
    }
    // Hono's `set res` copies the OLD response's headers onto the new one, so a
    // stale `content-length` there would overwrite the sealed one.
    c.res.headers.delete("content-length");
    c.res = new Response(out.body ? new Uint8Array(out.body) : null, {
      status: c.res.status,
      headers: outHeaders,
    });
  };
