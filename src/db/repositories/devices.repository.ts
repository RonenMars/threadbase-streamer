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
}

/** A device as reported over the API. Deliberately carries no credential. */
export interface DeviceView {
  deviceId: string;
  name: string | null;
  capabilities: Capability[];
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
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
  };
}

export class DevicesRepository {
  private insertStmt: Database.Statement;
  private byTokenHashStmt: Database.Statement;
  private byIdStmt: Database.Statement;
  private listStmt: Database.Statement;
  private revokeStmt: Database.Statement;
  private touchStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO devices (
        device_id, public_key, token_hash, name, capabilities, created_at
      ) VALUES (
        @device_id, @public_key, @token_hash, @name, @capabilities, @created_at
      )
    `);
    this.byTokenHashStmt = db.prepare("SELECT * FROM devices WHERE token_hash = ?");
    this.byIdStmt = db.prepare("SELECT * FROM devices WHERE device_id = ?");
    this.listStmt = db.prepare("SELECT * FROM devices ORDER BY created_at DESC");
    this.revokeStmt = db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?");
    this.touchStmt = db.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ?");
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
  }): RegisteredDevice {
    const deviceId = randomUUID();
    const deviceToken = generateDeviceToken();
    const capabilities = capabilitiesForPreset(args.preset ?? "full");

    this.insertStmt.run({
      device_id: deviceId,
      public_key: args.publicKey,
      token_hash: hashDeviceToken(deviceToken),
      name: args.name ?? null,
      capabilities: JSON.stringify(capabilities),
      created_at: args.now ?? Date.now(),
    });

    return { deviceId, deviceToken, capabilities };
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

  touch(deviceId: string, now: number = Date.now()): void {
    this.touchStmt.run(now, deviceId);
  }
}
