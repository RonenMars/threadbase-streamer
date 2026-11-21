import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
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

function build(
  refreshedName: string | null,
  extra: { meta?: Record<string, unknown> | null; repo?: unknown } = {},
) {
  const store = new SessionStore();
  store.addManaged(session());
  const broadcast = vi.fn();
  const deps = {
    sessionStore: store,
    wsHub: { broadcast },
    sessionFileMap: new Map([
      [ID, "/tmp/p/sess-1.jsonl"],
      ["sess-2", "/tmp/p/sess-2.jsonl"],
      ["sess-3", "/tmp/p/sess-3.jsonl"],
    ]),
    scannerManager: {
      get: async () => ({}),
      refreshFileAfterWrite: async () => ({
        outcome: "refreshed",
        meta:
          extra.meta !== undefined
            ? extra.meta
            : refreshedName === null
              ? null
              : { sessionName: refreshedName, messageCount: 2 },
      }),
    },
    sessionStatusBus: { emit: vi.fn() },
    managedSessionsRepo: () => extra.repo ?? null,
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

describe("live session name slots: recorded in the runtime registry after a turn", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("hands the refreshed meta to the registry under the session id", async () => {
    const recordNameSlots = vi.fn();
    const meta = {
      sessionName: "AI generated title",
      messageCount: 2,
      nameSlots: { toolTitle: "AI generated title", lastPrompt: "from slots" },
      lastPrompt: "plain",
    };
    const { options } = build(null, { meta, repo: { recordNameSlots, recordStatus: vi.fn() } });
    options.onStatusChange?.(runner({ status: "waiting_input" }));
    await vi.waitFor(() => expect(recordNameSlots).toHaveBeenCalledWith(ID, meta));
  });

  it("still records when the meta carries a last prompt but no name slots", async () => {
    const recordNameSlots = vi.fn();
    const meta = { messageCount: 2, lastPrompt: "plain" };
    const { options } = build(null, { meta, repo: { recordNameSlots, recordStatus: vi.fn() } });
    options.onStatusChange?.(runner({ status: "idle" }));
    await vi.waitFor(() => expect(recordNameSlots).toHaveBeenCalledWith(ID, meta));
  });

  it("records nothing when the refresh found no parseable file", async () => {
    const recordNameSlots = vi.fn();
    const { options } = build(null, { repo: { recordNameSlots, recordStatus: vi.fn() } });
    options.onStatusChange?.(runner({ status: "waiting_input" }));
    await settle();
    expect(recordNameSlots).not.toHaveBeenCalled();
  });

  it("records nothing while the turn is still running", async () => {
    const recordNameSlots = vi.fn();
    const meta = { messageCount: 2, nameSlots: { toolTitle: "T" } };
    const { options } = build(null, { meta, repo: { recordNameSlots, recordStatus: vi.fn() } });
    options.onStatusChange?.(runner({ status: "running" }));
    await settle();
    expect(recordNameSlots).not.toHaveBeenCalled();
  });
});

describe("live session name slots: stored on the right row of a real runtime.db", () => {
  let dir: string;
  let runtime: RuntimeStore;
  let repo: ManagedSessionsRepository;

  const spawn = (id: string) =>
    repo.recordSpawn({
      session: session({ id, provider: "claude-code" } as Partial<ManagedSession>),
      pid: 1,
      cmdline: "claude",
      streamerInstanceId: "inst",
    });

  beforeEach(() => {
    dir = join(tmpdir(), `slot-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    runtime = RuntimeStore.open(join(dir, "runtime.db"));
    repo = new ManagedSessionsRepository(runtime.getDatabase());
  });

  afterEach(() => {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the slots to the finished session's row and leaves every other row alone", async () => {
    spawn(ID);
    spawn("sess-2");
    const meta = {
      messageCount: 2,
      nameSlots: { userTitle: "Mine", toolTitle: "Tool" },
      lastPrompt: "plain last prompt",
    };
    const { options } = build(null, { meta, repo });
    options.onStatusChange?.(runner({ id: "sess-2", status: "waiting_input" }));

    await vi.waitFor(() => expect(repo.get("sess-2")?.title_tool).toBe("Tool"));
    expect(repo.get("sess-2")).toMatchObject({
      title_user: "Mine",
      title_tool: "Tool",
      last_prompt: "plain last prompt",
    });
    expect(repo.get(ID)).toMatchObject({ title_user: null, title_tool: null, last_prompt: null });
  });

  it("does not throw or invent a row for a session the registry never recorded", async () => {
    spawn(ID);
    const meta = { messageCount: 2, nameSlots: { toolTitle: "Tool" } };
    const { options } = build(null, { meta, repo });
    options.onStatusChange?.(runner({ id: "sess-3", status: "waiting_input" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(repo.get("sess-3")).toBeNull();
    expect(repo.get(ID)?.title_tool).toBeNull();
  });
});
