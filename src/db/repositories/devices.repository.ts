import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import {
  type Capability,
  type CapabilityPreset,
  capabilitiesForPreset,
  isCapability,
} from "../../services/security/capabilities";

/**
 * Paired-device registry (C5).
 * See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
 *
 * Stores identity and authority for each paired device. Never stores a usable
 * credential: only the SHA-256 of a device token, so reading this table cannot
 * impersonate a device.
 */

export interface DeviceRow {
  device_id: string;
  public_key: string;
  token_hash: string;
  name: string | null;
  capabilities: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  /** Noise static public key, base64. Null on every row that predates E2EE. */
  e2ee_static_pub: string | null;
  /** The downgrade lock. 1 once this device has completed a handshake. */
  e2ee_required: number;
  e2ee_version: number | null;
}

/** A device as reported over the API. Deliberately carries no credential. */
export interface DeviceView {
  deviceId: string;
  name: string | null;
  capabilities: Capability[];
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /**
   * Whether this device is pinned to encryption.
   *
   * A boolean, never the key and never a hash of it: `GET /api/devices` exists
   * so a user can spot a device they did not pair, and answering "is this one
   * encrypted" needs no key material to do it. Publishing the static key would
   * hand an attacker who reached this endpoint the value that identifies a
   * device.
   */
  e2ee: boolean;
}

export interface RegisteredDevice {
  deviceId: string;
  /** Returned to the client exactly once, at pairing. Never persisted raw. */
  deviceToken: string;
  capabilities: Capability[];
}

/** Device tokens are opaque high-entropy strings; 32 bytes matches the API key. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of two token hashes, matching `validateApiKey`'s
 * discipline. Both inputs are fixed-length hex digests, so a length mismatch
 * means a malformed value rather than a secret-dependent branch.
 */
export function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Parse the stored capability JSON, dropping anything this build does not
 * recognize. A downgrade must never silently grant a capability it cannot
 * enforce — unknown entries are discarded rather than trusted.
 */
export function parseCapabilities(raw: string): Capability[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCapability);
  } catch {
    return [];
  }
}

export function toDeviceView(row: DeviceRow): DeviceView {
  return {
    deviceId: row.device_id,
    name: row.name,
    capabilities: parseCapabilities(row.capabilities),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    // Reported from `e2ee_required` rather than from the key's presence. The
    // two agree today, but they answer different questions — the key is what a
    // handshake is checked against, `e2ee_required` is whether plaintext is
    // refused — and it is the second one a user is asking about.
    e2ee: row.e2ee_required === 1,
  };
}

export class DevicesRepository {
  private insertStmt: Database.Statement;
  private byTokenHashStmt: Database.Statement;
  private byIdStmt: Database.Statement;
  private listStmt: Database.Statement;
  private revokeStmt: Database.Statement;
  private touchStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private deleteRevokedStmt: Database.Statement;
  private byE2eeStaticPubStmt: Database.Statement;
  private repairStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO devices (
        device_id, public_key, token_hash, name, capabilities, created_at,
        e2ee_static_pub, e2ee_required, e2ee_version
      ) VALUES (
        @device_id, @public_key, @token_hash, @name, @capabilities, @created_at,
        @e2ee_static_pub, @e2ee_required, @e2ee_version
      )
    `);
    this.byE2eeStaticPubStmt = db.prepare("SELECT * FROM devices WHERE e2ee_static_pub = ?");
    // A re-pair of a device we already know by its static key.
    //
    // `created_at` is deliberately NOT touched: it is what a user reads on the
    // paired-devices screen to spot a device they did not pair, and refreshing
    // it would erase the evidence that screen exists for.
    //
    // `revoked_at` IS cleared, which is the one debatable line here. The
    // alternative — leaving it set — makes a pairing that visibly succeeds
    // produce a device whose every request 401s, with nothing explaining why.
    // Re-pairing requires a live pair token minted on that machine, so it is an
    // authorized act by the same person who revoked it. design.md does not
    // cover this case; flagged rather than assumed.
    this.repairStmt = db.prepare(`
      UPDATE devices SET
        public_key = @public_key,
        token_hash = @token_hash,
        name = @name,
        capabilities = @capabilities,
        e2ee_required = 1,
        e2ee_version = @e2ee_version,
        revoked_at = NULL
      WHERE device_id = @device_id
    `);
    this.byTokenHashStmt = db.prepare("SELECT * FROM devices WHERE token_hash = ?");
    this.byIdStmt = db.prepare("SELECT * FROM devices WHERE device_id = ?");
    this.listStmt = db.prepare("SELECT * FROM devices ORDER BY created_at DESC");
    this.revokeStmt = db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?");
    this.touchStmt = db.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?");
    this.deleteStmt = db.prepare("DELETE FROM devices WHERE device_id = ?");
    this.deleteRevokedStmt = db.prepare("DELETE FROM devices WHERE revoked_at IS NOT NULL");
  }

  /**
   * Record a newly paired device and mint its token.
   *
   * The raw token is returned to the caller and never stored — this is the only
   * moment it exists outside the client.
   */
  register(args: {
    publicKey: string;
    name?: string | null;
    preset?: CapabilityPreset;
    now?: number;
    /**
     * The device's Noise static public key, base64, when pairing completed a
     * handshake. Absent on a plaintext pairing, which stays exactly as it is
     * today: no key, no pin, no behaviour change.
     */
    e2eeStaticPub?: string;
    e2eeVersion?: number;
  }): RegisteredDevice {
    const deviceToken = generateDeviceToken();
    const capabilities = capabilitiesForPreset(args.preset ?? "full");
    const now = args.now ?? Date.now();

    // A re-pair from the same phone presents the same static key, and the
    // unique index makes a second row impossible — so this updates rather than
    // inserts. Doing it as look-up-then-write rather than an upsert because the
    // existing device_id has to be returned, and because `ON CONFLICT` against
    // a PARTIAL index needs its WHERE clause repeated, which is a thing to get
    // wrong for no gain. Safe without a transaction: better-sqlite3 is
    // synchronous and nothing yields between the two statements.
    const existing = args.e2eeStaticPub
      ? (this.byE2eeStaticPubStmt.get(args.e2eeStaticPub) as DeviceRow | undefined)
      : undefined;

    if (existing) {
      this.repairStmt.run({
        device_id: existing.device_id,
        public_key: args.publicKey,
        token_hash: hashDeviceToken(deviceToken),
        name: args.name ?? null,
        capabilities: JSON.stringify(capabilities),
        e2ee_version: args.e2eeVersion ?? null,
      });
      return { deviceId: existing.device_id, deviceToken, capabilities };
    }

    const deviceId = randomUUID();
    this.insertStmt.run({
      device_id: deviceId,
      public_key: args.publicKey,
      token_hash: hashDeviceToken(deviceToken),
      name: args.name ?? null,
      capabilities: JSON.stringify(capabilities),
      created_at: now,
      e2ee_static_pub: args.e2eeStaticPub ?? null,
      // The downgrade lock, set in the same write that records the key. Once
      // set, nothing a client can send clears it (design.md §6.3) — which is
      // what makes it a lock rather than a preference.
      e2ee_required: args.e2eeStaticPub ? 1 : 0,
      e2ee_version: args.e2eeVersion ?? null,
    });

    return { deviceId, deviceToken, capabilities };
  }

  /** The device that owns a Noise static key, or null. */
  getByE2eeStaticPub(staticPub: string): DeviceRow | null {
    return (this.byE2eeStaticPubStmt.get(staticPub) as DeviceRow | undefined) ?? null;
  }

  /**
   * Resolve a presented token to a device, or null.
   *
   * Returns null for a revoked device, so revocation takes effect on the very
   * next request with no cache to go stale.
   */
  authenticate(token: string): DeviceRow | null {
    const hash = hashDeviceToken(token);
    const row = this.byTokenHashStmt.get(hash) as DeviceRow | undefined;
    if (!row) return null;
    // The lookup is already an indexed equality match on a hash; the explicit
    // constant-time compare guards the value we actually act on.
    if (!safeHashEquals(row.token_hash, hash)) return null;
    if (row.revoked_at != null) return null;
    return row;
  }

  get(deviceId: string): DeviceRow | null {
    return (this.byIdStmt.get(deviceId) as DeviceRow | undefined) ?? null;
  }

  /** All devices, including revoked ones — an audit surface needs the history. */
  list(): DeviceView[] {
    return (this.listStmt.all() as DeviceRow[]).map(toDeviceView);
  }

  /** Revoke one device. Others are untouched — no key rotation, no collateral. */
  revoke(deviceId: string, now: number = Date.now()): boolean {
    return this.revokeStmt.run(now, deviceId).changes > 0;
  }

  /**
   * Erase one device's record outright.
   *
   * Deliberately separate from `revoke`, which is a soft delete that keeps the
   * row so `list()` can show what happened. That audit trail is the right
   * default — but it meant a `devices` row, including the user-supplied `name`
   * ("Ronen's iPhone"), had no removal path at all once the registry moved to
   * runtime.db, which no command deletes. This is that path.
   *
   * Erasure is NOT revocation: deleting a row frees its `token_hash`, so a
   * device whose token is still on a phone somewhere stops being *known* rather
   * than being *refused*. Revoke first, delete second, is the safe order, and
   * `deleteRevoked()` exists so that is the easy thing to do.
   */
  delete(deviceId: string): boolean {
    return this.deleteStmt.run(deviceId).changes > 0;
  }

  /**
   * Erase every already-revoked device. The bulk companion to `delete`, and the
   * one that is safe by construction: a revoked device is already refused, so
   * removing its row cannot restore access to anything.
   *
   * Returns the number of rows removed.
   */
  deleteRevoked(): number {
    return this.deleteRevokedStmt.run().changes;
  }

  touch(deviceId: string, now: number = Date.now()): void {
    this.touchStmt.run(now, deviceId);
  }
}
