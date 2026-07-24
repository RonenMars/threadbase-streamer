-- Paired-device registry (C5 scoped device capabilities).
-- See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
--
-- Pairing exchanged a short-lived token for the streamer's API key — the SAME
-- string for every device that ever paired. Nothing recorded that a device
-- existed, so there was no attribution, no per-device revocation (rotating the
-- key de-authenticated everyone at once), and no way to scope authority.
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
