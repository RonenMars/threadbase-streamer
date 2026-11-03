# prune-builds.ps1 -- Windows port of prune-builds.sh (issue #900).
# Dot-sourced from scripts/deploy.ps1, which provides Write-Log/Write-Warn/Write-Err/Write-Dbg.
#
# One owner per machine: keeps $Keep deploy builds (the active one plus rollback
# targets) and removes the updater's staging trees. Deletes ONLY:
#   <install>\current
#   <install>\releases\cli.*.cjs and cli.*.cjs.version   deploy artifacts
#   <install>\releases\<semver>                          updater trees
#   <install>\releases\.tmp\*.tgz                        updater downloads
# Never cache.db, runtime.db, server.yaml, logs, node_modules, .history, releases\menubar.
#
# Windows differs from POSIX: cli.js is a COPY of the active artifact, so a
# running host never executes releases\cli.*.cjs and those are rollback-only.
# Natives live in the shared <install>\node_modules, which is never pruned.
# What a live pty-host can still hold is the updater layout (current\ or
# releases\<semver>\), so those are protected by the host's loaded modules; if
# they cannot be read, updater trees are kept. Windows also refuses to delete a
# mapped file, so each removal is caught per item and never fails the deploy.
#
# NOT executed on Windows when written: reviewed and parsed with pwsh on macOS only.

function Test-PruneRootOk {
  param([string]$Path)
  if (-not $Path -or -not [System.IO.Path]::IsPathRooted($Path)) { return $false }
  if ($Path -match '(^|[\\/])\.\.([\\/]|$)') { return $false }
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
  if (-not $full -or $full -eq $root) { return $false }
  # Drive root, a top-level folder ("C:\Users"), or the user profile itself.
  $depth = ($full.Substring($root.Length).Trim('\', '/') -split '[\\/]').Count
  if ($depth -lt 2) { return $false }
  if ($env:USERPROFILE -and $full -ieq $env:USERPROFILE.TrimEnd('\', '/')) { return $false }
  return $true
}

# The only deletion primitive. Target must be <install>\current, or one name
# under <install>\releases (cli.*, a semver) or <install>\releases\.tmp (*.tgz).
function Remove-PruneTarget {
  param([string]$Install, [string]$Target)
  if (-not $Install -or -not $Target) { return $false }
  $prefix = $Install.TrimEnd('\') + '\'
  if (-not $Target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  $rel = $Target.Substring($prefix.Length)
  $ok = $false
  if ($rel -ieq 'current') { $ok = $true }
  elseif ($rel -imatch '^releases\\\.tmp\\[^\\]+\.tgz$') { $ok = $true }
  elseif ($rel -imatch '^releases\\(cli\.[^\\]+|\d+\.\d+\.\d+([-+][^\\]*)?)$') { $ok = $true }
  if (-not $ok) { return $false }
  try {
    $item = Get-Item -LiteralPath $Target -Force -ErrorAction Stop
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      # A link: unlink only, never recurse into what it points at.
      if ($item.PSIsContainer) { [System.IO.Directory]::Delete($Target, $false) } else { [System.IO.File]::Delete($Target) }
    } else {
      Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
    }
    return $true
  } catch {
    Write-Warn "could not remove ${Target}: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-PruneBuilds {
  param([string]$Install, [int]$Keep = 2)

  if ($Keep -lt 1) { Write-Err "refusing to prune: bad keep count '$Keep'"; return }
  if (-not (Test-PruneRootOk $Install)) { Write-Err "refusing to prune: '$Install' is not a usable install dir"; return }
  if (Test-Path -LiteralPath $Install -PathType Leaf) { Write-Err "refusing to prune: '$Install' is not a directory"; return }
  $releases = Join-Path $Install 'releases'
  if (-not (Test-Path -LiteralPath $releases -PathType Container)) { return }

  # Active build: the newest history entry (cli.js is a copy, so history is the record).
  $historyFile = Join-Path $releases '.history'
  $entries = @()
  if (Test-Path -LiteralPath $historyFile) {
    $entries = @(Get-Content -LiteralPath $historyFile | ForEach-Object {
      $parts = $_ -split ' ', 2
      if ($parts.Length -eq 2 -and $parts[1]) { Split-Path -Leaf $parts[1] }
    })
  }
  if ($entries.Count -eq 0) {
    Write-Warn "no activation history in $releases, so no build is pruned"
    return
  }
  $active = $entries[-1]

  # Active + (Keep - 1) rollback targets: newest history entries that are not
  # the active build (what Invoke-Rollback picks), then newest by LastWriteTime.
  $protected = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  [void]$protected.Add($active)
  for ($i = $entries.Count - 1; $i -ge 0 -and $protected.Count -lt $Keep; $i--) {
    $e = $entries[$i]
    if ($e -like 'cli.*' -and (Test-Path -LiteralPath (Join-Path $releases $e))) { [void]$protected.Add($e) }
  }
  Get-ChildItem -LiteralPath $releases -Filter 'cli.*.cjs' -File | Sort-Object LastWriteTime -Descending | ForEach-Object {
    if ($protected.Count -lt $Keep) { [void]$protected.Add($_.Name) }
  }

  # Updater layout: protect trees a live pty-host has loaded modules from.
  # Unreadable modules mean we cannot tell, so updater trees are kept.
  $keepUpdater = $false
  $hosts = @()
  try {
    $hosts = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -match 'pty-host\s+--socket' -and $_.CommandLine.IndexOf($Install, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
  } catch {
    $keepUpdater = $true
    Write-Warn "cannot list pty-hosts, so updater trees are kept: $($_.Exception.Message)"
  }
  $currentProtected = $false
  foreach ($h in $hosts) {
    try {
      $mods = @((Get-Process -Id $h.ProcessId -ErrorAction Stop).Modules | ForEach-Object { $_.FileName })
    } catch {
      $keepUpdater = $true
      Write-Warn "pty-host $($h.ProcessId): cannot read its modules, so updater trees are kept"
      continue
    }
    foreach ($m in $mods) {
      if ($m.StartsWith((Join-Path $Install 'current') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $currentProtected = $true
        Write-Log "pty-host $($h.ProcessId) still runs from current\: keeping it"
      } elseif ($m -imatch [regex]::Escape($releases) + '\\(\d+\.\d+\.\d+[^\\]*)\\') {
        [void]$protected.Add($Matches[1])
        Write-Log "pty-host $($h.ProcessId) still runs $($Matches[1]): keeping it"
      }
    }
  }

  foreach ($f in @(Get-ChildItem -LiteralPath $releases -Filter 'cli.*' -Force)) {
    if ($f.Name -like '*.version') { continue }
    if ($protected.Contains($f.Name)) { continue }
    if (Remove-PruneTarget $Install $f.FullName) {
      $sidecar = "$($f.FullName).version"
      if (Test-Path -LiteralPath $sidecar) { [void](Remove-PruneTarget $Install $sidecar) }
      Write-Dbg "pruned build $($f.Name)"
    }
  }

  if (-not $keepUpdater) {
    foreach ($d in @(Get-ChildItem -LiteralPath $releases -Directory -Force | Where-Object { $_.Name -match '^\d+\.\d+\.\d+' })) {
      if ($protected.Contains($d.Name)) { continue }
      if (Remove-PruneTarget $Install $d.FullName) { Write-Dbg "pruned updater tree $($d.Name)" }
    }
    $tmpDir = Join-Path $releases '.tmp'
    if (Test-Path -LiteralPath $tmpDir) {
      foreach ($t in @(Get-ChildItem -LiteralPath $tmpDir -Filter '*.tgz' -File -Force)) {
        [void](Remove-PruneTarget $Install $t.FullName)
      }
    }
    $current = Join-Path $Install 'current'
    if ((Test-Path -LiteralPath $current) -and -not $currentProtected) {
      [void](Remove-PruneTarget $Install $current)
    }
  }
}

# Warn once when update.yaml still lets the updater own this machine.
function Test-AutoUpdateEnabled {
  param([string]$Install)
  $yaml = Join-Path $Install 'update.yaml'
  if (-not (Test-Path -LiteralPath $yaml)) { return }
  if (Select-String -LiteralPath $yaml -Pattern '^\s*auto_update:\s*true(\s|#|$)' -Quiet) {
    Write-Warn "auto_update is true in $yaml, but deploy.ps1 owns this machine: set auto_update: false there, or the updater and the deploy script will fight over the install"
  }
}
