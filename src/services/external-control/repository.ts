import type Database from "better-sqlite3";
import { randomBytes } from "crypto";

/** Phase 1 grants observation only; input scopes arrive with leases and receipts. */
export const EXTERNAL_CONTROL_SCOPES = ["screen"] as const;
export type ExternalControlScope = (typeof EXTERNAL_CONTROL_SCOPES)[number];

export const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExternalControlGrant {
  grantId: string;
  deviceId: string;
  sessionId: string;
  bindingFingerprint: string;
  scopes: ExternalControlScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

interface GrantRow {
  grant_id: string;
  device_id: string;
  session_id: string;
  binding_fingerprint: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function parseScopes(raw: string): ExternalControlScope[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((s): s is ExternalControlScope =>
          (EXTERNAL_CONTROL_SCOPES as readonly unknown[]).includes(s),
        )
      : [];
  } catch {
    return [];
  }
}

function toGrant(r: GrantRow): ExternalControlGrant {
  return {
    grantId: r.grant_id,
    deviceId: r.device_id,
    sessionId: r.session_id,
    bindingFingerprint: r.binding_fingerprint,
    scopes: parseScopes(r.scopes),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

export class ExternalControlGrantsRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO external_control_grants
           (grant_id, device_id, session_id, binding_fingerprint, scopes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      active: db.prepare(
        `SELECT * FROM external_control_grants
          WHERE device_id = ? AND binding_fingerprint = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC`,
      ),
      list: db.prepare(
        `SELECT * FROM external_control_grants
          WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at`,
      ),
      revoke: db.prepare(
        "UPDATE external_control_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
      ),
      revokeDevice: db.prepare(
        "UPDATE external_control_grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
      ),
    };
  }

  create(
    input: {
      deviceId: string;
      sessionId: string;
      bindingFingerprint: string;
      scopes: ExternalControlScope[];
      ttlMs: number;
    },
    now: number = Date.now(),
  ): ExternalControlGrant {
    if (!(input.ttlMs > 0 && input.ttlMs <= MAX_GRANT_TTL_MS)) throw new Error("invalid ttl");
    const grantId = `gr_${randomBytes(9).toString("base64url")}`;
    this.stmts.insert.run(
      grantId,
      input.deviceId,
      input.sessionId,
      input.bindingFingerprint,
      JSON.stringify(input.scopes),
      now,
      now + input.ttlMs,
    );
    return {
      grantId,
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      bindingFingerprint: input.bindingFingerprint,
      scopes: [...input.scopes],
      createdAt: now,
      expiresAt: now + input.ttlMs,
      revokedAt: null,
    };
  }

  findActive(
    deviceId: string,
    bindingFingerprint: string,
    scope: ExternalControlScope,
    now: number = Date.now(),
  ): ExternalControlGrant | null {
    const rows = this.stmts.active.all(deviceId, bindingFingerprint, now) as GrantRow[];
    return rows.map(toGrant).find((g) => g.scopes.includes(scope)) ?? null;
  }

  listActive(now: number = Date.now()): ExternalControlGrant[] {
    return (this.stmts.list.all(now) as GrantRow[]).map(toGrant);
  }

  revoke(grantId: string, now: number = Date.now()): boolean {
    return this.stmts.revoke.run(now, grantId).changes > 0;
  }

  revokeForDevice(deviceId: string, now: number = Date.now()): number {
    return this.stmts.revokeDevice.run(now, deviceId).changes;
  }
}
