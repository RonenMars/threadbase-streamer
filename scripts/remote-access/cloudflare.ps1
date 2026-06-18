#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Cloudflare quick-tunnel onboarding for @threadbase-sh/streamer.

.DESCRIPTION
  Cross-platform peer of cloudflare.sh. Runs on Windows native (Windows
  PowerShell or pwsh 7+) and on macOS/Linux via pwsh.

  Steps:
    1. Verify cloudflared is installed; if not, print platform-correct install
       hint and exit non-zero.
    2. Pick a free local port and start a throwaway HTTP server serving
       success.html (System.Net.HttpListener — no dependency on python/nc).
    3. Start `cloudflared tunnel --url http://127.0.0.1:<that-port>`.
    4. Parse the *.trycloudflare.com URL out of cloudflared's stdout/stderr.
    5. Prompt the user; tear down cleanly on confirmation, Ctrl-C, or error.

  Emits the same line-prefixed protocol on stdout as cloudflare.sh so the
  Go TUI wrapper can drive either implementation:
    STATUS: <human-readable step>
    URL:    <trycloudflare URL>
    PROMPT: <yes/no question>
    DONE:   <ok|aborted|error>
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Protocol helpers
# ---------------------------------------------------------------------------

function Emit-Status([string]$Message) { Write-Output "STATUS: $Message" }
function Emit-Url([string]$Url)        { Write-Output "URL: $Url" }
function Emit-Prompt([string]$Message) { Write-Output "PROMPT: $Message" }
function Emit-Done([string]$Result)    { Write-Output "DONE: $Result" }
function Emit-Err([string]$Message)    { [Console]::Error.WriteLine("STATUS: ERROR: $Message") }

# ---------------------------------------------------------------------------
# State used by cleanup
# ---------------------------------------------------------------------------

$script:TunnelProcess = $null
$script:HttpListener  = $null
$script:HttpRunspace  = $null
$script:HttpPs        = $null
$script:TunnelLog     = $null
$script:TunnelErrLog  = $null

function Invoke-Cleanup {
  if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
    Emit-Status "stopping cloudflared (pid $($script:TunnelProcess.Id))"
    try { $script:TunnelProcess.Kill() } catch { }
    try { $script:TunnelProcess.WaitForExit(2000) | Out-Null } catch { }
  }
  if ($script:HttpListener) {
    Emit-Status "stopping success-page server"
    try { $script:HttpListener.Stop() }  catch { }
    try { $script:HttpListener.Close() } catch { }
  }
  if ($script:HttpPs) {
    try { $script:HttpPs.Stop() }    catch { }
    try { $script:HttpPs.Dispose() } catch { }
  }
  if ($script:HttpRunspace) {
    try { $script:HttpRunspace.Close() }   catch { }
    try { $script:HttpRunspace.Dispose() } catch { }
  }
  foreach ($p in @($script:TunnelLog, $script:TunnelErrLog)) {
    if ($p -and (Test-Path $p)) {
      try { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue } catch { }
    }
  }
}

# Ctrl-C handler — PowerShell's [Console]::CancelKeyPress is the cleanest
# cross-platform option. Set early so we always tear down.
[Console]::TreatControlCAsInput = $false
$null = Register-EngineEvent PowerShell.Exiting -Action { Invoke-Cleanup } | Out-Null

# ---------------------------------------------------------------------------
# 1. Dependency check
# ---------------------------------------------------------------------------

Emit-Status "checking cloudflared is installed"

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  Emit-Err "cloudflared not found on PATH"
  $hint = @"

cloudflared is the Cloudflare Tunnel client. Install it, then re-run this script.

  Windows:   winget install --id Cloudflare.cloudflared
  macOS:     brew install cloudflared
  Linux:     see https://pkg.cloudflare.com/cloudflared/ (apt/dnf repos)

"@
  [Console]::Error.Write($hint)
  Emit-Done 'error'
  exit 1
}

$cloudflaredVersion = (& cloudflared --version 2>&1 | Select-Object -First 1)
Emit-Status "cloudflared found: $cloudflaredVersion"

# ---------------------------------------------------------------------------
# 2. Pick a free local port
# ---------------------------------------------------------------------------

function Get-FreePort {
  # Use the OS to pick any free port — most reliable on all platforms.
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
}

try {
  $httpPort = Get-FreePort
} catch {
  Emit-Err "couldn't find a free local port: $_"
  Emit-Done 'error'
  exit 1
}
Emit-Status "success page will be served on http://127.0.0.1:$httpPort"

# ---------------------------------------------------------------------------
# 3. Start the success-page HTTP server (HttpListener in a background runspace)
# ---------------------------------------------------------------------------

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$successHtml = Join-Path $scriptDir 'success.html'

if (-not (Test-Path $successHtml)) {
  Emit-Err "success.html missing at $successHtml"
  Emit-Done 'error'
  exit 1
}

$htmlBody = Get-Content -LiteralPath $successHtml -Raw

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$httpPort/")
try {
  $listener.Start()
} catch {
  Emit-Err "HttpListener failed to start on port ${httpPort}: $_"
  Emit-Done 'error'
  exit 1
}
$script:HttpListener = $listener

# Run the accept loop in a background runspace so the main script keeps going.
$runspace = [runspacefactory]::CreateRunspace()
$runspace.Open()
$ps = [powershell]::Create()
$ps.Runspace = $runspace
$null = $ps.AddScript({
  param($listener, $html)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
  while ($listener.IsListening) {
    try {
      $ctx = $listener.GetContext()
    } catch {
      break
    }
    try {
      $ctx.Response.ContentType   = 'text/html; charset=utf-8'
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch { }
    finally {
      try { $ctx.Response.Close() } catch { }
    }
  }
}).AddArgument($listener).AddArgument($htmlBody)
$null = $ps.BeginInvoke()
$script:HttpRunspace = $runspace
$script:HttpPs       = $ps

# Smoke-test the server is up
$probeOk = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$httpPort/" -UseBasicParsing -TimeoutSec 1
    $probeOk = $true
    break
  } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $probeOk) {
  Emit-Err "success-page server failed to start on port $httpPort"
  Invoke-Cleanup
  Emit-Done 'error'
  exit 1
}

# ---------------------------------------------------------------------------
# 4. Launch cloudflared quick-tunnel
# ---------------------------------------------------------------------------

$tempBase            = [System.IO.Path]::GetTempPath()
$logGuid             = [System.Guid]::NewGuid().ToString('N')
$script:TunnelLog    = [System.IO.Path]::Combine($tempBase, "threadbase-cloudflared-$logGuid.out.log")
$script:TunnelErrLog = [System.IO.Path]::Combine($tempBase, "threadbase-cloudflared-$logGuid.err.log")
Emit-Status "starting cloudflared quick-tunnel (logs: $($script:TunnelLog))"

# Use Start-Process for OS-level stream redirection — more reliable than the
# .NET BeginOutputReadLine event loop, which depends on PS's async event queue
# and can drop lines that arrive before the main thread idles.
try {
  $proc = Start-Process `
    -FilePath $cloudflared.Source `
    -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$httpPort") `
    -RedirectStandardOutput $script:TunnelLog `
    -RedirectStandardError  $script:TunnelErrLog `
    -NoNewWindow `
    -PassThru
} catch {
  Emit-Err "failed to start cloudflared: $_"
  Invoke-Cleanup
  Emit-Done 'error'
  exit 1
}
$script:TunnelProcess = $proc

# ---------------------------------------------------------------------------
# 5. Wait for the trycloudflare URL to appear in the log
# ---------------------------------------------------------------------------

$tunnelUrl = $null
$pattern   = [regex]'https://[a-z0-9-]+\.trycloudflare\.com'
for ($i = 0; $i -lt 60; $i++) {
  if ($proc.HasExited) {
    Emit-Err "cloudflared exited early — last log lines:"
    foreach ($lp in @($script:TunnelLog, $script:TunnelErrLog)) {
      if (Test-Path $lp) {
        Get-Content -LiteralPath $lp -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object {
          [Console]::Error.WriteLine($_)
        }
      }
    }
    Invoke-Cleanup
    Emit-Done 'error'
    exit 1
  }
  foreach ($lp in @($script:TunnelLog, $script:TunnelErrLog)) {
    if (Test-Path $lp) {
      $logContent = Get-Content -LiteralPath $lp -Raw -ErrorAction SilentlyContinue
      if ($logContent) {
        $m = $pattern.Match($logContent)
        if ($m.Success) { $tunnelUrl = $m.Value; break }
      }
    }
  }
  if ($tunnelUrl) { break }
  Start-Sleep -Milliseconds 500
}

if (-not $tunnelUrl) {
  Emit-Err "cloudflared did not print a trycloudflare URL within 30s"
  foreach ($lp in @($script:TunnelLog, $script:TunnelErrLog)) {
    if (Test-Path $lp) {
      Get-Content -LiteralPath $lp -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object {
        [Console]::Error.WriteLine($_)
      }
    }
  }
  Invoke-Cleanup
  Emit-Done 'error'
  exit 1
}

Emit-Url $tunnelUrl
Emit-Status "tunnel is up"

# ---------------------------------------------------------------------------
# 6. Banner + prompt
# ---------------------------------------------------------------------------

$banner = @"

╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🎉  YOUR QUICK-TUNNEL IS LIVE                                ║
║                                                                ║
║   $tunnelUrl
║                                                                ║
║   Open that URL on your phone (any browser).                   ║
║   You should see a green "You made it!" page.                  ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝

"@
Write-Host $banner

Emit-Prompt 'Did the success page load on your phone? [y/N]'
$answer = Read-Host

try {
  switch -Regex ($answer) {
    '^(?i:y|yes)$' {
      Emit-Status "round-trip confirmed — tearing down"
      Invoke-Cleanup
      Emit-Done 'ok'
      exit 0
    }
    default {
      Emit-Status "round-trip not confirmed — tearing down anyway"
      Invoke-Cleanup
      Emit-Done 'aborted'
      exit 0
    }
  }
} catch {
  Emit-Err "unexpected error during teardown: $_"
  Invoke-Cleanup
  Emit-Done 'error'
  exit 1
}
