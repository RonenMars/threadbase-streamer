import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import { StreamerServer } from "../src/server";
import type { ApnsClient, ApnsSendResult } from "../src/services/push/apnsClient";
import {
  liveActivityMetricsSnapshot,
  resetLiveActivityMetrics,
} from "../src/services/push/liveActivityMetrics";
import { LiveActivityNotifier } from "../src/services/push/liveActivityNotifier";
import {
  LiveActivityRenewalScheduler,
  RENEWAL_LEAD_MS,
} from "../src/services/push/liveActivityRenewal";
import { LiveActivitySender } from "../src/services/push/liveActivitySender";
import { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";

/**
 * Live Activity lifecycle counts and log events (#509).
 *
 * An ActivityKit decode failure is silent and a Lock Screen surface that stops
 * updating leaves nothing to look at, so each start, renew, end and retire is
 * logged as its own event and counted for /api/push/health.
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

const eventsOf = (event: string) => h.calls.filter((c) => c.fields?.event === event);

const HOUR = 60 * 60 * 1000;
const START = 1_700_000_000_000;

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  h.calls.length = 0;
  resetLiveActivityMetrics();
  dir = mkdtempSync(join(tmpdir(), "tb-la-metrics-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

function managed(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    projectPath: "/tmp/proj",
    projectName: "proj",
    branch: "main",
    status: "running",
    startedAt: new Date(START),
    completedAt: null,
    promptCount: 0,
    lastOutput: "building",
    ...overrides,
  } as ManagedSession;
}

function apnsReturning(result: ApnsSendResult): ApnsClient {
  return { send: vi.fn(async () => result), close: vi.fn() } as unknown as ApnsClient;
}

const ok: ApnsSendResult = { ok: true, status: 200, tokenDead: false };

function registerActivity(token: string) {
  repo.register({
    token,
    platform: "ios",
    kind: "liveactivity_update",
    activityId: `act-${token.length}`,
    sessionId: "sess-1",
    startedAt: START,
    staleDate: START + 8 * HOUR,
  });
}

describe("counters", () => {
  it("start at zero with a since timestamp", () => {
    const snap = liveActivityMetricsSnapshot();
    expect(snap).toMatchObject({ started: 0, renewed: 0, ended: 0, retired: 0 });
    expect(snap.since).toBeGreaterThan(1_700_000_000_000);
    expect(snap.since).toBeLessThanOrEqual(Date.now());
  });
});

describe("started and ended", () => {
  const notifier = (sender: Partial<LiveActivitySender>) =>
    new LiveActivityNotifier(sender as LiveActivitySender, "srv-1");
  const outcome = { attempted: 1, succeeded: 1, retired: 0 };

  it("counts and logs a turn start when an activity was pushed", async () => {
    const n = notifier({ send: vi.fn(async () => outcome) });

    await n.onStatusChange(managed({ status: "running" }), "waiting_input");

    expect(liveActivityMetricsSnapshot().started).toBe(1);
    const [evt] = eventsOf("live_activity.started");
    expect(evt.msg).toBe("live_activity.started");
    expect(evt.fields).toMatchObject({ sessionId: "sess-1", status: "running" });
  });

  it("does not count a start that had no activity to push to", async () => {
    const n = notifier({ send: vi.fn(async () => ({ attempted: 0, succeeded: 0, retired: 0 })) });

    await n.onStatusChange(managed({ status: "running" }), "waiting_input");

    expect(liveActivityMetricsSnapshot().started).toBe(0);
    expect(eventsOf("live_activity.started")).toHaveLength(0);
  });

  it("counts an end once, not the start", async () => {
    const n = notifier({
      send: vi.fn(async () => outcome),
      end: vi.fn(async () => outcome),
    });

    await n.onStatusChange(managed({ status: "running" }), "waiting_input");
    await n.onStatusChange(managed({ status: "waiting_input" }), "running");

    const snap = liveActivityMetricsSnapshot();
    expect(snap.started).toBe(1);
    expect(snap.ended).toBe(1);
    expect(eventsOf("live_activity.ended")).toHaveLength(1);
  });

  it("does not count a name refresh as a start", async () => {
    const n = notifier({ send: vi.fn(async () => outcome) });

    await n.onStatusChange(managed({ status: "running" }), "waiting_input");
    await n.onStatusChange(managed({ status: "running", sessionName: "named" }), "running");

    expect(liveActivityMetricsSnapshot().started).toBe(1);
  });
});

describe("retired", () => {
  it("counts and logs each token APNs reports dead, without the token", async () => {
    registerActivity("secret-token-a");
    registerActivity("secret-token-b");
    const sender = new LiveActivitySender(
      apnsReturning({ ok: false, status: 410, reason: "Unregistered", tokenDead: true }),
      repo,
    );

    await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: {
        sessionId: "sess-1",
        serverId: "srv-1",
        projectName: "proj",
        status: "running",
        startedAt: START,
        lastOutput: "",
      },
    });

    expect(liveActivityMetricsSnapshot().retired).toBe(2);
    const retired = eventsOf("live_activity.retired");
    expect(retired).toHaveLength(2);
    expect(retired[0].msg).toBe("live_activity.retired");
    expect(retired[0].fields).toMatchObject({ sessionId: "sess-1", reason: "Unregistered" });
    expect(JSON.stringify(h.calls)).not.toContain("secret-token");
  });

  it("does not count a transient failure", async () => {
    registerActivity("tok-a");
    const sender = new LiveActivitySender(
      apnsReturning({ ok: false, status: 0, reason: "Timeout", tokenDead: false }),
      repo,
    );

    await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: {
        sessionId: "sess-1",
        serverId: "srv-1",
        projectName: "proj",
        status: "running",
        startedAt: START,
        lastOutput: "",
      },
    });

    expect(liveActivityMetricsSnapshot().retired).toBe(0);
    expect(eventsOf("live_activity.retired")).toHaveLength(0);
  });
});

describe("renewed", () => {
  const tick = async () => {
    const store = new SessionStore();
    store.addManaged(managed());
    const sched = new LiveActivityRenewalScheduler({
      repo,
      sender: new LiveActivitySender(apnsReturning(ok), repo),
      sessionStore: store,
      serverId: "srv-1",
      now: () => START + 8 * HOUR - RENEWAL_LEAD_MS + 1_000,
    });
    await sched.tick();
    sched.stop();
  };

  it("counts a renewal once it was sent", async () => {
    registerActivity("tok-a");

    await tick();

    expect(liveActivityMetricsSnapshot().renewed).toBe(1);
    expect(eventsOf("live_activity.renewed")).toHaveLength(1);
  });

  it("does not count the same renewal twice", async () => {
    registerActivity("tok-a");

    await tick();
    await tick();

    expect(liveActivityMetricsSnapshot().renewed).toBe(1);
  });

  it("does not count a renewal that failed", async () => {
    registerActivity("tok-a");
    const store = new SessionStore();
    store.addManaged(managed());
    const failing = {
      send: vi.fn(async () => {
        throw new Error("boom");
      }),
      close: vi.fn(),
    } as unknown as ApnsClient;
    const sched = new LiveActivityRenewalScheduler({
      repo,
      sender: new LiveActivitySender(failing, repo),
      sessionStore: store,
      serverId: "srv-1",
      now: () => START + 8 * HOUR - RENEWAL_LEAD_MS + 1_000,
    });

    await sched.tick();
    sched.stop();

    expect(liveActivityMetricsSnapshot().renewed).toBe(0);
  });
});

describe("GET /api/push/health", () => {
  let server: StreamerServer;
  let cacheDir: string;
  const API_KEY = "tb_test_key_for_la_metrics";

  beforeEach(async () => {
    delete process.env.THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH;
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-la-metrics-"));
    server = new StreamerServer({
      codexRoots: [],
      cursorRoots: [],
      scannerPersistent: false,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
    });
    await server.listen(0, { awaitReady: true });
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const health = async () =>
    (
      await fetch(`http://localhost:${server.port}/api/push/health`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      })
    ).json();

  it("reports the counts beside the existing fields", async () => {
    const before = await health();
    expect(before.liveActivityMetrics).toMatchObject({
      started: 0,
      renewed: 0,
      ended: 0,
      retired: 0,
    });

    const n = new LiveActivityNotifier(
      { send: vi.fn(async () => ({ attempted: 1, succeeded: 1, retired: 0 })) } as never,
      "srv-1",
    );
    await n.onStatusChange(managed({ status: "running" }), "waiting_input");

    const after = await health();
    expect(after.liveActivityMetrics.started).toBe(1);
    // Existing fields are untouched.
    expect(after.available).toBe(true);
    expect(Array.isArray(after.tokens)).toBe(true);
    expect(after.push).toBeDefined();
  });
});
