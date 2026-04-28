@echo off
REM tb — Threadbase Streamer CLI launcher (Windows CMD).
REM Requires `node` (>=18) on PATH. Override the bundle location with
REM THREADBASE_CLI if not using the standard ~/.threadbase/cli.js layout.
setlocal

if not defined THREADBASE_CLI set "THREADBASE_CLI=%USERPROFILE%\.threadbase\cli.js"

if not exist "%THREADBASE_CLI%" (
  echo tb: CLI bundle not found at %THREADBASE_CLI% 1>&2
  echo tb: deploy a release first or set THREADBASE_CLI. 1>&2
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo tb: 'node' not found on PATH 1>&2
  echo tb: install Node.js 18+ from https://nodejs.org 1>&2
  exit /b 1
)

node "%THREADBASE_CLI%" %*
