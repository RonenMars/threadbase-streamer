# Device Identity and Scoped Capabilities

**Date:** 2026-07-24
**Status:** Proposed
**Scope:** tb-streamer (auth, pairing, authorization) — capability contract consumed by tb-mobile

---

## Problem

Authorization is a single shared secret with no notion of *who* is asking.

### 1. Every paired device holds the same credential

Pairing exchanges a short-lived token for the streamer's API key, sealed to the client's public key (`src/server.ts:1524-1559`). The `clientPublicKey` is used once as a sealing target and then discarded — nothing records that a device exists.

The value delivered is `this.apiKey`: the *same* string for every device that has ever paired. `authMiddleware` (`src/api/middleware/auth.middleware.ts:47-60`) accepts it via `Authorization: Bearer` or a `?key=` query parameter, and on success calls `next()` with no identity attached to the request.

Consequences, all currently unavoidable:

- **No revocation.** Removing one device's access means rotating the key (`rotateApiKey`, `src/server.ts:1561`), which silently de-authenticates every other device at the same time.
- **No attribution.** Audit logs record `ip` and a timestamp (`src/server.ts:1547`), never *which* device acted. Two phones on the same NAT are indistinguishable.
- **No scoping.** Any holder of the key can start sessions, send input, browse the filesystem, upload files, and read every conversation. A device paired to glance at status has exactly the authority of the one driving the agent.

### 2. Capability is all-or-nothing

`authMiddleware` answers one question — is this token the API key — and returns 401 or full access. There is no read-only mode, no per-project boundary, and no separation between reading history and controlling a process.

The task's requirement for "separate history/prompt/process/browse/upload/notification permissions" has nothing to attach to today, because there is no principal to attach it *to*.

### 3. The credential travels in query strings

`?key=<apiKey>` (`auth.middleware.ts:56-57`) is accepted because the WebSocket client cannot set headers. Query strings land in server logs, proxy logs, and browser history far more readily than headers do. It cannot simply be removed — the WS upgrade depends on it — so it needs a narrower credential rather than the master key.

### 4. What is already sound

Stated explicitly so the fix does not regress it: pair tokens are single-use with a 180-second TTL (`src/pair-store.ts:25`), exchange is rate-limited per IP (`src/server.ts:1510`), the key is sealed to the client's public key in transit rather than sent in the clear, and `validateApiKey` is a constant-time comparison (`src/auth.ts:28`).

The pairing cryptography is not the weakness and must not be weakened. The weakness is that everything it protects is one undifferentiated credential.

---

## Goals

- Each paired device has a distinct, recorded identity and its own credential.
- Revoking one device does not disturb any other.
- Requests carry a principal, so actions can be attributed and authorized.
- Capabilities are scoped per device, with read-only as a first-class mode.
- The existing shared API key keeps working, so no paired device breaks.

### Non-goals

- Changing the pairing handshake cryptography. It is sound; this builds on it.
- Per-project filesystem scoping, upload validation, and path-traversal hardening — real C5 requirements, but each is a separate change against this foundation, and none of them can be expressed until a principal exists.
- Rate limiting beyond what exists (pair exchange and session input are already limited).
- Multi-user accounts. Devices belong to one operator; this is about which device, not which person.

---

## Design

### Device identity at pairing

Pairing already receives a `clientPublicKey`. Instead of discarding it, record a device:

```
devices(
  device_id      TEXT PRIMARY KEY,   -- server-minted, not client-supplied
  public_key     TEXT NOT NULL,      -- from the pairing exchange
  token_hash     TEXT NOT NULL,      -- sha256 of the device token; never the token
  name           TEXT,               -- client-supplied label, e.g. "Ronen's iPhone"
  capabilities   TEXT NOT NULL,      -- JSON array
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER,
  revoked_at     INTEGER
)
```

The exchange returns a **device token** instead of the shared API key. Only its SHA-256 is stored, so a database read cannot impersonate a device — the same reason password hashes exist.

`device_id` is minted server-side. A client-supplied id would let a device claim another's identity.

### Capabilities

```ts
type Capability =
  | "history:read"      // read conversations and search
  | "session:control"   // start, resume, send input, interrupt
  | "fs:browse"         // browse the project tree
  | "fs:upload"         // upload files
  | "notifications"     // register for push
  | "admin"             // rotate keys, manage devices
```

Two presets: **full** (everything except `admin`) and **read-only** (`history:read` alone). Read-only is the mode that makes a "glance at status" device safe, and it is the one C5 explicitly calls for.

Authorization is a single check at the middleware: does this principal hold the capability this route requires. Route → capability mapping is a static table, so an unmapped route fails closed rather than defaulting to permitted.

### Backwards compatibility

`authMiddleware` accepts either credential:

1. **Device token** → resolve the device, reject if revoked, attach the principal, check the capability, update `last_seen_at`.
2. **Shared API key** → attach a synthetic `legacy` principal holding the full preset.

Every already-paired device keeps working with no client change. The legacy path is what makes this shippable without a coordinated mobile release; removing it is a later decision, not this PR's.

`?key=` keeps working for the WS upgrade, but a device token in that position is a narrower credential than the master key — that is the improvement available without breaking the upgrade path.

### Revocation

Setting `revoked_at` invalidates one device on its next request. No key rotation, no collateral. Revocation is checked per request rather than cached, because a stale cache is exactly the window an attacker wants.

### Audit attribution

Existing security-relevant log events gain `deviceId`. Never the token, never its hash — an identifier only. This turns "someone at 192.168.1.4 started a session" into "device abc123 (Ronen's iPhone) started a session", which is the difference between a log and an audit trail.

---

## Contract additions

```
POST /api/pair/exchange   → additionally returns { deviceId, deviceToken, capabilities }
GET  /api/devices         → [{ deviceId, name, capabilities, createdAt, lastSeenAt, revokedAt }]
POST /api/devices/:id/revoke
```

The exchange response keeps its existing fields, so an old client ignores the additions and continues using the sealed API key.

No device listing ever includes a token or hash. Requires the API-contract lock before `contracts/*.schema.json`.

---

## Migration and rollback

Additive migration `011_create_devices.sql` — a new table, nothing altered, nothing backfilled. Devices paired before this simply have no row and authenticate via the legacy path.

Rollback: revert the middleware change and the table becomes inert. Because the shared key never stops working, a rollback cannot lock anyone out — which is the property that makes this safe to ship first.

---

## Known limits

- **The shared key remains a full-authority credential** until it is retired. This PR adds a better path without closing the old one; a device holding the API key still has full access. Closing it requires every client to have migrated, and doing both at once would lock out any device that hasn't updated.
- **Capabilities are coarse.** Six buckets, not per-endpoint ACLs. Finer granularity without a real threat-driven need is complexity that obscures rather than protects.
- **Per-project filesystem scoping is not here.** `fs:browse` is all-or-nothing for now; scoping it to specific projects is a follow-up that this foundation makes expressible.
- **Device tokens do not expire.** Revocation is explicit. A TTL would force periodic re-pairing, which pushes users toward keeping a device paired that they would otherwise revoke.
- **A compromised streamer host defeats all of this.** Local disk access yields the token hashes and the API key. This raises the cost of a stolen *device* credential, not of a compromised host.

---

## Test plan

| Requirement | Test |
|---|---|
| Identity | Pairing records a device and returns a distinct token per device |
| Token storage | Only the hash is persisted; the raw token appears nowhere in the DB |
| Revocation isolation | Revoking device A rejects A and leaves B working |
| Capability enforcement | A read-only device is refused `session:control` routes and allowed history |
| Fail closed | An unmapped route denies rather than defaults to permitted |
| Legacy compatibility | The shared API key still authenticates with the full preset |
| Attribution | Security log events carry `deviceId`, never a token |
| No leakage | `GET /api/devices` never returns a token or hash |
| Constant-time | Device-token comparison is constant-time, matching `validateApiKey` |
