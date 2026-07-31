-- Which machine boot the pid in this row was recorded during.
--
-- managed_sessions.pid is only meaningful within one boot: pid assignment
-- restarts at boot, so a stored pid recorded under a previous boot no longer
-- identifies anything and probing it can hit an unrelated process that merely
-- inherited that number. When that process's argv happens to contain the
-- recorded cmdline token -- which for a FRESH Codex session is only the
-- project path -- the reconciler wrongly reports `detached` and claims a live
-- process that is not ours. A mismatch here skips the probe entirely.
ALTER TABLE managed_sessions ADD COLUMN boot_token TEXT;
