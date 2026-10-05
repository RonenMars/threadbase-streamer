import http from "http";
import { encodeFrame, FRAME_TYPES, type Frame, MAX_FRAME_PAYLOAD_BYTES } from "./frames";

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
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

export interface Forwarder {
  onFrame(frame: Frame): void;
  /** The tunnel is gone: abandon every request it was carrying. */
  closeAll(): void;
}

export function createForwarder(ingressPath: string, send: (frame: Buffer) => void): Forwarder {
  const streams = new Map<number, http.ClientRequest>();

  const reset = (streamId: number) => {
    const req = streams.get(streamId);
    if (!req) return;
    streams.delete(streamId);
    req.destroy();
    send(encodeFrame(FRAME_TYPES.RESET, streamId));
  };

  function open(streamId: number, payload: Buffer): void {
    let request: { kind?: unknown; method?: unknown; target?: unknown; headers?: unknown };
    try {
      request = JSON.parse(payload.toString("utf-8"));
    } catch {
      request = {};
    }
    const { method, target } = request;
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

    let req: http.ClientRequest;
    try {
      req = http.request({ socketPath: ingressPath, method, path: target, headers });
    } catch {
      // http.request throws synchronously on a target or header it cannot encode.
      send(encodeFrame(FRAME_TYPES.RESET, streamId));
      return;
    }
    streams.set(streamId, req);
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
      res.on("data", (chunk: Buffer) => {
        if (streams.get(streamId) !== req) return;
        for (let at = 0; at < chunk.length; at += MAX_FRAME_PAYLOAD_BYTES) {
          send(
            encodeFrame(
              FRAME_TYPES.DATA,
              streamId,
              chunk.subarray(at, at + MAX_FRAME_PAYLOAD_BYTES),
            ),
          );
        }
      });
      res.on("end", () => {
        if (streams.get(streamId) !== req) return;
        streams.delete(streamId);
        send(encodeFrame(FRAME_TYPES.END, streamId));
      });
      res.on("error", () => reset(streamId));
    });
  }

  return {
    onFrame(frame) {
      if (frame.type === FRAME_TYPES.OPEN) return open(frame.streamId, frame.payload);
      const req = streams.get(frame.streamId);
      // A frame for a stream that already ended is late, not hostile.
      if (!req) return;
      if (frame.type === FRAME_TYPES.DATA) req.write(frame.payload);
      else if (frame.type === FRAME_TYPES.END) req.end();
      else if (frame.type === FRAME_TYPES.RESET) {
        streams.delete(frame.streamId);
        req.destroy();
      }
    },
    closeAll() {
      for (const req of streams.values()) req.destroy();
      streams.clear();
    },
  };
}
