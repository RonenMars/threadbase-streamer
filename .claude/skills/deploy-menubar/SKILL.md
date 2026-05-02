---
name: deploy-menubar
description: Build and launch the Threadbase menubar Electron app from vendor/menubar. Run this after the streamer server is healthy (post local-deploy). Ensures the submodule is checked out, deps are installed, TypeScript is compiled, and the app is running. Use when the user says "launch the menubar", "start the tray app", "deploy menubar", or "set up the menubar".
---

# Deploy menubar

Builds and launches the `vendor/menubar` Electron app. Always run this **after** the streamer server is healthy — the menubar polls `/healthz` and needs the server up to show a green icon.

## Step 1 — Detect OS

Use `$IsWindows` / `$IsMacOS` / `$IsLinux` in PowerShell, or check `uname -s` in bash:

| Platform | Proceed? |
|---|---|
| macOS (`Darwin`) | yes |
| Linux | yes |
| Windows (`$IsWindows`) | yes |
| Other | stop — unsupported |

All subsequent steps have platform-specific variants where needed.

## Step 2 — Ensure submodule is checked out

**macOS / Linux (bash):**
```bash
cd <repo-root>
if [[ ! -f vendor/menubar/package.json ]]; then
  git submodule update --init --recursive vendor/menubar
fi
```

**Windows (PowerShell):**
```powershell
$menubarPkg = "vendor\menubar\package.json"
if (-not (Test-Path $menubarPkg)) {
  git submodule update --init --recursive vendor/menubar
}
```

## Step 3 — Install deps (idempotent)

**macOS / Linux:**
```bash
cd vendor/menubar
if [[ ! -d node_modules ]] || [[ package.json -nt node_modules ]]; then
  npm install --silent
fi
```

**Windows:**
```powershell
Set-Location vendor\menubar
if (-not (Test-Path node_modules)) { npm install --silent }
```

## Step 4 — Build (idempotent)

**macOS / Linux:**
```bash
cd vendor/menubar
need_build=0
if [[ ! -d dist ]]; then
  need_build=1
else
  newest_src="$(find src -type f -newer dist -print -quit 2>/dev/null || true)"
  [[ -n "$newest_src" ]] && need_build=1
fi
if (( need_build )); then
  npm run build
fi
```

**Windows:**
```powershell
Set-Location vendor\menubar
$needBuild = -not (Test-Path dist)
if (-not $needBuild) {
  $distMtime = (Get-Item dist).LastWriteTime
  $newerSrc = Get-ChildItem src -Recurse -File | Where-Object { $_.LastWriteTime -gt $distMtime } | Select-Object -First 1
  if ($newerSrc) { $needBuild = $true }
}
if ($needBuild) { npm run build }
```

## Step 5 — Check if already running

**macOS / Linux:**
```bash
pgrep -f "vendor/menubar" >/dev/null 2>&1 && already_running=1 || already_running=0
```

**Windows:**
```powershell
$electronProcs = Get-Process electron -ErrorAction SilentlyContinue
$alreadyRunning = !!$electronProcs
```

If already running, report "menubar is already running" and stop — do not kill and relaunch unless the user explicitly asked for a restart.

**Important (Windows):** always kill ALL existing electron processes before launching — Electron spawns ~10 child processes per instance, so even one prior failed launch leaves many orphans. Kill them all, then launch fresh:
```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
```

## Step 6 — Launch

**macOS / Linux:**
```bash
cd vendor/menubar
nohup npx electron . </dev/null >>/tmp/threadbase-menubar.log 2>&1 &
disown
sleep 1
pgrep -f "vendor/menubar" >/dev/null 2>&1 && echo "menubar running" || echo "menubar exited — check /tmp/threadbase-menubar.log"
```

**Windows (PowerShell):**

**Critical:** do NOT use `electron.cmd` (the npm bin wrapper) — it spawns a cmd.exe parent that exits and takes Electron with it. Launch `electron.exe` directly from `node_modules\electron\dist\`:

```powershell
$menubarDir = Resolve-Path "vendor\menubar"
$electronExe = "$menubarDir\node_modules\electron\dist\electron.exe"

$proc = Start-Process -FilePath $electronExe `
  -ArgumentList "." `
  -WorkingDirectory $menubarDir `
  -Environment @{
    THREADBASE_PORT = '8766'
    USERPROFILE     = $env:USERPROFILE
    APPDATA         = $env:APPDATA
    TEMP            = $env:TEMP
    SystemRoot      = $env:SystemRoot
    PATH            = $env:PATH
  } `
  -PassThru
Start-Sleep -Seconds 3
$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($alive) {
  Write-Host "menubar running (PID $($proc.Id))"
} else {
  Write-Host "menubar exited. ExitCode: $($proc.ExitCode)"
}
```

## Step 7 — Report

On success: "Menubar launched. Tray icon should appear in the system tray — gray until the streamer responds, then green."

On immediate exit: surface the last 20 lines of the log file and stop. Do not claim success.

- macOS/Linux log: `/tmp/threadbase-menubar.log`
- Windows log: `%TEMP%\threadbase-menubar.log`

## Notes

- The menubar default port is `3456`. If the streamer is running on a different port, pass it as an env var before launching:
  - macOS/Linux: `THREADBASE_PORT=8766 nohup npx electron . …`
  - Windows: `$env:THREADBASE_PORT = '8766'` before `Start-Process`
- `vendor/menubar` uses `tsc` (not tsup) — output lands in `dist/` with `main.ts` → `dist/main.js`.
- The renderer (`src/renderer/index.html`) is referenced as `../src/renderer/index.html` from `dist/` — this is intentional for dev; do not change the path.
- First launch: `config.json` won't exist yet, so the menubar auto-shows its popup for the "Launch at login" preference. This is expected behavior.
- Login-item registration (launch at login) is handled inside the app via the popup toggle — this skill does not configure it separately.
- On Windows, Electron shows a tray icon in the system tray (bottom-right). If the icon doesn't appear, check that the tray is not hidden under "Show hidden icons" (the `^` arrow in the taskbar).
