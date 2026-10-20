import type { LiveSessionWiringDeps } from "../src/server-wiring";
import { createLiveSessionOptions } from "../src/server-wiring";
import { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";

/**
 * A live session's name has two writers: the runner (the first valid prompt, set
 * as soon as it is submitted) and the scanner (the full precedence, once it has
 * read the JSONL: custom title, AI title, last prompt, ...). The scanner's answer
 * covers the file the runner's prompt is in, so it must win and stay won.
 */
const ID = "sess-1";

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: ID,
    projectPath: "/tmp/p",
    projectName: "p",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-02-01T10:00:00Z"),
    completedAt: null,
    promptCount: 1,
    lastOutput: "",
    ...overrides,
  };
}

function build(refreshedName: string | null) {
  const store = new SessionStore();
  store.addManaged(session());
  const broadcast = vi.fn();
  const deps = {
    sessionStore: store,
    wsHub: { broadcast },
    sessionFileMap: new Map([[ID, "/tmp/p/sess-1.jsonl"]]),
    scannerManager: {
      get: async () => ({}),
      refreshFileAfterWrite: async () => ({
        outcome: "refreshed",
        meta: refreshedName === null ? null : { sessionName: refreshedName, messageCount: 2 },
      }),
    },
    sessionStatusBus: { emit: vi.fn() },
    managedSessionsRepo: () => null,
    liveActivityNotifier: () => null,
    waitingInputNotifier: () => null,
    ptyAttachedIds: () => new Set<string>(),
    log: () => ({ info: vi.fn(), warn: vi.fn() }),
    rememberSelfPtyEnded: vi.fn(),
    cancelPendingQuestion: vi.fn(),
    pendingQuestionKey: new Map(),
    pendingPermission: new Map(),
    pendingPermissionKey: new Map(),
    promptRegistry: { invalidateSession: vi.fn() },
    contendedSessions: new Set<string>(),
    fileWatcher: { unwatch: vi.fn() },
    sessionGeometry: new Map(),
  } as unknown as LiveSessionWiringDeps;
  return { store, broadcast, options: createLiveSessionOptions(deps) };
}

const runner = (overrides: Partial<ManagedSession>) => session(overrides) as any;

describe("live session name: runner seed, scanner wins", () => {
  it("seeds the store with the runner's name while the store has none", () => {
    const { store, options } = build(null);
    options.onStatusChange?.(runner({ sessionName: "Fix the login bug" }));
    expect(store.getManaged(ID)?.sessionName).toBe("Fix the login bug");
  });

  it("does not overwrite a name the store already holds with the runner's", () => {
    const { store, options } = build(null);
    store.updateManaged(ID, { sessionName: "AI generated title" });
    options.onStatusChange?.(runner({ sessionName: "Fix the login bug" }));
    expect(store.getManaged(ID)?.sessionName).toBe("AI generated title");
  });

  it("takes the scanner's resolved name after the turn-end refresh and tells clients", async () => {
    const { store, broadcast, options } = build("AI generated title");
    options.onStatusChange?.(runner({ sessionName: "Fix the login bug", status: "waiting_input" }));
    await vi.waitFor(() => expect(store.getManaged(ID)?.sessionName).toBe("AI generated title"));
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "session_update",
          session: expect.objectContaining({ sessionName: "AI generated title" }),
        }),
      ),
    );
  });

  it("keeps the runner's name when the refresh finds no parseable file", async () => {
    const { store, options } = build(null);
    options.onStatusChange?.(runner({ sessionName: "Fix the login bug", status: "waiting_input" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getManaged(ID)?.sessionName).toBe("Fix the login bug");
  });
});
