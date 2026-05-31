# Lifecycle Windows Test Guide

Manual verification of the prod/dev coordination feature on Windows. Covers the Task Scheduler backend, the `prod` subcommand tree, the dev-takeover prompt, and `Repair-LaunchCmd` self-heal.

This is the Windows counterpart of Task 14 in the macOS plan and Task 10 in the Windows-port plan — it cannot be automated in CI because it exercises real Task Scheduler state.

See [`CLAUDE.md` → Prod/dev coordination → Windows (Task Scheduler)](../CLAUDE.md) for the architecture and [`docs/troubleshooting.md` → Prod/dev coordination](troubleshooting.md) for symptom-to-fix entries this guide may surface.

---

## Prereqs

- Windows 10 or 11.
- PowerShell 5.1 (`powershell.exe`) — already installed. PowerShell 7 (`pwsh.exe`) is fine too but not required.
- Node.js installed and on `PATH`.
- The streamer repo cloned somewhere writable.
- The `feat/streamer-lifecycle-coordination` branch checked out (or main, once merged).

```powershell
cd C:\path\to\dev
git clone git@github.com:RonenMars/threadbase-streamer.git
cd threadbase-streamer
git fetch
git checkout feat/streamer-lifecycle-coordination
# If submodules are part of the workflow:
git submodule update --init --recursive
npm install   # required before first deploy on a fresh clone
```

---

## 1. Setup — deploy and confirm the regenerated `launch.cmd`

```powershell
pwsh scripts\deploy.ps1
```

If a `launch.cmd` from a previous deploy already exists without the new flags, `Repair-LaunchCmd` should warn + back it up + rewrite. Look for a line like `! launch.cmd is missing --prod flag — rewriting` in the deploy output, followed by `✓ launch.cmd healed (backup saved alongside)`.

After deploy:

```powershell
Get-Content $env:USERPROFILE\.threadbase\launch.cmd
# Last line must contain: serve --port 8766 --verbose --prod
```

If the last line is missing any of `--port`, `--verbose`, or `--prod`, the self-heal didn't fire — re-run the deploy with `-Force` and capture the output.

---

## 2. Smoke tests (5 minutes)

### 2.1 Prod is healthy

```powershell
tb-streamer prod status
# Expected:
#   agent: loaded
#   pid: <some integer>
#   marker: none

Invoke-RestMethod http://localhost:8766/healthz
# Expected: ok=$true; version=<semver>+<sha>
```

### 2.2 Status reports a non-null PID

This is the single fragile piece of the Windows backend. `getAgentPid()` greps `Get-CimInstance Win32_Process` for `node.exe` whose command line matches `*cli.js*serve*`. If it returns null even though the task is clearly running, the WMI filter and your actual `launch.cmd` invocation have drifted.

If `pid: (none)`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
# Look for the streamer's row. Its CommandLine should include "cli.js" and "serve".
# If it includes "launchd-entry.cjs" instead (because launch.cmd was customised),
# update the WMI filter in src/lifecycle/task-scheduler.ts to match.
```

---

## 3. Functional tests (15 minutes)

### 3.1 Dev-takeover prompt fires on conflict

In a new PowerShell window, in any directory inside a git repo:

```powershell
cd C:\Users\<you>\projects\any-git-repo
tb-streamer serve --port 8766
```

Expected interactive prompt:
```
Prod streamer is running on port 8766.
  [r] Stop prod and take port 8766
  [p] Run dev on port 8767 instead
Choice [r/p]:
```

Pick `p`, then `N` when asked about remembering. Verify the dev binds 8767 by checking the log line `Listening on http://localhost:8767`.

Ctrl-C to exit.

### 3.2 `--replace-prod` bypasses the prompt

```powershell
tb-streamer serve --port 8766 --replace-prod
```

Expected: no prompt, dev binds 8766 immediately. In another PowerShell window:

```powershell
tb-streamer prod status
# Expected:
#   agent: NOT loaded
#   marker: userHeld=false, devPid=<the dev pid>, port=8766
```

### 3.3 Clean exit flips `userHeld=true`

Ctrl-C the dev from step 3.2.

```powershell
tb-streamer prod status
# Expected:
#   marker: userHeld=true
Get-ScheduledTask -TaskName Threadbase | Select-Object State
# Expected: Disabled
```

### 3.4 `prod start` restores the supervised instance

```powershell
tb-streamer prod start
# Expected message: "prod streamer restored — Task Scheduler is starting it now."
Start-Sleep 2
tb-streamer prod status
# Expected: agent: loaded, marker: none

Invoke-RestMethod http://localhost:8766/healthz
# Expected: 200 OK with the streamer's version
```

### 3.5 Per-repo remembered choice

```powershell
cd C:\Users\<you>\projects\any-git-repo
tb-streamer serve --port 8766
# Pick [p], then [Y] to remember.
# Ctrl-C.
tb-streamer serve --port 8766
# Expected: no prompt; binds the alt port immediately.

Get-Content $env:USERPROFILE\.threadbase\dev-prefs.json
# Expected: { "repos": { "<git toplevel>": { "choice": "use-port", "port": 8767, ... } } }
```

Verify the `<git toplevel>` key looks like a real Windows path (e.g. `C:\\Users\\<you>\\projects\\any-git-repo`). If it has forward slashes like `/c/Users/...`, `getGitToplevel` returned a Git-Bash-style path — note it for follow-up but not a blocker.

### 3.6 `--forget` clears the remembered choice and re-prompts

```powershell
tb-streamer serve --port 8766 --forget
# Expected: prompt fires again, dev-prefs entry for this repo is gone before the prompt.
```

### 3.7 `prod doctor` detects + repairs stale markers

```powershell
# Manually craft a stale marker:
$marker = '{"devPid":999999,"port":8766,"repoToplevel":"C:\\x","suspendedAt":"2026-05-30T19:55:00.000Z","userHeld":false,"shimVersion":1}'
$marker | Set-Content $env:USERPROFILE\.threadbase\prod-suspended.json

tb-streamer prod doctor
# Expected: findings list "stale marker (dev pid 999999 dead)"
#           + suggestion "(re-run with --fix to apply repairs)"

tb-streamer prod doctor --fix
# Expected: repairs list "cleared stale marker (dev pid 999999 was dead)"

Test-Path $env:USERPROFILE\.threadbase\prod-suspended.json
# Expected: False
```

---

## 4. Windows-specific gotchas to validate

| Scenario | Expected | Watch for |
|---|---|---|
| `tb-streamer prod status` first run | `pid: <integer>` | If shows `pid: (none)` while task IS running → the WMI `getAgentPid` query isn't matching your `launch.cmd`. See §2.2 above. |
| `tb-streamer serve --replace-prod` from a non-elevated shell | Dev binds 8766 | If port is held after `Stop-ScheduledTask` returns → race condition; the troubleshooting entry "--replace-prod succeeds but prod restarts immediately" applies. Try `Stop-Process -Id <pid> -Force` first. |
| Prompt under VS Code's integrated terminal | Renders + accepts input | If it hangs → `readline.question` with redirected stdin. Use `cmd.exe` or `powershell.exe` directly. (Already documented in troubleshooting.) |
| `dev-prefs.json` written | `repos: { "C:\\...": {...} }` with backslashes | If path uses forward slashes → `getGitToplevel` returned a Git-Bash-style path. Worth noting but not breaking. |
| `Repair-LaunchCmd` on a stale `launch.cmd` | Warns + backs up + rewrites | Manually delete `--prod` from `launch.cmd`, re-run `pwsh scripts\deploy.ps1`. Should detect + heal. A `.bak.<timestamp>` file should appear alongside. |

---

## 5. If something fails

### Where to look

- `$env:USERPROFILE\.threadbase\logs\*.log` — main streamer log + stderr.
- `$env:TEMP\threadbase.err` — only if the task action explicitly redirects there; otherwise empty (see troubleshooting "Service starts but immediately exits").
- Task Scheduler GUI: `Win+R` → `taskschd.msc` → find "Threadbase" task → **Last Run Result** + **History** tab.
- `Get-ScheduledTaskInfo -TaskName Threadbase` — shows last run result code.

### Force a clean state

```powershell
tb-streamer prod stop
Remove-Item $env:USERPROFILE\.threadbase\prod-suspended.json -ErrorAction SilentlyContinue
Remove-Item $env:USERPROFILE\.threadbase\dev-prefs.json -ErrorAction SilentlyContinue
tb-streamer prod start
```

If `tb-streamer prod start` reports `task 'Threadbase' is not registered`, run `pwsh scripts\deploy.ps1 setup` to re-register the task.

---

## 6. Findings to report back

After running through the suite, the three pieces I'd like specific confirmation on (because they were implemented without a real Windows machine to verify against):

1. **Does `getAgentPid` return a non-null integer when prod is running?** This is the most fragile piece — the WMI command-line filter was picked heuristically. If it returns null in §2.2, the filter in `src/lifecycle/task-scheduler.ts` needs to be updated to match the actual `launch.cmd` invocation.

2. **Does the dev-takeover prompt render and accept input in standard `powershell.exe`?** The `readline/promises` implementation is portable in theory; in practice some Windows terminal hosts redirect stdin in unexpected ways.

3. **Does `Repair-LaunchCmd` detect a pre-shim `launch.cmd`?** Test by manually editing `launch.cmd` to drop the `--prod` flag, then re-running `pwsh scripts\deploy.ps1`. The output should include a warning and the file should be backed up + rewritten.

For any of these that misbehave: file a GitHub issue with the symptom, the exact command line, and the contents of `$env:USERPROFILE\.threadbase\launch.cmd`.
