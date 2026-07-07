# Postmortem: Auto-updater broken on Windows; conversations blank after v1.18.1 install

**Date:** 2026-06-28
**Severity:** Medium — `scripts/install-auto-update.ps1` failed to run at all on Windows, leaving auto-update unregistered; after manually triggering the update to v1.18.1, `/api/conversations` returned a native-module error and the app showed no conversation history.
**Status:** Resolved.
**Components:** `scripts/install-auto-update.ps1`, `~/.threadbase/current/node_modules/better-sqlite3`.

## Symptoms

1. Running `scripts/install-auto-update.ps1` on Windows (PowerShell 5.1) immediately failed with a string-terminator parse error pointing at a character position inside a `Write-Log` call.
2. After fixing the script and registering the Task Scheduler job, running `node ~/.threadbase/cli.js update` installed v1.18.1 and reported success — but the app still showed no conversations.
3. `GET /api/conversations` returned: `The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 120.`

## Investigation

### Script failures (four independent bugs)

**Bug 1 — Em dashes in double-quoted strings.**
PowerShell 5.1 on Windows reads UTF-8 files without a BOM as ANSI (Windows-1252). The em dash `—` (U+2014) is encoded in UTF-8 as the three bytes `0xE2 0x80 0x94`. In Windows-1252 those bytes decode as `â`, `€`, `"` respectively. The `"` in the middle of a double-quoted string literal prematurely terminates the string, causing a parse error. The script had three such em dashes in double-quoted strings:
- `Write-Log "installed scheduled task $TaskName — fires every $intervalMin min"`
- `Write-Warn "no $UpdateYaml — create one with..."`
- `Write-Err "streamer not deployed at $ActiveLink — run scripts/deploy.ps1 setup first"`

The parse error on the first one prevented the script from loading at all.

**Bug 2 — `$Matches` scope in `Read-YamlField`.**
The function used `Where-Object { $_ -match "..." }` to find matching YAML lines, then read `$Matches[1]` after the pipeline. PowerShell populates `$Matches` inside the `Where-Object` script block scope, not the enclosing function scope, so `$Matches[1]` was always `$null` after the pipeline. The function silently fell through to `return ($null).Trim()` which returned an empty string instead of the parsed value. Because the empty string was not `$null`, the `if (-not $line)` guard didn't catch it. `Read-YamlField` appeared to work (no exception) but returned wrong values for every key.

**Bug 3 — Hardcoded `current\dist\cli.cjs` path.**
The script checked `$InstallDir\current\dist\cli.cjs` to verify the streamer was deployed. On this Windows machine the deploy had not yet created a `current\` directory — the earlier deploy layout used a flat `cli.js` shim at `$InstallDir\cli.js`. The script exited with "streamer not deployed" even though the streamer was running.

**Bug 4 — `[TimeSpan]::MaxValue` rejected by Task Scheduler.**
`New-ScheduledTaskTrigger -RepetitionDuration ([TimeSpan]::MaxValue)` serialises to `P99999999DT23H59M59S` in the task XML, which Task Scheduler rejects with `HRESULT 0x80041318`. Omitting `-RepetitionDuration` entirely is the correct way to request indefinite repetition.

### Conversations blank after update

After the script was fixed and the update to v1.18.1 applied, the service restarted using the new `~/.threadbase/current/dist/cli.cjs`. The 1.18.1 release tarball ships `better-sqlite3` pre-compiled for Node MODULE_VERSION 137 (Node v22+), but this machine runs Node v21.7.0 (MODULE_VERSION 120). The mismatch caused `better-sqlite3` to throw on load, crashing the conversation-cache initialisation path silently. All conversation endpoints returned the native-module error as a JSON `{"error": "..."}`.

A second issue was also present: `launch.cmd` still pointed at the old `cli.js` shim rather than `current\dist\cli.cjs`, so the new binary was not actually being invoked until `launch.cmd` was updated.

## Root causes

| # | Root cause |
|---|---|
| 1 | Script source file is UTF-8 without BOM; PowerShell 5.1 misreads it as ANSI, breaking multi-byte characters inside string literals |
| 2 | `$Matches` has pipeline-local scope in PowerShell; reading it outside `Where-Object` always yields `$null` |
| 3 | Install script assumed Unix symlink layout (`current/dist/cli.cjs`) that the Windows deploy didn't create at the time |
| 4 | Task Scheduler does not accept `[TimeSpan]::MaxValue` for repetition duration |
| 5 | Release tarball pre-compiles native modules against a Node version newer than the one installed on this machine |
| 6 | `launch.cmd` was not updated to use the new `current\dist\cli.cjs` path after the first update |

## Fixes applied

**`scripts/install-auto-update.ps1`:**
- Replaced all three em dashes in double-quoted strings with plain hyphens
- Fixed `Read-YamlField` to re-run the regex against `$line` directly (after the pipeline) so `$Matches` is populated in the correct scope
- Resolved `$ActiveLink` dynamically: use `current\dist\cli.cjs` if it exists, fall back to `cli.js`
- Removed `-RepetitionDuration ([TimeSpan]::MaxValue)` from `New-ScheduledTaskTrigger`

**Runtime:**
- Ran `npm rebuild better-sqlite3` inside `~/.threadbase/current/` to recompile the native module against Node v21.7.0
- Updated `~/.threadbase/launch.cmd` to invoke `current\dist\cli.cjs` instead of `cli.js`
- Restarted the Threadbase Task Scheduler task

## Lessons

1. **PowerShell 5.1 and UTF-8 without BOM are a silent trap.** Any non-ASCII character in a string literal can become arbitrary bytes when read as ANSI. Either save `.ps1` files with UTF-8 BOM, or restrict string literals to ASCII. The em dash `—` is common in prose-style log messages and will bite again.
2. **`$Matches` does not escape `Where-Object`.** The pattern `$list | Where-Object { $_ -match $re }; $Matches[1]` looks correct but is broken. Always re-match the captured line: `if ($line -match $re) { $Matches[1] }`.
3. **Release tarballs that include pre-compiled native modules need a Node version matrix or a post-install rebuild step.** `better-sqlite3` (and `node-pty`) are compiled for a specific ABI. If the tarball targets a newer Node than the host, the update silently breaks persistence. The updater should run `npm rebuild` in `current/` after swapping the release, or the CI build matrix should target the minimum supported Node version.
4. **`launch.cmd` is part of the update surface.** After the first update, `launch.cmd` pointed at the old shim while `current/` held the new binary. Future updater iterations should rewrite `launch.cmd` to reference `current\dist\cli.cjs`, matching what the deploy script now generates.

## References

- Fix commit: `fix(auto-update): fix install-auto-update.ps1 on Windows` (PR #139)
- Script: `scripts/install-auto-update.ps1`
- Deploy script: `scripts/deploy.ps1`
- Auto-update docs: `docs/guides/auto-update.md`
