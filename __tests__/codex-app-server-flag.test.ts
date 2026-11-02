import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexAppServerRunner } from "../src/codex-app-server-runner";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import { FEATURE_FLAGS } from "../src/feature-flags";
import { LiveSessionManager } from "../src/live-session-manager";
import { StreamerServer } from "../src/server";
import type { LiveSessionWiringDeps } from "../src/server-wiring";
import { createLiveSessionOptions } from "../src/server-wiring";
import { capabilitiesFor } from "../src/services/providers/capabilities";

const codexRunner = (m: LiveSessionManager) => (m as any).runners.get("codex-cli");

describe("codexAppServer flag", () => {
  it("is registered, off by default, with a stable env name", () => {
    expect(FEATURE_FLAGS.codexAppServer.default).toBe(false);
    expect(FEATURE_FLAGS.codexAppServer.env).toBe("THREADBASE_FEATURE_CODEX_APP_SERVER");
  });

  it("keeps the PTY runner as the Codex runner unless the flag is on", () => {
    expect(codexRunner(new LiveSessionManager({}))).toBeInstanceOf(CodexPtyRunner);
    expect(codexRunner(new LiveSessionManager({}, { codexAppServer: false }))).toBeInstanceOf(
      CodexPtyRunner,
    );
    const on = new LiveSessionManager({}, { codexAppServer: true });
    expect(codexRunner(on)).toBeInstanceOf(CodexAppServerRunner);
    expect(codexRunner(on)).not.toBeInstanceOf(CodexPtyRunner);
  });

  it("claims no permission gates or extra directories while the app-server runner is on", () => {
    expect(capabilitiesFor("codex-cli").permissionGates).toBe(true);
    expect(capabilitiesFor("codex-cli", { codexAppServer: true })).toMatchObject({
      permissionGates: false,
      multiDirectory: false,
      liveControl: true,
    });
  });
});

describe("session_event wiring", () => {
  it("broadcasts a normalized event to that session's subscribers only, as an additive frame", () => {
    const broadcastToClients = vi.fn();
    const subscribers = new Set([{}]);
    const deps = {
      wsHub: { broadcastToClients },
      sessionSubscribers: new Map([["s1", subscribers]]),
    } as unknown as LiveSessionWiringDeps;
    const options = createLiveSessionOptions(deps);
    options.onSessionEvent?.("s1", { type: "turn_started", turnId: "t1" });
    expect(broadcastToClients).toHaveBeenCalledWith(
      subscribers,
      expect.objectContaining({
        type: "session_event",
        sessionId: "s1",
        seq: 1,
        event: { type: "turn_started", turnId: "t1" },
        at: expect.any(String),
      }),
    );
    options.onSessionEvent?.("s1", { type: "turn_started", turnId: "t2" });
    expect(broadcastToClients.mock.calls[1][1].seq).toBe(2);
  });
});

describe("server wiring of the flag", () => {
  const runnerFor = (featureFlags: { codexAppServer: boolean }) => {
    const cacheDir = mkdtempSync(join(tmpdir(), "tb-flag-"));
    try {
      const server = new StreamerServer({
        codexRoots: [],
        scannerPersistent: false,
        port: 0,
        apiKey: "tb_test_key_for_codex_app_server_flag",
        localNoAuth: false,
        verbose: false,
        disableDb: true,
        cacheDir,
        featureFlags,
      });
      return (server as any).ptyManager.runners.get("codex-cli");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  };

  it("hands the resolved flag to the session manager", () => {
    expect(runnerFor({ codexAppServer: true })).toBeInstanceOf(CodexAppServerRunner);
    expect(runnerFor({ codexAppServer: false })).toBeInstanceOf(CodexPtyRunner);
  });
});
