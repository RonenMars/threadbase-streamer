#!/usr/bin/env pwsh
# Deploy/rollback/status helper for the Windows (Task Scheduler) threadbase-streamer.
# Mirrors scripts/deploy.sh; differences: no symlinks (uses atomic Move-Item),
# service restart goes through Task Scheduler instead of launchctl/systemd.
#
# Usage:
#   pwsh scripts/deploy.ps1                    # build + deploy
#   pwsh scripts/deploy.ps1 -Force             # skip lint/test gates and dirty-tree check
#   pwsh scripts/deploy.ps1 -UpdateScanner     # bump vendor/scanner pin first
#   pwsh scripts/deploy.ps1 rollback           # repoint cli.js to the previous release
#   pwsh scripts/deploy.ps1 status             # show current release and task status
#   pwsh scripts/deploy.ps1 healthcheck        # probe /healthz
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
  [ValidateSet('deploy', 'rollback', 'status', 'healthcheck', '')]
  [string]$Command = 'deploy',

  [switch]$Force,
  [switch]$UpdateScanner
)

$ErrorActionPreference = 'Stop'

$repoRoot     = Split-Path -Parent $PSScriptRoot
$installDir   = if ($env:THREADBASE_INSTALL_DIR) { $env:THREADBASE_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.threadbase' }
$releasesDir  = Join-Path $installDir 'releases'
$historyFile  = Join-Path $releasesDir '.history'
$activeFile   = Join-Path $installDir 'cli.js'
$taskName     = if ($env:THREADBASE_TASK_NAME) { $env:THREADBASE_TASK_NAME } else { 'Threadbase' }
$healthUrl    = if ($env:THREADBASE_HEALTH_URL) { $env:THREADBASE_HEALTH_URL } else { 'http://localhost:8766/healthz' }
$keepReleases = 5

$scannerDir = Join-Path $repoRoot 'vendor\scanner'

function Write-Log  { param($m) Write-Host "▶ $m" -ForegroundColor Blue }
function Write-Warn { param($m) Write-Host "! $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "✗ $m" -ForegroundColor Red }
function Write-Ok   { param($m) Write-Host "✓ $m" -ForegroundColor Green }

function Invoke-Native {
  param([string]$Command, [string[]]$ArgList)
  & $Command @ArgList
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with code $LASTEXITCODE"
  }
}

function Ensure-ScannerBuilt {
  param([bool]$UpdateRemote)

  Push-Location $repoRoot
  try {
    if (-not (Test-Path (Join-Path $scannerDir 'package.json'))) {
      Write-Log "initializing vendor/scanner submodule"
      Invoke-Native git @('submodule', 'update', '--init', '--recursive', 'vendor/scanner')
    }

    if ($UpdateRemote) {
      Write-Log "bumping vendor/scanner to remote main"
      Invoke-Native git @('submodule', 'update', '--remote', 'vendor/scanner')
      $porcelain = & git status --porcelain vendor/scanner
      if ($porcelain) {
        Push-Location $scannerDir
        $newSha = (& git rev-parse --short HEAD).Trim()
        Pop-Location
        Write-Warn "scanner pin moved to $newSha — remember to commit the .gitmodules/vendor/scanner bump"
      }
    }

    $needBuild = $false
    $distDir = Join-Path $scannerDir 'dist'
    if (-not (Test-Path $distDir)) {
      $needBuild = $true
    } else {
      $distMTime = (Get-Item $distDir).LastWriteTime
      $newest = Get-ChildItem -Recurse -File (Join-Path $scannerDir 'src') |
                Where-Object { $_.LastWriteTime -gt $distMTime } |
                Select-Object -First 1
      if ($newest) { $needBuild = $true }
    }

    if ($needBuild) {
      Write-Log "building scanner submodule"
      Push-Location $scannerDir
      try {
        Invoke-Native npm @('install', '--silent')
        Invoke-Native npm @('run', 'build')
      } finally {
        Pop-Location
      }
    }
  } finally {
    Pop-Location
  }
}

function Invoke-PredeployCheck {
  Push-Location $repoRoot
  try {
    $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    $dirty  = (& git status --porcelain) -ne $null -and (& git status --porcelain).Length -gt 0

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

function Invoke-Kickstart {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Warn "scheduled task '$taskName' not found; the local-deploy skill installs it on fresh setup"
    return
  }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
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

function Invoke-Deploy {
  Invoke-PredeployCheck
  Invoke-CheckBrowseRoot

  Ensure-ScannerBuilt -UpdateRemote:$UpdateScanner

  Push-Location $repoRoot
  try {
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
    # Copy migrations to the install root (not releases/) so the CJS bundle finds them.
    $migrationsrc = Join-Path $repoRoot 'dist\migrations'
    if (Test-Path $migrationsrc) {
      Copy-Item -Path $migrationsrc -Destination (Join-Path $installDir 'migrations') -Recurse -Force
    }

    Write-Log "activating cli.js"
    Invoke-Activate -RelFilename $relFilename

    Write-Log "restarting scheduled task '$taskName'"
    Invoke-Kickstart

    Invoke-Healthcheck

    Write-Log "garbage-collecting old releases (keeping last $keepReleases)"
    Get-ChildItem $releasesDir -Filter 'cli.*.cjs' |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $keepReleases |
      Remove-Item -Force

    Write-Ok "deploy complete: $relFilename"
  } finally {
    Pop-Location
  }
}

switch ($Command) {
  ''            { Invoke-Deploy }
  'deploy'      { Invoke-Deploy }
  'rollback'    { Invoke-Rollback }
  'status'      { Invoke-Status }
  'healthcheck' { Invoke-Healthcheck }
}
