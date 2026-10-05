import http from "http";
import {
  createFlowReceiver,
  createFlowSender,
  encodeCredit,
  type FlowReceiver,
  type FlowSender,
  parseCredit,
} from "./flow";
import { encodeFrame, FRAME_TYPES, type Frame } from "./frames";
import { RELAY_CLIENT_HEADER } from "./ingress";

// Replays each stream the relay opens as an HTTP request on the relay ingress
// listener (relay design §4.3). The relay is untrusted: everything in an OPEN
// frame is attacker-controlled, so only the header allowlist crosses and the
// request lands on the listener whose connections the server already treats as
// hostile — it never reaches the loopback-trusted TCP listener.

const FORWARDED_HEADERS = new Set([
  "content-type",
  "content-length",
  "accept",
  "if-none-match",
  "etag",
  "cache-control",
]);
const forwarded = (name: string) => name.startsWith("x-tb-") || FORWARDED_HEADERS.has(name);

// The relay allows 64 streams per tunnel; holding it to that here means a
// misbehaving relay cannot open unbounded requests against the server.
const MAX_STREAMS = 64;
const CLIENT_TAG = /^[A-Za-z0-9_-]{1,64}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

export interface Forwarder {
  onFrame(frame: Frame): void;
  /** The tunnel is gone: abandon every request it was carrying. */
  closeAll(): void;
}

export function createForwarder(ingressPath: string, send: (frame: Buffer) => void): Forwarder {
  interface Stream {
    req: http.ClientRequest;
    /** Request body arriving from the relay. */
    inbound: FlowReceiver;
    /** Response body going back; absent until the server answers. */
    outbound?: FlowSender;
  }
  const streams = new Map<number, Stream>();

  const reset = (streamId: number) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    stream.req.destroy();
    send(encodeFrame(FRAME_TYPES.RESET, streamId));
  };

  function open(streamId: number, payload: Buffer): void {
    let request: {
      kind?: unknown;
      method?: unknown;
      target?: unknown;
      headers?: unknown;
      clientTag?: unknown;
    };
    try {
      request = JSON.parse(payload.toString("utf-8"));
    } catch {
      request = {};
    }
    const { method, target, clientTag } = request;
    if (
      streams.has(streamId) ||
      streams.size >= MAX_STREAMS ||
      request.kind !== "http" ||
      typeof method !== "string" ||
      !METHODS.has(method) ||
      typeof target !== "string" ||
      !target.startsWith("/")
    ) {
      send(encodeFrame(FRAME_TYPES.RESET, streamId));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (request.headers ?? {}) as Record<string, unknown>,
    )) {
      if (forwarded(name.toLowerCase()) && typeof value === "string")
        headers[name.toLowerCase()] = value;
    }
    // Set from the frame, never from a forwarded header, so a client cannot
    // choose its own rate-limit bucket.
    delete headers[RELAY_CLIENT_HEADER];
    if (typeof clientTag === "string" && CLIENT_TAG.test(clientTag)) {
      headers[RELAY_CLIENT_HEADER] = clientTag;
    }

    let req: http.ClientRequest;
    try {
      req = http.request({ socketPath: ingressPath, method, path: target, headers });
    } catch {
      // http.request throws synchronously on a target or header it cannot encode.
      send(encodeFrame(FRAME_TYPES.RESET, streamId));
      return;
    }
    const stream: Stream = {
      req,
      inbound: createFlowReceiver((credit) =>
        send(encodeFrame(FRAME_TYPES.WINDOW, streamId, encodeCredit(credit))),
      ),
    };
    streams.set(streamId, stream);
    const live = () => streams.get(streamId) === stream;
    req.on("error", () => reset(streamId));
    req.on("response", (res) => {
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (forwarded(name) && value !== undefined) responseHeaders[name] = String(value);
      }
      send(
        encodeFrame(
          FRAME_TYPES.HEAD,
          streamId,
          Buffer.from(JSON.stringify({ status: res.statusCode, headers: responseHeaders })),
        ),
      );
      // Reading the response pauses while the relay holds no credit, so a slow
      // client stalls this one request instead of buffering it here.
      const outbound = createFlowSender((data) => {
        if (live()) send(encodeFrame(FRAME_TYPES.DATA, streamId, data));
      }, res);
      stream.outbound = outbound;
      res.on("data", (chunk: Buffer) => outbound.write(chunk));
      res.on("end", () =>
        outbound.end(() => {
          if (!live()) return;
          streams.delete(streamId);
          send(encodeFrame(FRAME_TYPES.END, streamId));
        }),
      );
      res.on("error", () => reset(streamId));
    });
  }

  return {
    onFrame(frame) {
      if (frame.type === FRAME_TYPES.OPEN) return open(frame.streamId, frame.payload);
      const stream = streams.get(frame.streamId);
      // A frame for a stream that already ended is late, not hostile.
      if (!stream) return;
      const { req } = stream;
      if (frame.type === FRAME_TYPES.DATA) {
        const bytes = frame.payload.length;
        if (!stream.inbound.accept(bytes)) return reset(frame.streamId);
        req.write(frame.payload, (err) => {
          if (!err && streams.get(frame.streamId) === stream) stream.inbound.drained(bytes);
        });
      } else if (frame.type === FRAME_TYPES.WINDOW) {
        try {
          stream.outbound?.grant(parseCredit(frame.payload));
        } catch {
          reset(frame.streamId);
        }
      } else if (frame.type === FRAME_TYPES.END) req.end();
      else if (frame.type === FRAME_TYPES.RESET) {
        streams.delete(frame.streamId);
        req.destroy();
      }
    },
    closeAll() {
      for (const { req } of streams.values()) req.destroy();
      streams.clear();
    },
  };
}
