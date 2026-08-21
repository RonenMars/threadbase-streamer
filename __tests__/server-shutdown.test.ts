import { mkdtempSync } from "fs";
import { createServer, type Server } from "http";
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
// These tests pin the contract: close() must force those sockets down and
// release the port, even with a live, slow-to-ACK WebSocket client.

const API_KEY = "tb_test_key_for_shutdown_tests";

// A hang guard, not a performance budget. These tests used to bound close() with
// a fixed 1 000 ms / 3 000 ms stopwatch, which measures the CI runner as much as
// the code: `Smoke (windows-latest)` reported 8 458 ms tearing down a server that
// was doing nothing wrong, and reds landed on whichever commit happened to be
// merging (issue #659). The assertions below check drained state instead, and
// this bound only has to fire on a genuine regression where close() never
// resolves at all.
const CLOSE_HANG_GUARD_MS = 30_000;

function hangGuard(label: string): Promise<never> {
  return new Promise((_resolve, reject) =>
    setTimeout(
      () => reject(new Error(`${label} did not resolve within ${CLOSE_HANG_GUARD_MS}ms`)),
      CLOSE_HANG_GUARD_MS,
    ),
  );
}

// The falsifiable half of the contract, and the one a stopwatch was standing in
// for. `httpServer.close(cb)` fires its callback only once every accepted socket
// is gone, and close() backstops it with a 2 s timer — so "did the callback fire,
// or did the timer rescue us?" is exactly "were the sockets force-closed?", and
// it reads off the connection count with no clock involved.
//
// Measured both ways on this file (see the PR): with WSHub.dispose() reverted to
// a graceful client.close() and closeAllConnections() removed, this returns 1 and
// close() takes 2 013 ms; with the fix in place it returns 0 and close() takes
// 3 ms. Neither the old duration bounds nor a port-rebind check separates those
// two — httpServer.close() unbinds the listening socket synchronously, so the
// port is rebindable in both.
async function remainingConnections(server: StreamerServer): Promise<number> {
  // @ts-expect-error — reach past the public API for the listener under test.
  const httpServer = server.httpServer as Server;
  return new Promise((resolve) => {
    httpServer.getConnections((_err, count) => resolve(count ?? -1));
  });
}

// close() must leave the port takeable by the next process — the literal
// EADDRINUSE the header describes. Node does not set SO_REUSEADDR on Windows, so
// a still-bound listener genuinely fails this there.
async function expectPortRebindable(port: number): Promise<void> {
  const probe = createServer();
  await expect(
    new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    }),
  ).resolves.toBeUndefined();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

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
  it("releases the port with no clients connected (common deploy path)", async () => {
    const port = await getRandomPort();
    const server = makeServer(port);
    await server.listen(port);

    await Promise.race([server.close(), hangGuard("server.close()")]);
    await expectPortRebindable(port);
  });

  it("releases :PORT even when a WebSocket client withholds its close ACK", async () => {
    const port = await getRandomPort();
    const server = makeServer(port);
    await server.listen(port);

    const ws = await connectSlowWs(port);

    // Before the fix this hangs on the lingering socket; bound it so a
    // regression fails loudly instead of timing out the whole suite.
    await Promise.race([server.close(), hangGuard("server.close()")]);
    // The regression guard: a graceful-only dispose leaves this socket open and
    // the count at 1, because close() returned on its 2 s backstop rather than
    // on httpServer.close()'s drained callback.
    expect(await remainingConnections(server)).toBe(0);

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

    await Promise.race([server.close(), hangGuard("server.close()")]);

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
