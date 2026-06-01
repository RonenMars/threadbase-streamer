#!/usr/bin/env pwsh
# Deploy/rollback/status helper for the Windows (Task Scheduler) threadbase-streamer.
# Mirrors scripts/deploy.sh; differences: no symlinks (uses atomic Move-Item),
# service restart goes through Task Scheduler instead of launchctl/systemd.
#
# Usage:
#   pwsh scripts/deploy.ps1                              # build + deploy
#   pwsh scripts/deploy.ps1 -Force                       # skip lint/test gates and dirty-tree check
#   pwsh scripts/deploy.ps1 -InstallShim standard        # non-interactive: install global threadbase-streamer.cmd
#                                                        #   values: standard | user-local | custom | skip
#   pwsh scripts/deploy.ps1 -PathUpdate auto             # non-interactive: how to add the shim dir to PATH
#                                                        #   values: print | auto | skip
#   pwsh scripts/deploy.ps1 rollback                     # repoint cli.js to the previous release
#   pwsh scripts/deploy.ps1 status                       # show current release and task status
#   pwsh scripts/deploy.ps1 healthcheck                  # probe /healthz
#
# Layout (Windows uses a real-file replacement instead of a symlink):
#   %USERPROFILE%\.threadbase\cli.js                  -> active release (real file)
#   %USERPROFILE%\.threadbase\releases\cli.<sha>.cjs  -> versioned build artifacts
#   %USERPROFILE%\.threadbase\releases\.history       -> append-only activation log
#
# Scheduled task (created out-of-band by the local-deploy skill):
#   Threadbase  (per-user, "at logon" trigger)
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Position = 0)]
  [ValidateSet('deploy', 'setup', 'rollback', 'status', 'healthcheck', '')]
  [string]$Command = 'deploy',

  [switch]$Force,

  # Non-interactive override for the global-shim install step.
  # Equivalent to the bash $TB_INSTALL_SHIM env var.
  [ValidateSet('standard', 'user-local', 'custom', 'skip', '')]
  [string]$InstallShim = '',

  # Non-interactive override for PATH handling when the chosen install dir
  # isn't on PATH. Equivalent to the bash $TB_PATH_UPDATE env var.
  [ValidateSet('print', 'auto', 'skip', '')]
  [string]$PathUpdate = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot     = Split-Path -Parent $PSScriptRoot
$installDir   = if ($env:THREADBASE_INSTALL_DIR) { $env:THREADBASE_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.threadbase' }
$releasesDir  = Join-Path $installDir 'releases'
$historyFile  = Join-Path $releasesDir '.history'
$activeFile   = Join-Path $installDir 'cli.js'
$taskName     = if ($env:THREADBASE_TASK_NAME) { $env:THREADBASE_TASK_NAME } else { 'Threadbase' }
$port         = if ($env:THREADBASE_PORT) { $env:THREADBASE_PORT } else { '8766' }
$healthUrl    = if ($env:THREADBASE_HEALTH_URL) { $env:THREADBASE_HEALTH_URL } else { 'http://localhost:8766/healthz' }
$keepReleases = 5

$menubarDir          = Join-Path $repoRoot 'vendor\menubar'
$menubarInstalledSha = Join-Path $installDir 'menubar-installed-sha'
$menubarFetchLog     = Join-Path $installDir 'logs\menubar-fetch.log'
$menubarLaunchLog    = Join-Path $env:TEMP    'threadbase-menubar.log'

function Write-Log  { param($m) Write-Host "▶ $m" -ForegroundColor Blue }
function Write-Warn { param($m) Write-Host "! $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "✗ $m" -ForegroundColor Red }
function Write-Ok   { param($m) Write-Host "✓ $m" -ForegroundColor Green }

# Dot-source the global-shim installer (Install-GlobalShim function).
. (Join-Path $PSScriptRoot 'lib\install-shim.ps1')

# Dot-source the menubar release fetcher.
. (Join-Path $PSScriptRoot 'lib\fetch-menubar.ps1')

# Forward CLI params into the env vars the helper reads, so the same code path
# works for both interactive and non-interactive invocations.
if ($InstallShim) { $env:TB_INSTALL_SHIM = $InstallShim }
if ($PathUpdate)  { $env:TB_PATH_UPDATE  = $PathUpdate }

function Ensure-MenubarDeployed {
  if (-not (Test-Path (Join-Path $menubarDir 'package.json'))) {
    Write-Log "initializing vendor/menubar submodule"
    Invoke-Native git @('submodule', 'update', '--init', '--recursive', 'vendor/menubar')
  }

  $currentSha = (& git -C $menubarDir rev-parse HEAD).Trim()

  $installedSha = if (Test-Path $menubarInstalledSha) { (Get-Content $menubarInstalledSha -Raw).Trim() } else { '' }
  $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\Threadbase Menubar\Threadbase Menubar.exe'

  # Idempotent skip: same SHA + installed binary still present.
  if (($currentSha -eq $installedSha) -and (Test-Path $installedExe)) {
    Write-Log "menubar is up-to-date ($currentSha)"
    $running = Get-Process 'Threadbase Menubar' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $running) {
      Start-MenubarInstalled -ExePath $installedExe
    } else {
      Write-Ok "menubar already running (PID $($running.Id))"
    }
    return
  }

  Write-Log "menubar needs install (installed: $(if ($installedSha) { $installedSha } else { 'none' }), current: $currentSha)"

  # Stop any running instance (installed or in-tree electron) before swapping.
  Write-Log "stopping running menubar"
  Get-Process 'Threadbase Menubar' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  # Try to fetch the matching pre-built NSIS installer from GitHub Releases.
  if (-not (Test-Path (Split-Path $menubarFetchLog -Parent))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $menubarFetchLog -Parent) | Out-Null
  }
  Set-Content -Path $menubarFetchLog -Value '' -NoNewline -Encoding Ascii

  Write-Log "fetching menubar release for $currentSha from GitHub"
  $tmpDir = Join-Path $installDir '.menubar-download'
  if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
  $result = Get-MenubarAsset -Sha $currentSha -AssetPattern '*-x64.exe' -OutDir $tmpDir -LogPath $menubarFetchLog

  if ($result.Status -eq 'ok') {
    Write-Ok "menubar release downloaded: $($result.Path)"
    Write-Log "installing menubar (silent NSIS, /S)"
    # /S: silent. NSIS installs to %LOCALAPPDATA%\Programs\Threadbase Menubar\ by default.
    $proc = Start-Process -FilePath $result.Path -ArgumentList '/S' -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) {
      Write-Warn "menubar installer exited with code $($proc.ExitCode) — falling back to in-tree electron"
    } elseif (-not (Test-Path $installedExe)) {
      Write-Warn "installer ran but $installedExe not found — falling back to in-tree electron"
    } else {
      Set-Content -Path $menubarInstalledSha -Value $currentSha -NoNewline -Encoding Ascii
      Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
      Start-MenubarInstalled -ExePath $installedExe
      return
    }
  } elseif ($result.Status -eq 'miss') {
    Write-Log "no matching menubar release for $currentSha — running in-tree electron"
  } else {
    Write-Warn "menubar release fetch failed — see $menubarFetchLog"
    Write-MenubarFetchError -LogPath $menubarFetchLog
    Write-Warn "falling back to in-tree electron run…"
  }

  if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }

  # In-tree fallback: build dist/ and launch electron.exe against vendor/menubar.
  Write-Log "building menubar (npm install + tsc)"
  Push-Location $menubarDir
  try {
    if (-not (Test-Path node_modules)) { Invoke-Native npm @('install', '--silent') }
    Invoke-Native npm @('run', 'build')
  } finally {
    Pop-Location
  }

  $electronExe = Join-Path $menubarDir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electronExe)) {
    Write-Warn "electron.exe not found at $electronExe — skipping menubar launch"
    return
  }

  Write-Log "launching menubar via in-tree electron"
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
    -RedirectStandardOutput $menubarLaunchLog `
    -PassThru
  Start-Sleep -Seconds 3
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($alive) {
    Write-Ok "menubar running (in-tree, PID $($proc.Id))"
  } else {
    Write-Warn "menubar exited immediately — check $menubarLaunchLog"
  }
}

function Start-MenubarInstalled {
  param([Parameter(Mandatory)] [string] $ExePath)
  Write-Log "launching $ExePath"
  $proc = Start-Process -FilePath $ExePath -PassThru
  Start-Sleep -Seconds 3
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($alive) {
    Write-Ok "menubar running (PID $($proc.Id))"
  } else {
    Write-Warn "menubar exited immediately"
  }
}

function Invoke-Native {
  param([string]$Command, [string[]]$ArgList)
  & $Command @ArgList
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with code $LASTEXITCODE"
  }
}

function Invoke-PredeployCheck {
  Push-Location $repoRoot
  try {
    $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    $dirty  = (& git diff --name-only HEAD) -ne $null -and (& git diff --name-only HEAD).Length -gt 0

    if ($Force) {
      if ($branch -ne 'main') { Write-Warn "branch is '$branch', forcing" }
      if ($dirty) { Write-Warn "working tree is dirty, forcing" }
      return
    }

    if ($branch -ne 'main') {
      Write-Err "not on main (current: $branch). Re-run with -Force to override."
      exit 1
    }
    if ($dirty) {
      Write-Err "working tree is dirty. Commit/stash, or re-run with -Force."
      exit 1
    }
  } finally {
    Pop-Location
  }
}

function Invoke-Setup {
  $logsDir = Join-Path $installDir 'logs'
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

  $nodeBin = (Get-Command node -ErrorAction SilentlyContinue)?.Source
  if (-not $nodeBin) { Write-Err "node not found in PATH"; exit 1 }

  $enableAutostart = $true
  if (-not [Console]::IsInputRedirected) {
    $response = (Read-Host "`n  Launch server automatically at login? [Y/n]").Trim()
    if ($response -in @('n', 'N')) { $enableAutostart = $false }
  }

  # Generate launch.cmd + launch.vbs so the task fires without flashing a console window.
  # wscript has no console, so its child (cmd.exe via the vbs shim) inherits a hidden window.
  $cmdPath = Join-Path $installDir 'launch.cmd'
  $vbsPath = Join-Path $installDir 'launch.vbs'

  $cmdLines = @('@echo off', "cd /d `"$installDir`"")
  $cmdLines += "`"$nodeBin`" `"$activeFile`" serve --port $port --verbose --prod"
  Set-Content -Path $cmdPath -Value $cmdLines -Encoding Ascii

  $vbsContent = 'CreateObject("WScript.Shell").Run """' + $cmdPath + '""", 0, False'
  Set-Content -Path $vbsPath -Value $vbsContent -Encoding Ascii

  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`"" -WorkingDirectory $installDir
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)

  if ($enableAutostart) {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
    Write-Ok "auto-startup at login: enabled"
  } else {
    Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -RunLevel Limited -Force | Out-Null
    Write-Ok "auto-startup at login: disabled — run 'Start-ScheduledTask -TaskName $taskName' to start manually"
  }
}

# Self-heal: existing launch.cmd files from before the lifecycle work omit
# --port / --verbose / --prod. Detect + rewrite in place.
function Repair-LaunchCmd {
  $cmdPath = Join-Path $installDir 'launch.cmd'
  if (-not (Test-Path $cmdPath)) { return }

  $content = Get-Content -Path $cmdPath -Raw
  $needsRewrite = $false

  if ($content -notmatch '--prod') {
    Write-Warn "launch.cmd is missing --prod flag — rewriting"
    $needsRewrite = $true
  }
  if ($content -notmatch '--port') {
    Write-Warn "launch.cmd is missing --port flag — rewriting"
    $needsRewrite = $true
  }

  if (-not $needsRewrite) { return }

  Copy-Item -Path $cmdPath -Destination "$cmdPath.bak.$(Get-Date -Format yyyyMMddHHmmss)" -Force
  $nodeBin = (Get-Command node).Source
  $cmdLines = @('@echo off', "cd /d `"$installDir`"")
  $cmdLines += "`"$nodeBin`" `"$activeFile`" serve --port $port --verbose --prod"
  Set-Content -Path $cmdPath -Value $cmdLines -Encoding Ascii
  Write-Ok "launch.cmd healed (backup saved alongside)"
}

function Invoke-KillStalePort {
  param([int]$Port = 8766)
  # netstat -ano lists listening sockets; parse the owning PID and kill it so the
  # new task can bind cleanly (Stop-ScheduledTask doesn't kill orphaned node processes).
  $lines = netstat -ano 2>$null | Select-String ":$Port\s"
  foreach ($line in $lines) {
    $parts = ($line.ToString().Trim() -split '\s+')
    $pidStr = $parts[-1]
    if ($pidStr -match '^\d+$' -and [int]$pidStr -ne 0) {
      Write-Warn "killing stale process PID $pidStr on port $Port"
      Stop-Process -Id ([int]$pidStr) -Force -ErrorAction SilentlyContinue
    }
  }
  if ($lines) { Start-Sleep -Milliseconds 300 }
}

function Invoke-Kickstart {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Warn "scheduled task '$taskName' not found — run 'pwsh scripts/deploy.ps1 setup' to initialize"
    return
  }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Invoke-KillStalePort -Port 8766
  Start-ScheduledTask -TaskName $taskName
}

function Invoke-Healthcheck {
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -ErrorAction Stop
      Write-Ok "healthcheck passed: $resp"
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  Write-Err "healthcheck failed after 15s ($healthUrl)"
  Write-Warn "last 20 lines of stderr log:"
  $errLog = Join-Path $env:TEMP 'threadbase.err'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 }
  exit 1
}

function Invoke-Status {
  Write-Host "Active release:" -ForegroundColor White
  if (Test-Path $activeFile) {
    $info = Get-Item $activeFile
    Write-Host ("  {0} ({1:N0} bytes, {2})" -f $activeFile, $info.Length, $info.LastWriteTime)
  } else {
    Write-Host "  (none)"
  }

  Write-Host "`nScheduled task:" -ForegroundColor White
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "  state=$($task.State) lastRun=$($info.LastRunTime) lastResult=$($info.LastTaskResult)"
  } else {
    Write-Host "  (not registered)"
  }

  Write-Host "`nRecent releases:" -ForegroundColor White
  if (Test-Path $releasesDir) {
    Get-ChildItem $releasesDir -Filter 'cli.*.cjs' |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First $keepReleases |
      ForEach-Object { Write-Host "  $($_.LastWriteTime)  $($_.Name)" }
  } else {
    Write-Host "  (no releases dir yet)"
  }

  if (Test-Path $historyFile) {
    Write-Host "`nActivation history (latest 5):" -ForegroundColor White
    Get-Content $historyFile -Tail 5 | ForEach-Object { Write-Host "  $_" }
  }
}

function Invoke-Activate {
  param([string]$RelFilename)
  $relPath = "releases\$RelFilename"
  $src = Join-Path $installDir $relPath
  $tmp = "$activeFile.new"

  Copy-Item -Path $src -Destination $tmp -Force
  Move-Item -Path $tmp -Destination $activeFile -Force

  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -Path $historyFile -Value "$stamp $relPath"
}

function Invoke-Rollback {
  if (-not (Test-Path $historyFile)) {
    Write-Err "no history file at $historyFile — nothing to roll back to"
    exit 1
  }

  $currentTarget = ''
  if (Test-Path $activeFile) {
    $lastEntry = Get-Content $historyFile -Tail 1
    if ($lastEntry) { $currentTarget = ($lastEntry -split ' ', 2)[1] }
  }

  $prev = $null
  Get-Content $historyFile | ForEach-Object {
    $parts = $_ -split ' ', 2
    if ($parts.Length -eq 2 -and $parts[1] -ne $currentTarget) {
      $prev = $parts[1]
    }
  }

  if (-not $prev) {
    Write-Err "no prior release found in history (current: $currentTarget)"
    exit 1
  }

  $prevPath = Join-Path $installDir $prev
  if (-not (Test-Path $prevPath)) {
    Write-Err "previous release file missing: $prevPath"
    exit 1
  }

  Write-Log "rolling back to $prev"
  $relFilename = Split-Path -Leaf $prev
  Invoke-Activate -RelFilename $relFilename
  Invoke-Kickstart
  Invoke-Healthcheck
}

function Invoke-CheckBrowseRoot {
  $yaml = Join-Path $installDir 'server.yaml'
  $current = $null

  if (Test-Path $yaml) {
    $line = Get-Content $yaml | Where-Object { $_ -match '^browse_root:\s*\S' } | Select-Object -First 1
    if ($line) { $current = ($line -replace '^browse_root:\s*', '').Trim() }
  }

  if ($current -and (Test-Path $current -PathType Container)) { return }

  if ($current) {
    Write-Warn "browse_root is configured but the directory does not exist: $current"
  } else {
    Write-Log "browse_root is not set in $yaml"
    Write-Host "  The browse root lets the mobile app navigate your filesystem."
    Write-Host "  Set it to any directory you want to expose (e.g. C:\Users\you\dev)."
  }

  do {
    $raw   = (Read-Host "  Enter browse root path").Trim()
    $input = $raw -replace '^~', $env:USERPROFILE
    if (-not $input) { Write-Warn "Path cannot be empty."; continue }
    if (-not (Test-Path $input -PathType Container)) {
      Write-Warn "Directory does not exist: $input"
      $yn = (Read-Host "  Create it? [y/N]").Trim()
      if ($yn -notin @('y', 'Y')) { continue }
      New-Item -ItemType Directory -Path $input -Force | Out-Null
    }
    break
  } while ($true)

  if (-not (Test-Path $yaml)) {
    Set-Content -Path $yaml -Value "browse_root: $input" -Encoding Ascii
  } elseif (Get-Content $yaml | Where-Object { $_ -match '^browse_root:' }) {
    $lines = (Get-Content $yaml) | ForEach-Object {
      if ($_ -match '^browse_root:') { "browse_root: $input" } else { $_ }
    }
    Set-Content -Path $yaml -Value $lines -Encoding Ascii
  } else {
    Add-Content -Path $yaml -Value "browse_root: $input" -Encoding Ascii
  }
  Write-Ok "browse_root set to: $input"
}

function Ensure-ScannerSubmodule {
  # @threadbase/scanner is a git submodule consumed via file:vendor/scanner and
  # bundled inline by tsup. Its source must be checked out and its dist/ built
  # before lint (tsc) and build (tsup) run. Mirrors Ensure-MenubarDeployed.
  if (-not (Test-Path 'vendor/scanner/package.json')) {
    Write-Log "initializing vendor/scanner submodule"
    Invoke-Native git @('submodule', 'update', '--init', '--recursive', 'vendor/scanner')
  }
  if (-not (Test-Path 'vendor/scanner/dist/index.cjs')) {
    Write-Log "building vendor/scanner (dist missing)"
    Invoke-Native npm @('--prefix', 'vendor/scanner', 'install', '--no-audit', '--no-fund')
  }
}

function Invoke-Deploy {
  Invoke-PredeployCheck
  Invoke-CheckBrowseRoot

  Push-Location $repoRoot
  try {
    Ensure-ScannerSubmodule

    if ($Force) {
      Write-Warn "skipping lint + tests (-Force)"
    } else {
      Write-Log "running lint + tests"
      Invoke-Native npm @('run', 'lint')
      Invoke-Native npm @('test')
    }

    Write-Log "building"
    Invoke-Native npm @('run', 'build')

    $sha = (& git rev-parse --short HEAD).Trim()
    if ($Force -and (& git status --porcelain)) {
      $sha = "$sha-dirty-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    }
    $relFilename = "cli.$sha.cjs"

    if (-not (Test-Path $releasesDir)) {
      New-Item -ItemType Directory -Path $releasesDir -Force | Out-Null
    }

    Write-Log "stamping release: $relFilename"
    Copy-Item -Path (Join-Path $repoRoot 'dist\cli.cjs') -Destination (Join-Path $releasesDir $relFilename) -Force
    # On Windows, cli.js is a real file at $installDir so __dirname = $installDir.
    # Copy both migration trees to the install root (not releases/) so the CJS bundle finds them.
    # - migrations/    — SQLite (ConversationCache.open(); always required)
    # - pg-migrations/ — Postgres (only loaded when THREADBASE_DATABASE_URL is set, but the
    #                   migration runner reads the dir at startup and crashes if absent)
    foreach ($mig in @('migrations', 'pg-migrations')) {
      $src = Join-Path $repoRoot "dist\$mig"
      if (Test-Path $src) {
        $dst = Join-Path $installDir $mig
        # Remove first: Copy-Item -Recurse into an existing dir creates
        # a nested $dst\$mig\* AND merges siblings, leaving stale PG files
        # alongside the new SQLite ones. Wipe to guarantee a clean tree.
        if (Test-Path $dst) { Remove-Item -Path $dst -Recurse -Force }
        Copy-Item -Path $src -Destination $dst -Recurse -Force
      }
    }
    # node-pty is external to the tsup bundle (native addon). Copy it from source
    # node_modules so the deployed cli.js can resolve it without a full node_modules tree.
    $nodePtySrc = Join-Path $repoRoot 'node_modules\node-pty'
    if (Test-Path $nodePtySrc) {
      $nodePtyDst = Join-Path $installDir 'node_modules\node-pty'
      New-Item -ItemType Directory -Path (Split-Path $nodePtyDst) -Force | Out-Null
      Copy-Item -Path $nodePtySrc -Destination $nodePtyDst -Recurse -Force
    }
    # better-sqlite3 is external to the tsup bundle (native addon). Copy it and its
    # transitive deps (bindings, file-uri-to-path) from source node_modules.
    foreach ($mod in @('better-sqlite3', 'bindings', 'file-uri-to-path')) {
      $modSrc = Join-Path $repoRoot "node_modules\$mod"
      if (Test-Path $modSrc) {
        $modDst = Join-Path $installDir "node_modules\$mod"
        New-Item -ItemType Directory -Path (Split-Path $modDst) -Force | Out-Null
        Copy-Item -Path $modSrc -Destination $modDst -Recurse -Force
      }
    }

    Write-Log "activating cli.js"
    Invoke-Activate -RelFilename $relFilename

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
      Write-Log "service not registered — running first-time setup"
      Invoke-Setup
    }

    Repair-LaunchCmd

    Write-Log "restarting scheduled task '$taskName'"
    Invoke-Kickstart

    Invoke-Healthcheck

    Write-Log "garbage-collecting old releases (keeping last $keepReleases)"
    Get-ChildItem $releasesDir -Filter 'cli.*.cjs' |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $keepReleases |
      Remove-Item -Force

    Ensure-MenubarDeployed

    # Install (or refresh) the global `threadbase-streamer.cmd` shim. Non-fatal:
    # deploy is already healthy at this point.
    try {
      Install-GlobalShim -CliPath $activeFile
    } catch {
      Write-Warn "global shim install failed (deploy itself is OK): $($_.Exception.Message)"
    }

    Write-Ok "deploy complete: $relFilename"
  } finally {
    Pop-Location
  }
}

switch ($Command) {
  ''            { Invoke-Deploy }
  'deploy'      { Invoke-Deploy }
  'setup'       { Invoke-Setup }
  'rollback'    { Invoke-Rollback }
  'status'      { Invoke-Status }
  'healthcheck' { Invoke-Healthcheck }
}
