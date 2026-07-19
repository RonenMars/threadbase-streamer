#!/usr/bin/env pwsh
# install-tb.ps1 — copy the `tb` shims into a per-user directory and add it
# to the user PATH.
#
# DEPRECATED. Prefer the auto-installed global commands.
# `pwsh scripts/deploy.ps1` now installs `tb-streamer.cmd` and
# `threadbase-streamer.cmd` on PATH automatically — no separate installer
# needed. See CLAUDE.md → "Global `threadbase-streamer` / `tb-streamer`
# command". This script keeps working for users who want `tb` specifically,
# or who rely on the $env:THREADBASE_CLI override in bin/tb.ps1.
#
# Idempotent. Default install dir:
# %USERPROFILE%\.threadbase\bin (override with $env:TB_INSTALL_DIR).
$ErrorActionPreference = 'Stop'

# Timestamped, leveled logging. Every line carries an ISO-8601 local timestamp
# and a level word.
function _LogTs { (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
function _LogLine {
  param($Level, $Color, $Message)
  Write-Host ("{0} {1,-5} [install-tb] {2}" -f (_LogTs), $Level, $Message) -ForegroundColor $Color
}
function Write-Info { param($m) _LogLine 'INFO' 'Cyan'   $m }
function Write-Warn { param($m) _LogLine 'WARN' 'Yellow' $m }

$repoRoot = Split-Path -Parent $PSScriptRoot
$installDir = if ($env:TB_INSTALL_DIR) {
  $env:TB_INSTALL_DIR
} else {
  Join-Path $env:USERPROFILE '.threadbase\bin'
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$shims = @('tb', 'tb.cmd', 'tb.ps1')
foreach ($shim in $shims) {
  $src = Join-Path $repoRoot "bin\$shim"
  if (-not (Test-Path $src)) {
    Write-Warn "skipping ${shim}: not found at $src"
    continue
  }
  $dest = Join-Path $installDir $shim
  Copy-Item -Path $src -Destination $dest -Force
  Write-Info "installed: $dest"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $false
if ($userPath) {
  foreach ($entry in $userPath -split ';') {
    if ($entry -and ($entry.TrimEnd('\') -ieq $installDir.TrimEnd('\'))) {
      $onPath = $true
      break
    }
  }
}

if (-not $onPath) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$installDir;$userPath" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Info "added $installDir to user PATH. Open a new terminal to pick it up."
} else {
  Write-Info "$installDir is already in user PATH."
}
