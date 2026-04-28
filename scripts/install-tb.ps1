#!/usr/bin/env pwsh
# install-tb.ps1 — copy the `tb` shims into a per-user directory and add it
# to the user PATH. Idempotent. Default install dir:
# %USERPROFILE%\.threadbase\bin (override with $env:TB_INSTALL_DIR).
$ErrorActionPreference = 'Stop'

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
    Write-Warning "Skipping ${shim}: not found at $src"
    continue
  }
  $dest = Join-Path $installDir $shim
  Copy-Item -Path $src -Destination $dest -Force
  Write-Host "Installed: $dest"
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
  Write-Host "Added $installDir to user PATH. Open a new terminal to pick it up."
} else {
  Write-Host "$installDir is already in user PATH."
}
