import { mkdtempSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";
import { createForwarder, type Forwarder } from "../src/relay/forwarder";
import { decodeFrame, FRAME_TYPES, type Frame } from "../src/relay/frames";

const HEADER = "sec-websocket-protocol";

describe("the forwarder's WebSocket subprotocol offer", () => {
  let dir: string;
  let upstream: Server;
  let wss: WebSocketServer;
  let forwarder: Forwarder;
  let frames: Frame[];
  let upgradeRaw: string[][];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-fwp-"));
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\tb-fwp-${process.pid}-${Date.now()}`
        : join(dir, "up.sock");
    upstream = createServer();
    wss = new WebSocketServer({ server: upstream });
    upgradeRaw = [];
    // rawHeaders, because req.headers carries Object.prototype too.
    // The upgrade event, not "connection": a polluted prototype also reaches the
    // test server's own handshake in this process, which may then refuse the socket.
    upstream.on("upgrade", (req) => upgradeRaw.push(req.rawHeaders));
    await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
    frames = [];
    forwarder = createForwarder(socketPath, (bytes) => frames.push(decodeFrame(bytes)));
  });
  afterEach(async () => {
    delete (Object.prototype as Record<string, unknown>)[HEADER];
    forwarder.closeAll();
    for (const client of wss.clients) client.terminate();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const openSocket = (headers: Record<string, string>) =>
    forwarder.onFrame({
      type: FRAME_TYPES.OPEN,
      streamId: 1,
      payload: Buffer.from(JSON.stringify({ kind: "ws", method: "GET", target: "/ws", headers })),
    });
  const connected = async () => {
    for (let i = 0; i < 400 && upgradeRaw.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(upgradeRaw).toHaveLength(1);
    return upgradeRaw[0].filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
  };

  it("offers the subprotocols the relay forwarded (positive control)", async () => {
    openSocket({ [HEADER]: "real-one, real-two" });
    const names = await connected();
    expect(names).toContain(HEADER);
    const value = upgradeRaw[0][upgradeRaw[0].findIndex((n) => n.toLowerCase() === HEADER) + 1];
    expect(value).toBe("real-one,real-two");
  });

  it("does not offer a subprotocol the relay never sent, even from a polluted prototype", async () => {
    (Object.prototype as Record<string, unknown>)[HEADER] = "polluted";
    openSocket({});
    const names = await connected();
    expect(names).not.toContain(HEADER);
    expect(upgradeRaw[0]).not.toContain("polluted");
  });
});
