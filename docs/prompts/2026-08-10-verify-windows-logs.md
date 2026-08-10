# Verify on Windows — supervised logs and `prod logs` (#472 / PR #520)

**Paste this whole file into a Claude Code session on the Windows PC.** Everything below is the instruction set.

**Delete this file once the fix is validated.** It is a one-shot verification script, not documentation — `git rm docs/prompts/2026-08-10-verify-windows-logs.md` and say so in the PR. If verification *fails*, keep it and record what happened instead.

## Why this exists

PR #520 fixes #472: the supervised streamer wrote no logs at all on Windows, because `launch.cmd` had no redirection and Task Scheduler offers none natively. `getLogPaths()` threw rather than pointing at files that did not exist.

Everything in that PR was verified on macOS, and **macOS cannot execute the thing that actually matters**. The tests are content assertions on the PowerShell that `deploy.ps1` generates — nothing there runs cmd redirection, `wscript.exe`, or Task Scheduler. Three claims are therefore unproven and only this box can settle them:

1. The task chain (Task Scheduler → `wscript.exe` → `launch.vbs` → `launch.cmd`) actually produces **non-empty** `stdout.log` / `stderr.log`.
2. `Repair-LaunchCmd` rewrites a **real stale** `launch.cmd` — one written by the old deploy, without `>>`.
3. `tb-streamer prod logs` tails those files.

A green `Smoke (windows-latest)` in CI does **not** cover any of these — it does not install a scheduled task.

## Setup

```powershell
cd <your tb-streamer checkout>
gh pr checkout 520
npm ci
```

`npm ci` matters: the branch is behind whatever your last install was, and a stale `node_modules` produces a build that is not the one under test.

## Step 1 — capture the BEFORE state, or the self-heal proves nothing

Do this **before** deploying. If `launch.cmd` already contains `>>`, the self-heal path is not being exercised and step 3 is meaningless.

```powershell
$installDir = Join-Path $env:USERPROFILE '.threadbase'
Get-Content (Join-Path $installDir 'launch.cmd')
Test-Path (Join-Path $installDir 'logs\stdout.log')
```

Record both. Expected on an install predating the fix: no `>>` anywhere in `launch.cmd`, and `stdout.log` absent (or present and 0 bytes — `deploy.ps1` created the `logs` directory and never wrote to it).

**If `launch.cmd` already has `>>`**, you are on a post-fix install. Force the stale state so the self-heal is genuinely tested:

```powershell
$cmd = Join-Path $installDir 'launch.cmd'
(Get-Content $cmd) -replace '\s*>>.*$', '' | Set-Content $cmd
Get-Content $cmd    # confirm the redirection is gone
```

## Step 2 — deploy

```powershell
npm run deploy:windows
```

Report the tail of its output, including the healthcheck line.

## Step 3 — did the launcher self-heal?

```powershell
Get-Content (Join-Path $installDir 'launch.cmd')
```

**Expected:** an `if not exist … mkdir` guard, and the node line ending with `>> "…\logs\stdout.log" 2>> "…\logs\stderr.log"`.

If the redirection is missing, `Repair-LaunchCmd`'s `-notmatch '>>'` condition did not fire — capture the file verbatim and stop.

## Step 4 — are the log files actually being written?

This is the claim that matters most.

```powershell
$logs = Join-Path $installDir 'logs'
Get-ChildItem $logs | Select-Object Name, Length, LastWriteTime
```

**Expected:** `stdout.log` with `Length` greater than zero and a `LastWriteTime` from the restart that just happened.

A zero-length `stdout.log` means the redirection is in the file but the chain is not delivering — that is the original bug surviving the fix, and it is the single most important thing to report.

Then force new output and confirm it lands:

```powershell
$before = (Get-Item (Join-Path $logs 'stdout.log')).Length
Invoke-RestMethod -Uri http://localhost:8766/healthz | ConvertTo-Json -Compress
Start-Sleep -Seconds 3
$after = (Get-Item (Join-Path $logs 'stdout.log')).Length
"grew: $($after - $before) bytes"
```

**Expected:** a positive byte delta. Zero growth means the file was written once at boot and the stream is not attached — report that.

## Step 5 — does `prod logs` read them?

```powershell
tb-streamer prod logs
tb-streamer prod --help
```

**Expected:** `prod logs` prints the content seen in step 4 and does not throw. `prod --help` still lists it.

Then confirm it reads the same files rather than a coincidental second pair:

```powershell
tb-streamer prod status
```

## Step 6 — the regression the fix could plausibly cause

`getAgentPid()` finds the server by a WMI command-line filter (`*cli.js*serve*`). The reasoning on macOS was that cmd consumes the redirection, so the node child's command line is unchanged — **unverified here**.

```powershell
tb-streamer prod status
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine | Format-List
```

**Expected:** `prod status` reports a running pid, and the node process's `CommandLine` contains `cli.js … serve` with **no** `>>` in it.

If `prod status` says nothing is running while the server answers `/healthz`, the filter broke — report the full `CommandLine`.

## Step 7 — the log cap still applies

`lifecycle/log-cap.ts` truncates supervised logs at boot. It previously took its defaults from the macOS backend on every platform; it now reads `logPaths()`. Confirm nothing grows without bound:

```powershell
Get-ChildItem $logs | Select-Object Name, Length
tb-streamer prod restart
Start-Sleep -Seconds 5
Get-ChildItem $logs | Select-Object Name, Length
```

**Expected:** sizes are capped or reset across the restart, not monotonically growing.

## Report back with

- Step 1 BEFORE state — verbatim `launch.cmd` and whether `stdout.log` existed. Without this, a pass on step 3 is unfalsifiable.
- Step 3 launcher content, verbatim.
- Step 4 file sizes and the byte delta.
- Step 5 `prod logs` output (first ~20 lines is plenty).
- Step 6 `prod status` result and the node `CommandLine`.
- Anything that threw, verbatim — including PowerShell errors that scrolled past.

State plainly which of the three unproven claims now hold and which do not. A partial pass is a useful result; a claimed pass that skipped step 1 is not.

## Traps

- **`npm ci`, not `npm install`.** The lockfile is the point.
- **Do not hand-edit `launch.cmd` to make step 3 pass.** The whole question is whether `deploy.ps1` writes it.
- **A pre-existing post-fix install makes step 3 vacuous.** Force the stale state (step 1) or say you skipped it.
- **`prod restart` may not recreate the task.** If `prod status` reports nothing after a restart, run the deploy again rather than concluding the fix broke the task.
- **Stale port 8766.** If a node process from an earlier install still holds it, the new task fails silently — `Get-NetTCPConnection -LocalPort 8766` and kill the owner before re-testing.
