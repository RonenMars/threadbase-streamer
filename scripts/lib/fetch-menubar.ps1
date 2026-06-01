# fetch-menubar.ps1 — download a pre-built menubar artifact from
# RonenMars/threadbase-menubar GitHub Releases that matches a given submodule
# commit SHA. Dot-sourced from scripts\deploy.ps1.
#
# Exposes:
#   Get-MenubarAsset -Sha <sha> -AssetPattern <wildcard> -OutDir <dir> -LogPath <log>
#     -> on success: returns [pscustomobject]@{ Status='ok'; Path=<file> }
#     -> on miss:    returns [pscustomobject]@{ Status='miss' }
#     -> on error:   returns [pscustomobject]@{ Status='error'; Message=<msg> }
#
#   Write-MenubarFetchError -LogPath <log>
#     -> prints a user-facing error message pointing at the issues tab + log
#
# Uses Invoke-RestMethod and Invoke-WebRequest (no gh / external deps).
# threadbase-menubar is public, so anonymous reads work.

$script:MenubarRepo      = 'RonenMars/threadbase-menubar'
$script:MenubarIssuesUrl = "https://github.com/$script:MenubarRepo/issues"

function _Get-MenubarReleaseSha {
  param(
    [Parameter(Mandatory)] $Release,
    [Parameter(Mandatory)] [string] $LogPath
  )

  $target = [string]$Release.target_commitish
  if ($target -match '^[0-9a-f]{40}$') { return $target }

  $tag = [string]$Release.tag_name
  if (-not $tag) { return '' }

  try {
    $ref = Invoke-RestMethod `
      -Uri "https://api.github.com/repos/$script:MenubarRepo/git/ref/tags/$([uri]::EscapeDataString($tag))" `
      -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'threadbase-streamer-deploy' } `
      -TimeoutSec 15
  } catch {
    Add-Content -Path $LogPath -Value "[fetch-menubar] tag-ref lookup failed for $tag : $($_.Exception.Message)"
    return ''
  }

  if (-not $ref.object) { return '' }

  # Annotated tag → peel one layer to find the commit SHA.
  if ($ref.object.type -eq 'tag') {
    try {
      $peeled = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$script:MenubarRepo/git/tags/$($ref.object.sha)" `
        -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'threadbase-streamer-deploy' } `
        -TimeoutSec 15
      if ($peeled.object) { return [string]$peeled.object.sha }
    } catch {
      Add-Content -Path $LogPath -Value "[fetch-menubar] tag peel failed for $($ref.object.sha) : $($_.Exception.Message)"
      return ''
    }
  }

  return [string]$ref.object.sha
}

function Get-MenubarAsset {
  param(
    [Parameter(Mandatory)] [string] $Sha,
    [Parameter(Mandatory)] [string] $AssetPattern,
    [Parameter(Mandatory)] [string] $OutDir,
    [Parameter(Mandatory)] [string] $LogPath
  )

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  if (-not (Test-Path (Split-Path $LogPath -Parent))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $LogPath -Parent) | Out-Null
  }

  try {
    $releases = Invoke-RestMethod `
      -Uri "https://api.github.com/repos/$script:MenubarRepo/releases?per_page=30" `
      -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'threadbase-streamer-deploy' } `
      -TimeoutSec 15
  } catch {
    $msg = "[fetch-menubar] releases API failed: $($_.Exception.Message)"
    Add-Content -Path $LogPath -Value $msg
    return [pscustomobject]@{ Status='error'; Message=$msg }
  }

  if (-not $releases -or -not ($releases -is [System.Collections.IEnumerable])) {
    $msg = '[fetch-menubar] unexpected releases response shape'
    Add-Content -Path $LogPath -Value $msg
    return [pscustomobject]@{ Status='error'; Message=$msg }
  }

  foreach ($rel in $releases) {
    $relSha = _Get-MenubarReleaseSha -Release $rel -LogPath $LogPath
    if ($relSha -ne $Sha) { continue }

    $asset = $rel.assets | Where-Object { $_.name -like $AssetPattern } | Select-Object -First 1
    if (-not $asset) {
      # Release matched SHA but no asset for this OS. Treat as miss —
      # the next rolling build will pick up the missing artifact.
      $msg = "[fetch-menubar] release $($rel.tag_name) matched SHA but no asset matches $AssetPattern"
      Add-Content -Path $LogPath -Value $msg
      return [pscustomobject]@{ Status='miss'; Message=$msg }
    }

    $target = Join-Path $OutDir $asset.name
    try {
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target `
        -Headers @{ 'User-Agent' = 'threadbase-streamer-deploy' } `
        -UseBasicParsing -TimeoutSec 300 | Out-Null
    } catch {
      $msg = "[fetch-menubar] download failed: $($asset.browser_download_url) : $($_.Exception.Message)"
      Add-Content -Path $LogPath -Value $msg
      Remove-Item -Force -ErrorAction SilentlyContinue $target
      return [pscustomobject]@{ Status='error'; Message=$msg }
    }
    return [pscustomobject]@{ Status='ok'; Path=$target }
  }

  return [pscustomobject]@{ Status='miss' }
}

function Write-MenubarFetchError {
  param([Parameter(Mandatory)] [string] $LogPath)
  Write-Host "! menubar release fetch failed"          -ForegroundColor Yellow
  Write-Host "!   error log: $LogPath"                 -ForegroundColor Yellow
  Write-Host "!   please report at: $script:MenubarIssuesUrl" -ForegroundColor Yellow
  Write-Host "!   (please attach the error log)"       -ForegroundColor Yellow
}
