import {
  type AttachIO,
  type AttachSocket,
  runCodexAttach,
  toBrowseRelativePath,
} from "../cli/attach";

/**
 * The `tb codex` flow, driven through injected IO so none of it needs a TTY.
 *
 * Weighted toward the refusals. The happy path is three messages in a row; the
 * ways this can go wrong — a directory the server cannot address, a streamer
 * that is not running, a start that fails — are what a user actually meets, and
 * each one has to say which of those it was.
 */

function makeIO(overrides: Partial<AttachIO> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const written: string[] = [];
  let keyHandler: ((keys: string) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  const io: AttachIO = {
    size: () => ({ cols: 100, rows: 30 }),
    write: (d) => written.push(d),
    readKeys: (onKeys) => {
      keyHandler = onKeys;
      return () => {
        keyHandler = null;
      };
    },
    onResize: (h) => {
      resizeHandler = h;
      return () => {
        resizeHandler = null;
      };
    },
    log: (l) => logs.push(l),
    error: (e) => errors.push(e),
    ...overrides,
  };
  return {
    io,
    logs,
    errors,
    written,
    pressKeys: (k: string) => keyHandler?.(k),
    resize: () => resizeHandler?.(),
    keysBound: () => keyHandler !== null,
  };
}

function makeSocket() {
  const sent: string[] = [];
  let onMessage: ((raw: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  let closed = false;
  const socket: AttachSocket = {
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
    },
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    onError: () => {},
  };
  return {
    socket,
    sent: () => sent.map((s) => JSON.parse(s)),
    emit: (msg: unknown) => onMessage?.(JSON.stringify(msg)),
    emitRaw: (raw: string) => onMessage?.(raw),
    hangUp: () => onClose?.(),
    isClosed: () => closed,
  };
}

function okStart(sessionId = "sess-1") {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/api/sessions/start")) {
      return new Response(JSON.stringify({ session: { id: sessionId } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

const BASE = { port: 8766, apiKey: "tb_key", detached: false, resize: false };

describe("toBrowseRelativePath", () => {
  it("addresses a nested directory relative to the browse root", () => {
    expect(toBrowseRelativePath("/home/me/code/app", "/home/me/code")).toEqual({
      ok: true,
      path: "app",
    });
  });

  // "" would be an empty `path` field; the server addresses the root as ".".
  it("addresses the browse root itself as .", () => {
    expect(toBrowseRelativePath("/home/me/code", "/home/me/code")).toEqual({ ok: true, path: "." });
  });

  it("refuses a directory outside the browse root, naming both", () => {
    const result = toBrowseRelativePath("/etc", "/home/me/code");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("/etc");
      expect(result.reason).toContain("/home/me/code");
    }
  });

  // A sibling sharing a prefix is not inside the root: /home/me/coder is not
  // under /home/me/code, and a naive startsWith check says it is.
  it("refuses a sibling directory that merely shares a prefix", () => {
    expect(toBrowseRelativePath("/home/me/coder", "/home/me/code").ok).toBe(false);
  });

  it("explains an unconfigured browse root rather than posting a path", () => {
    const result = toBrowseRelativePath("/home/me/code", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("browse_root");
  });
});

describe("runCodexAttach", () => {
  it("starts a Codex session for the resolved path", async () => {
    const fetchFn = okStart();
    const t = makeIO();
    const s = makeSocket();

    await runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root", detached: true },
      { fetchFn, connect: async () => s.socket, io: t.io },
    );

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ path: "app", provider: "codex-cli" });
  });

  // The default is load-bearing, not a preference. VIEWPORT_ROWS is compiled
  // into every mobile build already on a device, and those cannot be
  // force-updated — so a session resized away from the spawn geometry renders
  // as garbage on any phone watching it, including one that never asked for a
  // local attach. Attaching must not do that to a session by default.
  it("subscribes without resizing the session by default", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    expect(s.sent()).toEqual([{ type: "subscribe_session", sessionId: "sess-1" }]);

    s.hangUp();
    await run;
  });

  it("does not resize on a window change either, unless asked", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    t.resize();

    expect(s.sent().some((m) => m.type === "resize_session")).toBe(false);
    s.hangUp();
    await run;
  });

  it("reports this terminal's size before any output when --resize is given", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root", resize: true },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    expect(s.sent()).toEqual([
      { type: "subscribe_session", sessionId: "sess-1" },
      { type: "resize_session", sessionId: "sess-1", cols: 100, rows: 30 },
    ]);

    s.hangUp();
    await run;
  });

  it("warns that a watching phone will render incorrectly when --resize is given", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root", resize: true },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    expect(t.logs.join("\n")).toContain("phone");

    s.hangUp();
    await run;
  });

  it("reports a new size when the terminal is resized", async () => {
    let cols = 100;
    const s = makeSocket();
    const t = makeIO({ size: () => ({ cols, rows: 30 }) });
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root", resize: true },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    cols = 180;
    t.resize();

    expect(s.sent().at(-1)).toEqual({
      type: "resize_session",
      sessionId: "sess-1",
      cols: 180,
      rows: 30,
    });
    s.hangUp();
    await run;
  });

  // Not a TTY, or a size the terminal cannot state: reporting 0 columns would
  // resize the PTY to nothing, which is worse than leaving the spawn default.
  it("reports no size at all rather than a nonsense one", async () => {
    const s = makeSocket();
    const t = makeIO({ size: () => null });
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root", resize: true },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    expect(s.sent().some((m) => m.type === "resize_session")).toBe(false);

    s.hangUp();
    await run;
  });

  it("writes replay then live output to the terminal", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    s.emit({ type: "terminal_replay", sessionId: "sess-1", lines: ["one", "two"] });
    s.emit({ type: "terminal_output", sessionId: "sess-1", data: "live" });

    expect(t.written).toEqual(["one\r\ntwo\r\n", "live"]);

    s.hangUp();
    await run;
  });

  it("ignores output addressed to another session on the same socket", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    s.emit({ type: "terminal_output", sessionId: "someone-else", data: "not mine" });

    expect(t.written).toEqual([]);
    s.hangUp();
    await run;
  });

  it("survives a malformed frame", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    expect(() => s.emitRaw("{not json")).not.toThrow();

    s.hangUp();
    await run;
  });

  it("forwards keystrokes as raw keys, not as a submitted message", async () => {
    const fetchFn = okStart();
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn, connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    t.pressKeys("1");

    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const keyCall = calls.find(([url]) => String(url).endsWith("/input"));
    expect(keyCall).toBeDefined();
    expect(JSON.parse(keyCall?.[1].body)).toEqual({ keys: "1" });

    s.hangUp();
    await run;
  });

  // Ctrl-] releases the terminal. The session must keep running — detaching is
  // not stopping, and the message has to say so or the user assumes it stopped.
  it("detaches on Ctrl-] without stopping the session", async () => {
    const fetchFn = okStart();
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn, connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    t.pressKeys("\x1d");

    expect(await run).toBe(0);
    expect(s.isClosed()).toBe(true);
    expect(t.keysBound()).toBe(false);
    expect(t.logs.join("\n")).toContain("keeps running");
    // The detach byte is a local control, never forwarded to the agent.
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => String(url).endsWith("/input"))).toBe(false);
  });

  it("restores the terminal when the stream closes on its own", async () => {
    const s = makeSocket();
    const t = makeIO();
    const run = runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      { fetchFn: okStart(), connect: async () => s.socket, io: t.io },
    );
    await vi.waitFor(() => expect(t.keysBound()).toBe(true));

    s.hangUp();

    expect(await run).toBe(0);
    expect(t.keysBound()).toBe(false);
  });

  it("says the streamer is unreachable rather than failing obscurely", async () => {
    const t = makeIO();
    const code = await runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      {
        fetchFn: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        connect: async () => makeSocket().socket,
        io: t.io,
      },
    );

    expect(code).toBe(1);
    expect(t.errors.join("\n")).toContain("Is it running?");
  });

  it("surfaces the server's own reason when the start is refused", async () => {
    const t = makeIO();
    const code = await runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      {
        fetchFn: (async () =>
          new Response(JSON.stringify({ error: "Codex is not installed" }), {
            status: 400,
          })) as unknown as typeof fetch,
        connect: async () => makeSocket().socket,
        io: t.io,
      },
    );

    expect(code).toBe(1);
    expect(t.errors.join("\n")).toContain("Codex is not installed");
  });

  // The session is already running at this point, so the message must not read
  // as "nothing happened" — it has to say what to do about it.
  it("reports the started session when attaching fails", async () => {
    const t = makeIO();
    const code = await runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root" },
      {
        fetchFn: okStart("sess-9"),
        connect: async () => {
          throw new Error("socket refused");
        },
        io: t.io,
      },
    );

    expect(code).toBe(1);
    expect(t.errors.join("\n")).toContain("sess-9");
  });

  it("never opens a socket in detached mode", async () => {
    const t = makeIO();
    const connect = vi.fn(async () => makeSocket().socket);

    const code = await runCodexAttach(
      { ...BASE, cwd: "/root/app", browseRoot: "/root", detached: true },
      { fetchFn: okStart(), connect, io: t.io },
    );

    expect(code).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(t.logs.join("\n")).toContain("sess-1");
  });
});
