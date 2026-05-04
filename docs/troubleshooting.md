# Troubleshooting Guide

Collected from fixed bugs, deploy incidents, and CLAUDE.md/SKILL.md history. Each section describes a symptom, its root cause, and the fix. Use this before digging into source.

---

## Session list / cache issues

### Stale `disc_*` or `ses_*` sessions appearing in the list after a server upgrade

**When:** After deploying a new streamer version, the mobile session list shows sessions with old-format IDs (`disc_12345`, `ses_abc`) that 404 when opened.
**Cause:** The SQLite conversation cache (`~/.threadbase/cache/cache.db`) still holds rows written by the previous server version. The new server serves the cached list but can't find matching JSONL files because the IDs don't correspond to real filenames.
**Fix:** Clear the cache and restart — the server will rebuild it from JSONL files on disk:

```sh
node ~/.threadbase/cli.js cache clear
# then restart the server
node ~/.threadbase/cli.js serve
```

Or manually:
```sh
rm ~/.threadbase/cache/cache.db*
```

---

## Deploy failures

### `Cannot find module` on lint or build

**When:** Fresh clone, or a branch that added new packages.
**Cause:** `node_modules` is missing or stale.
**Fix:** Run `npm install` before `npm run deploy` / `npm run deploy:windows`. The `postinstall` script also patches `qrcode-terminal` and sets execute permissions on the `node-pty` prebuild — skip it and the build will fail later.

---

### Healthcheck fails with `ENOENT … migrations`

**When:** Server starts but crashes immediately; `dist/migrations/` cannot be found at runtime.
**Cause:** The deploy script copied migrations to the wrong path. Node resolves `__dirname` from the *real* file path, not the symlink source:
- **macOS/Linux**: `cli.js` is a symlink → `__dirname` = `~/.threadbase/releases/` → migrations must be at `~/.threadbase/releases/migrations/`
- **Windows**: `cli.js` is a real copy at the install root → `__dirname` = `~/.threadbase/` → migrations must be at `~/.threadbase/migrations/`

**Fix:** Confirm the deploy script copies to the correct platform-specific path. On Windows this is `$installDir\migrations\`, not `$releasesDir\migrations\`.

---

### `Cannot find module 'pg'` at runtime

**When:** Deployed CLI crashes on any DB-backed operation.
**Cause:** The deployed CLI lives in `~/.threadbase/releases/` with no `node_modules`. Only `node-pty` is declared external in tsup (native module). `pg` and every other dependency must be bundled.
**Fix:** Verify `tsup.config.ts` lists `node-pty` as the only external for the CLI entry. If `pg` appears in `external`, remove it and rebuild.

---

### `Cannot find module 'bindings'` at runtime (after adding a native dependency)

**When:** Deployed CLI crashes with `Error: Cannot find module 'bindings'` when a new native addon (e.g. `better-sqlite3`) was added.
**Cause:** Native addons declared as `external` in tsup are copied to `~/.threadbase/node_modules/<package>` by the deploy script, but their transitive dependencies (e.g. `bindings`, `file-uri-to-path` for `better-sqlite3`) are not automatically included. Node resolves them from the same `node_modules` tree, so they must also be present.
**Fix:** Add the missing transitive packages to the deploy script's copy loop alongside the native addon. For `better-sqlite3`, the deploy scripts (`scripts/deploy.ps1` and `scripts/deploy-linux.sh`) now copy `bindings` and `file-uri-to-path` in addition to `better-sqlite3` itself. If you add another native dependency in future, check what it requires with `node -e "require('<package>')"` in the repo root and add any missing modules to the copy loop.

---

### Deploy script hangs with no output

**When:** Running any deploy script on a machine where `browse_root` is not set.
**Cause:** The deploy script checks `~/.threadbase/server.yaml` for a `browse_root` key. If missing or the path doesn't exist, it prompts interactively. In non-TTY contexts the script hangs.
**Fix:** Pre-populate `server.yaml` before deploying:
```yaml
api_key: tb_…
browse_root: /path/to/your/projects
```

---

## Windows-specific issues

### Service starts but immediately exits (no error visible)

**When:** Task Scheduler task starts and exits with no log output.
**Cause:** Task Scheduler has no native stdout/stderr redirection. If the action does not use `pwsh.exe` as the executor with explicit redirection inside the PowerShell command string, `%TEMP%\threadbase.err` is never written.
**Fix:** The task action must use `pwsh.exe` as executor and redirect inside `$psArg`:
```powershell
$psArg = "-NonInteractive -WindowStyle Hidden -Command `"& '$nodePath' '$cliPath' serve --port 8766 --verbose >> '$logOut' 2>> '$logErr'`""
```
Then read `%TEMP%\threadbase.err` to diagnose the actual failure.

---

### Newly set env vars not picked up by the scheduled task

**When:** DB connection string was set with `SetEnvironmentVariable` but the task still fails to connect.
**Cause:** `[Environment]::SetEnvironmentVariable(..., 'User')` writes to the registry but does **not** update the live session environment. `Start-ScheduledTask` launched from the same terminal will not see the new var — the session's environment block is frozen at logon.
**Fix:** Read back from the registry and inline the value directly into `$psArg`:
```powershell
$dbUrl  = [Environment]::GetEnvironmentVariable('THREADBASE_DATABASE_URL', 'User')
$instId = [Environment]::GetEnvironmentVariable('THREADBASE_INSTANCE_ID', 'User')
$psArg  = "… `$env:THREADBASE_DATABASE_URL='$dbUrl'; `$env:THREADBASE_INSTANCE_ID='$instId'; & '$nodePath' '$cliPath' …"
```

---

### `EACCES` on port 5432 (not `ECONNREFUSED`)

**When:** `%TEMP%\threadbase.err` shows `EACCES` on port 5432.
**Cause:** The env var `THREADBASE_DATABASE_URL` is missing from the task action. The server starts on port 8766 but crashes when the DB client tries to parse an undefined connection string.
**Diagnosis:** First confirm TCP reachability: `Test-NetConnection -ComputerName <host> -Port 5432`. If that succeeds, the problem is the missing env var, not a firewall rule.
**Fix:** See "Newly set env vars not picked up by the scheduled task" above.

---

### New task fails to bind port 8766

**When:** `Get-ScheduledTaskInfo` shows the task ran but the server is unreachable.
**Cause:** A leftover node process (old streamer version, prior deploy, dev server) is already bound to port 8766. The new task starts and exits silently.
**Fix:** Before starting the task, kill any process on that port:
```powershell
$pid8766 = (netstat -ano | Select-String ':8766\s').ToString().Trim() -split '\s+' | Select-Object -Last 1
if ($pid8766 -match '^\d+$') { Stop-Process -Id $pid8766 -Force -ErrorAction SilentlyContinue }
```

---

### Blank PowerShell window flashes briefly during Claude Code sessions *(Windows only)*

**When:** A blank Windows Terminal tab or window labelled "PowerShell" appears and disappears while Claude Code is running. Hovering the tab shows only the generic name "PowerShell" with no custom title.
**Cause:** When Claude Code executes its `PowerShell` tool, it spawns a `pwsh` process on the system. Windows Terminal detects the new shell process and briefly surfaces it as a tab before the process exits. The window is blank because the process runs non-interactively and produces no interactive output.
**Fix:** None required — it is harmless and can be safely closed. The command Claude Code was running has already completed (or will complete) regardless of whether you close the window.

---

### ConPTY crash during session start — no JavaScript logs appear *(Windows only)*

**When:** `POST /api/sessions/start` crashes the server process silently. No log lines appear even when logging is placed at the very first line of `handleRequest` (before CORS headers, before auth). The process exits with no output.
**Cause:** The crash happens inside the native ConPTY C++ layer before any JavaScript runs. This can occur when the PTY is spawned with an invalid executable path or environment. In testing, this manifested when CF-proxied requests triggered session starts under conditions the SYSTEM service's environment didn't support.
**Diagnosis:** If zero JS log output appears for a request (not even the first line of `handleRequest`), the crash is native, not JS. Check that `resolveClaudeExe()` resolves to a valid path in the Task Scheduler environment (PATH is stripped vs. interactive sessions).
**Fix:** Verify `where.exe claude` succeeds in a non-interactive context, or add fallback candidates to `resolveClaudeExe()` in `src/pty-manager.ts`.

---

### `git submodule update --init` fails with `Permission denied (publickey)`

**When:** Fresh Windows clone without SSH keys configured.
**Cause:** Submodule URLs are SSH (`git@github.com:…`); no SSH key is present.
**Fix (one-time):**
```powershell
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

---

### Path prefix checks fail silently on Windows

**When:** Browse or file-watch endpoints return unexpected results on Windows.
**Cause:** `path.resolve()` returns backslash-separated paths on Windows. Using `"/"` as a separator in `startsWith` guards will never match.
**Fix:** Always use `path.sep` (not `"/"`) for path prefix comparisons. See `src/browse.ts`.

---

### Timestamp mismatches in tests on Windows

**When:** Reconcile or session tests fail on Windows but pass on macOS/Linux.
**Cause:** `fs.stat().birthtimeMs` reflects the real Windows creation time and is unaffected by `fs.utimes()`. Tests that call `utimes` to manipulate timestamps and then read `birthtimeMs` will not see the change.
**Fix:** Use `mtimeMs` for any timestamp that needs to survive cross-platform test assertions. See `src/reconcile.ts`.

---

## Cloudflare Tunnel / Access

### External requests to `/healthz` (or any endpoint) return `401`

**When:** Testing the public URL from a browser, `curl`, or `Test-NetConnection`.
**Cause:** The tunnel hostname (`https://tb-pc.rbv1000.win`) is protected by Cloudflare Access. Any request without an `Authorization` header gets `401` from the CF edge before the origin ever sees it — including `/healthz`.
**Fix:** Always include the Bearer token for external requests:
```powershell
Invoke-RestMethod -Uri https://tb-pc.rbv1000.win/api/info -Headers @{Authorization="Bearer <api_key>"}
```
Deploy-script healthchecks hit `http://localhost:8766/healthz` directly and are unaffected.

---

### Tunnel returns `502` despite local server being healthy *(Windows only)*

**When:** `https://tb-pc.rbv1000.win` returns `error code: 502` but `http://localhost:8766/healthz` returns OK. The `cloudflared` service shows as Running and `cloudflared tunnel info` shows an active connector.
**Cause:** The `cloudflared` Windows service runs as LocalSystem and reads from `C:\Windows\system32\config\systemprofile\.cloudflared\config.yml` — a separate file from `~/.cloudflared/config-system.yml`. When new ingress hostnames are added to the user config they are **not** automatically applied to the SYSTEM copy. Cloudflare returns 502 for any hostname with no matching ingress rule.
**Diagnosis:** If the local server is healthy, the tunnel is connected, and `cloudflared tunnel route dns` confirms the hostname points to the right tunnel, the SYSTEM config is almost certainly stale.
**Fix (requires admin):**
```powershell
# Run as Administrator
Copy-Item "$env:USERPROFILE\.cloudflared\config-system.yml" `
  "C:\Windows\system32\config\systemprofile\.cloudflared\config.yml" -Force
Restart-Service cloudflared
```

---

### `Restart-Service cloudflared` silently does nothing without admin *(Windows only)*

**When:** Running `Restart-Service cloudflared` from a non-elevated terminal returns no error and reports the service as "Running", but the tunnel still misbehaves and no new events appear in the Windows event log.
**Cause:** The cloudflared service runs as LocalSystem. Restarting a system service requires elevation. PowerShell silently ignores the restart rather than throwing an access-denied error.
**Fix:** Open a PowerShell window as Administrator before running `Restart-Service cloudflared`. Confirm the restart happened by checking `Get-WinEvent -ProviderName cloudflared -MaxEvents 3` for a new "service starting" event.

---

### Adding a second user-context cloudflared connector doesn't help *(Windows: SYSTEM vs user; all platforms: Cloudflare routing)*

**When:** You start a second `cloudflared tunnel run` process with a correct config as a workaround, but tunnel requests still 100% fail.
**Cause:** Cloudflare routes all traffic to the longest-running (SYSTEM service) connector. User-context connectors registered later receive zero requests regardless of how many connections they hold. `cloudflared tunnel cleanup` removes all connectors simultaneously — the SYSTEM service reconnects in ~1 second and grabs all traffic again before the user connector can re-establish.
**Fix:** Fix the SYSTEM config and restart the service (see above). There is no user-space workaround.

---

### Tunnel routes to wrong port after config change

**When:** `cloudflared` service is running but traffic goes to the old port.
**Cause:** Two config files exist and must be kept in sync:
- `~/.cloudflared/config.yml` — used when running `cloudflared` manually
- `~/.cloudflared/config-system.yml` — used by the Windows service (SYSTEM account); this is the one that matters

**Fix:** Edit **both** files, then restart the service as admin: `Restart-Service cloudflared`.

---

### QR code embeds `localhost` instead of the public URL

**When:** Pairing QR on mobile shows `localhost:8766` instead of the tunnel hostname.
**Cause:** `public_url` is not set in `~/.threadbase/server.yaml`.
**Fix:**
```yaml
public_url: https://tb-pc.rbv1000.win
```
Restart the streamer to pick it up.

---

## Mobile app error messages

### "Failed to start session — File not found:" via public URL

**When:** Session start works fine from `localhost` but the mobile app shows "Failed to start session — File not found:" (or similar) when connecting through `https://tb-pc.rbv1000.win`.
**Cause:** The Cloudflare tunnel is returning `502 Bad Gateway`, not a real path error. The mobile app surfaces the raw error text from the JSON response, which can be misleading. The 502 is almost always the SYSTEM cloudflared config being stale and missing the tunnel hostname's ingress rule.
**Fix:** See "Tunnel returns 502 despite local server being healthy" above.

---

### "Failed to start session — ENOENT: no such file or directory, realpath '/Users/.../dev/Users/.../dev/...'" (Mac)

**When:** The mobile app shows a "Failed to start session" dialog with a doubled path like `realpath '/Users/ronenmars/Desktop/dev/Users/ronenmars/Desktop/dev/ai-tools/threadbase-streamer'`. Happens on Mac after a deploy that included Windows path fixes.
**Cause:** Commit `0e61299` added `relativePath.replace(/^[/\\]+/, "")` in `src/browse.ts` to fix Windows drive-root-relative paths. On Windows, a client sending `/foo` means "relative to drive root" and stripping the `/` is correct. On Mac, the mobile app sends the full absolute path (e.g. `/Users/ronenmars/Desktop/dev/ai-tools/threadbase-streamer`) — stripping its leading `/` turns it into a relative name, which `path.resolve` then joins onto `browseRoot`, doubling the path.
**Fix:** `src/browse.ts` now checks `process.platform !== "win32"` before deciding whether to strip. On Unix, absolute paths that contain a `/` after the first character are used directly; only bare names like `/projectA` get stripped. Windows behavior is unchanged.

---

## Session idle / on_hold

### Session transitions to `on_hold` unexpectedly

**When:** A session in `waiting_input` becomes `on_hold` after roughly a minute of inactivity, even though the user intended to resume it.
**Cause:** `IdleSweeper` runs every 30 s and puts any `waiting_input` session whose `lastActivityAt` is older than `idleTimeoutMs` (default: 60 000 ms) on hold. The PTY process is killed and status is set to `on_hold`.
**Fix:** Resume the conversation with `POST /api/sessions/resume` using the same `conversationId`. A new PTY session will be spawned against the existing conversation history. To raise the threshold, set `idle_timeout_ms` in `~/.threadbase/server.yaml` (e.g. `idle_timeout_ms: 300000` for 5 minutes) or pass `--idle-timeout 300000` on the CLI. Set to `0` to disable idle sweep entirely.

---

### `on_hold` session incorrectly shows as `failed` after server restart

**When:** A session that was `on_hold` before the server restarted is now listed as `failed`.
**Cause:** Running an older build of the streamer that does not include the `on_hold` status. The reconcile pass in older builds marks all non-terminal sessions (including `on_hold`) as `failed`.
**Fix:** Deploy the current build. The reconcile pass now treats `on_hold` as an intentional terminal-ish state and leaves it unchanged across restarts.

---

## Server / API issues

### Sessions show empty output on first request after startup

**When:** Hitting `/api/sessions/:id/output` immediately after the server starts returns an empty body.
**Cause:** The scanner (conversation history cache) has a warm-up period. Requests that arrive before the cache is ready return empty results.
**Fix:** The server awaits scanner readiness before accepting requests. If you see this, check whether the startup `await` in `server.ts` is present and the scanner's readiness promise resolves correctly.

---

### PTY cancel leaves Claude process running

**When:** Sending a cancel request does not stop the running Claude session.
**Cause (historical):** An earlier version sent `SIGHUP` instead of `SIGINT`. Claude ignores `SIGHUP` but responds to `SIGINT`.
**Fix:** PTY cancel must send `SIGINT`. Verify `pty-manager.ts` uses `SIGINT` for the cancel path, not `SIGHUP`.

---

### Session endpoint returns `404` for a known-good session

**When:** `/api/sessions/:id/output` returns 404 for a session that is visible in `/api/sessions`.
**Cause (historical):** An earlier version returned 404 for sessions that were discovered via process scanning but had no PTY-managed output buffer.
**Fix:** Untracked (discovered) sessions should return an empty output array, not 404. Verify `server.ts` distinguishes "session not found at all" (404) from "session exists but has no buffered output" (200 + empty array).

---

## Launchd plist (macOS)

### `launchctl kickstart` fails with `could not find service`

**When:** Running `launchctl kickstart "gui/$(id -u)/com.ronen.threadbase"` after a fresh deploy.
**Cause:** The plist existed from an old install pointing to a dev-workspace path. It was bootstrapped at some point, then the service was booted out without being re-bootstrapped.
**Fix:**
1. Run `launchctl bootout "gui/$(id -u)/com.ronen.threadbase"` (will fail if not loaded — that is fine).
2. Rewrite the plist so `ProgramArguments` points to `~/.threadbase/cli.js`.
3. Run `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist`.
4. Then `launchctl kickstart` will succeed.

**Stale-plist check:** even if the plist file exists, verify the `ProgramArguments` entry references `~/.threadbase/cli.js` and not a hardcoded workspace path. If it doesn't, treat as a fresh install.

---

### Server runs but binds to port 3456 instead of 8766

**When:** Healthcheck on `http://localhost:8766/healthz` fails with "couldn't connect", but `~/.threadbase/logs/stdout.log` shows `Listening on http://localhost:3456`. `~/.threadbase/server.yaml` clearly has `port: 8766`.
**Cause:** `cli.js serve` does not honour the `port:` key from `server.yaml` — the port must come from the CLI flag `--port`. If the launchd plist's `ProgramArguments` has only `["node", "cli.js", "serve"]` with no `--port`, the server falls back to its built-in default (3456).
**Fix:** Edit `~/Library/LaunchAgents/com.ronen.threadbase.plist` so `ProgramArguments` includes the port flag (and `--verbose` for log parity with the deploy script):

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/Users/ronen/.threadbase/cli.js</string>
  <string>serve</string>
  <string>--port</string>
  <string>8766</string>
  <string>--verbose</string>
</array>
```

Then bootout + re-bootstrap to apply (launchd reads the plist at bootstrap time, not at every kickstart):
```sh
launchctl bootout "gui/$(id -u)/com.ronen.threadbase" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist
launchctl kickstart "gui/$(id -u)/com.ronen.threadbase"
```

---

### `launchctl print` reports a non-existent plist `path`

**When:** `launchctl print "gui/$(id -u)/com.ronen.threadbase"` shows `path = /some/old/location/com.ronen.threadbase.plist`, but that file no longer exists on disk. The service is still `state = running` and serving requests.
**Cause:** launchd caches the path of whichever plist was last bootstrapped. If that plist file was deleted or moved (e.g. a dotfiles symlink was overwritten by a real file copy), launchd keeps the path string in its in-memory metadata even though the on-disk file is gone. The running process is fine — launchd only reads the plist at bootstrap time, so the program continues to execute normally.
**Why it matters:** future `kickstart -k` calls still work, but they restart the program string launchd cached at bootstrap, not whatever the canonical plist now contains. Edits to `~/Library/LaunchAgents/com.ronen.threadbase.plist` are silently ignored until the next bootout/bootstrap cycle.
**Fix:** Bootout the stale entry and re-bootstrap from the canonical plist path:
```sh
launchctl bootout "gui/$(id -u)/com.ronen.threadbase"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist
launchctl kickstart "gui/$(id -u)/com.ronen.threadbase"
```
After this, `launchctl print` should show `path = /Users/<you>/Library/LaunchAgents/com.ronen.threadbase.plist`.

---

### Deploy reports success but the running process predates the build

**When:** `npm run deploy` reports `✓ healthcheck passed: {"ok":true,"version":"0.1.0+<sha>"}` and `✓ deploy complete`. But `ps -o pid,etime` on the listening node shows an elapsed time longer than the deploy itself, and `launchctl print` reports a `path` to a plist that no longer exists.
**Cause:** This is a benign confusion, not a deploy failure. Three signals were misread:
1. The PID's `etime` looks "too old" because investigation took longer than expected — `etime` keeps growing while `ps` is invoked, so a 30-second-old process can show 30+ minutes of elapsed time after a long debugging session.
2. The shim path on `program = /usr/local/bin/threadbase-streamer` looks suspicious but is a real symlink chain that resolves to `~/.threadbase/cli.js`.
3. The stale `path` in `launchctl print` (see above) makes the service look like it's loaded from a missing file.

The deploy is actually fine if the healthcheck reports the new SHA. To verify:
```sh
curl -sS http://localhost:8766/healthz   # should report new SHA
ps -o pid,lstart,command -p $(pgrep -f 'threadbase.*serve')   # STARTED column should match symlink mtime
ls -la ~/.threadbase/cli.js              # symlink target should be the new release
```
Only re-bootstrap (above section) if you actually need launchd's cached metadata to reflect the canonical plist.

---

## Native modules / ABI mismatches

### `better-sqlite3` `ERR_DLOPEN_FAILED` after a Node major upgrade

**When:** Server starts and accepts requests, but `~/.threadbase/logs/stderr.log` (or `/tmp/threadbase.err`) repeats:
```
ConversationCache failed to open (running without cache):
The module '…/better-sqlite3/build/Release/better_sqlite3.node' was compiled
against a different Node.js version using NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 141.
{ code: 'ERR_DLOPEN_FAILED' }
```
The mobile session list still works — just slower, since every request scans JSONL files instead of hitting the SQLite cache.
**Cause:** Node was upgraded (e.g. system Node went from v22 to v24) after the streamer was deployed. `better-sqlite3`'s prebuilt `.node` binary at `~/.threadbase/releases/node_modules/better-sqlite3/build/Release/` is locked to the old `NODE_MODULE_VERSION`. The streamer catches the load error and degrades gracefully: cache disabled, server continues.
**Fix:** Rebuild the native module against the current Node — but use the **same Node binary launchd runs** (not whatever your shell's `node` resolves to). The launchd plist hardcodes `/usr/local/bin/node`; if your shell uses nvm or another Node manager, `npm rebuild` will silently produce a binary for the wrong ABI and the error will persist after restart.

```sh
# Compare the two Nodes first — if they differ, you must use the service's npm explicitly:
/usr/local/bin/node -p "process.versions.modules + ' (' + process.version + ')'"
node -p "process.versions.modules + ' (' + process.version + ')'"

# Rebuild with the service's npm (PATH override ensures node-gyp finds the v24 headers):
cd ~/.threadbase/releases && PATH="/usr/local/bin:$PATH" /usr/local/bin/npm rebuild better-sqlite3
launchctl kickstart -k "gui/$(id -u)/com.ronen.threadbase"
```

If the `releases/` directory has no `package.json` to rebuild from, the simpler fix is to wipe the cached `node_modules` and let the next deploy rehydrate it from a fresh `npm install` against the current Node:
```sh
rm -rf ~/.threadbase/releases/node_modules
npm run deploy
```

**Diagnosis cue:** the error is non-fatal — the server keeps running. If you only check `/healthz` you won't notice. Look in stderr.log if the mobile app feels noticeably slower after a Node upgrade.

**Confirming the fix worked:** after `kickstart -k`, the *file* `stderr.log` is appended to, not truncated, so old errors stay visible. To verify the fresh process is clean, truncate the log first:
```sh
: > ~/.threadbase/logs/stderr.log
launchctl kickstart -k "gui/$(id -u)/com.ronen.threadbase"
sleep 3
cat ~/.threadbase/logs/stderr.log   # should be empty if the cache loaded successfully
```
