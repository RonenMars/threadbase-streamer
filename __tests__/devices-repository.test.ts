import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import {
  DevicesRepository,
  hashDeviceToken,
  parseCapabilities,
} from "../src/db/repositories/devices.repository";

/**
 * Paired-device registry (C5).
 * See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
 */

let dir: string;
let cache: ConversationCache;
let repo: DevicesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-devices-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new DevicesRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("device registration", () => {
  it("mints a distinct identity and token per device", () => {
    const a = repo.register({ publicKey: "pk-a", name: "Phone A" });
    const b = repo.register({ publicKey: "pk-b", name: "Phone B" });

    // The whole point: two devices no longer share one credential.
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.deviceToken).not.toBe(b.deviceToken);
  });

  // A database read must not yield a usable credential.
  it("persists only the token hash, never the raw token", () => {
    const { deviceToken, deviceId } = repo.register({ publicKey: "pk" });
    const row = repo.get(deviceId);

    expect(row?.token_hash).toBe(hashDeviceToken(deviceToken));
    expect(row?.token_hash).not.toBe(deviceToken);
    expect(JSON.stringify(row)).not.toContain(deviceToken);
  });

  it("defaults to the full preset and honours read-only", () => {
    expect(repo.register({ publicKey: "pk" }).capabilities).toContain("session:control");

    const ro = repo.register({ publicKey: "pk2", preset: "read-only" });
    expect(ro.capabilities).toEqual(["history:read"]);
  });
});

describe("authentication", () => {
  it("resolves a valid token to its device", () => {
    const { deviceToken, deviceId } = repo.register({ publicKey: "pk" });

    expect(repo.authenticate(deviceToken)?.device_id).toBe(deviceId);
  });

  it("rejects an unknown token", () => {
    repo.register({ publicKey: "pk" });
    expect(repo.authenticate("not-a-real-token")).toBeNull();
  });

  it("rejects a token that is merely the stored hash", () => {
    const { deviceToken } = repo.register({ publicKey: "pk" });
    // Someone who read the table still cannot authenticate with what they saw.
    expect(repo.authenticate(hashDeviceToken(deviceToken))).toBeNull();
  });
});

describe("revocation", () => {
  // The property that key rotation could never provide: revoking one device
  // must not disturb any other.
  it("revokes one device and leaves others working", () => {
    const a = repo.register({ publicKey: "pk-a" });
    const b = repo.register({ publicKey: "pk-b" });

    expect(repo.revoke(a.deviceId)).toBe(true);

    expect(repo.authenticate(a.deviceToken)).toBeNull();
    expect(repo.authenticate(b.deviceToken)?.device_id).toBe(b.deviceId);
  });

  it("takes effect immediately, with no cached grace window", () => {
    const { deviceToken, deviceId } = repo.register({ publicKey: "pk" });
    expect(repo.authenticate(deviceToken)).not.toBeNull();

    repo.revoke(deviceId);

    expect(repo.authenticate(deviceToken)).toBeNull();
  });

  it("reports false for an unknown device", () => {
    expect(repo.revoke("no-such-device")).toBe(false);
  });
});

describe("listing", () => {
  // An audit surface must never hand out a credential.
  it("never exposes a token or hash", () => {
    repo.register({ publicKey: "pk", name: "Phone" });

    const listed = repo.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/token/i);
    expect(listed[0].name).toBe("Phone");
    expect(listed[0].capabilities).toContain("history:read");
  });

  it("includes revoked devices so the history stays auditable", () => {
    const a = repo.register({ publicKey: "pk-a" });
    repo.revoke(a.deviceId);

    expect(repo.list().find((d) => d.deviceId === a.deviceId)?.revokedAt).toBeGreaterThan(0);
  });

  it("records last-seen when a device is touched", () => {
    const { deviceId } = repo.register({ publicKey: "pk" });
    expect(repo.get(deviceId)?.last_seen_at).toBeNull();

    repo.touch(deviceId, 1_700_000_000_000);

    expect(repo.get(deviceId)?.last_seen_at).toBe(1_700_000_000_000);
  });
});

describe("parseCapabilities", () => {
  // A downgrade must not silently grant a capability this build cannot enforce.
  it("drops entries this build does not recognize", () => {
    expect(parseCapabilities('["history:read","future:superpower"]')).toEqual(["history:read"]);
  });

  it("fails closed on malformed JSON", () => {
    expect(parseCapabilities("{not json")).toEqual([]);
    expect(parseCapabilities('"a string"')).toEqual([]);
  });
});
