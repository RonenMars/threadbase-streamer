import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";

/**
 * Binding a paired device's identity to a key rather than a string (#590,
 * Phase 2). See specs/end-to-end-encryption/design.md §2.5.
 *
 * The columns live in a RUNTIME migration, not a cache one. Everything in
 * cache.db is regenerable from ~/.claude and ~/.codex, which is why
 * `tb-streamer cache clear` deletes it outright — and a pinned static key is
 * not regenerable from anything. On the cache side a routine clear would drop
 * every device's pinned key while leaving that device's authentication intact
 * here, so the devices would keep working, unencrypted, with nothing reporting
 * an error.
 */

const KEY_A = "YmFzZTY0LWxvb2tpbmcta2V5LWZvci1kZXZpY2UtYQ==";
const KEY_B = "YmFzZTY0LWxvb2tpbmcta2V5LWZvci1kZXZpY2UtYg==";

let dir: string;
let store: RuntimeStore;
let repo: DevicesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-device-e2ee-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new DevicesRepository(store.getDatabase());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a plaintext pairing", () => {
  /**
   * The compatibility half, and the one that must not move: a device that never
   * completed a handshake is stored exactly as it is today, and is never pinned.
   * Pinning one would refuse it plaintext it has no way to stop using.
   */
  it("records no key and no pin, exactly as before", () => {
    const { deviceId } = repo.register({ publicKey: "pk", name: "Old Phone" });
    const row = repo.get(deviceId);

    expect(row?.e2ee_static_pub).toBeNull();
    expect(row?.e2ee_required).toBe(0);
    expect(row?.e2ee_version).toBeNull();
    expect(repo.list().find((d) => d.deviceId === deviceId)?.e2ee).toBe(false);
  });

  it("still authenticates on its device token", () => {
    const { deviceToken, deviceId } = repo.register({ publicKey: "pk" });
    expect(repo.authenticate(deviceToken)?.device_id).toBe(deviceId);
  });

  // Two plaintext devices both carry a NULL key, and the unique index is
  // partial precisely so that is not a collision. Without the WHERE clause the
  // second pairing on any server would fail outright.
  it("does not collide with another key-less device", () => {
    const a = repo.register({ publicKey: "pk-a" });
    const b = repo.register({ publicKey: "pk-b" });
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(repo.list()).toHaveLength(2);
  });
});

describe("an encrypted pairing", () => {
  it("records the static key and sets the downgrade lock in the same write", () => {
    const { deviceId } = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A, e2eeVersion: 1 });
    const row = repo.get(deviceId);

    expect(row?.e2ee_static_pub).toBe(KEY_A);
    // Set with the key rather than afterwards: a row that held a key without
    // the pin would be a device that can encrypt and is not required to.
    expect(row?.e2ee_required).toBe(1);
    expect(row?.e2ee_version).toBe(1);
  });

  it("is findable by its static key, which is how a handshake resolves a device", () => {
    const { deviceId } = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A });
    expect(repo.getByE2eeStaticPub(KEY_A)?.device_id).toBe(deviceId);
    expect(repo.getByE2eeStaticPub(KEY_B)).toBeNull();
  });

  /**
   * `GET /api/devices` is where a user who suspects a photographed QR goes to
   * find the extra device. It needs to say which devices are encrypted, and it
   * needs to do that without publishing the value that identifies one.
   */
  it("reports a boolean to the API and never the key itself", () => {
    repo.register({ publicKey: "pk", name: "Phone", e2eeStaticPub: KEY_A });
    const view = repo.list()[0];

    expect(view.e2ee).toBe(true);
    expect(JSON.stringify(view)).not.toContain(KEY_A);
  });
});

describe("re-pairing the same phone", () => {
  /**
   * One static key is one device.
   *
   * Without the unique index and this update path, every re-pair would leave a
   * second row behind — so the paired-devices screen fills with ghosts, and
   * revoking "the" device leaves its twin working. That screen is the recovery
   * path for a photographed QR, so filling it with noise disarms the one
   * mitigation §2.6 offers.
   */
  it("updates the existing row instead of creating a second one", () => {
    const first = repo.register({ publicKey: "pk", name: "Phone", e2eeStaticPub: KEY_A });
    const second = repo.register({ publicKey: "pk2", name: "Phone", e2eeStaticPub: KEY_A });

    expect(second.deviceId).toBe(first.deviceId);
    expect(repo.list()).toHaveLength(1);
  });

  it("issues a fresh credential and retires the old one", () => {
    const first = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A });
    const second = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A });

    expect(second.deviceToken).not.toBe(first.deviceToken);
    expect(repo.authenticate(second.deviceToken)?.device_id).toBe(second.deviceId);
    // The point of re-issuing: the previous token must stop working, or a
    // re-pair would widen access rather than replace it.
    expect(repo.authenticate(first.deviceToken)).toBeNull();
  });

  /**
   * `createdAt` is what a user reads to spot a device they did not pair, so a
   * re-pair must not refresh it — that would erase the evidence the
   * paired-devices screen exists to show.
   */
  it("keeps the original pairing date", () => {
    const first = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A, now: 1000 });
    repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A, now: 9999 });

    expect(repo.get(first.deviceId)?.created_at).toBe(1000);
  });

  it("leaves a different phone alone", () => {
    const a = repo.register({ publicKey: "pk-a", e2eeStaticPub: KEY_A });
    const b = repo.register({ publicKey: "pk-b", e2eeStaticPub: KEY_B });
    repo.register({ publicKey: "pk-a", e2eeStaticPub: KEY_A });

    expect(repo.list()).toHaveLength(2);
    expect(repo.get(b.deviceId)?.e2ee_static_pub).toBe(KEY_B);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  /**
   * The debatable one, asserted so the choice is visible rather than implied.
   *
   * design.md does not cover re-pairing a revoked device. Leaving `revoked_at`
   * set would make the pairing visibly succeed and then 401 every request, with
   * nothing explaining why — a silent failure. Re-pairing requires a live pair
   * token minted on that machine, so it is an authorized act by the same person
   * who revoked it.
   */
  it("un-revokes, because a pairing that succeeds must produce a usable device", () => {
    const first = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A });
    repo.revoke(first.deviceId);
    expect(repo.authenticate(first.deviceToken)).toBeNull();

    const second = repo.register({ publicKey: "pk", e2eeStaticPub: KEY_A });
    expect(repo.get(second.deviceId)?.revoked_at).toBeNull();
    expect(repo.authenticate(second.deviceToken)?.device_id).toBe(first.deviceId);
  });
});

describe("rows that predate the migration", () => {
  /**
   * The migration is additive and backfills nothing, so a device paired before
   * E2EE existed reads as key-less and unpinned and authenticates exactly as it
   * did. This is the same compatibility shape the C5 migration used.
   */
  it("authenticate and revoke behave identically with the new columns present", () => {
    const { deviceId, deviceToken } = repo.register({ publicKey: "pk", name: "Legacy" });

    expect(repo.authenticate(deviceToken)?.device_id).toBe(deviceId);
    expect(repo.revoke(deviceId)).toBe(true);
    expect(repo.authenticate(deviceToken)).toBeNull();

    const view = repo.list()[0];
    expect(view.e2ee).toBe(false);
    expect(view.revokedAt).not.toBeNull();
  });
});
