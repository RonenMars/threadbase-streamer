# Postmortem: Windows auto-update reports success while live streamer stays stale

**Date:** 2026-07-18  
**Investigation time:** 2026-07-18 13:45 +03:00  
**Window reviewed:** last 72 hours of local updater/deploy state  
**Severity:** High  
**Status:** Active incident. Disk has `1.31.1+update`, but the process serving port 8766 still reports `1.31.0+6b5d30f`.

## Summary

The auto-updater did install new release files, but it did not reliably activate the running Windows service. The clearest current evidence is:

- `C:\Users\PC\.threadbase\version.txt` reports `1.31.1+update`.
- `C:\Users\PC\.threadbase\current\dist\version.txt` reports `1.31.1+update`.
- `GET http://127.0.0.1:8766/healthz` reports `{"ok":true,"version":"1.31.0+6b5d30f"}`.

That means the latest update is on disk but the active server process is still the older deploy-script build.

The timestamped updater log has no real `[error]` or `[failed]` entries in the reviewed window, but that is part of the problem: older updater bundles report success after `schtasks` returns, without verifying that `/healthz` moved to the target version.

## Timeline

All UTC timestamps are from `C:\Users\PC\.threadbase\update.log`; local time is UTC+03:00.

| Time | Event | Assessment |
|---|---|---|
| 2026-07-16 10:45:41Z / 13:45:41 +03:00 | `[check] current=1.24.6 latest=1.30.0` | Update available. |
| 2026-07-16 10:46:06Z / 13:46:06 +03:00 | `[installed] 1.24.6 -> 1.30.0 restart=schtasks pruned=1` | Logged as success. |
| 2026-07-16 11:45:15Z through 19:45:16Z | Repeated checks still show `current=1.24.6 latest=1.30.0` | The `1.30.0` install did not become the effective update path for later scheduled runs. |
| 2026-07-16 19:59:34Z / 22:59:34 +03:00 | `releases/.history` records `releases\cli.6b5d30f.cjs` | Separate deploy-script activation to `1.31.0+6b5d30f`. |
| 2026-07-16 20:09:49Z / 23:09:49 +03:00 | `[check] current=1.31.0 latest=1.31.0 status=Already up to date` | Manual/deploy activation had taken over. |
| 2026-07-18 00:45:16Z / 03:45:16 +03:00 | `[check] current=1.31.0 latest=1.31.1` | Patch update available. |
| 2026-07-18 00:45:25Z / 03:45:25 +03:00 | `[installed] 1.31.0 -> 1.31.1 restart=schtasks pruned=1` | Logged as success. |
| 2026-07-18 01:45Z onward | Checks report `current=1.31.1 latest=1.31.1` | The scheduled updater sees disk state as current. |
| 2026-07-18 13:45 +03:00 | `/healthz` still reports `1.31.0+6b5d30f` | The live service did not restart onto `1.31.1`. |

## Findings

### 1. Auto-update can report success without activating the live server

**Severity:** High

The updater's success condition in the installed bundles is too weak. The `1.31.0+6b5d30f` and `1.31.1+update` bundles contain logic that:

1. Stops the Windows task with `schtasks /End`.
2. Swaps files under `C:\Users\PC\.threadbase`.
3. Starts the task with `schtasks /Run`.
4. Logs `[installed] ... restart=schtasks`.

Those bundles do not verify that the process currently serving `/healthz` reports the newly installed version. They also do not kill a stale process still bound to port 8766 before restarting the task.

On Windows this matters because the task launches through `wscript.exe` and `launch.cmd`; ending the scheduled task can leave the child `node.exe` process alive. If that stale process keeps port 8766, the restarted task either fails to bind or exits, while the old server continues serving traffic.

**Impact:** Users and mobile clients keep talking to the old server even though update logs and `version.txt` imply the system is up to date. Security fixes or compatibility fixes may not actually be active.

**Evidence:**

- `version.txt=1.31.1+update`
- `current\dist\version.txt=1.31.1+update`
- `/healthz` returns `1.31.0+6b5d30f`
- Listening PID on port 8766 started on 2026-07-16 at the deploy time, not on 2026-07-18 at the patch update time.

### 2. The July 16 `1.24.6 -> 1.30.0` install was logged as success but was not durable

**Severity:** Medium-High

After the updater logged `1.24.6 -> 1.30.0`, subsequent scheduled checks still reported `current=1.24.6` for hours. That means the update did not become the version used by the scheduled updater path. A later deploy-script activation to `1.31.0+6b5d30f` is what changed the effective version.

This matches the known class of updater layout bugs: older updater versions could swap `current/` without keeping `cli.js` and root `version.txt` in sync. The current source has changes in `src/updater/swap.ts` to copy `current\dist\cli.cjs` to `~\.threadbase\cli.js` and publish root `version.txt`, but those fixes only help after they are actually deployed.

**Impact:** Repeated hourly downloads/install attempts, misleading audit records, and delayed activation until a manual deploy or newer updater takes over.

### 3. `EPERM` failures against `better_sqlite3.node` indicate the old process held native-module handles

**Severity:** Medium

`C:\Users\PC\.threadbase\logs\updater.err` contains repeated lines:

```text
Update failed: EPERM: operation not permitted, unlink 'C:\Users\PC\.threadbase\current\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
```

The file has no per-line timestamps, so these specific EPERM failures cannot be placed precisely in the 72-hour window. The same file also contains later deferred-run messages, so its file modification time is not enough to timestamp the EPERM lines.

The failure mode is still relevant: on Windows, `better_sqlite3.node` remains locked while the running server has loaded it. Removing or replacing `current/` fails unless the service process is actually stopped first.

**Impact:** Update attempts can abort before activation. No data loss was observed from this log alone, but the updater can remain stuck until the stale process is killed or the task is restarted through a path that clears the listener.

### 4. Active-session deferrals were expected safety behavior

**Severity:** Low

The updater repeatedly deferred while active sessions existed:

```text
[deferred] ... 1 active session(s); use --force to interrupt
```

These are not errors. They delayed updates until a safe window, which is the intended behavior for `defer_if_active_sessions: true`.

### 5. Menubar deploy had a non-fatal release-asset mismatch

**Severity:** Low

`C:\Users\PC\.threadbase\logs\menubar-fetch.log` contains:

```text
[fetch-menubar] release v0.2.2 matched SHA but no asset matches *-x64.exe
```

`C:\Users\PC\.threadbase\menubar-track.log` then reports:

```text
2026-07-16T19:59:53.787Z [app] menubar ready
```

So the deploy recovered or used the fallback path. This is not blocking, but it means the expected prebuilt Windows x64 asset was missing or named differently.

### 6. Unit tests polluted the production updater audit log

**Severity:** Medium for audit quality, Low for runtime impact

`update.log` contains clusters such as:

```text
2026-07-16T15:29:25Z [installed] 1.0.0 -> 1.0.1 restart=launchctl pruned=1
2026-07-16T15:29:25Z [installed] 1.0.0 -> 1.0.1 restart=failed: launchctl not found pruned=1
```

These are not real Windows updates. They match `__tests__/install.test.ts`, which mocks `restartService` as `launchctl` and uses fixture versions `1.0.0` and `1.0.1`.

Root cause: `src/updater/update-log.ts` writes to `join(homedir(), ".threadbase", "update.log")`, and the install tests do not mock `appendUpdateLog` or redirect `THREADBASE_ROOT` to a temp directory.

**Impact:** Production update history is no longer clean audit evidence. Manual filtering is required to separate real update runs from test artifacts.

## Current State

| Check | Result |
|---|---|
| Root version file | `1.31.1+update` |
| Current release version file | `1.31.1+update` |
| Live `/healthz` version | `1.31.0+6b5d30f` |
| `launch.cmd` entry point | `C:\Users\PC\.threadbase\cli.js serve --port 8766 --verbose --prod` |
| Real successful installs in the reviewed window | `1.24.6 -> 1.30.0`, `1.31.0 -> 1.31.1` |
| Real timestamped updater failures in `update.log` | None |
| Effective activation of latest patch | Not active |

## Recommended Actions

1. **Immediate operational fix:** restart the Windows streamer using a path that kills the process bound to port 8766 before starting the task. A plain `schtasks /End` is not enough if the child `node.exe` is orphaned.

2. **Ship the local updater hardening before relying on auto-update again:** the worktree already contains uncommitted changes that add `src/updater/restart-health.ts`, call `waitForRestartHealth()` from `src/updater/install.ts`, and extend `src/updater/restart.ts` to kill the Windows port listener. These are the right fixes for the stale-process class of bug, but they are not active in the installed `1.31.1` bundle.

3. **Make restart verification mandatory:** an update should log `[failed]` and exit non-zero if `/healthz` does not report the target version after restart. `version.txt` alone is not sufficient because it only proves disk state.

4. **Keep `cli.js`, `current/`, and root `version.txt` synchronized:** this prevents the old "installed but current still old" loop seen after `1.24.6 -> 1.30.0`.

5. **Fix updater test isolation:** mock `appendUpdateLog` in install tests, or make `THREADBASE_ROOT` configurable in tests so fixtures never write to `C:\Users\PC\.threadbase\update.log`.

6. **Fix or document menubar asset fallback:** either publish a matching Windows x64 menubar asset for the submodule SHA or make the fallback message clearly non-fatal.

## Open Questions

- The exact Task Scheduler registration could not be inspected from this shell: `Get-ScheduledTask` returned access denied and direct `schtasks /Query /TN Threadbase` did not resolve the task path. The current `launch.cmd` was inspected and points to `cli.js`, but the registered task action should be confirmed from an elevated shell if deeper validation is needed.
- The exact timestamps of the `EPERM` lines in `updater.err` are unavailable because that file has no per-line timestamps.

