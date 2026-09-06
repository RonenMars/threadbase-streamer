import { relative, resolve, sep } from "node:path";

/**
 * `tb codex` — start a streamer-managed Codex session in a directory and drive
 * it from this terminal.
 *
 * The point is not the terminal. A Codex session started from a shell is one
 * the streamer does not own: its startup gates (the directory-trust dialog, the
 * hooks-review dialog) are drawn by the TUI and never written to the rollout,
 * so nothing can forward them to a phone. Only the PTY owner can see them.
 * Starting the session through the streamer makes it managed from birth, which
 * is what puts those gates on the phone as answerable cards; attaching here is
 * what keeps it usable from the keyboard you started it at.
 *
 * Keystrokes go over HTTP rather than the socket because `POST
 * /api/sessions/:id/input` with `{ keys }` is the raw-key path mobile already
 * uses. On loopback the round trip is not worth a second transport.
 */

/** Byte the local terminal sends that means "let go", not "type this". */
const DETACH_KEY = "\x1d"; // Ctrl-]

export interface AttachSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
}

export interface AttachIO {
  /** Terminal size, or null when stdout is not a TTY. */
  size(): { cols: number; rows: number } | null;
  write(data: string): void;
  /** Put stdin in raw mode and stream it. Returns a stop function. */
  readKeys(onKeys: (keys: string) => void): () => void;
  /** Subscribe to terminal resizes. Returns an unsubscribe function. */
  onResize(handler: () => void): () => void;
  log(line: string): void;
  error(line: string): void;
}

export interface AttachDeps {
  fetchFn: typeof fetch;
  connect(url: string): Promise<AttachSocket>;
  io: AttachIO;
}

export interface AttachOptions {
  /** Directory to start the session in. Absolute, already resolved. */
  cwd: string;
  browseRoot: string | undefined;
  port: number;
  apiKey: string;
  /** Skip the terminal attach and just report the started session. */
  detached: boolean;
}

/**
 * The session start endpoint addresses projects relative to the server's
 * browse root, so a directory outside it has no name the server will accept.
 * Refuse with the reason rather than posting a path that resolves somewhere
 * else — `resolveBrowsePath` rejects traversal, so the alternative is a 400
 * whose message is about path syntax rather than about configuration.
 */
export function toBrowseRelativePath(
  cwd: string,
  browseRoot: string | undefined,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!browseRoot) {
    return {
      ok: false,
      reason:
        "This streamer has no browse root configured, so it cannot start a session anywhere.\nSet browse_root in ~/.threadbase/server.yaml (or pass --browse-root) and restart it.",
    };
  }
  const root = resolve(browseRoot);
  const target = resolve(cwd);
  const rel = relative(root, target);
  if (rel.startsWith("..") || resolve(root, rel) !== target) {
    return {
      ok: false,
      reason: `${target} is outside this streamer's browse root (${root}).\nRun from a directory inside it, or widen browse_root.`,
    };
  }
  // "" is the root itself, which the server addresses as ".".
  return { ok: true, path: rel === "" ? "." : rel.split(sep).join("/") };
}

/** Terminal dimensions to report, or null when there is nothing trustworthy. */
function sizeOrNull(io: AttachIO): { cols: number; rows: number } | null {
  const size = io.size();
  if (!size) return null;
  if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows)) return null;
  if (size.cols < 1 || size.rows < 1) return null;
  return size;
}

export async function runCodexAttach(opts: AttachOptions, deps: AttachDeps): Promise<number> {
  const { io } = deps;

  const rel = toBrowseRelativePath(opts.cwd, opts.browseRoot);
  if (!rel.ok) {
    io.error(rel.reason);
    return 1;
  }

  const base = `http://localhost:${opts.port}`;
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };

  let started: Response;
  try {
    started = await deps.fetchFn(`${base}/api/sessions/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: rel.path, provider: "codex-cli" }),
    });
  } catch (err) {
    io.error(
      `Could not reach the streamer on port ${opts.port}. Is it running? (tb prod status)\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const body = (await started.json().catch(() => null)) as {
    session?: { id?: string };
    error?: string;
  } | null;

  if (!started.ok || !body?.session?.id) {
    io.error(body?.error ?? `Session start failed (HTTP ${started.status}).`);
    return 1;
  }
  const sessionId = body.session.id;

  if (opts.detached) {
    io.log(`Started Codex session ${sessionId} in ${rel.path}`);
    return 0;
  }

  let socket: AttachSocket;
  try {
    socket = await deps.connect(
      `ws://localhost:${opts.port}/ws?key=${encodeURIComponent(opts.apiKey)}`,
    );
  } catch (err) {
    io.error(
      `Session ${sessionId} started, but the stream could not be attached: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const sendResize = () => {
    const size = sizeOrNull(io);
    if (!size) return;
    socket.send(
      JSON.stringify({ type: "resize_session", sessionId, cols: size.cols, rows: size.rows }),
    );
  };

  return await new Promise<number>((resolveExit) => {
    let stopKeys: (() => void) | null = null;
    let stopResize: (() => void) | null = null;
    let settled = false;

    const finish = (code: number, message?: string) => {
      if (settled) return;
      settled = true;
      stopKeys?.();
      stopResize?.();
      socket.close();
      if (message) io.log(message);
      resolveExit(code);
    };

    socket.onMessage((raw) => {
      let msg: { type?: string; sessionId?: string; data?: string; lines?: string[] };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.sessionId !== sessionId) return;
      // Replay first paints the screen the session already has; output is the
      // live stream after it. Both are raw PTY bytes — write them through.
      if (msg.type === "terminal_replay" && Array.isArray(msg.lines)) {
        io.write(`${msg.lines.join("\r\n")}\r\n`);
        return;
      }
      if (msg.type === "terminal_output" && typeof msg.data === "string") {
        io.write(msg.data);
      }
    });

    socket.onClose(() =>
      finish(0, "\r\nStream closed. The session keeps running; reopen it from the app."),
    );
    socket.onError((err) => finish(1, `\r\nStream error: ${err.message}`));

    socket.send(JSON.stringify({ type: "subscribe_session", sessionId }));
    // Before the first output, so the session is drawn at this terminal's size
    // rather than repainting at the spawn default a moment later.
    sendResize();
    stopResize = io.onResize(sendResize);

    stopKeys = io.readKeys((keys) => {
      if (keys.includes(DETACH_KEY)) {
        finish(
          0,
          "\r\nDetached. The session keeps running; reopen it from the app or with tb codex.",
        );
        return;
      }
      void deps
        .fetchFn(`${base}/api/sessions/${sessionId}/input`, {
          method: "POST",
          headers,
          body: JSON.stringify({ keys }),
        })
        .catch(() => {
          // A dropped keystroke is not worth tearing the attach down: the
          // socket's own close/error path owns that decision.
        });
    });

    io.log(`Attached to Codex session ${sessionId}. Ctrl-] to detach.\r\n`);
  });
}
