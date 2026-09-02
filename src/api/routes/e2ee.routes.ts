// `POST /api/e2ee/open` — the transport handshake.
//
// A second Noise handshake, this time against the static keys pairing already
// stored, which leaves behind a transport context and (for a socket) a
// single-use ticket. design.md §3.5, NONCE-DESIGN §8, §10 and §11.
//
// THIS ROUTE IS PUBLIC. It is in `PUBLIC_POST_PATHS`, so everything it parses is
// bytes an attacker chose, before anything has authenticated them (D-9). The
// order below is the hardening, and it is not incidental:
//
//   1. refuse a source that has already spent its FAILURE budget, before the
//      handshake runs — an `IK` msg1 carries no freshness, so a captured one
//      can be replayed for two Diffie-Hellmans each time (§8);
//   2. bound the body as it arrives — `Content-Length` first, then the bytes
//      themselves — so nothing is buffered in proportion to what the sender
//      claims to be sending;
//   3. bound the base64 BEFORE decoding it (`parseE2eeRequest`);
//   4. run the handshake, the first point an attacker without a paired device's
//      static key fails;
//   5. fail closed on the device row: missing and revoked are both
//      `E2EE_DEVICE_REVOKED`, and neither is success.
//
// The context that comes out is PROVISIONAL — it dies at the 30 s ticket TTL
// unless something authenticates under it — and per-device caps bound how many
// a replayer can hold at once.

import { Hono } from "hono";
import type { IncomingMessage } from "http";
import {
  type ContextKind,
  contextRegistry,
  type E2eeContextRegistry,
  newCtxId,
  provisionalExpiresAt,
  REST_CONTEXT_TTL_MS,
} from "../../e2ee/context";
import {
  keyPairFrom,
  messageEphemeral,
  OPEN_PROLOGUE,
  readMessage1,
  writeMessage2,
} from "../../e2ee/noise";
import { E2eeRequestError, parseE2eeRequest } from "../../e2ee/pair-request";
import { E2EE_DEVICE_REVOKED, E2EE_PROTOCOL_VERSION, own } from "../../e2ee/protocol";
import { Msg1ReplayCache } from "../../e2ee/replay-cache";
import { getLogger } from "../../logger";
import { loadOrCreateServerIdentity } from "../../server-identity";
import type { AppEnv } from "../app";
import {
  createRateBudget,
  createRateLimiter,
  OPEN_SOURCE_FAILURE_LIMIT,
  PAIR_EXCHANGE_LIMIT,
  PAIR_EXCHANGE_WINDOW_MS,
} from "../rate-limit";
import type { ApiDeps } from "../types/api-deps";
import { describeE2eeCapability } from "./misc.routes";

/**
 * Ceiling on the request body, enforced as it arrives rather than after.
 *
 * The only field that carries size is `e2ee.noise`, which `parseE2eeRequest`
 * caps at roughly 5.5 KB of base64 (`NOISE_MAX_MESSAGE_BYTES`). This is that
 * plus room for the JSON around it — deliberately snug, because the whole point
 * of a pre-authentication bound is that it is reached before memory is.
 */
export const MAX_OPEN_BODY_BYTES = 8 * 1024;

const log = getLogger("e2ee");

/**
 * Read a JSON body, refusing one that grows past `maxBytes`.
 *
 * `readBody` in `api/handlers/http-helpers.ts` concatenates every chunk before
 * parsing, so on a public path a multi-GB POST is fully buffered before any
 * bound applies — `pair-request.ts`'s base64 cap runs *after* the whole body is
 * in memory (§10). This is the bounded reader that replaces it here.
 * Retrofitting `/pair/exchange` is a one-line follow-up in another track's file.
 *
 * `Content-Length` is checked first because it costs nothing and refuses the
 * honest oversized body before a byte arrives; the running total is what
 * refuses the dishonest one.
 */
function readBoundedJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // **`own()`, not a bracket read.** `req.headers` is a raw Node object with
    // `Object.prototype` on its chain, so `req.headers["content-length"]` on a
    // request that sent no `Content-Length` returns whatever
    // `Object.prototype["content-length"]` holds — on this endpoint, which is
    // public and runs before anything has authenticated the bytes it parses.
    //
    // Not a bypass: the running byte total below is the real ceiling and still
    // refuses an oversized body. What a polluted value buys is a SELF-inflicted
    // refusal — a bodiless or small request reads as huge and eats a `400` on
    // the D-9 path.
    //
    // The stronger remedy is not to have a bracket read at all: Hono's
    // `c.req.header()` goes through a fetch-API `Headers`, whose `get()`
    // answers `null` for an absent name whatever the prototype holds. That is
    // why the rest of W1b needs no guard here. This one is a raw Node object
    // reached before Hono's request wrapper, so `own()` is the tool.
    const declared = Number(own(req.headers, "content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new E2eeRequestError("E2EE_MALFORMED", "request body is too large"));
      return;
    }
    let chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop BUFFERING, but keep draining: the remaining chunks are dropped
        // as they arrive rather than collected, so memory stays flat while the
        // connection is left healthy enough to carry the 400 back.
        refused = true;
        chunks = [];
        reject(new E2eeRequestError("E2EE_MALFORMED", "request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new E2eeRequestError("E2EE_MALFORMED", "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Message 1's authenticated payload.
 *
 * `{ v, kind }`, exactly as NONCE-DESIGN §11 specifies. The two context kinds
 * (§8) differ in what they carry and how long they live, so the handshake has
 * to say which one it wants, and a capability that was never asked for must not
 * be inferred.
 *
 * `kind` lives INSIDE the AEAD rather than in the outer JSON for the same
 * reason the pairing payloads do: the outer body is attacker-modifiable, and a
 * rewritten `kind` would flip a socket context into a REST one.
 *
 * Required, not defaulted: a claim that was never made cannot be defaulted in
 * either direction (design.md §8's reasoning about `readOnly`).
 */
export function parseOpenPayload(payload: Buffer): { kind: ContextKind } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf-8"));
  } catch {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee open payload is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new E2eeRequestError("E2EE_MALFORMED", "e2ee open payload must be an object");
  }
  const { v, kind } = parsed as { v?: unknown; kind?: unknown };
  if (v !== E2EE_PROTOCOL_VERSION) {
    throw new E2eeRequestError(
      "E2EE_VERSION_UNSUPPORTED",
      `e2ee open payload v ${String(v)} is not supported; this server speaks ${E2EE_PROTOCOL_VERSION}`,
    );
  }
  if (kind !== "ws" && kind !== "rest") {
    throw new E2eeRequestError("E2EE_MALFORMED", 'e2ee open payload kind must be "ws" or "rest"');
  }
  return { kind };
}

export const createE2eeRoutes = (
  deps: Pick<ApiDeps, "devicesRepo" | "featureFlagsConfig">,
  /** Overridden by tests so a suite gets its own registry rather than the process one. */
  registry: E2eeContextRegistry = contextRegistry(),
) => {
  const app = new Hono<AppEnv>();
  // Same policy `/api/pair/exchange` enforces, applied to two different keys
  // for two different jobs (§8).
  //
  // `rateLimit` bounds ALLOCATION per authenticated device, after the
  // handshake has named one.
  const rateLimit = createRateLimiter({
    limit: PAIR_EXCHANGE_LIMIT,
    windowMs: PAIR_EXCHANGE_WINDOW_MS,
  });
  // `failures` bounds CPU per source address, before any Diffie-Hellman runs.
  // It is a separate budget with a separate key because the two bound
  // different things and neither substitutes for the other.
  const failures = createRateBudget({
    limit: OPEN_SOURCE_FAILURE_LIMIT,
    windowMs: PAIR_EXCHANGE_WINDOW_MS,
  });
  // A captured msg1 is replayable for the life of the identity key, and a
  // replay is a COMPLETE, authentic handshake — so neither budget above sees
  // it: it never throws, and it resolves to a live device row. Worse, because
  // it authenticates as the victim, the per-device limiter is what makes the
  // attack targeted. This is what makes a replay refusable before any
  // Diffie-Hellman runs.
  const replays = new Msg1ReplayCache({ ttlMs: REST_CONTEXT_TTL_MS });

  app.post("/open", async (c) => {
    // Same gate `/api/pair/exchange` applies, and for the same reason: a build
    // or deployment that reports `enabled: false` on `/api/info` must not run a
    // pre-authentication handshake anyway. Answered as a 404 so a disabled
    // server looks like one without the endpoint at all.
    if (!describeE2eeCapability(deps.featureFlagsConfig().values.e2ee).enabled) {
      return c.json({ error: "E2EE is not enabled on this server", code: "E2EE_DISABLED" }, 404);
    }

    const ip = c.env.incoming?.socket?.remoteAddress ?? "unknown";
    let body: unknown;
    try {
      body = await readBoundedJsonBody(c.env.incoming, MAX_OPEN_BODY_BYTES);
    } catch (err) {
      const e = err as E2eeRequestError;
      return c.json({ error: e.message ?? "Invalid body", code: e.code ?? "E2EE_MALFORMED" }, 400);
    }

    let request: ReturnType<typeof parseE2eeRequest>;
    try {
      request = parseE2eeRequest((body as { e2ee?: unknown } | null)?.e2ee);
    } catch (err) {
      const e = err as E2eeRequestError;
      return c.json({ error: e.message, code: e.code }, 400);
    }
    if (!request) {
      // Unlike `/api/pair/exchange`, absence is not "an older client" here:
      // nothing but an E2EE client has any reason to call this endpoint.
      return c.json({ error: "e2ee is required on this endpoint", code: "E2EE_MALFORMED" }, 400);
    }

    // Checked BEFORE the handshake, because the handshake is the expensive
    // part: `readMessage1` performs two Diffie-Hellmans on bytes nobody has
    // authenticated yet, which is the D-9 CPU case on a public endpoint. A
    // budget consulted after the work has already run bounds nothing.
    //
    // Charged only on FAILURE (below), so a device whose handshakes succeed
    // never spends from it however often it re-opens — the per-device limit is
    // what governs those.
    //
    // **The residual, stated rather than papered over.** This keys on the
    // socket's `remoteAddress`, and behind a Cloudflare tunnel every request
    // arrives from 127.0.0.1 — the streamer reads no forwarded-IP header — so
    // it is one bucket for the whole fleet and cannot tell a flood from the
    // fleet. A sustained malformed flood from the internet can therefore lock
    // that tunnel's `/open` for a minute. The control for that is
    // operator-side, Cloudflare rate limiting or Access in front of the
    // tunnel, and it belongs in the rollout guide — not in a `429` we pretend
    // is adequate. The ceiling is set high enough (§8) that no legitimate
    // device reaches it, which is what keeps this from being the self-DoS it
    // was at five.
    if (!failures.check(ip)) {
      return c.json({ error: "Too many handshake attempts; try again in a minute" }, 429);
    }

    // **Replay check, before any Diffie-Hellman.** `e` is message 1's first
    // field and travels in the clear, and a legitimate client mints a fresh one
    // per handshake — so a repeated `e` is definitionally a replay, not a
    // heuristic for one.
    //
    // Charged to the SOURCE and never to the device. Charging the device is
    // precisely what made this targeted: five replays of one captured message
    // spent the victim's own minute and pushed it past its context cap, while
    // every other device carried on.
    //
    // **The client is told nothing that distinguishes this from any other
    // handshake failure, deliberately.** `E2EE_HANDSHAKE_FAILED` is the same
    // code a wrong static key and a tampered ciphertext get, because telling an
    // attacker which of its guesses was a replay is worse than the diagnostic
    // being unavailable. The `e2ee.open_replayed` line is server-side only.
    //
    // The cost falls on a client that retries by re-sending the SAME bytes:
    // it is indistinguishable from a replay and is refused for the life of the
    // entry. That is a client obligation — every `/open` attempt, including a
    // retry after a lost response, a timeout or a `429`, runs `writeMessage1`
    // afresh (§11) — and it is in the contract rather than compensated for
    // here, because compensating for it means telling replays apart from
    // retries, which is the thing that cannot be done.
    const ephemeral = messageEphemeral(request.message1);
    if (ephemeral && replays.has(ephemeral)) {
      failures.charge(ip);
      log.warn("[e2ee] open refused: message 1 replays an ephemeral already seen", {
        event: "e2ee.open_replayed",
      });
      return c.json({ error: "E2EE handshake failed", code: "E2EE_HANDSHAKE_FAILED" }, 400);
    }

    let handshake: ReturnType<typeof readMessage1>;
    try {
      handshake = readMessage1({
        staticKeyPair: keyPairFrom(loadOrCreateServerIdentity().privateKey),
        // The psk-less pattern, named EXPLICITLY: `Noise_IK_25519_ChaChaPoly_
        // SHA256` with the `"threadbase-e2ee/1 open"` prologue (§11). Both
        // halves are domain separation — a captured pairing msg1 cannot be
        // replayed into here, and the protocol name alone already makes the
        // two transcripts disjoint. Passing `pattern` rather than omitting
        // `psk` is what keeps a forgotten argument from selecting a weaker
        // protocol somewhere else.
        pattern: "IK",
        message1: request.message1,
        prologue: OPEN_PROLOGUE,
      });
    } catch {
      // One code for every handshake failure, as at pairing: distinguishing
      // "wrong static key" from "tampered ciphertext" would tell an attacker
      // which half of their guess was right, and the client's remedy is the
      // same either way. The caught error is dropped for the same reason.
      //
      // A failed handshake names nobody, so the cost is charged to the source
      // address. The check that spends this is at the top of the handshake
      // block, so the sixth garbage msg1 from one source is refused before its
      // Diffie-Hellmans run rather than after.
      failures.charge(ip);
      // Logged because a device pinned to a DIFFERENT server identity fails
      // here on every attempt, forever, and until now left nothing behind: the
      // replay and unknown-device refusals below each wrote a line, this one
      // wrote none, so the one permanent condition was the one that could not
      // be told from the wire. `reason` distinguishes it; nothing about the
      // message is logged, for the same reason the caught error is dropped.
      //
      // Safe to log HERE and not on the branches above: this one is charged to
      // the source budget, so the line rate is bounded by
      // `OPEN_SOURCE_FAILURE_LIMIT`. The malformed-body and `429` branches
      // return before or instead of a charge, so logging there would hand an
      // unauthenticated caller an unbounded write to the operator's disk.
      log.warn("[e2ee] open refused: message 1 did not authenticate", {
        event: "e2ee.open_refused",
        reason: "handshake",
      });
      return c.json({ error: "E2EE handshake failed", code: "E2EE_HANDSHAKE_FAILED" }, 400);
    }

    // Fail closed on the row. Absent and revoked are both refusals and neither
    // is success (§10) — and both answer `E2EE_DEVICE_REVOKED` rather than
    // `E2EE_CTX_UNKNOWN`, because this is the hard failure a client must
    // surface, not the recoverable one it silently re-handshakes through (§9).
    const staticPub = handshake.initiatorStaticPub.toString("base64");

    // Rate-limited HERE, on the authenticated static key, rather than on the
    // socket's `remoteAddress` (§8). Behind a Cloudflare tunnel every request
    // arrives from 127.0.0.1 and the streamer reads no forwarded-IP header, so
    // an IP-keyed bucket degrades to ONE bucket for the whole fleet — it cannot
    // tell an attacker from the fleet, and it 429s legitimate devices out of
    // the very re-open storm §8 describes, since each device re-opens twice
    // after a restart.
    //
    // The trade, stated rather than left to be discovered: a replayer still
    // spends this server two DH per attempt before the check, because the key
    // it is charged to only exists once the handshake has run. What this bounds
    // is context and ticket ALLOCATION per device, which is the D-9 concern;
    // the per-device cap is the other half and the real bound.
    if (!rateLimit(`key:${staticPub}`)) {
      // The same status `/pair/exchange` uses for the same policy.
      return c.json({ error: "Too many handshake attempts; try again in a minute" }, 429);
    }

    const device = deps.devicesRepo()?.getByE2eeStaticPub(staticPub) ?? null;
    if (!device || device.revoked_at != null) {
      // The static key is deliberately not logged: it identifies a device.
      // Charged to the source, because this IS a failure from it. The server's
      // static key is public, so anyone can mint unlimited WELL-FORMED msg1s
      // from fresh keypairs; each costs two Diffie-Hellmans and is refused only
      // here. An adversary ran fifty and tripped nothing, because the budget
      // was charged solely on a malformed handshake — the flood that costs CPU
      // went uncounted while the trivial one locked out real devices.
      failures.charge(ip);
      log.warn("[e2ee] open refused: no live device holds that static key", {
        event: "e2ee.open_refused",
        reason: "unknown_device",
      });
      return c.json(
        { error: "This device is not paired for encryption", code: E2EE_DEVICE_REVOKED },
        403,
      );
    }

    // Recorded only HERE — after the handshake parsed AND the device row
    // resolved to a live paired device.
    //
    // Anywhere earlier and unauthenticated traffic drives the eviction clock:
    // a well-formed msg1 from a keypair the server has never seen would take a
    // slot, one permitted source contributes ~43 200 entries a day (~66 % of
    // capacity), and two fill it inside a day — at which point eviction starts
    // discarding the OLDEST entries, which is exactly where a captured
    // victim's msg1 lives. Only messages that authenticated as a real device
    // can age this cache, and a stranger's replay is refused by the device row
    // regardless.
    //
    // `ephemeral` is non-null on this path: `readMessage1` enforces the same
    // minimum length.
    if (ephemeral) replays.record(ephemeral);

    let kind: ContextKind;
    try {
      kind = parseOpenPayload(handshake.payload).kind;
    } catch (err) {
      const e = err as E2eeRequestError;
      // Past the handshake, so this caller authenticated as a live device and
      // the line rate is bounded by the per-device limit rather than by
      // anything a stranger controls. The code is logged; the payload is not.
      log.warn("[e2ee] open refused: the sealed payload is not a valid open request", {
        event: "e2ee.open_refused",
        reason: "payload",
        code: e.code,
      });
      return c.json({ error: e.message, code: e.code }, 400);
    }

    // Server-assigned, 16 random bytes, never derived by the client (§12).
    const { raw: ctxIdRaw, id: ctxId } = newCtxId();
    const now = Date.now();
    // **The advertised deadline is the deadline that applies** (§8, §12). Every
    // context — socket and REST alike — starts provisional and is collected at
    // the 30 s ticket TTL unless something authenticates under it, so msg2
    // carries THAT, plus the `provisional` flag telling the client which kind
    // of deadline it is holding.
    //
    // Advertising the 24 h lifetime here would be a promise the registry does
    // not keep: a client that opened a REST context and sent its first request
    // a minute later would get `E2EE_CTX_UNKNOWN` from a context it had been
    // told it owned for a day. §8's answer to that is the client's — open a
    // REST context with the request already in hand, never lazily in advance.
    const expiresAt = provisionalExpiresAt(now);
    // Only a socket needs a ticket; a REST context is addressed by `X-TB-Ctx`.
    const ticket = kind === "ws" ? registry.issueTicket(ctxId, now) : undefined;

    let message2: Buffer;
    let keys: ReturnType<typeof writeMessage2>["keys"];
    try {
      ({ message2, keys } = writeMessage2(
        handshake,
        Buffer.from(
          JSON.stringify({
            v: E2EE_PROTOCOL_VERSION,
            ctxId,
            expiresAt,
            provisional: true,
            ...(ticket && { ticket }),
          }),
          "utf-8",
        ),
      ));
    } catch (err) {
      // A server fault. Drop the ticket rather than leaving a live one bound to
      // a context that will never exist.
      registry.destroy(ctxId);
      log.error("[e2ee] could not write the open response", { event: "e2ee.open_failed", err });
      return c.json({ error: "Could not open an encrypted context" }, 500);
    }

    // `consume()` hands the traffic keys over exactly once: the registry gets
    // OpenSSL key handles and this route keeps nothing (§13).
    registry.open({ deviceId: device.device_id, kind, ctxIdRaw, ctxId, keys: keys.consume(), now });
    log.info(`[e2ee] opened a ${kind} context`, { event: "e2ee.context_opened", kind });

    // `ctxId`, `expiresAt` and `ticket` travel ONLY inside the sealed payload.
    // The outer body carries the version and the Noise message and nothing else
    // — a ticket in an outer field would be a credential in a response body a
    // proxy can read, which is the leak the ticket exists to close.
    return c.json({ e2ee: { v: E2EE_PROTOCOL_VERSION, noise: message2.toString("base64") } });
  });

  return app;
};
