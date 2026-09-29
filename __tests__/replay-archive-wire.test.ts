import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import type { ReplayLines } from "../src/pty-shared";
import type { StreamerServer } from "../src/server";

/**
 * `terminal_replay.archivedLineCount` over a real socket.
 *
 * The client splits a replay at this count: rows before it were drawn before
 * the render terminal's last full clear, rows after it are the frame the agent
 * is painting now. It is additive, so a replay with nothing archived must look
 * exactly like one from before the field existed.
 */

const API_KEY = "tb_test_replay_archive_wire";
const SID = "replay-archive-session";

type Frame = { type: string; lines?: string[]; archivedLineCount?: number };
type Client = { ws: WebSocket; frames: Frame[] };

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("terminal_replay carries the archive boundary", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let port: number;
  const clients: Client[] = [];

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-replay-archive-"));
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0);
    port = server.port;
  });

  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function stubReplay(replay: ReplayLines): void {
    const internals = server as unknown as {
      ptyManager: {
        hasSession: (id: string) => boolean;
        getReplayLines: (id: string, max: number) => Promise<ReplayLines>;
        getInputHistory: (id: string) => unknown[];
      };
    };
    internals.ptyManager.hasSession = (id: string) => id === SID;
    internals.ptyManager.getReplayLines = async () => replay;
    internals.ptyManager.getInputHistory = () => [];
  }

  async function subscribe(): Promise<Frame> {
    const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
    const client: Client = { ws, frames: [] };
    clients.push(client);
    ws.on("message", (data) => client.frames.push(JSON.parse(data.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SID }));
    const replay = () => client.frames.find((f) => f.type === "terminal_replay");
    await waitFor(() => replay() !== undefined);
    const frame = replay();
    if (!frame) throw new Error("no terminal_replay");
    return frame;
  }

  it("sends the archived rows ahead of the screen, with their count", async () => {
    stubReplay({ lines: ["old 1", "old 2", "old 3", "frame"], archivedLineCount: 3 });
    const frame = await subscribe();
    expect(frame.lines).toEqual(["old 1", "old 2", "old 3", "frame"]);
    expect(frame.archivedLineCount).toBe(3);
  });

  it("omits the field when nothing is archived", async () => {
    stubReplay({ lines: ["frame"], archivedLineCount: 0 });
    const frame = await subscribe();
    expect(frame.lines).toEqual(["frame"]);
    expect("archivedLineCount" in frame).toBe(false);
  });
});
