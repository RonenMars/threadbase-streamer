import type { WebSocket } from "ws";
import { contextRegistry, type E2eeContext } from "./e2ee/context";
import {
  E2EE_CTX_UNKNOWN,
  E2EE_DEVICE_REVOKED,
  E2EE_SEAL_FAILED,
  E2EE_SEQUENCE_VIOLATION,
  type E2eeRejectionCode,
  own,
} from "./e2ee/protocol";
import { CHANNEL_WS, RecordError } from "./e2ee/record";
import { getLogger } from "./logger";
import type { WSMessage } from "./types";

/**
 * The one interval both liveness signals run on. It must stay under
 * `CLIENT_SILENCE_TIMEOUT_MS`.
 *
 * Two pings leave this timer per sweep and they are **not** redundant. The
 * WebSocket PROTOCOL ping proves the TCP connection is alive to the socket
 * layer, and is handled below `onmessage` — React Native's JS layer never sees
 * it. The app-level `{ type: "ping" }` frame is the only liveness signal the
 * client's silence timer can observe. Without it an idle-but-alive session
 * redials every `CLIENT_SILENCE_TIMEOUT_MS`: measured on hardware at 3.1
 * context opens per minute against a limit of 5 per device per minute, 62 % of
 * the budget spent while nobody touched the phone (tb-mobile #946).
 *
 * **One timer rather than two.** A single schedule cannot drift against itself,
 * there is one place to change the cadence, and the ordering argument on
 * `sendTo` has to hold for one call site instead of two.
 */
export const PING_INTERVAL_MS = 30_000;
/**
 * The client's silence timer, mirrored here because this file's cadence is only
 * correct relative to it — `WS_SILENCE_TIMEOUT_MS` in tb-mobile
 * `hooks/useTerminalStream.ts`. A client that receives nothing for this long
 * calls `forceReconnect`, and against a pinned server every reconnect is a
 * fresh Noise handshake charged to a 5-per-minute-per-device limit.
 *
 * Nothing reads it at runtime. It is here so a test can assert
 * `PING_INTERVAL_MS` stays under it: raising the cadence past this window
 * silently restores the churn the app-level ping was added to stop, and no
 * other part of the server would notice.
 */
export const CLIENT_SILENCE_TIMEOUT_MS = 45_000;
// How long to wait for a pong before treating the socket as dead.
// Must be less than PING_INTERVAL_MS.
const PONG_TIMEOUT_MS = 10_000;

const log = getLogger("ws");

/**
 * How long a sealed socket has to prove it holds the keys (NONCE-DESIGN §10).
 *
 * The clock starts at the 101 and stops on the FIRST frame that unseals — **any
 * valid sealed inbound frame, never a particular message type.** The client
 * contract says a socket sends `register` promptly, and that is one way for a
 * client to satisfy this; making it the server's condition would tie the server
 * to a message name it does not need and break the day a client legitimately
 * sends something else first.
 *
 * It exists because of the ticket thief. An intermediary that spends the
 * client's ticket first holds a socket bound to a context whose keys it does not
 * have: it gets no plaintext — every frame is sealed to keys it lacks — but it
 * occupies a hub slot and receives sealed broadcasts, and **the existing ping
 * reaper cannot evict it, because answering a pong costs it nothing.** Silence
 * is precisely what it is good at. This is the only clock that runs on a socket
 * that never speaks.
 *
 * **Ten seconds, and 15 s — the client's own connect timeout — is the only
 * permitted relaxation. Never lower**: a real phone on a bad network has to fit
 * an upgrade and one frame inside it.
 */
export const WS_FIRST_FRAME_DEADLINE_MS = 10_000;

/**
 * The plaintext of one broadcast, built at most once.
 *
 * A broadcast serialises its message once and then seals it N times. The JSON
 * is shared; the ciphertext never is. Lazy so a hub with no sealed socket at
 * all — every client on the legacy path — allocates nothing extra.
 */
interface Memo {
  plaintext?: Buffer;
}

/** The §9 code a record-layer throw carries, or a server fault if it carries none. */
function sealCode(err: unknown): E2eeRejectionCode {
  return err instanceof RecordError ? err.code : E2EE_SEAL_FAILED;
}

/**
 * The code the SEND path is allowed to report (§9).
 *
 * A sequence violation is a **claim about the peer**. Nothing we fail at while
 * sealing our own frame can be one, so a send-path error carrying that code
 * would tell a client its frames were wrong when the fault was entirely ours —
 * the collapse §9 splits these two codes to prevent, arriving from the other
 * direction. Unreachable today, because `seal` only ever raises
 * `E2EE_SEAL_FAILED`; asserted here so it stays unreachable rather than staying
 * unreachable by luck. The original code is still logged.
 */
function sendCode(err: unknown): E2eeRejectionCode {
  const code = sealCode(err);
  return code === E2EE_SEQUENCE_VIOLATION ? E2EE_SEAL_FAILED : code;
}

/**
 * Whatever `ws` handed us, as bytes.
 *
 * A sealed socket speaks the binary opcode (§12), so anything else — a text
 * frame, a client that forgot `binaryType` — is not a record. It becomes an
 * empty buffer and is refused by the record layer's own length check rather
 * than by a second copy of that check here.
 */
function asBytes(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return Buffer.alloc(0);
}

export class WSHub {
  private clients = new Set<WebSocket>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Per-socket pong-timeout handle; set when ping is sent, cleared on pong/close.
  private pongTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  /**
   * The E2EE context of every sealed socket. Absent for a legacy `?key=` client.
   *
   * PER SOCKET, not per device (NONCE-DESIGN §8). That is what forces N seals
   * for N sockets below: the three send paths used to `JSON.stringify` once and
   * hand the same bytes to every client, and the same bytes cannot be sealed to
   * N different keys under N independent counters.
   *
   * A socket absent from this map is a legacy plaintext client and keeps
   * working exactly as it does today — dual paths are the whole reason a
   * released app survives this change.
   */
  private contexts = new Map<WebSocket, E2eeContext>();
  /**
   * Every socket that has EVER held a context.
   *
   * `contexts` is cleared the moment a socket is closed for a policy violation
   * or a revocation, and `close()` is not instantaneous — a frame already in
   * the receive buffer still arrives. Without this set that frame would find no
   * context and be handled as a LEGACY PLAINTEXT one: a sealed socket
   * downgrading itself to cleartext in the window after it was cut off, which
   * is the one thing a dual-path design must never do.
   */
  private everSealed = new WeakSet<WebSocket>();
  /** Per-socket "prove you hold the keys" deadline; cleared on the first unseal. */
  private unprovenTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private readonly firstFrameMs: number;

  /**
   * `firstFrameMs` is a test seam and nothing else: the deadline it defaults to
   * is the contract, and a suite cannot spend ten seconds per case proving a
   * socket went away. A test asserts the DEFAULT is the contract's value, so
   * lowering the constant is still caught.
   *
   * **Read with `own()`, never `??`.** `server.ts` constructs `new WSHub()`, so
   * `options` is `{}` — an object that carries `Object.prototype`, and `??`
   * reads straight through it. A single `Object.prototype.firstFrameMs`
   * anywhere in the process then sets this deadline, in either direction and
   * both behavioural: lengthened, the ticket-thief defence stops firing
   * entirely, because the ping reaper cannot evict a socket that answers
   * pongs; shortened below the floor, every legitimate socket is reaped before
   * a phone on a bad network can fit an upgrade and one frame inside it.
   *
   * `own()` asks the object and nothing above it. `context.ts` reads `now` this
   * way and `record.ts` reads `initialCounter` this way, for exactly this
   * reason; this call site is the one that did not.
   */
  constructor(options: { firstFrameMs?: number } = {}) {
    this.firstFrameMs = own(options, "firstFrameMs") ?? WS_FIRST_FRAME_DEADLINE_MS;
  }

  addClient(ws: WebSocket, context?: E2eeContext): void {
    this.clients.add(ws);
    if (context) {
      this.contexts.set(ws, context);
      // Set HERE, at attach — not on the first successful seal. Whoever holds
      // this socket has spent a ticket, and everything downstream that asks
      // "was this ever sealed?" must be true from the 101 onwards.
      this.everSealed.add(ws);
      // The clock starts at the 101.
      this.unprovenTimers.set(
        ws,
        setTimeout(() => {
          this.unprovenTimers.delete(ws);
          log.warn("[e2ee] closing a sealed socket that never proved it holds the keys", {
            event: "e2ee.unproven_socket_reaped",
          });
          // `E2EE_CTX_UNKNOWN` and not a fifth code: by the time this close
          // lands the context IS destroyed, so the code is literally true, and
          // §9 already defines it as the recoverable one — a legitimate client
          // whose first frame was lost to a network stall re-opens, which is
          // exactly the right recovery. A thief learns nothing it did not
          // already know.
          this.closeForE2ee(ws, E2EE_CTX_UNKNOWN, "unproven");
        }, this.firstFrameMs),
      );
    }

    ws.on("pong", () => {
      const t = this.pongTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.pongTimers.delete(ws);
      }
    });

    ws.on("close", () => {
      const t = this.pongTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.pongTimers.delete(ws);
      }
      this.clients.delete(ws);
      this.forgetContext(ws);
    });

    ws.on("error", () => {
      const t = this.pongTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.pongTimers.delete(ws);
      }
      this.clients.delete(ws);
      this.forgetContext(ws);
    });

    if (!this.pingTimer && this.clients.size > 0) {
      this.startPing();
    }
  }

  broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    const memo: Memo = {};
    const dead: WebSocket[] = [];

    for (const client of this.clients) {
      if (!this.sendTo(client, data, memo)) dead.push(client);
    }

    for (const client of dead) {
      this.clients.delete(client);
    }
  }

  // Scoped broadcast for high-frequency per-session messages (terminal_output,
  // user_message). Sending to every connected client for every PTY output
  // chunk made broadcast() cost scale with connections x active sessions;
  // this bounds it to only that session's subscribers.
  broadcastToClients(clients: Iterable<WebSocket>, message: WSMessage): void {
    const data = JSON.stringify(message);
    const memo: Memo = {};
    for (const client of clients) {
      if (!this.sendTo(client, data, memo)) this.clients.delete(client);
    }
  }

  unicast(ws: WebSocket, message: WSMessage): void {
    if (!this.sendTo(ws, JSON.stringify(message), {})) this.clients.delete(ws);
  }

  /**
   * Seal for THIS socket, then send. One synchronous step, with no `await`
   * anywhere between the two (NONCE-DESIGN §14).
   *
   * An await between `seal` and `ws.send` reorders frames — two sends resumed
   * in the wrong order put counter 8 on the wire before counter 7 — and the
   * peer's strict `counter == expected` (§5 R2) then closes the socket. The
   * `await getOutputLines(...)` on the `terminal_replay` path is upstream of
   * this method for exactly that reason: it finishes, and only then is anything
   * sealed.
   *
   * Returns false when the caller should drop this client.
   *
   * The plaintext Buffer is memoised across a broadcast because it is the same
   * bytes for every recipient; the SEAL is not, and cannot be — N sockets means
   * N keys, N counters and N distinct nonces. `seal` does not mutate its
   * argument, so one Buffer feeds every seal.
   *
   * An app-level `{ type: "ping" }` frame — emitted by `startPing` — is sealed
   * here like every other frame and consumes a counter. That is correct and
   * costs nothing, and it is written down because WebSocket PROTOCOL pings are
   * invisible to React Native's JS layer — the client's silence timer depends on
   * the app-level ping continuing to exist, so nobody should optimise it away on
   * the grounds that the protocol already has one (NONCE-DESIGN §18).
   */
  private sendTo(ws: WebSocket, json: string, memo: Memo): boolean {
    const context = this.contexts.get(ws);
    // **A socket that consumed a ticket is never on the plaintext send path**
    // (NONCE-DESIGN §8). Sealed-and-now-contextless is not a legacy client; it
    // is a fault, and it closes rather than falling through.
    //
    // Unreachable as the code stands — the only way to hold `everSealed` with
    // no context is `forgetContext`, which runs on close or error, and the
    // `readyState` check a few lines down catches that socket anyway. The guard
    // is here because UNREACHABILITY was doing the work: detach a context from
    // a live socket by any future means and the failure is a silent plaintext
    // `session_list`, which enumerates every session with its project path.
    if (!context && this.everSealed.has(ws)) {
      this.closeForE2ee(ws, E2EE_SEAL_FAILED, "send-without-context");
      return false;
    }
    if (ws.readyState !== ws.OPEN) {
      if (context) this.closeForE2ee(ws, E2EE_SEAL_FAILED, "transport-not-open");
      return false;
    }
    let frame: string | Buffer = json;
    if (context) {
      memo.plaintext ??= Buffer.from(json, "utf-8");
      try {
        frame = context.sendState(CHANNEL_WS).seal(memo.plaintext);
      } catch (err) {
        // A seal failure is a SERVER-side fault and gets its own code (§9).
        // Closing rather than dropping is deliberate: a dropped frame is a gap,
        // and under the strict counter the peer would reject everything after
        // it anyway — with a reason that pointed at the client.
        this.closeForE2ee(ws, sendCode(err), "send", err);
        return false;
      }
    }
    try {
      ws.send(frame);
      return true;
    } catch (err) {
      if (context) this.closeForE2ee(ws, E2EE_SEAL_FAILED, "transport-send", err);
      return false;
    }
  }

  /**
   * Decode one client→server frame: unseal it for a sealed socket, pass it
   * through for a legacy one.
   *
   * Returns null when the frame was refused — the socket has already been
   * closed with the §9 code that says why, and the caller drops the frame. A
   * refusal is never silent: `E2EE_SEQUENCE_VIOLATION` is a claim about the
   * peer, `E2EE_SEAL_FAILED` is a fault on this side, and the two must not
   * arrive as the same "nothing happened".
   */
  receive(ws: WebSocket, raw: unknown): string | null {
    const context = this.contexts.get(ws);
    if (!context) {
      // A socket that was never sealed is a legacy client; one that WAS is a
      // socket already closed for cause, and it does not get to speak plaintext
      // on the way out.
      if (this.everSealed.has(ws)) return null;
      return typeof raw === "string" ? raw : String(raw);
    }

    try {
      const plaintext = context.receiveState(CHANNEL_WS).unseal(asBytes(raw)).toString("utf-8");
      // Proved. ANY valid sealed frame stops the clock — the unseal succeeding
      // is the proof, and what the frame says is none of this method's business.
      this.clearUnproven(ws);
      return plaintext;
    } catch (err) {
      this.closeForE2ee(ws, sealCode(err), "receive", err);
      return null;
    }
  }

  /** Close every socket bound to one of these explicit context handles. */
  closeContexts(ctxIds: Iterable<string>): number {
    const ids = new Set(ctxIds);
    if (ids.size === 0) return 0;
    let closed = 0;
    for (const [ws, context] of this.contexts) {
      if (!ids.has(context.ctxId)) continue;
      closed++;
      this.closeForE2ee(ws, E2EE_DEVICE_REVOKED, "revoked");
    }
    return closed;
  }

  /** Close every sealed socket the hub owns for one device. */
  closeDevice(deviceId: string): number {
    let closed = 0;
    for (const [ws, context] of this.contexts) {
      if (context.deviceId !== deviceId) continue;
      closed++;
      this.closeForE2ee(ws, E2EE_DEVICE_REVOKED, "revoked");
    }
    return closed;
  }

  /**
   * A socket's close destroys ITS OWN context and nothing else.
   *
   * Never the device's REST context (§8): the 2 s HTTP replay fallback runs
   * precisely when the socket is down, so a REST context that died with the
   * socket would take the fallback with it. A reconnect is a new
   * `POST /api/e2ee/open`, not a resurrection of this one.
   */
  private clearUnproven(ws: WebSocket): void {
    const t = this.unprovenTimers.get(ws);
    if (t) {
      clearTimeout(t);
      this.unprovenTimers.delete(ws);
    }
  }

  private forgetContext(ws: WebSocket): void {
    // Unconditional, and before the early return: a socket whose context has
    // already gone must not leave a timer behind to fire at a dead socket.
    this.clearUnproven(ws);
    const context = this.contexts.get(ws);
    if (!context) return;
    this.contexts.delete(ws);
    contextRegistry().destroyOwned(context);
  }

  private closeForE2ee(ws: WebSocket, code: E2eeRejectionCode, phase: string, err?: unknown): void {
    const violation = code === E2EE_SEQUENCE_VIOLATION;
    // **The record layer's own words, carried through.** Without them a frame
    // addressed to ANOTHER live context and a frame naming a context that never
    // existed logged byte-identical lines — the hub threw away the distinction
    // the record layer had already made. §9 is explicit that the wording here is
    // what a human reads at 3am: "misaddressed" and "unknown" call for different
    // next steps, and the log was the only place either could be seen.
    const detail = err instanceof RecordError ? err.message : undefined;
    const reported = err instanceof RecordError ? err.code : undefined;
    log.warn(
      `[e2ee.${violation ? "sequence_violation" : "frame_refused"}] ${phase}${detail ? `: ${detail}` : ""}`,
      {
        event: violation ? "e2ee.sequence_violation" : "e2ee.frame_refused",
        code,
        phase,
        ...(detail ? { detail } : {}),
        // Differs from `code` only where the send path coerced a peer-claim into
        // a server fault; logging both keeps that coercion visible rather than
        // silent.
        ...(reported && reported !== code ? { reported } : {}),
      },
    );
    this.clients.delete(ws);
    try {
      // 1008 policy violation. The REASON is the frozen §9 code, so the client
      // can tell a policy close from a network drop and from each other.
      ws.close(1008, code);
    } catch {
      // Already gone.
    }
    this.forgetContext(ws);
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** Sealed sockets. Tests and diagnostics — never a key, never a `ctxId`. */
  get sealedCount(): number {
    return this.contexts.size;
  }

  dispose(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [, t] of this.pongTimers) {
      clearTimeout(t);
    }
    this.pongTimers.clear();
    for (const client of this.clients) {
      try {
        // terminate() (not close()) so the underlying TCP socket dies
        // immediately. A graceful close() only sends a close frame and waits
        // for the peer's reply — a slow/backgrounded client would keep the
        // connection (and thus the HTTP listener's port) alive until the peer
        // ACKs, which is what stalled shutdown and caused EADDRINUSE on the
        // next deploy.
        client.terminate();
      } catch {
        // Already closed
      }
    }
    this.clients.clear();
    // Destroy them HERE rather than leaving it to each socket's `close` event.
    // `terminate()` fires that event on a later tick, by which point this map
    // is empty and `forgetContext` finds nothing — so the registry would keep
    // every context of a hub that had already gone away. §8: contexts are
    // in-memory only and do not outlive the thing they belong to.
    for (const context of this.contexts.values()) {
      contextRegistry().destroyOwned(context);
    }
    this.contexts.clear();
    for (const [, t] of this.unprovenTimers) {
      clearTimeout(t);
    }
    this.unprovenTimers.clear();
  }

  /**
   * The maintenance sweep: both liveness pings, and the stale-context check.
   *
   * **The callback must stay synchronous.** `sendTo` seals and sends in one
   * synchronous step precisely so no `await` can sit between the two and reorder
   * counters (see `sendTo`), and that guarantee is what makes a periodic sender
   * safe at all: a synchronous block runs to completion, so two sends cannot
   * interleave and counter order is wire order. Making this callback `async`
   * would create the hazard `sendTo` documents rather than inherit its absence.
   *
   * **Ordering inside the loop is load-bearing.** The app-level ping is emitted
   * only for a socket that has already passed the stale-context and `readyState`
   * guards. Sealing on a registry-invalidated context throws, so emitting above
   * the stale-context guard would attempt a send on a socket this sweep has
   * already decided to close, and report the refusal as `phase: "send"` rather
   * than `phase: "maintenance"` — the sweep's own verdict, logged as if the
   * frame had been at fault. The §9 code is unaffected either way, since
   * `sendState` on an invalidated context raises `E2EE_CTX_UNKNOWN` itself.
   */
  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.clients.size === 0 && this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        return;
      }
      // One `ts` and one plaintext Buffer per sweep; the SEAL is still per
      // socket, because N sockets means N keys and N counters.
      //
      // `: WSMessage` is load-bearing, not redundant typing. Do NOT inline this
      // literal into the `JSON.stringify` below: that function accepts anything,
      // so an inlined literal is type-checked against nothing and this frame's
      // shape could drift a field at a time with the build staying green. The
      // annotation is what makes the contract with tb-mobile's own `WSMessage`
      // union a build failure (TS2353) rather than a convention everyone has to
      // remember — the shape is frozen across two repositories (`types.ts` and
      // NONCE-DESIGN §18), and this is where that freeze is enforced.
      const appPing: WSMessage = { type: "ping", ts: Date.now() };
      const appPingJson = JSON.stringify(appPing);
      const memo: Memo = {};
      for (const client of this.clients) {
        const context = this.contexts.get(client);
        if (context && contextRegistry().get(context.ctxId) !== context) {
          this.closeForE2ee(client, E2EE_CTX_UNKNOWN, "maintenance");
          continue;
        }
        if (client.readyState !== client.OPEN) continue;
        // The app-level liveness frame — the ONLY one the client's silence timer
        // can see, since the protocol ping below never reaches `onmessage`.
        // Sealed for a sealed socket and plaintext for a legacy one, by the same
        // `sendTo` every other frame uses; a legacy client ignores an unknown
        // type, and its silence timer resets just the same.
        if (!this.sendTo(client, appPingJson, memo)) {
          this.clients.delete(client);
          continue;
        }
        // WS protocol ping — client must reply with a pong frame. If no pong
        // arrives within PONG_TIMEOUT_MS the socket is considered dead and
        // terminated. This is what detects iOS silently killing the TCP
        // connection without delivering a close frame to the JS layer.
        client.ping();
        const t = setTimeout(() => {
          this.pongTimers.delete(client);
          client.terminate();
        }, PONG_TIMEOUT_MS);
        this.pongTimers.set(client, t);
      }
    }, PING_INTERVAL_MS);
  }
}
