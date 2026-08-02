-- Push token kinds, for iOS Live Activities (Feature 12 phase 1b).
--
-- push_tokens (012) modelled exactly one token per device: the Expo relay token
-- used for ordinary notifications. A device now supplies three distinct token
-- types, and they are NOT interchangeable:
--
--   expo             — Expo relay token. Ordinary push notifications.
--   liveactivity_start — ActivityKit push-to-start token. App-wide, one per
--                      device, long-lived. Starts an activity when none exists.
--   liveactivity_update — ActivityKit per-activity update token. Issued by iOS
--                      AFTER an activity starts, scoped to that one activity,
--                      and short-lived.
--
-- Conflating them silently breaks delivery: an ActivityKit token posted to
-- Expo's relay is rejected, and an Expo token used to sign a
-- `.push-type.liveactivity` topic is rejected by APNs. Neither failure is
-- visible at registration time, which is exactly why kind is stored explicitly
-- rather than inferred from token shape.
ALTER TABLE push_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'expo';

-- The ActivityKit activity this token updates, for kind =
-- 'liveactivity_update' only. A device runs several activities at once (one per
-- live session), so device_id alone cannot identify which row to update or end
-- — the reason 012's one-row-per-device shape does not stretch to cover this.
ALTER TABLE push_tokens ADD COLUMN activity_id TEXT;

-- The session this activity is rendering. Sending is driven by session
-- lifecycle transitions, so the send path looks tokens up by session, not by
-- device.
ALTER TABLE push_tokens ADD COLUMN session_id TEXT;

-- Per-activity tokens expire. Retained rather than deleted (matching
-- revoked_at's reasoning in 012) so the health report can say "expired"
-- instead of the row simply vanishing.
ALTER TABLE push_tokens ADD COLUMN expires_at INTEGER;

-- iOS ends a Live Activity ~8h after it starts, so a long session must be
-- renewed before the cap. Stored per activity rather than derived at read time:
-- a renewal must survive a restart, and re-arming timers on boot needs a
-- persisted deadline to read (an in-process timer does not survive).
ALTER TABLE push_tokens ADD COLUMN stale_date INTEGER;

-- The activity's ORIGINAL start, carried unchanged across every renewal.
-- iOS renders its own ticking elapsed timer from this value, so a renewal that
-- stamps a fresh start visibly resets the user's timer to zero. Persisting the
-- original is what makes elapsed time continuous across a renewal.
ALTER TABLE push_tokens ADD COLUMN started_at INTEGER;

-- Set once a renewal has been performed for this row, making renewal
-- idempotent: a restart mid-window re-arms the timer, and this column is what
-- stops the re-armed timer from sending a second time.
ALTER TABLE push_tokens ADD COLUMN renewed_at INTEGER;

-- The send path selects by (kind, session) — driven by a session status change,
-- never by scanning every token.
CREATE INDEX IF NOT EXISTS idx_push_tokens_kind_session ON push_tokens (kind, session_id);

-- The renewal scheduler scans for activities approaching their cap. Partial
-- index: only unrenewed rows with a deadline are ever candidates, which keeps
-- the boot-time re-arm scan proportional to pending renewals rather than to
-- every token ever registered.
CREATE INDEX IF NOT EXISTS idx_push_tokens_stale_date ON push_tokens (stale_date)
  WHERE stale_date IS NOT NULL AND renewed_at IS NULL;
