import { mkdtempSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

// Bug 1 (boot EADDRINUSE noise): on every prod boot `launchctl kickstart -k`
// relaunches before the old process frees :PORT, so bindWithRetry hits a
// transient EADDRINUSE and recovers within its attempt budget. The retries are
// expected and self-healing, so each one must log at debug (invisible by
// default) rather than warn. Only a genuinely stuck port — all attempts
// exhausted — should surface, exactly once, at error before rethrowing.
//
// The logger emits to console with dest="both" regardless of pino level, and
// maps debug -> console.log, warn -> console.warn, error -> console.error. We
// spy on those to assert the level each path uses.

const API_KEY = "tb_test_key_for_bind_retry_tests";

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
  const cacheDir = mkdtempSync(join(tmpdir(), "threadbase-bind-retry-test-"));
  return new StreamerServer({
    port,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    scanProfiles: [],
  });
}

// Count console.* calls whose message text matches the bind log lines, so we
// don't trip over unrelated startup logging.
function bindLogCounter() {
  const isRetry = (m: unknown) => typeof m === "string" && m.includes("busy (EADDRINUSE), retry");
  const isFail = (m: unknown) => typeof m === "string" && m.includes("still busy (EADDRINUSE)");
  // The persistent listener-level handler's EADDRINUSE line — must NOT warn
  // during the retry window (it's demoted to debug while binding).
  const isHandlerWarn = (m: unknown) =>
    typeof m === "string" && m.includes("httpServer error:") && m.includes("EADDRINUSE");
  let debugRetries = 0;
  let warnRetries = 0;
  let errorFails = 0;
  let handlerWarns = 0;
  const logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    if (isRetry(m)) debugRetries++;
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((m?: unknown) => {
    if (isRetry(m)) warnRetries++;
    if (isHandlerWarn(m)) handlerWarns++;
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
    if (isFail(m)) errorFails++;
  });
  return {
    restore() {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
    get debugRetries() {
      return debugRetries;
    },
    get warnRetries() {
      return warnRetries;
    },
    get errorFails() {
      return errorFails;
    },
    get handlerWarns() {
      return handlerWarns;
    },
  };
}

describe("StreamerServer bind retry logging", () => {
  it("logs a recovering EADDRINUSE retry at debug, not warn", async () => {
    const port = await getRandomPort();
    const first = makeServer(port);
    await first.listen(port);

    const counter = bindLogCounter();
    const second = makeServer(port);
    const bindPromise = second.listen(port); // EADDRINUSE, then retries

    // Release the port mid-window so the second instance binds within budget.
    setTimeout(() => {
      void first.close();
    }, 600);

    await expect(bindPromise).resolves.toBeUndefined();

    expect(counter.debugRetries).toBeGreaterThanOrEqual(1);
    expect(counter.warnRetries).toBe(0);
    expect(counter.errorFails).toBe(0);
    // The persistent listener-level handler also sees each failed attempt's
    // EADDRINUSE — it must stay quiet (debug) during the bind window, not warn.
    expect(counter.handlerWarns).toBe(0);

    counter.restore();
    await second.close();
  });

  it("logs exactly one error and rethrows when all attempts are exhausted", async () => {
    const port = await getRandomPort();
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, resolve));

    const counter = bindLogCounter();
    const server = makeServer(port);

    // Port is held for the entire ~3s retry budget, so every attempt fails and
    // the final one rethrows EADDRINUSE.
    await expect(server.listen(port)).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(counter.errorFails).toBe(1);
    expect(counter.warnRetries).toBe(0);
    // The non-final attempts still logged at debug (not warn).
    expect(counter.debugRetries).toBeGreaterThanOrEqual(1);
    // The persistent handler stayed quiet for every in-window EADDRINUSE; the
    // final give-up surfaced via the bind_failed error line above, not warn.
    expect(counter.handlerWarns).toBe(0);

    counter.restore();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }, 15000);
});
