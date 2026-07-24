import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { FAILURE_STREAK_LIMIT, PushRepository } from "../src/db/repositories/push.repository";

/**
 * Push registration and delivery state (C7).
 *
 * POST /api/push/register was a no-op returning { ok: true }: mobile registered,
 * got success, and nothing was stored — so nothing could ever be delivered and
 * no failure could be observed.
 */

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-push-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("registration", () => {
  it("persists a token so delivery becomes possible at all", () => {
    repo.register({ token: "tok-1", platform: "ios" });

    expect(repo.get("tok-1")?.platform).toBe("ios");
    expect(repo.listDeliverable().map((t) => t.token)).toEqual(["tok-1"]);
  });

  // Without upsert, one device accumulates rows and receives the same
  // notification several times.
  it("updates rather than duplicating on re-registration", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.register({ token: "tok-1", platform: "android" });

    expect(repo.listHealth()).toHaveLength(1);
    expect(repo.get("tok-1")?.platform).toBe("android");
  });

  it("clears prior failure state on re-registration", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.recordFailure("tok-1", "DeviceNotRegistered");
    repo.register({ token: "tok-1", platform: "ios" });

    // The client is telling us this token is live again.
    expect(repo.get("tok-1")?.failure_streak).toBe(0);
    expect(repo.get("tok-1")?.last_failure_code).toBeNull();
  });

  it("revives a revoked token on re-registration", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.revoke("tok-1");
    repo.register({ token: "tok-1", platform: "ios" });

    expect(repo.get("tok-1")?.revoked_at).toBeNull();
    expect(repo.listDeliverable()).toHaveLength(1);
  });

  // Push registration predates device identity (C5) and must keep working
  // without it.
  it("accepts a registration with no device id", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    expect(repo.get("tok-1")?.device_id).toBeNull();
  });
});

describe("delivery health", () => {
  // "Not yet delivered" and "your notifications are broken" look identical
  // without this distinction, and they need very different UI.
  it("distinguishes never-delivered from healthy", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    expect(repo.listHealth()[0].state).toBe("never-delivered");

    repo.recordSuccess("tok-1");
    expect(repo.listHealth()[0].state).toBe("healthy");
  });

  it("reports failing while the streak is below the limit", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.recordFailure("tok-1", "MessageRateExceeded");

    expect(repo.listHealth()[0].state).toBe("failing");
    expect(repo.listHealth()[0].lastFailureCode).toBe("MessageRateExceeded");
  });

  // A provider rejecting a token repeatedly means the app is gone. Retrying
  // forever wastes work and misreports "failing" instead of "this device left".
  it("stops delivering to a token past the failure limit", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    for (let i = 0; i < FAILURE_STREAK_LIMIT; i++) {
      repo.recordFailure("tok-1", "DeviceNotRegistered");
    }

    expect(repo.listHealth()[0].state).toBe("dead");
    expect(repo.listDeliverable()).toHaveLength(0);
  });

  it("recovers a failing token after a success", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.recordFailure("tok-1", "Timeout");
    repo.recordSuccess("tok-1");

    expect(repo.listHealth()[0].state).toBe("healthy");
    expect(repo.listHealth()[0].failureStreak).toBe(0);
  });

  it("keeps a revoked token in the report to explain why delivery stopped", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.revoke("tok-1");

    expect(repo.listHealth()[0].state).toBe("revoked");
    expect(repo.listDeliverable()).toHaveLength(0);
  });

  // A push token is a delivery credential; a health endpoint has no reason to
  // echo one back.
  it("never includes the token itself in health output", () => {
    repo.register({ token: "super-secret-token", platform: "ios" });

    expect(JSON.stringify(repo.listHealth())).not.toContain("super-secret-token");
  });
});

describe("event deduplication", () => {
  // The user must never be told twice about one thing.
  it("claims an event id exactly once", () => {
    expect(repo.claimEvent("evt-1", "sess-1")).toBe(true);
    expect(repo.claimEvent("evt-1", "sess-1")).toBe(false);
  });

  it("allows distinct events", () => {
    expect(repo.claimEvent("evt-1", "sess-1")).toBe(true);
    expect(repo.claimEvent("evt-2", "sess-1")).toBe(true);
  });

  // A reconnect reconciliation re-evaluates events that may already have been
  // delivered; the claim must still refuse them.
  it("refuses a re-claim even after delivery is recorded", () => {
    repo.claimEvent("evt-1", "sess-1");
    repo.markDelivered("evt-1");

    expect(repo.claimEvent("evt-1", "sess-1")).toBe(false);
  });
});
