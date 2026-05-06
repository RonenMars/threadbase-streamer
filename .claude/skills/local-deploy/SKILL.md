---
name: local-deploy
description: Build, stamp, and (re)launch threadbase-streamer locally on macOS, Linux, or Windows. Detects the OS and dispatches to the right deploy script (launchd / systemd-user / Task Scheduler). On a fresh install, prompts the user for PostgreSQL persistence vs memory-only mode and bootstraps the platform service before the first deploy. Use when the user says "deploy locally", "redeploy threadbase", "ship a local build", "install threadbase on this machine", or wants to update the running streamer.
---

# Local deploy (cross-platform)

Wraps the OS-specific deploy scripts (`scripts/deploy.sh` for macOS, `scripts/deploy-linux.sh` for Linux, `scripts/deploy.ps1` for Windows) plus first-run setup. The orchestration logic — fresh-install detection, DB-vs-memory prompt, API key generation, healthcheck reporting — is the same on every platform; only the service-management layer differs.

## Step 1 — Detect OS

Pick the correct branch by `uname -s` (or `$IsWindows` in PowerShell):

| `uname -s` output | Platform | Service mechanism | Deploy script |
|---|---|---|---|
| `Darwin` | macOS | launchd user agent | `scripts/deploy.sh` |
| `Linux` | Linux | systemd user unit | `scripts/deploy-linux.sh` |
| `MINGW*`, `MSYS*`, `CYGWIN*`, or PowerShell | Windows | Task Scheduler at logon | `scripts/deploy.ps1` |

If you can't determine the OS or it doesn't match these three, stop and tell the user this skill doesn't support their platform — don't guess.

## Step 2 — Classify install state

A platform-appropriate freshness probe (run **all** the relevant ones; install is **fresh** if any signal is missing):

**macOS:**
```bash
test -L "$HOME/.threadbase/cli.js"
launchctl print "gui/$(id -u)/com.ronen.threadbase" >/dev/null 2>&1
test -f "$HOME/Library/LaunchAgents/com.ronen.threadbase.plist"
```

**Linux:**
```bash
test -L "$HOME/.threadbase/cli.js"
systemctl --user list-unit-files threadbase.service >/dev/null 2>&1
test -f "$HOME/.config/systemd/user/threadbase.service"
```

**Windows (PowerShell):**
```powershell
Test-Path (Join-Path $env:USERPROFILE '.threadbase\cli.js')
Get-ScheduledTask -TaskName 'Threadbase' -ErrorAction SilentlyContinue
```

If everything is present → **update**, skip to Step 4.
If any signal is missing → **fresh install**, do Step 3 first.

**Stale plist check (macOS):** even if the plist file exists, check that its `ProgramArguments` entry references `~/.threadbase/cli.js` (not a hardcoded path like a dev workspace). If it doesn't, treat as fresh: run `launchctl bootout "gui/$(id -u)/com.ronen.threadbase"` first, rewrite the plist (Step 3c), then bootstrap. The deploy script's `kickstart` call will fail with "could not find service" if the service was booted out but never re-bootstrapped.

## Step 3 — Fresh-install bootstrap

The shared head (do these on every platform):

### 3a. Ensure npm deps are installed

Before anything else, confirm `node_modules` is present and up to date. A fresh clone or a repo where new packages were added since last install will fail the lint/build step with "Cannot find module" errors:

```bash
npm install
```

On Windows the `postinstall` script patches `qrcode-terminal` and sets permissions on the `node-pty` prebuild — this must complete successfully before the deploy can proceed.

### 3b. Ask DB vs memory (use `AskUserQuestion`)

Two options:
- **postgres** — managed sessions survive restarts; requires a `postgresql://…` URI (Neon, RDS, local Docker). Ask for the connection string as a follow-up.
- **memory** — sessions held in memory only, lost on restart. Zero config.

### 3c. Generate an API key if missing

```bash
mkdir -p "$HOME/.threadbase"
chmod 700 "$HOME/.threadbase"  # macOS/Linux only
[ ! -f "$HOME/.threadbase/server.yaml" ] && \
  printf 'api_key: tb_%s\n' "$(openssl rand -hex 16)" > "$HOME/.threadbase/server.yaml" && \
  chmod 600 "$HOME/.threadbase/server.yaml"
```

PowerShell equivalent:
```powershell
$dir = Join-Path $env:USERPROFILE '.threadbase'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$cfg = Join-Path $dir 'server.yaml'
if (-not (Test-Path $cfg)) {
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  "api_key: tb_$hex" | Set-Content -Path $cfg -Encoding ascii
}
```

Confirm a port with the user (default `8766`). Use `command -v node` (POSIX) or `(Get-Command node).Source` (PowerShell) to resolve the absolute node binary.

The deploy script (Step 4) will interactively prompt for `browse_root` if it is not set. To configure it upfront, add it to `server.yaml` now:

```yaml
api_key: tb_…
browse_root: /path/to/your/projects
```

### 3d. Write the platform service definition

#### macOS — launchd plist

`~/Library/LaunchAgents/com.ronen.threadbase.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ronen.threadbase</string>
  <key>ProgramArguments</key>
  <array>
    <string>{NODE_BIN}</string>
    <string>{HOME}/.threadbase/cli.js</string>
    <string>serve</string><string>--port</string><string>{PORT}</string>
    <string>--verbose</string>
  </array>
  <key>WorkingDirectory</key><string>{HOME}/.threadbase</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>{HOME}</string>
    {DB_BLOCK}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/threadbase.log</string>
  <key>StandardErrorPath</key><string>/tmp/threadbase.err</string>
</dict>
</plist>
```

`{DB_BLOCK}` is empty for memory mode, or:
```xml
<key>THREADBASE_DATABASE_URL</key><string>postgresql://…</string>
<key>THREADBASE_INSTANCE_ID</key><string>{HOSTNAME}</string>
```

Bootstrap: `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist`.

#### Linux — systemd user unit

`~/.config/systemd/user/threadbase.service`:

```ini
[Unit]
Description=Threadbase Streamer
After=default.target

[Service]
Type=simple
ExecStart={NODE_BIN} %h/.threadbase/cli.js serve --port {PORT} --verbose
Restart=on-failure
RestartSec=2
StandardOutput=append:/tmp/threadbase.log
StandardError=append:/tmp/threadbase.err
Environment=HOME=%h
{DB_ENV_LINES}

[Install]
WantedBy=default.target
```

`{DB_ENV_LINES}` is empty for memory mode, or:
```ini
Environment=THREADBASE_DATABASE_URL=postgresql://…
Environment=THREADBASE_INSTANCE_ID={HOSTNAME}
```

Bootstrap:
```bash
mkdir -p ~/.config/systemd/user
# (write the file)
systemctl --user daemon-reload
systemctl --user enable --now threadbase.service
```

If the user wants the service to keep running after they log out, mention `loginctl enable-linger $USER` (don't run it automatically — it's a session-management policy decision).

#### Windows — Task Scheduler "at logon"

**Important:** Task Scheduler doesn't support native stdout/stderr redirection, and `pwsh.exe -WindowStyle Hidden` still briefly flashes a console window when the task fires on logon. To avoid the flash, the action launches `wscript.exe` with a `.vbs` shim that invokes a `.cmd` batch file hidden — `wscript` has no console, so its child processes inherit a hidden window. The `.cmd` carries the env vars and the `>>` redirection that captures stdout/stderr to the log files (`%TEMP%\threadbase.log` / `%TEMP%\threadbase.err`).

```powershell
$nodePath   = (Get-Command node).Source
$installDir = "$env:USERPROFILE\.threadbase"
$cliPath    = "$installDir\cli.js"
$logOut     = "$env:TEMP\threadbase.log"
$logErr     = "$env:TEMP\threadbase.err"
$cmdPath    = "$installDir\launch.cmd"
$vbsPath    = "$installDir\launch.vbs"

# Read DB env vars back from the registry (User scope) and inline them into launch.cmd
$dbUrl  = [Environment]::GetEnvironmentVariable('THREADBASE_DATABASE_URL', 'User')
$instId = [Environment]::GetEnvironmentVariable('THREADBASE_INSTANCE_ID', 'User')

# Build launch.cmd. Quoted `set "K=V"` form preserves trailing spaces and special chars
# in the connection string. The final node line uses cmd's >> redirection.
$cmdLines = @('@echo off', "cd /d `"$installDir`"")
if ($dbUrl)  { $cmdLines += "set `"THREADBASE_DATABASE_URL=$dbUrl`"" }
if ($instId) { $cmdLines += "set `"THREADBASE_INSTANCE_ID=$instId`"" }
$cmdLines += "`"$nodePath`" `"$cliPath`" serve --port {PORT} --verbose >> `"$logOut`" 2>> `"$logErr`""
Set-Content -Path $cmdPath -Value $cmdLines -Encoding Ascii

# launch.vbs: hidden launcher (window style 0, no wait) for launch.cmd.
# Triple double-quotes embed literal `"` into the VBS string so paths with spaces work.
$vbsContent = 'CreateObject("WScript.Shell").Run """' + $cmdPath + '""", 0, False'
Set-Content -Path $vbsPath -Value $vbsContent -Encoding Ascii

$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$vbsPath`"" `
  -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName 'Threadbase' `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Threadbase Streamer (managed by local-deploy skill)' -Force
Start-ScheduledTask -TaskName 'Threadbase'
```

**Windows DB mode — inline env vars into `launch.cmd`; do not rely on inheritance.** Persist the connection string at User scope in the registry, then read it back when generating `launch.cmd`. On Windows, tasks started via `Start-ScheduledTask` within the same terminal session that called `SetEnvironmentVariable` will NOT pick up the new var — the user session's environment block is frozen at logon and the registry write doesn't update live processes. The snippet above already handles this; just ensure the registry values exist before re-registering the task:

```powershell
# Persist to registry (survives reboots, future sessions)
[Environment]::SetEnvironmentVariable('THREADBASE_DATABASE_URL', 'postgresql://…', 'User')
[Environment]::SetEnvironmentVariable('THREADBASE_INSTANCE_ID', $env:COMPUTERNAME, 'User')
```

**Windows DB connectivity diagnosis:** if `%TEMP%\threadbase.err` shows `EACCES` on port 5432 (not `ECONNREFUSED`), the env var is missing from the task action — the server starts but crashes when it can't find the DB URI. Test reachability first with `Test-NetConnection -ComputerName <host> -Port 5432`; if that succeeds, the issue is the missing env var, not a Windows Firewall rule.

**Stale instance check (Windows):** Before starting the task, kill any node process already listening on port 8766 (old streamer version, previous deploy, etc.). Skipping this causes the new task to fail silently because the port is taken:
```powershell
$pid8766 = (netstat -ano | Select-String ':8766\s').ToString().Trim() -split '\s+' | Select-Object -Last 1
if ($pid8766 -match '^\d+$') { Stop-Process -Id $pid8766 -Force -ErrorAction SilentlyContinue }
```

**Submodule SSH → HTTPS (Windows without SSH keys):** If `git submodule update --init` fails with "Permission denied (publickey)", redirect SSH URLs to HTTPS before the first deploy:
```powershell
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

## Step 4 — Run the deploy

Choose the npm script that matches the OS:

```bash
# macOS
npm run deploy
npm run deploy:force            # skip lint/tests/dirty-tree
npm run deploy:update-scanner   # bump submodule first

# Linux
npm run deploy:linux
npm run deploy:linux:force

# Windows
npm run deploy:windows
npm run deploy:windows:force
```

Each script does the same shape: predeploy check → **browse_root check** (prompts interactively if `~/.threadbase/server.yaml` has no `browse_root:` key or the path doesn't exist) → ensure scanner built → lint + tests (unless `--force`/`-Force`) → `npm run build` → stamp release at `~/.threadbase/releases/cli.<sha>.cjs` → **copy `dist/migrations/`** → activate → restart the service → healthcheck on `http://localhost:8766/healthz`.

The migrations destination differs by platform because Node resolves `__dirname` from the *real* file location (not symlink source):
- **macOS/Linux**: `cli.js` is a symlink → `__dirname` = `releases/` → copy to `~/.threadbase/releases/migrations/`
- **Windows**: `cli.js` is a real file copy at install root → `__dirname` = `~/.threadbase/` → copy to `~/.threadbase/migrations/`

> **Migrations path differs by OS.** macOS/Linux: `cli.js` is a symlink → Node resolves `__dirname` to `releases/` → copy to `releases/migrations/`. Windows: `cli.js` is a real file at the install root → `__dirname` = `~/.threadbase/` → copy to `~/.threadbase/migrations/`. If the healthcheck fails with `ENOENT … migrations`, the deploy script is copying to the wrong location.

## Cloudflare Tunnel (Windows)

The Windows install uses a `cloudflared` Windows service with two config files that must be kept in sync:
- `~/.cloudflared/config.yml` — used when running `cloudflared` manually
- `~/.cloudflared/config-system.yml` — used by the Windows service (SYSTEM account); this is the active one

The active public hostname is **`https://tb-pc.rbv1000.win`** → `http://127.0.0.1:8766`.

After verifying the tunnel works, add `public_url` to `~/.threadbase/server.yaml` so the pairing QR code embeds the correct URL:
```yaml
api_key: tb_…
browse_root: C:\…
public_url: https://tb-pc.rbv1000.win
```
Then restart the Threadbase task to pick it up.

**Cloudflare Access nuance:** the hostname is behind Cloudflare Access. Any request without an `Authorization` header gets `401 Unauthorized` from the CF edge — including `/healthz`. Requests with `Authorization: Bearer <api_key>` pass through to the origin. Practical consequences:
- The deploy-script healthcheck hits `http://localhost:8766/healthz` directly and is not affected.
- To verify the public URL manually, always include the Bearer header: `Invoke-RestMethod -Uri https://tb-pc.rbv1000.win/api/info -Headers @{Authorization="Bearer <key>"}`
- Browser and `Test-NetConnection` probes will be blocked at the CF edge; that is expected and correct.

To apply config changes: edit **both** config files, then `Restart-Service cloudflared`.

## Step 5 — Report

Run the matching `:status` script and summarize:

| | macOS | Linux | Windows |
|---|---|---|---|
| Status command | `npm run deploy:status` | `npm run deploy:linux:status` | `npm run deploy:windows:status` |
| Active release | symlink target of `~/.threadbase/cli.js` | symlink target of `~/.threadbase/cli.js` | mtime/size of `%USERPROFILE%\.threadbase\cli.js` |
| Service health | `launchctl list \| grep com.ronen.threadbase` | `systemctl --user status threadbase` | `Get-ScheduledTaskInfo -TaskName 'Threadbase'` |

If the healthcheck failed, the deploy script already prints the last 20 lines of stderr (`/tmp/threadbase.err` on Unix, `%TEMP%\threadbase.err` on Windows). Surface those and stop. Don't claim success.

If the user has the `tb` shim installed (see `scripts/install-tb.sh` / `install-tb.ps1`), remind them they can now run `tb pair`, `tb serve`, etc.

## Out of scope

- Installing Node.js. If `node` is missing, fail with `https://nodejs.org/` and stop.
- Provisioning Postgres. We trust whatever URI the user provides.
- Editing shell rc files (PATH, lazy-nvm).
- Linux init systems other than systemd (OpenRC, runit, sysvinit) — unsupported.
- Windows Service via `sc.exe`/NSSM. We use Task Scheduler intentionally to avoid admin requirements; if the user explicitly asks for a Windows Service, that's a separate skill.
