// The input_not_submitted frame is one-shot, so a client that reloads or
// reconnects inside the window would miss it. The store keeps the state until
// the session next runs, and REST plus session_update carry it.
import type { LiveSessionWiringDeps } from "../src/server-wiring";
import { createLiveSessionOptions } from "../src/server-wiring";
import { SessionStore } from "../src/session-store";

const ID = "sess-1";

function build() {
  const store = new SessionStore();
  store.addManaged({
    id: ID,
    projectPath: "/tmp/p",
    projectName: "p",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-02-01T10:00:00Z"),
    completedAt: null,
    promptCount: 2,
    lastOutput: "",
  });
  const broadcast = vi.fn();
  const deps = {
    sessionStore: store,
    wsHub: { broadcast, broadcastToClients: vi.fn() },
    sessionSubscribers: new Map(),
    ptyAttachedIds: () => new Set([ID]),
  } as unknown as LiveSessionWiringDeps;
  return { store, broadcast, options: createLiveSessionOptions(deps) };
}

const inputNotSubmitted = { promptCount: 2, at: expect.any(String) };

describe("inputNotSubmitted on the session record", () => {
  it("is null until the event arrives", () => {
    const { store } = build();
    expect(store.get(ID, new Set([ID]))?.inputNotSubmitted).toBeNull();
  });

  it("is set by the event and broadcast as a session_update", () => {
    const { store, broadcast, options } = build();
    options.onSessionEvent?.(ID, { type: "input_not_submitted", promptCount: 2 });
    expect(store.get(ID, new Set([ID]))?.inputNotSubmitted).toEqual(inputNotSubmitted);
    expect(broadcast).toHaveBeenCalledWith({
      type: "session_update",
      session: expect.objectContaining({ id: ID, inputNotSubmitted }),
    });
  });

  it("ignores other session events", () => {
    const { store, broadcast, options } = build();
    options.onSessionEvent?.(ID, { type: "turn_started", turnId: "t1" });
    expect(store.get(ID, new Set([ID]))?.inputNotSubmitted).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("clears when the session next runs", () => {
    const { store, options } = build();
    options.onSessionEvent?.(ID, { type: "input_not_submitted", promptCount: 2 });
    store.updateManaged(ID, { status: "waiting_input" });
    expect(store.get(ID, new Set([ID]))?.inputNotSubmitted).toEqual(inputNotSubmitted);
    store.updateManaged(ID, { status: "running" });
    expect(store.get(ID, new Set([ID]))?.inputNotSubmitted).toBeNull();
  });
});
