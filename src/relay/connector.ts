import { createCipheriv, type KeyObject } from "crypto";
import WebSocket from "ws";
import { type KeyPair, readMessage2, writeMessage1 } from "../e2ee/noise";
import type { Logger } from "../logger";
import { createForwarder } from "./forwarder";
import { decodeFrame } from "./frames";

// The streamer half of the relay tunnel handshake (relay design §4.2). The relay
// half lives in the relay repository; the constants below are the wire contract
// between them and must change on both sides together.
//
// The streamer dials out, proves it holds its identity key with a Noise IK
// handshake, and then sends one confirmation sealed under keys that depend on
// the relay's fresh ephemeral — so a recorded message 1 cannot be replayed to
// claim this streamer's route.

/** Separates this use of the identity key from the pairing and open handshakes. */
export const TUNNEL_PROLOGUE = Buffer.from("threadbase-relay/1 tunnel", "utf-8");
const CONFIRM_PLAINTEXT = Buffer.from("threadbase-relay/1 confirm", "utf-8");
const CONFIRM_NONCE = Buffer.alloc(12);
const OFFER = { protocols: [1], caps: ["http", "ws"] };

/** Close codes the relay sends during the handshake. */
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_UNSUPPORTED_PROTOCOL = 4406;

/** Reported by the `relay` diagnostics check (design §5.2). */
export type RelayState =
  | "disabled"
  | "not_configured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "authentication_failed"
  | "unsupported_protocol";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// A tunnel that died without a close frame (a NAT dropping the mapping, a
// sleeping laptop) is only noticed by a missed pong.
const PING_INTERVAL_MS = 30_000;

function sealConfirm(key: KeyObject, handshakeHash: Buffer): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, CONFIRM_NONCE, { authTagLength: 16 });
  cipher.setAAD(handshakeHash, { plaintextLength: CONFIRM_PLAINTEXT.length });
  return Buffer.concat([cipher.update(CONFIRM_PLAINTEXT), cipher.final(), cipher.getAuthTag()]);
}

export interface RelayConnectorOptions {
  url: string;
  /** The relay's pinned X25519 static public key, raw 32 bytes. */
  relayPublicKey: Buffer;
  /** This streamer's identity key. Its public half decides the route id. */
  keyPair: KeyPair;
  /** Where relayed requests are replayed. Without it the tunnel attaches but carries nothing. */
  ingressPath?: string;
  log?: Pick<Logger, "info" | "warn">;
  /** Test seam. */
  backoff?: { minMs: number; maxMs: number };
}

/**
 * Keeps one authenticated tunnel open to the relay, reconnecting with
 * exponential backoff and jitter.
 *
 * Streams the relay opens are replayed onto the relay ingress listener, never
 * the TCP one, so the server knows they came from an untrusted network.
 * Whatever happens here never touches the direct path — the connector holds no
 * listener and shares nothing with the TCP server but the process.
 */
export class RelayConnector {
  private stateValue: RelayState = "connecting";
  private ws: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly backoff: { minMs: number; maxMs: number };

  constructor(private readonly opts: RelayConnectorOptions) {
    this.backoff = opts.backoff ?? { minMs: BACKOFF_MIN_MS, maxMs: BACKOFF_MAX_MS };
  }

  get state(): RelayState {
    return this.stateValue;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  private connect(): void {
    const { message: message1, state } = writeMessage1({
      staticKeyPair: this.opts.keyPair,
      responderStaticPub: this.opts.relayPublicKey,
      pattern: "IK",
      payload: Buffer.from(JSON.stringify(OFFER), "utf-8"),
      prologue: TUNNEL_PROLOGUE,
    });
    const tunnel = new WebSocket(this.opts.url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    this.ws = tunnel;
    let handshakeDone = false;
    let authFailed = false;
    let alive = true;
    const forwarder = this.opts.ingressPath
      ? createForwarder(this.opts.ingressPath, (frame) => {
          if (tunnel.readyState === WebSocket.OPEN) tunnel.send(frame);
        })
      : null;

    tunnel.on("open", () => tunnel.send(message1));
    tunnel.on("pong", () => {
      alive = true;
    });
    tunnel.on("message", (data: Buffer) => {
      if (handshakeDone) {
        try {
          forwarder?.onFrame(decodeFrame(data));
        } catch {
          // A frame we cannot parse means the two ends disagree about the
          // protocol; nothing after it can be trusted to line up.
          tunnel.terminate();
        }
        return;
      }
      handshakeDone = true;
      try {
        const { keys } = readMessage2(state, data);
        const { clientToServer, handshakeHash } = keys.consume();
        tunnel.send(sealConfirm(clientToServer, handshakeHash));
      } catch {
        // Message 2 did not authenticate: whoever answered does not hold the
        // pinned relay key. Same outcome as the relay refusing us.
        authFailed = true;
        tunnel.terminate();
        return;
      }
      this.stateValue = "connected";
      this.attempt = 0;
      this.opts.log?.info("[relay] tunnel attached", { event: "relay.connected" });
      this.pingTimer = setInterval(() => {
        if (!alive) return tunnel.terminate();
        alive = false;
        tunnel.ping();
      }, PING_INTERVAL_MS);
    });
    // `close` always follows `error`; the state change and the retry live there.
    tunnel.on("error", () => {});
    tunnel.on("close", (code) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === tunnel) this.ws = null;
      forwarder?.closeAll();
      if (authFailed || code === CLOSE_AUTH_FAILED) this.stateValue = "authentication_failed";
      else if (code === CLOSE_UNSUPPORTED_PROTOCOL) this.stateValue = "unsupported_protocol";
      else this.stateValue = "reconnecting";
      this.opts.log?.warn("[relay] tunnel closed", {
        event: "relay.closed",
        code,
        state: this.stateValue,
      });
      if (!this.stopped) this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    const ceiling = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** this.attempt);
    this.attempt += 1;
    // Full-range jitter on the upper half, so a relay restart does not get
    // every streamer back in the same second.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref();
  }
}
