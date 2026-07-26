import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import {
  DEFAULT_PUSH_TOKEN_KIND,
  isPushTokenKind,
  PushRepository,
} from "../src/db/repositories/push.repository";

/**
 * Push token kinds (Live Activities, Feature 12 phase 1b).
 *
 * A device supplies three non-interchangeable token types. Conflating them
 * fails only at send time — an ActivityKit token is rejected by Expo's relay,
 * an Expo token is rejected by APNs for a .push-type.liveactivity topic — with
 * nothing at registration time to explain why. These tests pin the separation.
 */

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-push-kind-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("backward compatibility", () => {
  // tb-mobile is released and cannot be force-updated. A client posting
  // { token, platform } with no kind must keep working.
  it("defaults an omitted kind to expo", () => {
    repo.register({ token: "old-client", platform: "ios" });

    expect(repo.get("old-client")?.kind).toBe("expo");
    expect(DEFAULT_PUSH_TOKEN_KIND).toBe("expo");
  });

  it("keeps a kind-less registration deliverable over the expo relay", () => {
    repo.register({ token: "old-client", platform: "ios" });

    expect(repo.listDeliverable().map((t) => t.token)).toEqual(["old-client"]);
  });
});

describe("kind isolation", () => {
  // The failure this prevents: an ActivityKit token posted to Expo's relay.
  it("excludes live-activity tokens from the expo delivery list", () => {
    repo.register({ token: "expo-tok", platform: "ios", kind: "expo" });
    repo.register({ token: "start-tok", platform: "ios", kind: "liveactivity_start" });
    repo.register({
      token: "update-tok",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-1",
      sessionId: "sess-1",
    });

    expect(repo.listDeliverable().map((t) => t.token)).toEqual(["expo-tok"]);
  });

  it("looks per-activity tokens up by session", () => {
    repo.register({
      token: "update-a",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-a",
      sessionId: "sess-1",
    });
    repo.register({
      token: "update-b",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-b",
      sessionId: "sess-2",
    });

    expect(repo.listForSession("liveactivity_update", "sess-1").map((t) => t.token)).toEqual([
      "update-a",
    ]);
  });

  // Push-to-start is app-wide: the activity does not exist yet, so there is no
  // per-activity token to look up.
  it("lists push-to-start tokens without a session", () => {
    repo.register({ token: "start-tok", platform: "ios", kind: "liveactivity_start" });
    repo.register({ token: "expo-tok", platform: "ios" });

    expect(repo.listByKind("liveactivity_start").map((t) => t.token)).toEqual(["start-tok"]);
  });

  it("rejects unknown kinds at the type guard", () => {
    expect(isPushTokenKind("expo")).toBe(true);
    expect(isPushTokenKind("liveactivity_update")).toBe(true);
    expect(isPushTokenKind("apns")).toBe(false);
    expect(isPushTokenKind(undefined)).toBe(false);
  });
});

describe("multiple live activities per device", () => {
  // A device runs one activity per live session. 012's shape assumed one token
  // per device; this is the case that shape could not express.
  it("keeps one row per activity for the same device", () => {
    repo.register({
      token: "update-a",
      platform: "ios",
      deviceId: "dev-1",
      kind: "liveactivity_update",
      activityId: "act-a",
      sessionId: "sess-1",
    });
    repo.register({
      token: "update-b",
      platform: "ios",
      deviceId: "dev-1",
      kind: "liveactivity_update",
      activityId: "act-b",
      sessionId: "sess-2",
    });

    const rows = repo.listByKind("liveactivity_update");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.activity_id).sort()).toEqual(["act-a", "act-b"]);
  });
});

describe("expiry", () => {
  it("drops an expired per-activity token from delivery", () => {
    const now = 1_000_000;
    repo.register({
      token: "update-tok",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-1",
      sessionId: "sess-1",
      expiresAt: now - 1,
    });

    expect(repo.listForSession("liveactivity_update", "sess-1", now)).toEqual([]);
  });

  // A per-activity token must not outlive its session, or a later renewal
  // sweep resurrects an activity for a session that is already gone.
  it("expires every activity for a session at once", () => {
    const now = 2_000_000;
    for (const [token, activityId] of [
      ["a", "act-a"],
      ["b", "act-b"],
    ]) {
      repo.register({
        token,
        platform: "ios",
        kind: "liveactivity_update",
        activityId,
        sessionId: "sess-1",
      });
    }

    repo.expireSessionActivities("sess-1", now);

    expect(repo.listForSession("liveactivity_update", "sess-1", now)).toEqual([]);
  });

  it("reports an expired token as expired rather than failing", () => {
    const now = 3_000_000;
    repo.register({
      token: "update-tok",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-1",
      sessionId: "sess-1",
      expiresAt: now - 1,
    });

    const health = repo.listHealth(now);
    expect(health[0]?.state).toBe("expired");
    expect(health[0]?.kind).toBe("liveactivity_update");
  });
});

describe("startedAt continuity", () => {
  // The headline failure mode: iOS renders its own ticking timer from
  // startedAt, so overwriting it makes the user's elapsed time jump back to
  // zero. Re-registration must preserve the original.
  it("preserves the original startedAt across re-registration", () => {
    repo.register({
      token: "update-tok",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-1",
      sessionId: "sess-1",
      startedAt: 1_000,
    });
    repo.register({
      token: "update-tok",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-1",
      sessionId: "sess-1",
      startedAt: 9_999,
    });

    expect(repo.get("update-tok")?.started_at).toBe(1_000);
  });
});

describe("renewal claim", () => {
  it("lists unrenewed activities with a deadline, soonest first", () => {
    repo.register({
      token: "late",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-late",
      sessionId: "s1",
      staleDate: 5_000,
    });
    repo.register({
      token: "soon",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-soon",
      sessionId: "s2",
      staleDate: 1_000,
    });
    // No deadline — never a renewal candidate.
    repo.register({ token: "expo-tok", platform: "ios" });

    expect(repo.listRenewable().map((r) => r.token)).toEqual(["soon", "late"]);
  });

  // A restart re-arms timers from the persisted deadline, so the same renewal
  // can be attempted twice. Exactly one attempt may send.
  it("claims a renewal exactly once", () => {
    repo.register({
      token: "update-tok",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-1",
      sessionId: "sess-1",
      staleDate: 1_000,
    });

    expect(repo.claimRenewal("update-tok")).toBe(true);
    expect(repo.claimRenewal("update-tok")).toBe(false);
    expect(repo.listRenewable()).toEqual([]);
  });
});
