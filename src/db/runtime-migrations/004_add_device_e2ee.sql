-- Bind a paired device's identity to a key instead of a string (E2EE Phase 2).
-- See specs/end-to-end-encryption/design.md §2.5.
--
-- WHY THIS IS A RUNTIME MIGRATION, since design.md originally said otherwise.
-- The design proposed `016_add_device_e2ee.sql` beside `migrations/011_create_devices.sql`,
-- which was where `devices` lived when it was written. The table has since moved
-- to runtime.db, and the distinction is load-bearing rather than cosmetic:
-- cache.db is the file `tb-streamer cache clear` deletes and the integrity
-- monitor rebuilds, because everything in it is regenerable from ~/.claude and
-- ~/.codex. A pinned static key is not. Putting these columns on the cache side
-- would mean a routine cache clear silently dropped every device's pinned key
-- while leaving that device's *authentication* intact here -- so the devices
-- keep working, unencrypted, with nothing anywhere reporting an error. That is
-- the worst available failure shape for this feature: it degrades security
-- silently and looks healthy.
--
-- Additive by construction. Nothing is altered and nothing is backfilled, so
-- every row that predates this reads as e2ee_static_pub IS NULL and
-- e2ee_required = 0, and authenticates exactly as it does today.

-- The device's Noise static public key, raw 32 bytes as base64. This becomes
-- the authoritative device identity: a device proves who it is by completing a
-- handshake against this key, rather than by presenting a token anyone holding
-- the string could present. The device token remains as the credential an older
-- client presents and as the fallback path.
ALTER TABLE devices ADD COLUMN e2ee_static_pub TEXT;

-- The downgrade lock (design.md §6.3). Set inside the pairing transaction when
-- both sides completed a handshake, and never cleared by anything a client can
-- send -- clearing it requires re-pairing, which creates a new row, or an
-- explicit admin action. Without this, "we speak encryption" would be a claim
-- an intermediary could strip, and stripping it is the cheapest possible attack.
ALTER TABLE devices ADD COLUMN e2ee_required INTEGER NOT NULL DEFAULT 0;

-- Envelope version this device negotiated. Recorded rather than assumed so a
-- future version can be rolled out per device instead of per server.
ALTER TABLE devices ADD COLUMN e2ee_version INTEGER;

-- One static key is one device.
--
-- A re-pair from the same phone presents the same static key, and without this
-- it would create a second row -- so `GET /api/devices` would fill with ghosts
-- and revoking "the" device would leave its twin working. Partial, because
-- every pre-E2EE row has a NULL here and SQLite treats NULLs as distinct only
-- inside a partial index that excludes them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_e2ee_static_pub
  ON devices (e2ee_static_pub) WHERE e2ee_static_pub IS NOT NULL;
