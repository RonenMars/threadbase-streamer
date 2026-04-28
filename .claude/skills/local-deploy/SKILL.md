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

## Step 3 — Fresh-install bootstrap

The shared head (do these on every platform):

### 3a. Ask DB vs memory (use `AskUserQuestion`)

Two options:
- **postgres** — managed sessions survive restarts; requires a `postgresql://…` URI (Neon, RDS, local Docker). Ask for the connection string as a follow-up.
- **memory** — sessions held in memory only, lost on restart. Zero config.

### 3b. Generate an API key if missing

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

### 3c. Write the platform service definition

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

```powershell
$action = New-ScheduledTaskAction `
  -Execute (Get-Command node).Source `
  -Argument "`"$env:USERPROFILE\.threadbase\cli.js`" serve --port {PORT} --verbose"
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

# Add env vars (DB mode only) by composing a CIM XML attribute or by setting
# them on the user PATH/USER env vars before invoking node. The simplest path
# for the DB URI is a per-task XML attribute on the action; document this in
# the bootstrap step.

Register-ScheduledTask -TaskName 'Threadbase' `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Threadbase Streamer (managed by local-deploy skill)'
Start-ScheduledTask -TaskName 'Threadbase'
```

For DB mode, set `THREADBASE_DATABASE_URL` as a user environment variable so the task inherits it:
```powershell
[Environment]::SetEnvironmentVariable('THREADBASE_DATABASE_URL', 'postgresql://…', 'User')
[Environment]::SetEnvironmentVariable('THREADBASE_INSTANCE_ID', $env:COMPUTERNAME, 'User')
```

Standard out/err go to files specified in the action's working directory; default to `%TEMP%\threadbase.log` and `%TEMP%\threadbase.err` (the deploy script's healthcheck reads from there).

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

Each script does the same shape: predeploy check → ensure scanner built → lint + tests (unless `--force`/`-Force`) → `npm run build` → stamp release at `~/.threadbase/releases/cli.<sha>.cjs` → activate (symlink swap on macOS/Linux, atomic file replace on Windows) → restart the service → healthcheck on `http://localhost:8766/healthz`.

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
