import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import { ExpoPushSender } from "../src/services/push/expoPushSender";
import {
  IDLE_NOTIFY_DEFAULT_SWEEP_MS,
  IDLE_NOTIFY_DEFAULT_THRESHOLD_MS,
  IdleSessionNotifier,
  parseIdleNotifyConfig,
} from "../src/services/push/idleSessionNotifier";
import type { ManagedSession } from "../src/types";

/**
 * Idle-session push (#515): a session parked in `waiting_input` past a
 * threshold gets exactly one push per wait. Real PushRepository, stubbed fetch,
 * injected clock — no network, no real timers.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any) =>
    h.calls.push({ level, msg, fields });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const MIN = 60_000;
const ON = { enabled: true, thresholdMs: 20 * MIN, sweepMs: MIN };

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-idle-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
  clock = 1_000_000;
  h.calls.length = 0;
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    projectPath: "/tmp/proj",
    projectName: "my-project",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-08-11T09:00:00Z"),
    completedAt: null,
    promptCount: 1,
    lastOutput: "sk-secret-token printed by the agent",
    sessionName: "fix the login bug",
    ...overrides,
  };
}

function stubFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const n = (JSON.parse(String(init.body)) as unknown[]).length;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: Array.from({ length: n }, () => ({ status: "ok" })) }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function setup(sessions: ManagedSession[], config = ON) {
  const list = { current: sessions };
  const notifier = new IdleSessionNotifier({
    sender: new ExpoPushSender(repo),
    listSessions: () => list.current,
    config,
    now: () => clock,
  });
  /** Mirror the server funnel: update the list, then tell the notifier. */
  const transition = (s: ManagedSession, previous?: string) => {
    list.current = list.current.filter((x) => x.id !== s.id).concat(s);
    notifier.onStatusChange(s, previous);
  };
  return { notifier, list, transition };
}

describe("parseIdleNotifyConfig", () => {
  it("is off by default, with 20 minute threshold and 60 s sweep", () => {
    expect(parseIdleNotifyConfig({})).toEqual({
      enabled: false,
      thresholdMs: 20 * MIN,
      sweepMs: 60_000,
    });
    expect(IDLE_NOTIFY_DEFAULT_THRESHOLD_MS).toBe(20 * MIN);
    expect(IDLE_NOTIFY_DEFAULT_SWEEP_MS).toBe(60_000);
  });

  it("turns on only for a truthy IDLE_NOTIFY_ENABLED", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      expect(parseIdleNotifyConfig({ IDLE_NOTIFY_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ["", "0", "false", "no", "off", "banana"]) {
      expect(parseIdleNotifyConfig({ IDLE_NOTIFY_ENABLED: v }).enabled).toBe(false);
    }
  });

  it("reads the tunables as milliseconds", () => {
    const c = parseIdleNotifyConfig({
      IDLE_NOTIFY_ENABLED: "1",
      IDLE_NOTIFY_THRESHOLD_MS: "90000",
      IDLE_NOTIFY_SWEEP_MS: "5000",
    });
    expect(c).toEqual({ enabled: true, thresholdMs: 90_000, sweepMs: 5_000 });
  });

  it("falls back to the defaults for bad values", () => {
    for (const bad of ["", "abc", "-5", "0", "NaN", "Infinity", "1.5e3x", " "]) {
      const c = parseIdleNotifyConfig({
        IDLE_NOTIFY_THRESHOLD_MS: bad,
        IDLE_NOTIFY_SWEEP_MS: bad,
      });
      expect(c.thresholdMs).toBe(20 * MIN);
      expect(c.sweepMs).toBe(60_000);
    }
    for (const bad of ["1000.5", "20.5"]) {
      expect(parseIdleNotifyConfig({ IDLE_NOTIFY_THRESHOLD_MS: bad }).thresholdMs).toBe(20 * MIN);
    }
    // A sweep faster than once a second is a busy loop, not a tuning choice.
    expect(parseIdleNotifyConfig({ IDLE_NOTIFY_SWEEP_MS: "999" }).sweepMs).toBe(60_000);
    expect(parseIdleNotifyConfig({ IDLE_NOTIFY_SWEEP_MS: "1000" }).sweepMs).toBe(1_000);
    expect(parseIdleNotifyConfig({ IDLE_NOTIFY_THRESHOLD_MS: "1" }).thresholdMs).toBe(1);
  });
});

describe("IdleSessionNotifier", () => {
  beforeEach(() => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
  });

  it("is inert when disabled: no timer, no send", async () => {
    const { fn } = stubFetch();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { notifier, transition } = setup([], { ...ON, enabled: false });

    notifier.start();
    transition(session(), "running");
    await notifier.sweep();
    clock += 60 * MIN;
    await notifier.sweep();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("starts one unref'd timer on the sweep interval and stops it", () => {
    stubFetch();
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const { notifier } = setup([]);

    notifier.start();
    notifier.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(MIN);
    expect(unref).toHaveBeenCalledTimes(1);

    notifier.stop();
    expect(clearSpy).toHaveBeenCalledWith(timer);
    notifier.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it("does not fire before the threshold, fires once after it", async () => {
    const { fn, calls } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");

    clock += 20 * MIN - 1;
    await notifier.sweep();
    expect(fn).not.toHaveBeenCalled();

    clock += 1;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toContain("exp.host");
  });

  it("sends the same payload fields as the finished push, with kind idle", async () => {
    const { calls } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 25 * MIN;
    await notifier.sweep();

    const msg = JSON.parse(String(calls[0].init.body))[0];
    expect(msg).toEqual({
      to: "ExponentPushToken[a]",
      title: "💤 my-project",
      subtitle: "Claude is waiting for you",
      body: "Idle for 25 min.",
      data: { sessionId: "sess-1", kind: "idle" },
      sound: "default",
      priority: "high",
      threadId: "updates",
      collapseId: "sess-1",
      tag: "sess-1",
    });
    // Metadata only: nothing the agent or the user wrote.
    expect(JSON.stringify(msg)).not.toContain("sk-secret");
    expect(JSON.stringify(msg)).not.toContain("login bug");
  });

  it("adds the per-token serverId like every other push", async () => {
    repo.register({ token: "ExponentPushToken[b]", platform: "ios", clientServerId: "srv_bbb" });
    const { calls } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();

    const sent = JSON.parse(String(calls[0].init.body)) as Array<{
      to: string;
      data: Record<string, string>;
    }>;
    expect(sent.find((m) => m.to === "ExponentPushToken[b]")?.data.serverId).toBe("srv_bbb");
    expect(sent.find((m) => m.to === "ExponentPushToken[a]")?.data.serverId).toBeUndefined();
  });

  it("never sends twice in one wait", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    clock += 60 * MIN;
    await notifier.sweep();
    // A repeat waiting_input emit is the same wait, not a new one.
    transition(session(), "waiting_input");
    await notifier.sweep();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets when the session leaves waiting_input, and the next wait can notify", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);

    transition(session({ status: "running" }), "waiting_input");
    clock += 5 * MIN;
    transition(session(), "running");

    // The new wait has its own clock: not yet due...
    clock += 19 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
    // ...then due.
    clock += 1 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps the wait's clock across a repeat waiting_input emit", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 10 * MIN;
    transition(session(), "waiting_input");
    clock += 10 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports whole minutes, rounded down", async () => {
    const { calls } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 20 * MIN + 40_000;
    await notifier.sweep();
    expect(JSON.parse(String(calls[0].init.body))[0].body).toBe("Idle for 20 min.");
  });

  it("restarts the clock on leaving and re-entering between sweeps", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 19 * MIN;
    transition(session({ status: "running" }), "waiting_input");
    clock += 1 * MIN;
    transition(session(), "running");
    clock += 5 * MIN;
    await notifier.sweep();
    expect(fn).not.toHaveBeenCalled();
  });

  it("sends nothing for idle, running or on_hold sessions", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    for (const [i, status] of (["idle", "running", "on_hold"] as const).entries()) {
      transition(session({ id: `s${i}`, status }), "waiting_input");
    }
    await notifier.sweep();
    clock += 120 * MIN;
    await notifier.sweep();
    expect(fn).not.toHaveBeenCalled();
  });

  it("picks up a session already waiting that it never saw transition", async () => {
    const { fn } = stubFetch();
    const { notifier } = setup([session()]);
    await notifier.sweep(); // first sight: clock starts here
    expect(fn).not.toHaveBeenCalled();
    clock += 20 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("forgets a session that left the list so its id can wait afresh", async () => {
    const { fn } = stubFetch();
    const { notifier, list, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    list.current = [];
    await notifier.sweep();
    // Same id comes back waiting with no status event seen (e.g. rehydrated).
    list.current = [session()];
    await notifier.sweep();
    clock += 21 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("with no deliverable token sends nothing and does not use up the wait", async () => {
    const { fn } = stubFetch();
    repo.revoke("ExponentPushToken[a]", clock);
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    expect(fn).not.toHaveBeenCalled();

    // A device registers later in the same wait: it still gets the nudge.
    repo.register({ token: "ExponentPushToken[late]", platform: "ios" });
    clock += 1 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fn.mock.calls[0][1].body))[0].to).toBe("ExponentPushToken[late]");
    clock += 1 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("counts an attempted send as the wait's one push even if the relay failed", async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fn);
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    clock += 5 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects the receiving device's waitingInput preference", async () => {
    const { fn } = stubFetch();
    repo.register({
      token: "ExponentPushToken[a]",
      platform: "ios",
      notificationPrefs: { waitingInput: false, sessionFailed: true },
    });
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    expect(fn).not.toHaveBeenCalled();
  });

  it("never throws, and retries next sweep when the send itself blows up", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("db closed"))
      .mockResolvedValue({ attempted: 1, succeeded: 1, retired: 0, suppressed: 0 });
    const notifier = new IdleSessionNotifier({
      sender: { send },
      listSessions: () => [session()],
      config: ON,
      now: () => clock,
    });
    await notifier.sweep();
    clock += 21 * MIN;
    await expect(notifier.sweep()).resolves.toBeUndefined();
    await notifier.sweep();
    expect(send).toHaveBeenCalledTimes(2);
    await notifier.sweep();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never throws when listing sessions fails", async () => {
    const notifier = new IdleSessionNotifier({
      sender: new ExpoPushSender(repo),
      listSessions: () => {
        throw new Error("boom");
      },
      config: ON,
      now: () => clock,
    });
    await expect(notifier.sweep()).resolves.toBeUndefined();
  });

  it("does not let overlapping sweeps double-send", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await Promise.all([notifier.sweep(), notifier.sweep()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caps the sends per sweep and finishes the rest on the next", async () => {
    const { fn } = stubFetch();
    const { notifier, transition } = setup([]);
    const total = 12;
    for (let i = 0; i < total; i++) transition(session({ id: `s${i}` }), "running");
    clock += 21 * MIN;
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(10);
    await notifier.sweep();
    expect(fn).toHaveBeenCalledTimes(total);
  });

  it("logs push.idle_notify with counts and the session id, never a token", async () => {
    stubFetch();
    const { notifier, transition } = setup([]);
    transition(session(), "running");
    clock += 21 * MIN;
    await notifier.sweep();

    const call = h.calls.find((c) => c.fields?.event === "push.idle_notify");
    expect(call?.fields).toMatchObject({
      event: "push.idle_notify",
      sessionId: "sess-1",
      attempted: 1,
      succeeded: 1,
      idleMinutes: 21,
    });
    expect(JSON.stringify(call)).not.toContain("ExponentPushToken");
  });
});

describe("status funnel wiring", () => {
  it("feeds every status change to the idle notifier", async () => {
    const { createLiveSessionOptions } = await import("../src/server-wiring");
    const { SessionStore } = await import("../src/session-store");
    const onStatusChange = vi.fn();
    const store = new SessionStore();
    store.addManaged(session({ status: "running" }));
    const deps = {
      sessionStore: store,
      wsHub: { broadcast: vi.fn() },
      sessionFileMap: new Map(),
      scannerManager: { get: async () => ({}), refreshFileAfterWrite: async () => ({}) },
      sessionStatusBus: { emit: vi.fn() },
      managedSessionsRepo: () => null,
      liveActivityNotifier: () => null,
      waitingInputNotifier: () => null,
      idleSessionNotifier: () => ({ onStatusChange }),
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
    } as never;

    const s = session({ status: "waiting_input" });
    createLiveSessionOptions(deps).onStatusChange?.(s as never, "running" as never);

    expect(onStatusChange).toHaveBeenCalledWith(s, "running");
  });
});
