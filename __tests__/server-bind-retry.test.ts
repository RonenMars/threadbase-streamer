import { mkdtempSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

const recorded = vi.hoisted(() => [] as Array<{ level: string; msg: unknown }>);

vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  const tap = (real: import("../src/logger").Logger) => {
    const wrap =
      (level: "debug" | "info" | "warn" | "error") =>
      (msg: string, fields?: Record<string, unknown>, dest?: import("../src/logger").LogDest) => {
        recorded.push({ level, msg });
        real[level](msg, fields, dest);
      };
    return {
      ...real,
      debug: wrap("debug"),
      info: wrap("info"),
      warn: wrap("warn"),
      error: wrap("error"),
    };
  };
  return { ...actual, getLogger: (component?: string) => tap(actual.getLogger(component)) };
});

// Bug 1 (boot EADDRINUSE noise): on every prod boot `launchctl kickstart -k`
// relaunches before the old process frees :PORT, so bindWithRetry hits a
// transient EADDRINUSE and recovers within its attempt budget. The retries are
// expected and self-healing, so each one must log at debug (invisible by
// default) rather than warn. Only a genuinely stuck port — all attempts
// exhausted — should surface, exactly once, at error before rethrowing.
//
// We tap getLogger and record the level each line was emitted at. This used to
// spy on console.log/warn/error, which only worked because the logger's old
// dest="both" default printed every call to console regardless of pino level —
// the very duplication that grew stdout.log to 261 MB. Recording at the logger
// asserts the same intent (which level the bind path chose) without depending
// on a line being visible at a level that should have filtered it out.

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
    // This test only exercises the bind path (~20ms). Without this, listen()
    // starts a full scan of the machine's real ~/.claude/projects and close()
    // awaits it — measured at 34s under a loaded full-suite run, which is what
    // made this file flake against the 15s timeout.
    skipStartupWarmup: true,
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
  const from = recorded.length;
  const since = () => recorded.slice(from);
  const count = (level: string, match: (m: unknown) => boolean) =>
    since().filter((e) => e.level === level && match(e.msg)).length;
  return {
    restore() {
      // Nothing to unhook — the tap lives for the module's lifetime and each
      // counter reads only the slice recorded after it was created.
    },
    get debugRetries() {
      return count("debug", isRetry);
    },
    get warnRetries() {
      return count("warn", isRetry);
    },
    get errorFails() {
      return count("error", isFail);
    },
    get handlerWarns() {
      return count("warn", isHandlerWarn);
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

    // Free the port once a retry has actually been logged, rather than on a fixed
    // timer. The old 600ms guess raced the retry budget: if close() had not
    // finished when the attempts ran out, an expected recovery became an
    // exhaustion.
    await vi.waitFor(() => expect(counter.debugRetries).toBeGreaterThanOrEqual(1));
    await first.close();

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
