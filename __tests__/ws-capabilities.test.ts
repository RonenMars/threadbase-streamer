import type { WebSocket } from "ws";
import type { ApiDepsWiring } from "../src/server-wiring";
import { createApiDeps } from "../src/server-wiring";
import {
  type Capability,
  capabilitiesForPreset,
  legacyPrincipal,
  type Principal,
} from "../src/services/security/capabilities";

/**
 * Per-frame authorization on the WebSocket.
 *
 * The socket was authenticated ONCE, at the upgrade, and the principal never
 * travelled past the HTTP request — so every frame after it was authorized by
 * omission. `hold_session` was the sharp edge: it SIGINTs the agent and
 * disposes its screen, so any socket that cleared the upgrade's `history:read`
 * could stop any session by id with a single frame.
 *
 * These tests drive `handleWsMessage` directly with an explicit principal,
 * because that is the whole surface: there is no HTTP status to assert on, a
 * refused frame is dropped, and the only other evidence is the warn line.
 */

type Deps = {
  startGraceTimer: ReturnType<typeof vi.fn>;
  addSessionSubscriber: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  handleWsMessage: (ws: WebSocket, raw: unknown, principal: Principal | null) => void;
};

function buildDeps(): Deps {
  const startGraceTimer = vi.fn();
  const addSessionSubscriber = vi.fn();
  const warn = vi.fn();

  // Only the fields handleWsMessage actually reads. Casting is deliberate:
  // ApiDepsWiring assembles the whole server, and standing one up here would
  // test the wiring rather than the guard.
  const wiring = {
    startGraceTimer,
    addSessionSubscriber,
    ptyGracePeriodMs: 1000,
    wsToClientId: new Map(),
    clientIdToWs: new Map(),
    sessionSubscribers: new Map(),
    terminalSeq: new Map(),
    pendingPermission: new Map(),
    pendingQuestions: new Map(),
    // No live PTY, so subscribe_session takes its no-replay path and the test
    // observes the guard rather than the replay machinery.
    ptyManager: { hasSession: () => false },
    log: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  } as unknown as ApiDepsWiring;

  const { handleWsMessage } = createApiDeps(wiring);
  return { startGraceTimer, addSessionSubscriber, warn, handleWsMessage };
}

const fakeWs = { send: () => {} } as unknown as WebSocket;

const device = (capabilities: Capability[]): Principal => ({ kind: "device", capabilities });

const readOnly: Principal = {
  kind: "device",
  deviceId: "dev_readonly",
  capabilities: capabilitiesForPreset("read-only"),
};

const full: Principal = {
  kind: "device",
  deviceId: "dev_full",
  capabilities: capabilitiesForPreset("full"),
};

function send(deps: Deps, msg: object, principal: Principal | null): void {
  deps.handleWsMessage(fakeWs, JSON.stringify(msg), principal);
}

describe("hold_session requires session:control", () => {
  // The positive control. Without it a broken guard that refuses EVERYTHING
  // would make the refusal tests below pass for the wrong reason.
  it("holds the session for a principal that has session:control", () => {
    const deps = buildDeps();
    send(deps, { type: "hold_session", sessionId: "s1" }, full);
    expect(deps.startGraceTimer).toHaveBeenCalledWith("s1", 1000);
  });

  it("refuses a read-only device", () => {
    const deps = buildDeps();
    send(deps, { type: "hold_session", sessionId: "s1" }, readOnly);
    expect(deps.startGraceTimer).not.toHaveBeenCalled();
  });

  it("logs the refusal so a dropped frame is diagnosable", () => {
    const deps = buildDeps();
    send(deps, { type: "hold_session", sessionId: "s1" }, readOnly);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("hold_session"),
      expect.objectContaining({
        event: "ws.capability_denied",
        required: "session:control",
        deviceId: "dev_readonly",
      }),
    );
  });

  it("allows the legacy shared key, which holds the full preset plus admin", () => {
    const deps = buildDeps();
    send(deps, { type: "hold_session", sessionId: "s1" }, legacyPrincipal());
    expect(deps.startGraceTimer).toHaveBeenCalledWith("s1", 1000);
  });

  // --local-no-auth bypasses authMiddleware entirely, so no principal is set.
  // The socket must not be STRICTER than the HTTP routes on that path, or the
  // flag would half-work in a way nobody documented.
  it("allows a null principal, matching the --local-no-auth HTTP bypass", () => {
    const deps = buildDeps();
    send(deps, { type: "hold_session", sessionId: "s1" }, null);
    expect(deps.startGraceTimer).toHaveBeenCalledWith("s1", 1000);
  });
});

describe("subscribe_session requires history:read", () => {
  it("subscribes a read-only device — reading a stream is reading history", () => {
    const deps = buildDeps();
    send(deps, { type: "subscribe_session", sessionId: "s1" }, readOnly);
    expect(deps.addSessionSubscriber).toHaveBeenCalledWith("s1", fakeWs);
  });

  // Every shipped preset holds history:read, so this principal cannot arrive
  // from pairing today. It is the guard's contract under a future preset, and
  // asserting it now is what keeps the check from being deleted as dead code.
  it("refuses a principal holding no capabilities at all", () => {
    const deps = buildDeps();
    send(deps, { type: "subscribe_session", sessionId: "s1" }, device([]));
    expect(deps.addSessionSubscriber).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("subscribe_session"),
      expect.objectContaining({ required: "history:read" }),
    );
  });

  it("does not change behaviour for any preset a device can actually be issued", () => {
    for (const preset of ["full", "read-only"] as const) {
      const deps = buildDeps();
      send(
        deps,
        { type: "subscribe_session", sessionId: "s1" },
        device(capabilitiesForPreset(preset)),
      );
      expect(deps.addSessionSubscriber).toHaveBeenCalledWith("s1", fakeWs);
    }
  });
});
