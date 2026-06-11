# Prod/dev coordination (lifecycle module)

Only one streamer can bind port 8766 at a time. The platform-supervised "prod" instance and an ad-hoc "dev" instance (`tb-streamer serve` from a shell) coordinate via a JSON marker file rather than racing. The high-level summary lives in `CLAUDE.md`; this is the full reference.

## macOS (launchd)

**Components:**

- **Shim** at `~/.threadbase/launchd-entry.cjs` (built from `cli/launchd-entry.ts`). The plist points launchd at the shim, not `cli.js` directly. On every start attempt the shim consults the marker and either `exec`s `cli.js` or exits 0.
- **Marker** at `~/.threadbase/prod-suspended.json`. Written by dev when it takes over the prod port. Shape: `{ devPid, port, repoToplevel, suspendedAt, userHeld, shimVersion }`.
- **Prefs** at `~/.threadbase/dev-prefs.json`. Per-repo remembered choice (`replace-prod` or `use-port`), keyed by git toplevel path.
- **Plist** `KeepAlive` is a dict with `SuccessfulExit: false` + `ThrottleInterval: 10`. A clean shim exit (exit 0) does NOT trigger respawn; only crashes do.

**Marker decision table (shim):**

| Marker state | Shim action |
|---|---|
| absent / malformed | `exec` real `cli.js` |
| `userHeld: true` | exit 0 (intentional stop) |
| `userHeld: false`, devPid alive | exit 0 (dev is using the port) |
| `userHeld: false`, devPid dead | clear marker, `exec` cli.js (crash recovery) |

**Dev-side flags on `serve`:**

- `--replace-prod` — unconditionally bootout prod, take its port, install signal handlers that flip `userHeld=true` on clean exit.
- `--forget` — clear this repo's remembered choice and re-prompt.
- `--forget-all` — clear every repo's remembered choice.
- `--prod` — internal: tells the action to skip dev-takeover logic. Set by the plist; auto-detected when `process.ppid === 1`.

**Prod-side commands:**

- `tb-streamer prod status` — agent loaded?, agent pid, marker state.
- `tb-streamer prod start` — clear marker + `launchctl kickstart -k`. Use after a `userHeld` suspension to restore prod.
- `tb-streamer prod stop` — `launchctl bootout`. Will not auto-restart until `prod start` or reboot.
- `tb-streamer prod restart` — bootout + bootstrap (re-reads plist).
- `tb-streamer prod doctor [--fix]` — detect stale marker (dead devPid, not userHeld) and missing agent; `--fix` clears stale markers.
- `tb-streamer prod logs [-n <N>] [--no-follow] [--errors-only]` — tail the supervised streamer's stdout + stderr. Default follows both files live, seeded with the last 50 lines. Resolves paths via `Supervisor.getLogPaths()` (macOS: `~/.threadbase/logs/{stdout,stderr}.log`). Not yet wired on Windows — see `src/lifecycle/task-scheduler.ts` `getLogPaths`.

**Don't break without coordination:**

- The marker shape is versioned by `shimVersion: 1`. Bump it if you change the shape; the schema will reject older markers and `readMarker` returns null + logs a warning.
- The plist's `ProgramArguments` MUST start with `node $INSTALL_DIR/launchd-entry.cjs serve --port $PORT --verbose --prod`. The trailing `--prod` is what tells the action to skip dev-takeover even if PPID detection fails. `ensure_plist_healthy` in `scripts/deploy.sh` rewrites three stale layouts: missing `EnvironmentVariables`, ProgramArguments pointing at `cli.js` directly, or bare-bool `KeepAlive`.
- `dist/launchd-entry.cjs` is a tsup CLI entry; deploy copies it to `~/.threadbase/launchd-entry.cjs` (no per-release versioning — it always forwards to the active `cli.js` symlink).

Source modules: `src/lifecycle/{constants,marker,marker-schema,process-liveness,repo,prefs,launchd,dev-takeover,prompt}.ts` + `cli/launchd-entry.ts` + `cli/prod.ts`. Marker/prefs paths come from `installDir() ?? $HOME/.threadbase`; override via `THREADBASE_INSTALL_DIR` (used by tests).

## Windows (Task Scheduler)

The same lifecycle module is implemented for Windows via `src/lifecycle/task-scheduler.ts`. `getSupervisor()` in `src/lifecycle/platform.ts` picks the right backend at runtime based on `process.platform`.

**Components on Windows:**

- **No shim.** Task Scheduler does not auto-respawn on `KeepAlive`-style triggers — it runs the registered action once per trigger. The marker-suppression mechanism (the central reason for the shim on macOS) is unnecessary; a clean dev exit simply leaves the prod task stopped until the user runs `tb-streamer prod start` (or until the next at-logon trigger, if configured).
- **Marker + prefs files** at `%USERPROFILE%\.threadbase\prod-suspended.json` and `dev-prefs.json` — same shape as macOS. Used by `tb-streamer prod doctor` for diagnostics and by `--replace-prod` to track which dev session took the port.
- **Task** named `Threadbase` (overridable via `THREADBASE_TASK_NAME` env var). Registered by `scripts\deploy.ps1 setup`. Action: `wscript.exe launch.vbs` → `launch.cmd` → `node cli.js serve --port 8766 --verbose --prod`. The trailing `--prod` flag tells the action to skip dev-takeover logic.

**Marker decision (Windows):**

| Marker state | Effect |
|---|---|
| absent / malformed | Task runs normally on next trigger |
| `userHeld: true` | Task stays stopped until `tb-streamer prod start` |
| `userHeld: false`, devPid alive | Dev is using the port; user must stop dev or run `prod start` to force takeover back to prod |
| `userHeld: false`, devPid dead | Stale; `tb-streamer prod doctor --fix` clears it |

**Prod-side commands behave identically.** `tb-streamer prod start|stop|status|restart|doctor` all work on Windows; under the hood they call `Get-ScheduledTask`, `Stop-ScheduledTask`, `Start-ScheduledTask`, `Enable-ScheduledTask`, `Disable-ScheduledTask` via `powershell.exe`.

**Don't break without coordination:**

- `launch.cmd` must include `--port`, `--verbose`, and `--prod`. `Repair-LaunchCmd` in `scripts\deploy.ps1` self-heals stale layouts (mirrors `ensure_plist_healthy` on macOS).
- The `TASK_NAME` constant in `src/lifecycle/constants.ts` must match the task name registered by `deploy.ps1`. Both default to `"Threadbase"` and both honour the `THREADBASE_TASK_NAME` env var. If you change one, change the other.
- `task-scheduler.getAgentPid()` greps `Get-CimInstance Win32_Process` for `node.exe` whose command line matches `*cli.js*serve*`. If you change `launch.cmd` to invoke node with a different command line, update the WMI filter in `task-scheduler.ts` to match.
