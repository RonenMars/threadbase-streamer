import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import type { ApnsClient } from "../src/services/push/apnsClient";
import {
  LiveActivityRenewalScheduler,
  RENEWAL_LEAD_MS,
  renewalDueAt,
} from "../src/services/push/liveActivityRenewal";
import { LiveActivitySender } from "../src/services/push/liveActivitySender";
import { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";

/**
 * Live Activity renewal (Feature 12 phase 1b).
 *
 * iOS ends a Live Activity ~8h after it starts, so a long session loses its
 * surface mid-session unless the activity is replaced before the cap.
 *
 * The failure mode these tests exist for: a renewal that stamps a fresh
 * `startedAt` makes the user's visible elapsed timer reset to zero, because iOS
 * renders the timer itself from that value. It is invisible server-side.
 */

const HOUR = 60 * 60 * 1000;
const ORIGINAL_START = 1_700_000_000_000;
/** 8h cap from the original start. */
const STALE_DATE = ORIGINAL_START + 8 * HOUR;

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-renew-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
  store = new SessionStore();
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
    startedAt: new Date(ORIGINAL_START),
    completedAt: null,
    promptCount: 0,
    lastOutput: "still building",
    ...overrides,
  } as ManagedSession;
}

/** Captures sends without touching the network. */
function fakeApns() {
  const sent: Array<{ deviceToken: string; payload: ApsPayload }> = [];
  const client = {
    send: vi.fn(async (args: { deviceToken: string; payload: unknown }) => {
      sent.push({ deviceToken: args.deviceToken, payload: args.payload as ApsPayload });
      return { ok: true, status: 200, tokenDead: false };
    }),
    topic: "com.example.app.push-type.liveactivity",
    close: vi.fn(),
  };
  return { sent, client: client as unknown as ApnsClient };
}

interface ApsPayload {
  aps: {
    event: string;
    timestamp: number;
    "stale-date"?: number;
    "content-state": { startedAt: number; status: string; sessionId: string };
  };
}

function registerActivity(
  token: string,
  over: Partial<Parameters<PushRepository["register"]>[0]> = {},
) {
  repo.register({
    token,
    platform: "ios",
    kind: "liveactivity_update",
    activityId: `act-${token}`,
    sessionId: "sess-1",
    startedAt: ORIGINAL_START,
    staleDate: STALE_DATE,
    ...over,
  });
}

function scheduler(args: { now: number; sent?: ReturnType<typeof fakeApns> }) {
  const apns = args.sent ?? fakeApns();
  const sender = new LiveActivitySender(apns.client, repo);
  const sched = new LiveActivityRenewalScheduler({
    repo,
    sender,
    sessionStore: store,
    serverId: "srv-1",
    now: () => args.now,
  });
  return { sched, apns };
}

describe("renewal timing", () => {
  it("fires 30 minutes before the cap", () => {
    registerActivity("tok-a");
    const row = repo.get("tok-a");
    if (!row) throw new Error("expected the registered activity to be stored");

    expect(renewalDueAt(row)).toBe(STALE_DATE - RENEWAL_LEAD_MS);
    expect(RENEWAL_LEAD_MS).toBe(30 * 60 * 1000);
  });

  it("does not renew before the window opens", async () => {
    registerActivity("tok-a");
    store.addManaged(managed());
    // One hour before the renewal is due.
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS - HOUR });

    await sched.tick();
    sched.stop();

    expect(apns.client.send).not.toHaveBeenCalled();
    expect(repo.listRenewable()).toHaveLength(1);
  });

  it("renews once inside the window", async () => {
    registerActivity("tok-a");
    store.addManaged(managed());
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    expect(apns.sent.map((s) => s.payload.aps.event)).toContain("end");
    expect(repo.listRenewable()).toEqual([]);
  });
});

describe("elapsed-time continuity", () => {
  // THE failure this feature must not have. iOS renders its own ticking timer
  // from startedAt, so a fresh value visibly resets the user's timer to zero.
  it("carries the ORIGINAL startedAt through the renewal unchanged", async () => {
    registerActivity("tok-a");
    // A push-to-start token exists, so a replacement is actually requested.
    repo.register({ token: "start-tok", platform: "ios", kind: "liveactivity_start" });
    // The session has been running for hours by now.
    store.addManaged(managed());
    const now = STALE_DATE - RENEWAL_LEAD_MS + 1_000;
    const { sched, apns } = scheduler({ now });

    await sched.tick();
    sched.stop();

    // Every push in the renewal — the end AND the replacement start — must carry
    // the original start, not `now`.
    expect(apns.sent).toHaveLength(2);
    for (const s of apns.sent) {
      expect(s.payload.aps["content-state"].startedAt).toBe(ORIGINAL_START);
    }
    // Explicitly not the current time, which is the regression's signature.
    expect(apns.sent.some((s) => s.payload.aps["content-state"].startedAt === now)).toBe(false);
  });

  it("gives the replacement a fresh 8h window from the original start", async () => {
    registerActivity("tok-a");
    repo.register({ token: "start-tok", platform: "ios", kind: "liveactivity_start" });
    store.addManaged(managed());
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    const replacement = apns.sent.find((s) => s.deviceToken === "start-tok");
    // stale-date is in seconds; the window is measured from the original start.
    expect(replacement?.payload.aps["stale-date"]).toBe(
      Math.floor((ORIGINAL_START + 8 * HOUR) / 1000),
    );
  });

  // A restart loses in-memory state, so the persisted started_at is the only
  // surviving record of the original start.
  it("prefers the persisted started_at over the session's own", async () => {
    registerActivity("tok-a", { startedAt: ORIGINAL_START });
    repo.register({ token: "start-tok", platform: "ios", kind: "liveactivity_start" });
    // A resumed session reports a LATER start than the activity's original.
    store.addManaged(managed({ startedAt: new Date(ORIGINAL_START + 5 * HOUR) }));
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    for (const s of apns.sent) {
      expect(s.payload.aps["content-state"].startedAt).toBe(ORIGINAL_START);
    }
  });
});

describe("only renews genuinely live sessions", () => {
  // A session that ended inside the renewal window must NOT be resurrected.
  it("does not renew a session that is gone", async () => {
    registerActivity("tok-a");
    // Nothing added to the store: the session no longer exists.
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    expect(apns.client.send).not.toHaveBeenCalled();
    // And it stops being reconsidered, rather than being retried every tick.
    expect(repo.listRenewable()).toEqual([]);
  });

  it("does not renew an idle session", async () => {
    registerActivity("tok-a");
    store.addManaged(managed({ status: "idle", completedAt: new Date() }));
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    expect(apns.client.send).not.toHaveBeenCalled();
    expect(repo.listForSession("liveactivity_update", "sess-1")).toEqual([]);
  });

  it("renews a waiting_input session, which is still live", async () => {
    registerActivity("tok-a");
    store.addManaged(managed({ status: "waiting_input" }));
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    expect(apns.sent[0]?.payload.aps["content-state"].status).toBe("waiting_input");
  });
});

describe("restart safety", () => {
  // Deadlines live in the DB precisely so a restart mid-window does not drop
  // them: an in-process timer would have died with the process.
  it("finds a pending renewal after a restart", () => {
    registerActivity("tok-a");
    // Simulate a restart: a brand-new repository over the same database file.
    const fresh = new PushRepository(cache.getDatabase());

    expect(fresh.listRenewable().map((r) => r.token)).toEqual(["tok-a"]);
    expect(fresh.get("tok-a")?.started_at).toBe(ORIGINAL_START);
  });

  // A re-armed timer after a restart must not send a second time.
  it("does not double-send when a second tick runs the same window", async () => {
    registerActivity("tok-a");
    repo.register({ token: "start-tok", platform: "ios", kind: "liveactivity_start" });
    store.addManaged(managed());
    const now = STALE_DATE - RENEWAL_LEAD_MS + 1_000;
    const apns = fakeApns();
    const { sched } = scheduler({ now, sent: apns });

    await sched.tick();
    const afterFirst = apns.sent.length;
    // Second sweep in the same window, as a restart would produce.
    await sched.tick();
    sched.stop();

    expect(apns.sent).toHaveLength(afterFirst);
  });

  it("is idempotent at the claim level regardless of caller", () => {
    registerActivity("tok-a");

    expect(repo.claimRenewal("tok-a")).toBe(true);
    expect(repo.claimRenewal("tok-a")).toBe(false);
  });
});

describe("failure isolation", () => {
  it("keeps sweeping after one activity fails to send", async () => {
    registerActivity("bad-tok");
    registerActivity("good-tok");
    store.addManaged(managed());
    let call = 0;
    const client = {
      send: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("socket hang up");
        return { ok: true, status: 200, tokenDead: false };
      }),
      topic: "t",
      close: vi.fn(),
    } as unknown as ApnsClient;
    const sched = new LiveActivityRenewalScheduler({
      repo,
      sender: new LiveActivitySender(client, repo),
      sessionStore: store,
      serverId: "srv-1",
      now: () => STALE_DATE - RENEWAL_LEAD_MS + 1_000,
    });

    await sched.tick();
    sched.stop();

    // Both rows considered; the throw did not abort the sweep.
    expect(repo.listRenewable()).toEqual([]);
  });

  // Renewal must not fail just because the device never registered a
  // push-to-start token — the app cannot be asked to start one remotely, and
  // the next foreground WS update recreates it.
  it("still ends the old activity without a push-to-start token", async () => {
    registerActivity("tok-a");
    store.addManaged(managed());
    const { sched, apns } = scheduler({ now: STALE_DATE - RENEWAL_LEAD_MS + 1_000 });

    await sched.tick();
    sched.stop();

    expect(apns.sent).toHaveLength(1);
    expect(apns.sent[0]?.payload.aps.event).toBe("end");
  });
});
