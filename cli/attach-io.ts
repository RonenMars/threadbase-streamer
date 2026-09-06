import WebSocket from "ws";
import type { AttachIO, AttachSocket } from "./attach";

/**
 * The real terminal and socket behind `runCodexAttach`. Kept apart from the
 * flow itself so the flow is testable without a TTY: everything here either
 * touches process stdio or opens a socket, and none of it has logic worth
 * asserting on.
 */

export function createTerminalIO(): AttachIO {
  return {
    size() {
      const { columns, rows } = process.stdout;
      if (!process.stdout.isTTY || !columns || !rows) return null;
      return { cols: columns, rows };
    },
    write(data) {
      process.stdout.write(data);
    },
    readKeys(onKeys) {
      const stdin = process.stdin;
      // Raw mode is what makes this a terminal rather than a line editor: the
      // TUI wants each keypress, including the ones readline would swallow.
      const wasRaw = stdin.isRaw ?? false;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      const handler = (chunk: Buffer) => onKeys(chunk.toString("utf8"));
      stdin.on("data", handler);
      return () => {
        stdin.off("data", handler);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
      };
    },
    onResize(handler) {
      process.stdout.on("resize", handler);
      return () => process.stdout.off("resize", handler);
    },
    log(line) {
      process.stdout.write(`${line}\n`);
    },
    error(line) {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function connectSocket(url: string): Promise<AttachSocket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url);
    // Reject only until the socket is open; after that a failure is the
    // attach's own onError, not a failed connect.
    const onOpenError = (err: Error) => rejectPromise(err);
    ws.once("error", onOpenError);
    ws.once("open", () => {
      ws.off("error", onOpenError);
      resolvePromise({
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onMessage: (handler) => ws.on("message", (raw) => handler(raw.toString())),
        onClose: (handler) => ws.on("close", handler),
        onError: (handler) => ws.on("error", handler),
      });
    });
  });
}
