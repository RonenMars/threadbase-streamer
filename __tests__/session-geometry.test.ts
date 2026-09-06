import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { PTY_COLS, PTY_ROWS } from "../src/pty-shared";
import type { StreamerServer } from "../src/server";

/**
 * A session's PTY geometry, reported over real sockets.
 *
 * A TUI addresses rows absolutely within the viewport, so a client decoding the
 * stream at a different size resolves those moves to the wrong rows. Every
 * client assumed the spawn defaults because nothing could change them; now
 * `resize_session` can, so the size has to travel — as an event for a client
 * already watching, and on the replay for one that subscribes afterwards.
 *
 * Driven end to end (real server, real WSHub, real sockets) rather than against
 * the geometry map, because the map is not the behaviour: what matters is that
 * a subscriber is told.
 */

const API_KEY = "tb_test_session_geometry";
const SID = "geometry-session";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Frame = { type: string; sessionId?: string; cols?: number; rows?: number };
type Client = { ws: WebSocket; frames: Frame[] };

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, frames };
}

const resizeFrames = (c: Client) => c.frames.filter((f) => f.type === "terminal_resize");
const replayFrames = (c: Client) => c.frames.filter((f) => f.type === "terminal_replay");

describe("session geometry reaches subscribers", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let port: number;
  const clients: Client[] = [];

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "tb-session-geometry-"));
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
    port = server.port;
  });

  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  /** A PTY-less stand-in: the wiring only asks whether the session exists. */
  function stubSession(): { resized: Array<[string, number, number]> } {
    const resized: Array<[string, number, number]> = [];
    const internals = server as unknown as {
      ptyManager: {
        hasSession: (id: string) => boolean;
        resize: (id: string, cols: number, rows: number) => void;
        getOutputLines: (id: string, max: number) => Promise<string[]>;
        getInputHistory: (id: string) => unknown[];
      };
    };
    internals.ptyManager.hasSession = (id: string) => id === SID;
    internals.ptyManager.resize = (id, cols, rows) => {
      resized.push([id, cols, rows]);
    };
    internals.ptyManager.getOutputLines = async () => ["rendered line"];
    internals.ptyManager.getInputHistory = () => [];
    return { resized };
  }

  async function open(): Promise<Client> {
    const c = await connect(port);
    clients.push(c);
    return c;
  }

  it("tells a watching subscriber when the PTY is resized", async () => {
    const { resized } = stubSession();
    const watcher = await open();
    watcher.ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SID }));
    await waitFor(() => replayFrames(watcher).length > 0);

    watcher.ws.send(
      JSON.stringify({ type: "resize_session", sessionId: SID, cols: 200, rows: 60 }),
    );
    await waitFor(() => resizeFrames(watcher).length > 0);

    expect(resized).toContainEqual([SID, 200, 60]);
    expect(resizeFrames(watcher)[0]).toMatchObject({
      type: "terminal_resize",
      sessionId: SID,
      cols: 200,
      rows: 60,
    });
  });

  // The replay is the only frame a late subscriber gets before live output, so
  // the size has to ride on it — a separate event would arrive after the client
  // had already decoded the replayed screen at the wrong geometry.
  it("carries the current geometry on a later subscriber's replay", async () => {
    stubSession();
    const late = await open();

    late.ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SID }));
    await waitFor(() => replayFrames(late).length > 0);

    expect(replayFrames(late)[0]).toMatchObject({ cols: 200, rows: 60 });
  });

  it("reports the spawn defaults for a session nothing resized", async () => {
    const internals = server as unknown as {
      ptyManager: { hasSession: (id: string) => boolean };
    };
    internals.ptyManager.hasSession = (id: string) => id === "never-resized";
    const c = await open();

    c.ws.send(JSON.stringify({ type: "subscribe_session", sessionId: "never-resized" }));
    await waitFor(() => replayFrames(c).length > 0);

    expect(replayFrames(c)[0]).toMatchObject({ cols: PTY_COLS, rows: PTY_ROWS });
  });
});
