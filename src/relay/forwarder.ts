import http from "http";
import { connect } from "net";
import { WebSocket } from "ws";
import {
  createFlowReceiver,
  createFlowSender,
  encodeCredit,
  type FlowReceiver,
  type FlowSender,
  parseCredit,
} from "./flow";
import { encodeFrame, FRAME_TYPES, type Frame, MAX_FRAME_PAYLOAD_BYTES } from "./frames";
import { RELAY_CLIENT_HEADER } from "./ingress";

// Replays each stream the relay opens as an HTTP request, or a WebSocket, on the
// relay ingress listener (relay design §4.3). The relay is untrusted: everything in an OPEN
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
/** The first byte of a WebSocket DATA payload. Set when more of the same message follows. */
const MORE = 1;

export interface Forwarder {
  onFrame(frame: Frame): void;
  /** The tunnel is gone: abandon every request it was carrying. */
  closeAll(): void;
}

/** Close the local socket as the client closed its own, with the code it gave. */
function closeSocket(local: WebSocket, payload: Buffer): void {
  try {
    const { code, reason } = JSON.parse(payload.toString("utf-8")) as {
      code?: number;
      reason?: string;
    };
    local.close(code, typeof reason === "string" ? reason : undefined);
  } catch {
    // No payload, or not a code that may be sent (1005, 1006, out of range).
    local.close();
  }
}

export function createForwarder(ingressPath: string, send: (frame: Buffer) => void): Forwarder {
  interface Stream {
    /** Present on an HTTP stream. */
    req?: http.ClientRequest;
    /** Present on a WebSocket stream. */
    local?: WebSocket;
    /** Bytes arriving from the relay. */
    inbound: FlowReceiver;
    /** Bytes going back; absent until the server answers an HTTP request. */
    outbound?: FlowSender;
  }
  const destroy = (stream: Stream) => {
    stream.req?.destroy();
    stream.local?.terminate();
  };
  const streams = new Map<number, Stream>();

  const reset = (streamId: number) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    destroy(stream);
    send(encodeFrame(FRAME_TYPES.RESET, streamId));
  };

  // A client's WebSocket, opened against the ingress listener like any other
  // relayed request: `authMiddleware` admits it only on a ticket, and whatever
  // it refuses goes back as the status it refused with.
  function openSocket(streamId: number, target: string, headers: Record<string, string>): void {
    const offered = headers["sec-websocket-protocol"];
    delete headers["sec-websocket-protocol"];
    let local: WebSocket;
    try {
      local = new WebSocket(
        `ws://localhost${target}`,
        offered ? offered.split(",").map((p) => p.trim()) : [],
        {
          // `ws` discards a `socketPath` option, so the connection is made here.
          createConnection: () => connect(ingressPath),
          headers,
          perMessageDeflate: false,
        },
      );
    } catch {
      // `ws` throws synchronously on a target or subprotocol offer it cannot send.
      send(encodeFrame(FRAME_TYPES.RESET, streamId));
      return;
    }
    const head = (answer: object) =>
      send(encodeFrame(FRAME_TYPES.HEAD, streamId, Buffer.from(JSON.stringify(answer))));
    const outbound = createFlowSender(
      (piece, last) => {
        if (live())
          send(
            encodeFrame(
              FRAME_TYPES.DATA,
              streamId,
              Buffer.concat([Buffer.from([last ? 0 : MORE]), piece]),
            ),
          );
      },
      local,
      MAX_FRAME_PAYLOAD_BYTES - 1,
    );
    const stream: Stream = {
      local,
      outbound,
      inbound: createFlowReceiver((credit) =>
        send(encodeFrame(FRAME_TYPES.WINDOW, streamId, encodeCredit(credit))),
      ),
    };
    streams.set(streamId, stream);
    const live = () => streams.get(streamId) === stream;
    local.on(
      "open",
      () => live() && head({ accepted: true, protocol: local.protocol || undefined }),
    );
    local.on("unexpected-response", (req, res) => {
      req.destroy();
      if (!live()) return;
      streams.delete(streamId);
      head({ accepted: false, status: res.statusCode });
    });
    local.on("message", (data, isBinary) => {
      // A sealed socket is binary in both directions; this side never sends text.
      if (!isBinary) return reset(streamId);
      outbound.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
    });
    local.on("close", (code, reason) =>
      outbound.end(() => {
        if (!live()) return;
        streams.delete(streamId);
        send(
          encodeFrame(
            FRAME_TYPES.END,
            streamId,
            Buffer.from(JSON.stringify({ code, reason: reason.toString("utf-8") })),
          ),
        );
      }),
    );
    local.on("error", () => reset(streamId));
  }

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
      (request.kind !== "http" && request.kind !== "ws") ||
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
      const lower = name.toLowerCase();
      if (
        (forwarded(lower) || (request.kind === "ws" && lower === "sec-websocket-protocol")) &&
        typeof value === "string"
      )
        headers[lower] = value;
    }
    // Set from the frame, never from a forwarded header, so a client cannot
    // choose its own rate-limit bucket.
    delete headers[RELAY_CLIENT_HEADER];
    if (typeof clientTag === "string" && CLIENT_TAG.test(clientTag)) {
      headers[RELAY_CLIENT_HEADER] = clientTag;
    }
    if (request.kind === "ws") {
      openSocket(streamId, target, headers);
      return;
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
      const { req, local } = stream;
      if (frame.type === FRAME_TYPES.DATA) {
        const body = local ? frame.payload.subarray(1) : frame.payload;
        const bytes = body.length;
        if (!stream.inbound.accept(bytes)) return reset(frame.streamId);
        const drained = (err?: Error | null) => {
          if (!err && streams.get(frame.streamId) === stream) stream.inbound.drained(bytes);
        };
        if (!local) req?.write(body, drained);
        // The relay sends a message only on a socket this side accepted.
        else if (local.readyState !== WebSocket.OPEN || frame.payload.length === 0)
          reset(frame.streamId);
        else local.send(body, { binary: true, fin: (frame.payload[0] & MORE) === 0 }, drained);
      } else if (frame.type === FRAME_TYPES.WINDOW) {
        try {
          stream.outbound?.grant(parseCredit(frame.payload));
        } catch {
          reset(frame.streamId);
        }
      } else if (frame.type === FRAME_TYPES.END) {
        req?.end();
        if (local) closeSocket(local, frame.payload);
      } else if (frame.type === FRAME_TYPES.RESET) {
        streams.delete(frame.streamId);
        destroy(stream);
      }
    },
    closeAll() {
      for (const stream of streams.values()) destroy(stream);
      streams.clear();
    },
  };
}
