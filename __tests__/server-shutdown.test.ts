import { mkdtempSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocket } from "ws";
import { StreamerServer } from "../src/server";

// Regression for the intermittent deploy failure:
//   ✗ healthcheck failed ... listen EADDRINUSE: address already in use :::8766
//
// Root cause: on SIGTERM the old process runs `await server.close()`, whose
// final step awaits `httpServer.close(cb)`. That callback only fires once every
// open connection drains. WSHub.dispose() did a *graceful* `client.close()`
// (close frame + wait for the peer's reply) and nothing force-closed the
// sockets, so a slow/backgrounded WebSocket peer kept the listener — and thus
// :8766 — bound until launchd's SIGKILL. The newly-started instance then hit
// EADDRINUSE.
//
// These tests pin the contract: close() must release the port promptly even
// with a live, slow-to-ACK WebSocket client.

const API_KEY = "tb_test_key_for_shutdown_tests";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function makeServer(port: number): StreamerServer {
  const cacheDir = mkdtempSync(join(tmpdir(), "threadbase-shutdown-test-"));
  // An empty `scanProfiles` array falls back to watching the real
  // ~/.claude/projects directory (see server.ts's `listen()`), which on a dev
  // machine can hold thousands of JSONL files. Tearing down that many chokidar
  // watchers in close() takes seconds, blowing every wall-clock budget below.
  // Point at an empty fixture dir instead so file-watching stays a no-op.
  const configDir = mkdtempSync(join(tmpdir(), "threadbase-shutdown-fixture-"));
  return new StreamerServer({
    port,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
    codexRoots: [],
    scannerPersistent: false,
  });
}

// Open a real WebSocket against the server and suppress the client's automatic
// close-frame reply, so the connection lingers the way a backgrounded mobile
// client does during a redeploy.
async function connectSlowWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${API_KEY}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  // Swallow the server's close frame instead of echoing it back. Without a
  // reply the graceful close handshake never completes, so a non-forced
  // shutdown would block on this socket.
  ws.on("close", () => {});
  // @ts-expect-error — reach past the public API to neutralize the auto-reply.
  ws._receiver?.removeAllListeners?.("conclude");
  return ws;
}

describe("StreamerServer.close() port release", () => {
  it("resolves quickly with no clients connected (common deploy path)", async () => {
    const port = await getRandomPort();
    const server = makeServer(port);
    await server.listen(port);

    const start = Date.now();
    await server.close();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("releases :PORT even when a WebSocket client withholds its close ACK", async () => {
    const port = await getRandomPort();
    const server = makeServer(port);
    await server.listen(port);

    const ws = await connectSlowWs(port);

    const start = Date.now();
    // Before the fix this hangs on the lingering socket; bound it so a
    // regression fails loudly instead of timing out the whole suite.
    await Promise.race([
      server.close(),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("server.close() did not resolve within 3s")), 3000),
      ),
    ]);
    expect(Date.now() - start).toBeLessThan(3000);

    try {
      ws.terminate();
    } catch {
      // already gone
    }
  });

  it("retries the bind when the port is briefly still held (kickstart -k race)", async () => {
    // First instance holds the port. The second instance should NOT give up on
    // the first EADDRINUSE — it retries with backoff and binds once the first
    // releases mid-window, mirroring launchd relaunching before the kernel has
    // fully torn down the old socket.
    const port = await getRandomPort();
    const first = makeServer(port);
    await first.listen(port);

    const second = makeServer(port);
    const bindPromise = second.listen(port); // will EADDRINUSE, then retry

    // Release the port ~600ms in — after the first retry attempt, before the
    // 6-attempt budget is exhausted.
    setTimeout(() => {
      void first.close();
    }, 600);

    await expect(bindPromise).resolves.toBeUndefined();
    await second.close();
  });

  it("frees the port for an immediate rebind (the EADDRINUSE scenario)", async () => {
    const port = await getRandomPort();
    const server = makeServer(port);
    await server.listen(port);
    const ws = await connectSlowWs(port);

    await Promise.race([
      server.close(),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("server.close() did not resolve within 3s")), 3000),
      ),
    ]);

    // Simulate launchd starting the new instance immediately after the kick.
    const next = makeServer(port);
    await expect(next.listen(port)).resolves.toBeUndefined();
    await next.close();

    try {
      ws.terminate();
    } catch {
      // already gone
    }
  });
});
