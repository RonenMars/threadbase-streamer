# install-shim.ps1 — install a global `threadbase-streamer.cmd` that wraps
# the deployed CLI at the path passed by the caller (typically %USERPROFILE%\.threadbase\cli.js).
#
# Dot-sourced from scripts/deploy.ps1. Exposes:
#   Install-GlobalShim -CliPath <abs path>
#
# Non-interactive overrides:
#   $env:TB_INSTALL_SHIM      = standard | user-local | custom | skip
#   $env:TB_PATH_UPDATE       = print | auto | skip
#   $env:TB_CUSTOM_INSTALL_DIR = <abs path>
#
# Persisted state:
#   $env:USERPROFILE\.threadbase\shim.conf  (KEY=value, same format as bash)
#     TB_INSTALL_SHIM=...           — the choice from the first interactive run
#     TB_CUSTOM_INSTALL_DIR=...     — only when TB_INSTALL_SHIM=custom
#   On subsequent deploys this file is read and the prompt is skipped.
#   Delete the file to be re-prompted.
#
# Behavior:
#   1. Load $env:USERPROFILE\.threadbase\shim.conf if present (overlays into
#      $env:TB_INSTALL_SHIM / $env:TB_CUSTOM_INSTALL_DIR when those aren't set).
#   2. Idempotency check: if a threadbase-streamer.cmd is already on PATH and
#      already wraps $CliPath, log + return silently. Catches every redeploy
#      where the install layout hasn't changed.
#   3. Pick install dir (interactive or env/config override).
#      - standard:   $env:LOCALAPPDATA\Programs\threadbase-streamer\bin
#      - user-local: $env:USERPROFILE\.threadbase\bin
#      - custom:     user-supplied
#      - skip:       no-op (persisted, so future deploys stay silent)
#   4. Write threadbase-streamer.cmd shim that invokes `node "<cli-path>" %*`.
#   5. If chosen dir isn't on User PATH, either print the setx command or
#      (with user opt-in) update User PATH via [Environment]::SetEnvironmentVariable.
#   6. Persist the resolved choice back to shim.conf for next run.
#
# Windows can't reliably create symlinks without Developer Mode or admin,
# so we use a .cmd wrapper instead. Same UX from the user's shell.
#
# Soft-fail: never `throw` — return so the caller can keep deploying.

# Re-declare logging helpers if not already defined by the parent script.
if (-not (Get-Command -Name 'Write-Log' -ErrorAction SilentlyContinue)) {
  function Write-Log  { param($m) Write-Host "▶ $m" -ForegroundColor Blue }
}
if (-not (Get-Command -Name 'Write-Warn' -ErrorAction SilentlyContinue)) {
  function Write-Warn { param($m) Write-Host "! $m" -ForegroundColor Yellow }
}
if (-not (Get-Command -Name 'Write-Err' -ErrorAction SilentlyContinue)) {
  function Write-Err  { param($m) Write-Host "✗ $m" -ForegroundColor Red }
}
if (-not (Get-Command -Name 'Write-Ok' -ErrorAction SilentlyContinue)) {
  function Write-Ok   { param($m) Write-Host "✓ $m" -ForegroundColor Green }
}

# Path to the persisted choice file. Honors $env:THREADBASE_INSTALL_DIR.
function Get-ShimConfigPath {
  $base = $env:THREADBASE_INSTALL_DIR
  if (-not $base) { $base = Join-Path $env:USERPROFILE '.threadbase' }
  return Join-Path $base 'shim.conf'
}

# Load persisted choice from shim.conf into $env:TB_INSTALL_SHIM and
# $env:TB_CUSTOM_INSTALL_DIR. Already-set env vars win.
function Import-ShimConfig {
  $cfg = Get-ShimConfigPath
  if (-not (Test-Path $cfg)) { return }
  try {
    $lines = Get-Content -LiteralPath $cfg -ErrorAction Stop
  } catch {
    return
  }
  foreach ($raw in $lines) {
    $line = $raw.Trim()
    if (-not $line)        { continue }
    if ($line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key   = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    switch ($key) {
      'TB_INSTALL_SHIM' {
        if (-not $env:TB_INSTALL_SHIM) { $env:TB_INSTALL_SHIM = $value }
      }
      'TB_CUSTOM_INSTALL_DIR' {
        if (-not $env:TB_CUSTOM_INSTALL_DIR) { $env:TB_CUSTOM_INSTALL_DIR = $value }
      }
    }
  }
}

# Persist resolved choice + (when relevant) the custom dir back to shim.conf.
# Soft-fail: never aborts the caller.
function Save-ShimConfig {
  param(
    [Parameter(Mandatory = $true)] [string] $Choice,
    [string] $InstallDir
  )
  $cfg    = Get-ShimConfigPath
  $parent = Split-Path -Parent $cfg
  if (-not (Test-Path $parent)) {
    try { New-Item -ItemType Directory -Path $parent -Force | Out-Null } catch { return }
  }
  $lines = @(
    '# threadbase-streamer shim install choice - auto-written by scripts/lib/install-shim.ps1',
    '# Delete this file to be re-prompted on the next deploy.',
    "TB_INSTALL_SHIM=$Choice"
  )
  if ($Choice -eq 'custom' -and $InstallDir) {
    $lines += "TB_CUSTOM_INSTALL_DIR=$InstallDir"
  }
  try {
    Set-Content -LiteralPath $cfg -Value $lines -Encoding Ascii
  } catch {
    # Soft-fail — install already succeeded, only the cache write failed.
  }
}

# Command names this script installs. Both wrap the same cli.js.
# `threadbase-streamer` is the entrenched name (docs, auto-update scripts,
# existing user installs); `tb-streamer` is the short alias matching the
# npm package + repo name.
function Get-ShimCommandNames {
  @('threadbase-streamer', 'tb-streamer')
}

# Idempotency check — returns the resolved path of the first matched shim
# only when EVERY installed name has a .cmd on PATH that already wraps the
# given CliPath. Returns $null when any configured name is missing or wraps
# something else. Requiring all names ensures that adding a new shim name to
# Get-ShimCommandNames later causes the next redeploy to install the missing
# siblings, instead of silently keeping only the entrenched name. Mirror of
# _shim_existing_symlink_matches in install-shim.sh.
function Get-MatchingShimPath {
  param([Parameter(Mandatory = $true)] [string] $CliPath)
  $firstMatch = $null
  foreach ($name in (Get-ShimCommandNames)) {
    $existing = (Get-Command $name -ErrorAction SilentlyContinue |
                 Select-Object -First 1 -ExpandProperty Source)
    if (-not $existing) { return $null }
    if (-not (Test-Path -LiteralPath $existing)) { return $null }
    try {
      $body = Get-Content -LiteralPath $existing -Raw -ErrorAction Stop
    } catch {
      return $null
    }
    if (-not $body.Contains($CliPath)) { return $null }
    if (-not $firstMatch) { $firstMatch = $existing }
  }
  return $firstMatch
}

function Get-StandardShimDir {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = Join-Path $env:USERPROFILE 'AppData\Local' }
  return Join-Path $base 'Programs\threadbase-streamer\bin'
}

function Get-UserLocalShimDir {
  return Join-Path $env:USERPROFILE '.threadbase\bin'
}

# Is the given dir present in the User PATH (exact match, case-insensitive)?
function Test-PathContains {
  param([string]$Dir)
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if (-not $userPath) { return $false }
  $entries = $userPath -split ';' | Where-Object { $_ -ne '' }
  foreach ($e in $entries) {
    if ([string]::Equals($e.TrimEnd('\'), $Dir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

# Prompt for install mode. Honors $env:TB_INSTALL_SHIM.
function Get-ShimChoice {
  if ($env:TB_INSTALL_SHIM) { return $env:TB_INSTALL_SHIM }

  # Non-interactive (e.g. piped) → standard with auto-fallback.
  if (-not [Environment]::UserInteractive) { return 'standard' }
  if ($Host.Name -eq 'ServerRemoteHost') { return 'standard' }

  $standardDir = Get-StandardShimDir
  $userDir     = Get-UserLocalShimDir

  Write-Host ""
  Write-Log "Install a global 'threadbase-streamer' command on PATH?"
  Write-Host ("  1) standard      -> {0}   [default]" -f $standardDir)
  Write-Host ("  2) user-local    -> {0}   (no admin)" -f $userDir)
  Write-Host  "  3) custom        -> you pick a directory"
  Write-Host  "  4) skip          -> do not install"
  $ans = Read-Host "  Choice [1-4]"
  switch ($ans) {
    ''  { return 'standard' }
    '1' { return 'standard' }
    '2' { return 'user-local' }
    '3' { return 'custom' }
    '4' { return 'skip' }
    default { return 'standard' }
  }
}

function Get-ShimCustomDir {
  if ($env:TB_CUSTOM_INSTALL_DIR) { return $env:TB_CUSTOM_INSTALL_DIR }
  if (-not [Environment]::UserInteractive) { return $null }
  $raw = Read-Host "  Install dir"
  if (-not $raw) { return $null }
  # Expand a leading ~ manually.
  if ($raw.StartsWith('~')) { $raw = $env:USERPROFILE + $raw.Substring(1) }
  return $raw
}

# Write a single `.cmd` wrapper named $CmdName.cmd. Returns $true on success.
function Write-ShimCmd {
  param(
    [string]$ShimDir,
    [string]$CliPath,
    [string]$CmdName = 'threadbase-streamer'
  )

  if (-not (Test-Path $ShimDir)) {
    try {
      New-Item -ItemType Directory -Path $ShimDir -Force | Out-Null
    } catch {
      Write-Warn "Could not create $ShimDir : $($_.Exception.Message)"
      return $false
    }
  }

  $cmdPath = Join-Path $ShimDir "$CmdName.cmd"
  # The wrapper invokes `node` so any caller resolves the cli script even
  # if file associations for .js aren't wired up.
  $body = @"
@echo off
node "$CliPath" %*
"@
  try {
    Set-Content -Path $cmdPath -Value $body -Encoding Ascii -NoNewline
    return $true
  } catch {
    Write-Warn "Failed to write $cmdPath : $($_.Exception.Message)"
    return $false
  }
}

# Append $Dir to User PATH (idempotent). Returns $true if changed.
function Add-DirToUserPath {
  param([string]$Dir)
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if ($userPath -and (Test-PathContains -Dir $Dir)) {
    Write-Log "PATH entry already present"
    return $false
  }
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $Dir } else { "$userPath;$Dir" }
  try {
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    Write-Ok "Added $Dir to User PATH"
    Write-Log "Open a new terminal for the change to take effect."
    return $true
  } catch {
    Write-Warn "Failed to update User PATH: $($_.Exception.Message)"
    return $false
  }
}

function Show-MissingPath {
  param([string]$Dir)
  $mode = $env:TB_PATH_UPDATE

  Write-Warn "$Dir is not on your User PATH."
  Write-Host "  Run this in PowerShell to add it persistently:"
  Write-Host ("    [Environment]::SetEnvironmentVariable('PATH', `"`$env:PATH;{0}`", 'User')" -f $Dir)

  if (-not $mode) {
    if (-not [Environment]::UserInteractive) {
      $mode = 'print'
    } else {
      $ans = Read-Host "  Add this entry to User PATH now? [y/N]"
      if ($ans -match '^[yY]$') { $mode = 'auto' } else { $mode = 'print' }
    }
  }

  switch ($mode) {
    'auto'  { [void](Add-DirToUserPath -Dir $Dir) }
    default { } # print or skip — already printed the instruction above
  }
}

function Install-GlobalShim {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CliPath
  )

  if (-not (Test-Path $CliPath)) {
    Write-Warn "Install-GlobalShim: $CliPath does not exist yet; skipping shim install"
    return
  }

  # Load persisted choice (file values fill in any TB_* envs the caller didn't
  # set). Must happen before the prompt and before the idempotency check —
  # both consult $env:TB_INSTALL_SHIM.
  Import-ShimConfig

  # Idempotency check: if a working .cmd already wraps $CliPath (either name
  # is sufficient), the install would be a no-op rewrite. Skip and stay quiet.
  # Honor an explicit TB_INSTALL_SHIM=skip — a user who chose 'skip' may want
  # the existing shim removed; don't silently keep using it.
  if ($env:TB_INSTALL_SHIM -ne 'skip') {
    $resolved = Get-MatchingShimPath -CliPath $CliPath
    if ($resolved) {
      Write-Ok "Global shim already installed: $resolved -> $CliPath"
      return
    }
  }

  $choice = Get-ShimChoice
  if ($choice -eq 'skip') {
    Write-Log "Skipping global shim install (delete $(Get-ShimConfigPath) to re-enable the prompt)"
    Save-ShimConfig -Choice 'skip'
    return
  }

  $shimDir = switch ($choice) {
    'standard'   { Get-StandardShimDir }
    'user-local' { Get-UserLocalShimDir }
    'custom'     { Get-ShimCustomDir }
    default      { Get-StandardShimDir }
  }

  if (-not $shimDir) {
    Write-Warn "No install dir provided — skipping shim install."
    return
  }

  $names = Get-ShimCommandNames
  $primary = $names[0]
  Write-Log "Installing shim: $shimDir\$primary.cmd -> $CliPath"

  # Write the primary name; on failure, fall back to user-local and retry.
  $ok = Write-ShimCmd -ShimDir $shimDir -CliPath $CliPath -CmdName $primary
  if (-not $ok -and $choice -ne 'user-local') {
    Write-Warn "Falling back to user-local dir."
    $shimDir = Get-UserLocalShimDir
    $ok = Write-ShimCmd -ShimDir $shimDir -CliPath $CliPath -CmdName $primary
  }
  if (-not $ok) {
    Write-Err "Failed to install shim. Run manually:"
    Write-Host ("    `"$CliPath`" should be wrapped in: {0}\$primary.cmd" -f $shimDir)
    return
  }

  Write-Ok "Installed $primary.cmd in $shimDir"

  # Now write any additional aliases into the same (proven-writable) dir.
  # Soft-fail: a missing alias is a warning at most; primary is already in place.
  for ($i = 1; $i -lt $names.Count; $i++) {
    $alias = $names[$i]
    if (Write-ShimCmd -ShimDir $shimDir -CliPath $CliPath -CmdName $alias) {
      Write-Ok "Installed $alias.cmd in $shimDir"
    } else {
      Write-Warn "Could not write alias $alias.cmd (primary shim is fine)"
    }
  }

  # Persist the resolved choice so future deploys don't re-prompt. We persist
  # even when shimDir came from the user-local fallback — the saved 'choice'
  # captures intent; the next deploy will re-derive the directory.
  Save-ShimConfig -Choice $choice -InstallDir $shimDir

  if (Test-PathContains -Dir $shimDir) {
    Write-Log "$shimDir is on PATH — open a new shell to use '$primary' or '$($names[1])'."
  } else {
    Show-MissingPath -Dir $shimDir
  }
}
