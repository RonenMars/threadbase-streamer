import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import { StreamerServer } from "../src/server";
import {
  DEAD_TOKEN_GRACE_MS,
  PUSH_RETENTION_SWEEP_MS,
  startPushTokenRetention,
  sweepPushTokens,
  UNUSED_TOKEN_MS,
} from "../src/services/push/pushTokenRetention";

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

/**
 * push_tokens retention (#509).
 *
 * Two rules, and only for `push_tokens`:
 * - a token a provider reported invalid is deleted once the grace period that
 *   lets /api/push/health explain it has passed;
 * - a token unused for 90 days is deleted. "Used" is the later of the last
 *   registration and the last successful send.
 *
 * Nothing here may touch device rows (a standing rule: no automatic delete or
 * revoke of a device).
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  h.calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "tb-push-retention-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  vi.useRealTimers();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

const platforms = () =>
  repo
    .listHealth(NOW)
    .map((t) => t.platform)
    .sort();

describe("policy constants", () => {
  it("pins 90 days unused, 7 days of dead-token grace, and a daily sweep", () => {
    expect(UNUSED_TOKEN_MS).toBe(90 * DAY);
    expect(DEAD_TOKEN_GRACE_MS).toBe(7 * DAY);
    expect(PUSH_RETENTION_SWEEP_MS).toBe(DAY);
  });
});

describe("dead tokens", () => {
  it("deletes an Expo token revoked longer ago than the grace", () => {
    repo.register({ token: "dead", platform: "ios", now: NOW - DAY });
    repo.revoke("dead", NOW - DEAD_TOKEN_GRACE_MS - 1);

    const out = sweepPushTokens(repo, NOW);

    expect(repo.get("dead")).toBeNull();
    expect(out).toEqual({ dead: 1, unused: 0 });
  });

  it("keeps a freshly revoked token so health can still explain it", () => {
    repo.register({ token: "fresh-dead", platform: "ios", now: NOW - DAY });
    repo.revoke("fresh-dead", NOW - DEAD_TOKEN_GRACE_MS + 1_000);

    sweepPushTokens(repo, NOW);

    expect(repo.get("fresh-dead")?.revoked_at).not.toBeNull();
  });

  it("deletes a Live Activity token APNs reported dead, after the grace", () => {
    repo.register({
      token: "apns-dead",
      platform: "ios",
      kind: "liveactivity_update",
      sessionId: "s1",
      now: NOW - DAY,
    });
    const failedAt = NOW - DEAD_TOKEN_GRACE_MS - 1;
    repo.recordFailure("apns-dead", "BadDeviceToken", failedAt);
    repo.expire("apns-dead", failedAt);

    const out = sweepPushTokens(repo, NOW);

    expect(repo.get("apns-dead")).toBeNull();
    expect(out.dead).toBe(1);
  });

  it("keeps a token whose APNs failure was transient, however old", () => {
    repo.register({
      token: "timeout",
      platform: "ios",
      kind: "liveactivity_update",
      sessionId: "s1",
      now: NOW - DAY,
    });
    repo.recordFailure("timeout", "Timeout", NOW - 30 * DAY);

    sweepPushTokens(repo, NOW);

    expect(repo.get("timeout")).not.toBeNull();
  });

  it("keeps a token that merely expired with its session", () => {
    repo.register({
      token: "ended",
      platform: "ios",
      kind: "liveactivity_update",
      sessionId: "s1",
      now: NOW - 30 * DAY,
    });
    repo.expire("ended", NOW - 30 * DAY);

    sweepPushTokens(repo, NOW);

    expect(repo.get("ended")).not.toBeNull();
  });
});

describe("boundaries", () => {
  it("deletes a revoked token exactly at the grace boundary", () => {
    repo.register({ token: "t", platform: "ios", now: NOW - DAY });
    repo.revoke("t", NOW - DEAD_TOKEN_GRACE_MS);
    sweepPushTokens(repo, NOW);
    expect(repo.get("t")).toBeNull();
  });

  it("deletes an APNs-dead token exactly at the grace boundary", () => {
    repo.register({ token: "t", platform: "ios", kind: "liveactivity_update", now: NOW - DAY });
    repo.recordFailure("t", "Unregistered", NOW - DEAD_TOKEN_GRACE_MS);
    sweepPushTokens(repo, NOW);
    expect(repo.get("t")).toBeNull();
  });

  it("deletes an unused token exactly at 90 days", () => {
    repo.register({ token: "t", platform: "ios", now: NOW - UNUSED_TOKEN_MS });
    sweepPushTokens(repo, NOW);
    expect(repo.get("t")).toBeNull();
  });

  it("keeps an APNs-dead token still inside the grace", () => {
    repo.register({ token: "t", platform: "ios", kind: "liveactivity_update", now: NOW - DAY });
    repo.recordFailure("t", "Unregistered", NOW - DEAD_TOKEN_GRACE_MS + 1_000);
    sweepPushTokens(repo, NOW);
    expect(repo.get("t")).not.toBeNull();
  });
});

describe("logging", () => {
  it("logs one push.tokens_pruned event with the counts, and nothing when idle", () => {
    sweepPushTokens(repo, NOW);
    expect(h.calls).toHaveLength(0);

    repo.register({ token: "old", platform: "ios", now: NOW - UNUSED_TOKEN_MS - 1 });
    sweepPushTokens(repo, NOW);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fields).toEqual({ event: "push.tokens_pruned", dead: 0, unused: 1 });
  });

  it("logs a failed sweep instead of throwing", () => {
    vi.useFakeTimers();
    vi.spyOn(repo, "pruneTokens").mockImplementation(() => {
      throw new Error("db locked");
    });

    expect(() => startPushTokenRetention(repo)()).not.toThrow();

    expect(h.calls.map((c) => c.fields.event)).toEqual(["push.tokens_prune_failed"]);
  });
});

describe("unused tokens", () => {
  it("deletes a token registered over 90 days ago that never delivered", () => {
    repo.register({ token: "old", platform: "ios", now: NOW - UNUSED_TOKEN_MS - 1 });

    const out = sweepPushTokens(repo, NOW);

    expect(repo.get("old")).toBeNull();
    expect(out).toEqual({ dead: 0, unused: 1 });
  });

  it("keeps a token with a recent successful send, however old its registration", () => {
    repo.register({ token: "delivering", platform: "ios", now: NOW - 200 * DAY });
    repo.recordSuccess("delivering", NOW - DAY);

    sweepPushTokens(repo, NOW);

    expect(repo.get("delivering")).not.toBeNull();
  });

  it("keeps a token re-registered recently even if it never delivered", () => {
    repo.register({ token: "reregistered", platform: "ios", now: NOW - 200 * DAY });
    repo.register({ token: "reregistered", platform: "ios", now: NOW - DAY });

    sweepPushTokens(repo, NOW);

    expect(repo.get("reregistered")).not.toBeNull();
  });

  it("keeps a token used exactly inside the window", () => {
    repo.register({ token: "edge", platform: "ios", now: NOW - UNUSED_TOKEN_MS + 1 });

    sweepPushTokens(repo, NOW);

    expect(repo.get("edge")).not.toBeNull();
  });

  it("deletes a token whose last success is the only thing old", () => {
    repo.register({ token: "stale-success", platform: "ios", now: NOW - 200 * DAY });
    repo.recordSuccess("stale-success", NOW - UNUSED_TOKEN_MS - 1);

    sweepPushTokens(repo, NOW);

    expect(repo.get("stale-success")).toBeNull();
  });
});

describe("scope", () => {
  it("leaves healthy tokens, push_events and device rows alone", () => {
    const db = cache.getDatabase();
    repo.register({ token: "ok", platform: "android", now: NOW - DAY });
    repo.register({ token: "gone", platform: "ios", now: NOW - UNUSED_TOKEN_MS - 1 });
    repo.claimEvent("evt-1", "s1", NOW - 200 * DAY);
    db.prepare(
      "INSERT INTO devices (device_id, public_key, token_hash, capabilities, created_at) VALUES ('dev-1', 'pk', 'h', '[]', ?)",
    ).run(NOW - 400 * DAY);

    sweepPushTokens(repo, NOW);

    expect(platforms()).toEqual(["android"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_events").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM devices").get()).toEqual({ n: 1 });
  });

  it("reports zero when there is nothing to delete", () => {
    repo.register({ token: "ok", platform: "ios", now: NOW - DAY });
    expect(sweepPushTokens(repo, NOW)).toEqual({ dead: 0, unused: 0 });
  });
});

describe("startPushTokenRetention", () => {
  it("sweeps at start, then once a day, and stops when asked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    repo.register({ token: "old", platform: "ios", now: NOW - UNUSED_TOKEN_MS - 1 });

    const stop = startPushTokenRetention(repo);
    expect(repo.get("old")).toBeNull();

    repo.register({ token: "later", platform: "ios", now: NOW - UNUSED_TOKEN_MS + DAY / 2 });
    expect(repo.get("later")).not.toBeNull();
    vi.advanceTimersByTime(PUSH_RETENTION_SWEEP_MS);
    expect(repo.get("later")).toBeNull();

    stop();
    repo.register({ token: "after-stop", platform: "ios", now: NOW - 400 * DAY });
    vi.advanceTimersByTime(PUSH_RETENTION_SWEEP_MS * 2);
    expect(repo.get("after-stop")).not.toBeNull();
  });
});

describe("server wiring", () => {
  it("sweeps at boot and stops its timer on close", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "threadbase-push-retention-"));
    const seed = ConversationCache.open(join(cacheDir, "cache.db"));
    new PushRepository(seed.getDatabase()).register({
      token: "ancient",
      platform: "ios",
      now: Date.now() - UNUSED_TOKEN_MS - DAY,
    });
    seed.close();

    let stop = vi.fn();
    const server = new StreamerServer({
      codexRoots: [],
      cursorRoots: [],
      scannerPersistent: false,
      port: 0,
      apiKey: "tb_test_key_for_push_retention",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
    });
    try {
      await server.listen(0, { awaitReady: true });
      expect((server as any).pushRepo.get("ancient")).toBeNull();
      expect(h.calls.some((c) => c.fields?.event === "push.tokens_pruned")).toBe(true);
      const realStop = (server as any).stopPushTokenRetention as () => void;
      stop = vi.fn(realStop);
      (server as any).stopPushTokenRetention = stop;
    } finally {
      await server.close();
      rmSync(cacheDir, { recursive: true, force: true });
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect((server as any).stopPushTokenRetention).toBeNull();
  });
});
