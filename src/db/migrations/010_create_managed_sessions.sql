-- Managed-session registry (durable session runtime, C1 Phase 2).
-- See docs/architecture/2026-07-24-durable-session-runtime.md.
--
-- Until now managed session state lived only in SessionStore's in-memory Maps,
-- so a streamer restart lost startedAt, promptCount, sessionName, projectId,
-- the Codex placeholder→rollout binding, and failureReason outright. Sessions
-- did not come back as "recoverable" — they ceased to exist, reappearing at
-- best as external discovered processes with no managed metadata.
--
-- This table stores identity and provenance so the boot reconciler can say what
-- happened to each session. It deliberately does NOT store the byte stream:
-- outputBuffer is 64KiB of raw ANSI rewritten on every PTY chunk, and its
-- authoritative copy is already the provider's JSONL. Persisting it would turn
-- every chunk into a DB write to duplicate data we can re-read. Post-restart
-- replay is therefore conversation-accurate, not byte-accurate.
CREATE TABLE IF NOT EXISTS managed_sessions (
  -- Provider-native resume identifier: the JSONL UUID for Claude Code, the
  -- rollout id for Codex. This is what --resume / `codex resume` consumes, so
  -- the registry never invents an identifier of its own.
  session_id            TEXT PRIMARY KEY,
  provider              TEXT    NOT NULL,

  -- Liveness probing. pid alone is never treated as identity: PIDs get reused,
  -- so the reconciler matches the recorded cmdline before claiming a live
  -- process is ours, and reports `orphaned` on a mismatch rather than guessing.
  pid                   INTEGER,
  cmdline               TEXT,

  project_path          TEXT    NOT NULL,
  project_name          TEXT    NOT NULL,
  branch                TEXT    NOT NULL DEFAULT '',

  -- Semantic status (running/waiting_input/idle) as last observed. The
  -- reconciler never trusts this over a live PID probe — a SIGKILLed streamer
  -- never ran its exit writes, so a stored 'running' can be arbitrarily stale.
  -- status_source records how the value was obtained so that staleness is
  -- visible instead of implied.
  status                TEXT    NOT NULL,
  status_source         TEXT    NOT NULL,
  status_updated_at     INTEGER NOT NULL,

  started_at            INTEGER NOT NULL,
  completed_at          INTEGER,
  last_activity_at      INTEGER,
  prompt_count          INTEGER NOT NULL DEFAULT 0,

  -- User-visible identity that today vanishes silently on restart.
  session_name          TEXT,
  project_id            TEXT,
  -- Codex two-id model: the placeholder id the session was created under vs the
  -- rollout id its history is indexed by. Losing this on restart orphans the
  -- conversation from the session (types.ts:36-44).
  bound_conversation_id TEXT,
  resumed_from_conversation_id TEXT,
  failure_reason        TEXT,

  -- Which streamer run started this session. A row whose instance differs from
  -- the current run is the orphan test: the process outlived its streamer.
  streamer_instance_id  TEXT    NOT NULL
);

-- The reconciler's only read path on boot: every row not already in a terminal
-- state. Terminal rows are retained for history but never re-probed.
CREATE INDEX IF NOT EXISTS idx_managed_sessions_status
  ON managed_sessions (status);
