# Installs a second scheduled task — separate from the streamer service itself —
# that runs `threadbase-streamer update` every poll_interval_minutes. Reads
# the interval from %USERPROFILE%\.threadbase\update.yaml. Skips installation
# when update.yaml is missing or auto_update:false.
#
# Idempotent: rerun safely after `scripts/deploy.ps1 setup` to wire up
# auto-update on an already-deployed streamer.
#
# Usage:
#   scripts/install-auto-update.ps1            # install or refresh
#   scripts/install-auto-update.ps1 uninstall  # remove the auto-update task only
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string]$Command = "install"
)

$ErrorActionPreference = "Stop"

$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:USERPROFILE ".threadbase" }
$ActiveLinkCurrent = Join-Path $InstallDir "current\dist\cli.cjs"
$ActiveLinkShim    = Join-Path $InstallDir "cli.js"
$ActiveLink = if (Test-Path -LiteralPath $ActiveLinkCurrent) { $ActiveLinkCurrent } else { $ActiveLinkShim }
$UpdateYaml = Join-Path $InstallDir "update.yaml"
$TaskName = if ($env:THREADBASE_UPDATER_TASK_NAME) { $env:THREADBASE_UPDATER_TASK_NAME } else { "Threadbase-Updater" }

function Read-YamlField {
  param([string]$Key, [string]$Default = "")
  if (-not (Test-Path -LiteralPath $UpdateYaml)) { return $Default }
  $line = Get-Content -LiteralPath $UpdateYaml | Where-Object { $_ -match "^\s*${Key}\s*:\s*(.+)\s*$" } | Select-Object -First 1
  if (-not $line) { return $Default }
  if ($line -match "^\s*${Key}\s*:\s*(.+)\s*$") {
    return ($Matches[1] -replace '["'']', '').Trim()
  }
  return $Default
}

# Leveled, timestamped logging tagged [auto-update]. Every line carries an
# ISO-8601 local timestamp and a level word. Set LOG_LEVEL=debug to surface
# debug lines (default: info).
$script:LogLevel = if ($env:LOG_LEVEL) { $env:LOG_LEVEL } else { 'info' }
function _LogTs { (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
function _LogLine {
  param($Level, $Color, $Message)
  Write-Host ("{0} {1,-5} [auto-update] {2}" -f (_LogTs), $Level, $Message) -ForegroundColor $Color
}
function Write-Dbg  { if ($script:LogLevel -eq 'debug') { _LogLine 'DEBUG' 'DarkGray' "$args" } }
function Write-Info { _LogLine 'INFO'  'Cyan'   "$args" }
function Write-Log  { _LogLine 'INFO'  'Cyan'   "$args" }
function Write-Warn { _LogLine 'WARN'  'Yellow' "$args" }
function Write-Err  { _LogLine 'ERROR' 'Red'    "$args" }

if ($Command -eq "uninstall") {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Log "auto-update task removed ($TaskName)"
  } else {
    Write-Log "task $TaskName not registered; nothing to do"
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $UpdateYaml)) {
  Write-Warn "no $UpdateYaml - create one with at least 'github_repo: owner/name' and 'auto_update: true' to enable auto-update"
  exit 0
}

$autoUpdate = Read-YamlField -Key "auto_update" -Default "false"
if ($autoUpdate -ne "true") {
  Write-Log "auto_update is not 'true' in $UpdateYaml; not installing the scheduled task"
  Write-Log "set 'auto_update: true' and rerun to enable"
  exit 0
}

$intervalRaw = Read-YamlField -Key "poll_interval_minutes" -Default "60"
$intervalMin = 0
if (-not [int]::TryParse($intervalRaw, [ref]$intervalMin) -or $intervalMin -lt 1) {
  Write-Err "invalid poll_interval_minutes: $intervalRaw"
  exit 1
}

if (-not (Test-Path -LiteralPath $ActiveLink)) {
  Write-Err "streamer not deployed at $ActiveLink - run scripts/deploy.ps1 setup first"
  exit 1
}

$nodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeBin) {
  Write-Err "node not found in PATH"
  exit 1
}

$logDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "updater.log"
$errFile = Join-Path $logDir "updater.err"

# Task Scheduler has no native stdout/stderr redirection. We invoke pwsh and
# do the redirection inside the command string (same trick the streamer deploy
# uses). Single-quote the inner command to defeat re-expansion.
$cmdString = "& '$nodeBin' '$ActiveLink' update *>> '$logFile' 2>> '$errFile'"
$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument "-NoProfile -Command `"$cmdString`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $intervalMin)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMinutes(30)) `
  -StartWhenAvailable -DontStopOnIdleEnd -MultipleInstances IgnoreNew

# Drop any prior registration so we can re-register cleanly.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
Write-Log "installed scheduled task $TaskName - fires every $intervalMin min"
