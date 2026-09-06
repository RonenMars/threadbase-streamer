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

describe("deletion", () => {
  // Delete rather than revoke: a retained row is still a stored delivery
  // credential, so "we no longer hold your token" has to mean the row is gone.
  it("erases a token so nothing about it is retained", () => {
    repo.register({ token: "tok-1", platform: "ios" });

    expect(repo.deleteToken("tok-1")).toBe(true);
    expect(repo.get("tok-1")).toBeNull();
    expect(repo.listHealth()).toHaveLength(0);
  });

  // The unregister route is idempotent, which it can only be if a second
  // delete is a non-event rather than an error.
  it("reports nothing deleted the second time", () => {
    repo.register({ token: "tok-1", platform: "ios" });
    repo.deleteToken("tok-1");

    expect(repo.deleteToken("tok-1")).toBe(false);
  });

  it("erases every token of one device and leaves another device alone", () => {
    repo.register({ token: "a-1", platform: "ios", deviceId: "dev-a" });
    repo.register({ token: "a-2", platform: "ios", deviceId: "dev-a" });
    repo.register({ token: "b-1", platform: "ios", deviceId: "dev-b" });

    expect(repo.deleteForDevice("dev-a")).toBe(2);
    expect(repo.listHealth().map((t) => t.deviceId)).toEqual(["dev-b"]);
  });

  // Registrations predating device identity carry no device id. Deleting them
  // alongside some other device's tokens would retire a phone that was never
  // revoked.
  it("leaves unattributed tokens alone when erasing a device", () => {
    repo.register({ token: "orphan", platform: "ios" });
    repo.register({ token: "a-1", platform: "ios", deviceId: "dev-a" });

    expect(repo.deleteForDevice("dev-a")).toBe(1);
    expect(repo.get("orphan")).not.toBeNull();
  });

  describe("ownership-scoped delete", () => {
    it("erases the caller's own token", () => {
      repo.register({ token: "a-1", platform: "ios", deviceId: "dev-a" });

      expect(repo.deleteTokenForDevice("a-1", "dev-a")).toBe(true);
      expect(repo.get("a-1")).toBeNull();
    });

    // Otherwise any device holding `notifications` could retire a sibling's
    // token just by learning its value.
    it("refuses another device's token", () => {
      repo.register({ token: "b-1", platform: "ios", deviceId: "dev-b" });

      expect(repo.deleteTokenForDevice("b-1", "dev-a")).toBe(false);
      expect(repo.get("b-1")).not.toBeNull();
    });

    // Rows written before register took the device id from the principal have
    // none. Without this arm a phone could never retire its own old token.
    it("erases an unattributed token", () => {
      repo.register({ token: "orphan", platform: "ios" });

      expect(repo.deleteTokenForDevice("orphan", "dev-a")).toBe(true);
      expect(repo.get("orphan")).toBeNull();
    });
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
