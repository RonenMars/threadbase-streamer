#!/usr/bin/env pwsh
# tb — Threadbase Streamer CLI launcher (PowerShell).
# Requires `node` (>=18) on PATH. Override the bundle location with
# $env:THREADBASE_CLI if not using the standard ~\.threadbase\cli.js layout.
$ErrorActionPreference = 'Stop'

$cli = if ($env:THREADBASE_CLI) {
  $env:THREADBASE_CLI
} else {
  Join-Path $env:USERPROFILE '.threadbase\cli.js'
}

if (-not (Test-Path $cli)) {
  Write-Error "tb: CLI bundle not found at $cli. Deploy a release first or set THREADBASE_CLI."
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "tb: 'node' not found on PATH. Install Node.js 18+ from https://nodejs.org"
  exit 1
}

& node $cli @args
exit $LASTEXITCODE
