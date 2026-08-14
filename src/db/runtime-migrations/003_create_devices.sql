-- Paired-device registry (C5 scoped device capabilities).
-- See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
--
-- MOVED HERE from cache.db (migration 011_create_devices.sql), which was the
-- wrong file for it. Everything in cache.db is rebuildable from ~/.claude and
-- ~/.codex, which is why "delete the cache and restart" is reasonable support
-- advice, why `tb-streamer cache clear` deletes it outright, and why the
-- integrity monitor offers a reset-and-rescan action. A device registry is
-- rebuildable from nothing: losing it invalidates every device token issued so
-- far. Leaving it there made every paired device one documented troubleshooting
-- step away from having to re-pair — which is why the narrower device
-- credential could not safely be adopted by the client while it lived in the
-- cache.
--
-- The pre-split table in cache.db is MOVED here once by
-- RuntimeStore.importLegacyDevices(): copied, verified by row count, then
-- deleted from the cache. Unlike managed_sessions, no second copy is left
-- behind — a device row carries a user-supplied label, and duplicating that on
-- disk indefinitely retains more personal data than a rollback path whose
-- recovery is re-scanning a pairing QR.
CREATE TABLE IF NOT EXISTS devices (
  -- Minted server-side. A client-supplied id would let one device claim
  -- another's identity.
  device_id     TEXT PRIMARY KEY,

  -- The client public key already supplied at pairing, previously used once as
  -- a sealing target and then discarded.
  public_key    TEXT NOT NULL,

  -- SHA-256 of the device token, never the token itself: a read of this table
  -- must not let anyone impersonate a device. Same reasoning as password hashes.
  token_hash    TEXT NOT NULL UNIQUE,

  -- Client-supplied label ("Ronen's iPhone"). Display only, never trusted for
  -- authorization.
  name          TEXT,

  -- JSON array of capability strings. Unknown entries are dropped on read, so a
  -- downgrade cannot silently grant a capability this build does not understand.
  capabilities  TEXT NOT NULL,

  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,

  -- Set to revoke. Checked per request rather than cached — a stale cache is
  -- exactly the window that makes revocation useless.
  revoked_at    INTEGER
);

-- Authentication looks a device up by token hash on every request, so this is
-- the hot path.
CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices (token_hash);
