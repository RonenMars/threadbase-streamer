import { createDecipheriv } from "crypto";
import type { AddressInfo } from "net";
import { type WebSocket, WebSocketServer } from "ws";
import { generateKeyPair, type KeyPair, readMessage1, writeMessage2 } from "../../src/e2ee/noise";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_UNSUPPORTED_PROTOCOL,
  TUNNEL_PROLOGUE,
} from "../../src/relay/connector";
import { encodeCredit } from "../../src/relay/flow";
import {
  decodeFrame,
  encodeFrame,
  FRAME_TYPES,
  MAX_FRAME_PAYLOAD_BYTES,
} from "../../src/relay/frames";

/**
 * A stand-in relay built from the same Noise responder the relay uses. The
 * confirmation check is the relay's, so a connector that sends anything else
 * never attaches here.
 */

const CONFIRM = Buffer.from("threadbase-relay/1 confirm", "utf-8");

type Mode = "accept" | "unsupported";

export interface RelayedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** One client WebSocket, as the relay carries it. */
export interface RelayedSocket {
  /** The streamer's answer to the upgrade, or "reset". */
  head: { accepted?: boolean; status?: number; protocol?: string } | "reset";
  /** Whole messages from the streamer, reassembled. */
  messages: Buffer[];
  send(message: Buffer): void;
  close(code: number, reason?: string): void;
  /** Resolves when the streamer ends the stream: its close code, or "reset". */
  closed: Promise<number | "reset">;
}

export class FakeRelay {
  wss!: WebSocketServer;
  port = 0;
  confirmedKeys: string[] = [];
  mode: Mode = "accept";
  /** The attached tunnel, and every byte that crossed it in either direction. */
  tunnel: WebSocket | null = null;
  seen: Buffer[] = [];
  private nextStreamId = 1;
  constructor(readonly keyPair: KeyPair = generateKeyPair()) {}

  async start(port = 0): Promise<this> {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise((r) => this.wss.once("listening", r));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on("connection", (ws) => {
      let confirm: ((frame: Buffer) => void) | null = null;
      ws.on("message", (data: Buffer) => {
        if (confirm) return confirm(data);
        let state: ReturnType<typeof readMessage1>;
        try {
          state = readMessage1({
            staticKeyPair: this.keyPair,
            message1: data,
            pattern: "IK",
            prologue: TUNNEL_PROLOGUE,
          });
        } catch {
          return ws.close(CLOSE_AUTH_FAILED);
        }
        if (this.mode === "unsupported") return ws.close(CLOSE_UNSUPPORTED_PROTOCOL);
        const { message2, keys } = writeMessage2(state, Buffer.from("{}"));
        const { clientToServer, handshakeHash } = keys.consume();
        ws.send(message2);
        confirm = (frame) => {
          const d = createDecipheriv("chacha20-poly1305", clientToServer, Buffer.alloc(12), {
            authTagLength: 16,
          });
          d.setAAD(handshakeHash, { plaintextLength: CONFIRM.length });
          d.setAuthTag(frame.subarray(CONFIRM.length));
          const plain = Buffer.concat([d.update(frame.subarray(0, CONFIRM.length)), d.final()]);
          if (!plain.equals(CONFIRM)) return ws.close(CLOSE_AUTH_FAILED);
          this.confirmedKeys.push(state.initiatorStaticPub.toString("base64url"));
          this.tunnel = ws;
          confirm = (bytes) => void this.seen.push(bytes);
        };
      });
    });
    return this;
  }

  /** Open one stream the way the relay does. Resolves "reset" if the streamer refuses it. */
  request(open: object, body?: Buffer): Promise<RelayedResponse | "reset"> {
    const ws = this.tunnel;
    if (!ws) throw new Error("no tunnel attached");
    const streamId = this.nextStreamId++;
    const out = (type: Parameters<typeof encodeFrame>[0], payload?: Buffer) => {
      const frame = encodeFrame(type, streamId, payload);
      this.seen.push(frame);
      ws.send(frame);
    };
    return new Promise((resolve) => {
      let head: { status: number; headers: Record<string, string> } | null = null;
      const chunks: Buffer[] = [];
      const onMessage = (data: Buffer) => {
        const frame = decodeFrame(data);
        if (frame.streamId !== streamId) return;
        if (frame.type === FRAME_TYPES.HEAD) head = JSON.parse(frame.payload.toString("utf-8"));
        else if (frame.type === FRAME_TYPES.DATA) chunks.push(frame.payload);
        else if (frame.type === FRAME_TYPES.WINDOW) return;
        else {
          ws.off("message", onMessage);
          resolve(
            frame.type === FRAME_TYPES.END && head
              ? { ...head, body: Buffer.concat(chunks) }
              : "reset",
          );
        }
      };
      ws.on("message", onMessage);
      out(FRAME_TYPES.OPEN, Buffer.from(JSON.stringify(open), "utf-8"));
      if (body) out(FRAME_TYPES.DATA, body);
      out(FRAME_TYPES.END);
    });
  }

  /** Open a WebSocket stream the way the relay does, and wait for the streamer's answer. */
  socket(headers: Record<string, string>, target = "/ws"): Promise<RelayedSocket> {
    const ws = this.tunnel;
    if (!ws) throw new Error("no tunnel attached");
    const streamId = this.nextStreamId++;
    const out = (type: Parameters<typeof encodeFrame>[0], payload?: Buffer) => {
      const frame = encodeFrame(type, streamId, payload);
      this.seen.push(frame);
      ws.send(frame);
    };
    return new Promise((resolve) => {
      const messages: Buffer[] = [];
      let pieces: Buffer[] = [];
      let settle: (v: number | "reset") => void = () => {};
      const closed = new Promise<number | "reset">((r) => {
        settle = r;
      });
      const socket = (head: RelayedSocket["head"]): RelayedSocket => ({
        head,
        messages,
        closed,
        send: (message) => {
          const max = MAX_FRAME_PAYLOAD_BYTES - 1;
          for (let at = 0; at === 0 || at < message.length; at += max) {
            const more = at + max < message.length ? 1 : 0;
            out(
              FRAME_TYPES.DATA,
              Buffer.concat([Buffer.from([more]), message.subarray(at, at + max)]),
            );
          }
        },
        close: (code, reason = "") =>
          out(FRAME_TYPES.END, Buffer.from(JSON.stringify({ code, reason }))),
      });
      ws.on("message", (data: Buffer) => {
        const frame = decodeFrame(data);
        if (frame.streamId !== streamId) return;
        if (frame.type === FRAME_TYPES.HEAD)
          resolve(socket(JSON.parse(frame.payload.toString("utf-8"))));
        else if (frame.type === FRAME_TYPES.DATA) {
          pieces.push(frame.payload.subarray(1));
          if ((frame.payload[0] & 1) === 0) {
            messages.push(Buffer.concat(pieces));
            pieces = [];
          }
          if (frame.payload.length > 1)
            out(FRAME_TYPES.WINDOW, encodeCredit(frame.payload.length - 1));
        } else if (frame.type === FRAME_TYPES.END) {
          settle((JSON.parse(frame.payload.toString("utf-8")) as { code: number }).code);
        } else if (frame.type === FRAME_TYPES.RESET) {
          settle("reset");
          resolve(socket("reset"));
        }
      });
      out(
        FRAME_TYPES.OPEN,
        Buffer.from(JSON.stringify({ kind: "ws", method: "GET", target, headers }), "utf-8"),
      );
    });
  }

  get url() {
    return `ws://127.0.0.1:${this.port}/tunnel`;
  }

  async kill(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((r) => this.wss.close(r));
  }
}
