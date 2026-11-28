-- Local, short-lived grants that let one paired device observe one externally
-- launched agent's tmux pane ("Connect live"). Created only on the machine
-- (`tb-streamer external-control grant`), never over the API.
--
-- runtime.db rather than cache.db: a cache reset must not erase a grant, and a
-- grant must not outlive a revoke because the file it lived in was rebuilt.
--
-- binding_fingerprint pins the exact provider conversation, agent pid and OS
-- start identity, tmux server generation and pane. Any change to those reads as
-- a different binding, so a grant never carries over to a new process, pane or
-- conversation.
CREATE TABLE IF NOT EXISTS external_control_grants (
  grant_id            TEXT PRIMARY KEY,
  device_id           TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  binding_fingerprint TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_external_control_grants_lookup
  ON external_control_grants (device_id, binding_fingerprint);
