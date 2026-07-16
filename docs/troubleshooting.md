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

### `Startup cache warm-up failed: FOREIGN KEY constraint failed`

**When:** Recurring warning in `~/.threadbase/logs/{stdout,stderr}.log` (tail with `tb-streamer prod logs`) at every server start. Logged at level `40` (warn) with `event: cache.warmup_failed`. Streamer continues to serve `/healthz`, the conversation list, and PTY sessions normally — this is non-blocking.

**Symptom example:**
```
{"level":40,"time":"2026-05-24T15:24:12.418Z","service":"tb-streamer","component":"server","error":"FOREIGN KEY constraint failed","event":"cache.warmup_failed","msg":"Startup cache warm-up failed: FOREIGN KEY constraint failed"}
```

**Cause:** Suspected SQLite FK-ordering bug during startup cache warm-up. The warm-up path tries to write `conversation_meta` rows whose `project_id` references rows in `projects` that haven't been inserted yet — likely an ordering issue in `services/conversations/refreshConversationCache.ts` ⟶ `services/projects/ensureProjectsForConversations.ts`. The error is caught (level 40 not 50), logged, and execution continues without the warm-up succeeding. The cache then rebuilds incrementally on demand via the watcher + `shouldRefreshProjectsFromHdd` gate, so user-visible functionality is unaffected — just slower cold-start performance until the cache catches up.

**Fix:** Not yet root-caused. Open question — possibly: (a) wrap warm-up in an explicit transaction with project upserts ordered before conversation inserts, (b) defer FK enforcement during warm-up with `PRAGMA defer_foreign_keys = ON`, or (c) skip the warm-up entirely and rely solely on the lazy watcher-driven cache rebuild. None of these have been investigated in detail.

**Workaround:** None needed. The streamer functions correctly despite the warning. Worth a focused debug session when the FK enforcement is touched for other reasons, but does not require urgent attention.

**First observed:** 2026-05-23 (multiple occurrences). Not introduced by the scanner-goes-public migration (2026-05-24) — predates it.

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

**Note:** As of the projects refactor, `dist/migrations/` contains the **SQLite** migrations consumed by `ConversationCache.open()` (projects table, project_id columns, cache_metadata). The Postgres migrations now live at `src/db/pg-migrations/` → `dist/pg-migrations/` and are not currently shipped by the deploy scripts; see CLAUDE.md "Build notes".

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

**When:** The mobile app shows a "Failed to start session" dialog with a doubled path like `realpath '/Users/<you>/Desktop/dev/Users/<you>/Desktop/dev/ai-tools/threadbase-streamer'`. Happens on Mac after a deploy that included Windows path fixes.
**Cause:** Commit `0e61299` added `relativePath.replace(/^[/\\]+/, "")` in `src/browse.ts` to fix Windows drive-root-relative paths. On Windows, a client sending `/foo` means "relative to drive root" and stripping the `/` is correct. On Mac, the mobile app sends the full absolute path (e.g. `/Users/<you>/Desktop/dev/ai-tools/threadbase-streamer`) — stripping its leading `/` turns it into a relative name, which `path.resolve` then joins onto `browseRoot`, doubling the path.
**Fix:** `src/browse.ts` now checks `process.platform !== "win32"` before deciding whether to strip. On Unix, absolute paths that contain a `/` after the first character are used directly; only bare names like `/projectA` get stripped. Windows behavior is unchanged.

---

### Server "Unreachable" on Wi-Fi vs. "Fetch failed" on cellular (iOS, over Tailscale)

**When:** A LAN server entry (`http://192.168.x.x:8766`) works on the same Wi-Fi but goes **"Unreachable"** off Wi-Fi (cellular/5G). Switching the entry to the machine's **Tailscale IP** (`http://100.x.x.x:8766`) changes the error to **"Fetch failed"** — and the streamer log shows **no request from the phone at all**. Fly/`https://` servers connect fine throughout.
**Cause:** Two stacked issues, both client-side:
- The LAN IP is unroutable when the phone leaves Wi-Fi → "Unreachable."
- iOS **App Transport Security (ATS)** exempts private RFC-1918 ranges (`192.168.x`, `10.x`, `172.16–31.x`) and `.local`, so plaintext `http://` works on Wi-Fi. But Tailscale's `100.64.0.0/10` (CGNAT) range is treated as **public**, so ATS **requires HTTPS** and blocks the plaintext `http://100.x` request *before it leaves the phone*. Hence "Fetch failed" with nothing in the server log. (You can `tailscale ping` the phone and `curl` the `100.x` IP from the host successfully and still see this — the block is in iOS, not on the wire.)
**Fix:** Put valid HTTPS in front of `:8766` with **Tailscale Serve** and point the app at the `https://<host>.<tailnet>.ts.net` hostname (no port — `https` defaults to 443; Serve proxies to 8766 internally). Use the hostname, not the IP (the cert won't match the IP). Full walkthrough incl. the one-time "Enable HTTPS" admin step and reboot persistence: **[remote-access/tailscale-serve.md](guides/remote-access/tailscale-serve.md)**.

---

## Discovered sessions / PTY not attached

### Session shows `Idle · 0 prompts` with blank terminal and `PTY_ATTACHED: false`

**When:** The mobile app shows a session as "Idle · X prompts" but with `0 prompts` in the detail view, the terminal is blank, and Session Info shows `PTY ATTACHED: false`. The session has a non-zero elapsed time.

**Cause:** This is a *discovered* session — tb-streamer found an externally-running `claude` process via `pgrep -x claude` that it did not start itself. `discoveredToResponse()` in `session-store.ts` always hard-codes `status: "idle"`, `promptCount: 0`, `ptyAttached: false` for every externally-discovered session, regardless of what that process is actually doing. The elapsed time reflects how long that process has been running.

**Is this a bug?** No — it is expected behavior. tb-streamer surfaces discovered processes so you know they exist, but it cannot inspect their state or attach a PTY to them retroactively.

**Fix:** None needed. The session entry closes when the external process exits. If you want to interact with the session in the app, stop Claude Code in the other terminal (Ctrl+C), then open the session from the app — once the process is no longer running, tb-streamer can resume it as a fully-managed session with PTY and terminal output.

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

### `tb-streamer pair` (and the mobile app) return `401` even though the server is running

**When:** `POST /api/pair/start` returns 401, or the mobile app 401s on `/ws`, despite a healthy server on `localhost` (`/healthz` → 200).
**Cause:** The running server loads its API key from `~/.threadbase/server.yaml` **once at startup** and holds it in memory — it does not watch the file. If `server.yaml`'s `api_key:` line changed after the server started, the CLI/mobile (reading the current file) and the server (holding the old key) disagree, so every non-localhost request is rejected.
One way this happened historically: running the test suite from a checkout where `__tests__/security-hardening.test.ts` didn't sandbox the config path — its `/api/auth/rotate` tests rewrote the live `server.yaml` (fixed by resolving the config dir per call via `THREADBASE_CONFIG_DIR` in `src/auth.ts`).
**Fix:** Restart the supervised instance so it reloads the current key, then re-pair:

```bash
tb-streamer prod restart
tb-streamer pair
```

Verify with `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $(awk '/^api_key:/{print $2}' ~/.threadbase/server.yaml)" http://localhost:8766/api/pair/start` → expect `200`.

---

## Launchd plist (macOS)

### `launchctl kickstart` fails with `could not find service`

**When:** Running `launchctl kickstart "gui/$(id -u)/com.ronen.threadbase"` after a fresh deploy.
**Cause:** The plist existed from an old install pointing to a dev-workspace path. It was bootstrapped at some point, then the service was booted out without being re-bootstrapped.
**Fix:**
1. Run `launchctl bootout "gui/$(id -u)/com.ronen.threadbase"` (will fail if not loaded — that is fine).
2. Rewrite the plist so `ProgramArguments` points to `~/.threadbase/launchd-entry.cjs` (the shim, which `exec`s `cli.js`). Re-running `npm run deploy` does this automatically — `ensure_plist_healthy` detects and rewrites the stale layout.
3. Run `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist`.
4. Then `launchctl kickstart` will succeed.

**Stale-plist check:** even if the plist file exists, verify the `ProgramArguments` entry references `~/.threadbase/launchd-entry.cjs` (post-2026-05-30 shim) and not `~/.threadbase/cli.js` directly. If it points at `cli.js`, re-run `npm run deploy` to let the self-heal rewrite it.

---

### Mobile app shows session as `Idle 0s 0 prompts` immediately after start/resume — terminal stays blank

**When:** `POST /api/sessions/start` or `POST /api/sessions/resume` returns `201`/`202`, but the new session reports `status: idle`, `elapsedMs: 17–50`, `ptyAttached: false`, `lastOutput: ""`. The mobile app shows a blank terminal under "Idle 0s 0 prompts". Direct `claude --resume <uuid>` from a regular shell (with the same `cwd`) works fine. Affects every session, not specific UUIDs.
**Cause:** The launchd plist has no `EnvironmentVariables` block, so the streamer process inherits launchd's default `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. `resolveClaudeExe()` returns the bare string `"claude"`, expecting `PATH` to find it — but `claude` lives in `/opt/homebrew/bin/claude` (Apple Silicon) or `/usr/local/bin/claude` (Intel), neither of which is on the inherited `PATH`. `node-pty` calls `execvp("claude", …)`, which fails with `ENOENT`; the child exits in milliseconds with no output. The streamer's `handleExit` sets `status=idle` (since the early-exit diagnostic only runs for non-zero exits with empty buffers, and `failureReason` is never propagated to the response anyway).
**Diagnosis:** `launchctl print "gui/$(id -u)/com.ronen.threadbase" | grep -A5 'environment ='` — if there is no `PATH => …` entry pointing at `/opt/homebrew/bin` or `/usr/local/bin`, the plist is the problem. To confirm, simulate the broken environment:
```sh
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=$HOME /usr/local/bin/node -e "
const pty = require('/Users/$USER/.threadbase/node_modules/node-pty');
const p = pty.spawn('claude', ['--dangerously-skip-permissions','--version'], { name:'xterm', cols:120, rows:40, cwd:'/tmp', env:process.env });
let out=''; p.onData(d=>out+=d); p.onExit(({exitCode})=>console.log('exit', exitCode, 'len', out.length));
setTimeout(()=>p.kill(), 1500);
"
```
This reproduces the instant exit (`exit 1 len 0`) when `PATH` is missing the Homebrew/local prefixes.
**Fix:** Add the `EnvironmentVariables` block to `~/Library/LaunchAgents/com.ronen.threadbase.plist`:
```xml
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key>
  <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  <key>HOME</key>
  <string>/Users/<your-user></string>
</dict>
```
Then bootout + re-bootstrap (a kickstart alone does **not** pick up env changes — launchd reads the plist at bootstrap time):
```sh
launchctl bootout "gui/$(id -u)/com.ronen.threadbase"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist
```
Re-run `npm run deploy` afterwards if you want the deploy-script self-heal (see below) to lock the plist in.

**Defense in depth:** `src/platform.ts` (`resolveClaudeExe`) now also probes `/opt/homebrew/bin/claude` and `/usr/local/bin/claude` on macOS via `which`, so even a degraded `PATH` resolves to an absolute path. This keeps a misconfigured plist from completely breaking the streamer.

---

### Server runs but binds to port 3456 instead of 8766

**When:** Healthcheck on `http://localhost:8766/healthz` fails with "couldn't connect", but `~/.threadbase/logs/stdout.log` shows `Listening on http://localhost:3456`. `~/.threadbase/server.yaml` clearly has `port: 8766`.
**Cause:** `cli.js serve` does not honour the `port:` key from `server.yaml` — the port must come from the CLI flag `--port`. If the launchd plist's `ProgramArguments` has only `["node", "cli.js", "serve"]` with no `--port`, the server falls back to its built-in default (3456).
**Fix:** Edit `~/Library/LaunchAgents/com.ronen.threadbase.plist` so `ProgramArguments` includes the port flag (and `--verbose` for log parity with the deploy script):

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/Users/ronen/.threadbase/launchd-entry.cjs</string>
  <string>serve</string>
  <string>--port</string>
  <string>8766</string>
  <string>--verbose</string>
  <string>--prod</string>
</array>
```

(The shim at `launchd-entry.cjs` is the post-2026-05-30 layout; it `exec`s `cli.js`. The trailing `--prod` tells the action to skip dev-takeover logic.)

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

## Prod/dev coordination

The streamer can be supervised by launchd ("prod") or run ad-hoc from a shell ("dev"). They coordinate via `~/.threadbase/prod-suspended.json`. Background and the marker decision table are in [CLAUDE.md](../CLAUDE.md) under "Prod/dev coordination (macOS)".

### Prod is down but `launchctl list` shows the agent loaded and exiting cleanly *(macOS)*

**When:** `tb-streamer prod status` prints `agent: loaded, pid: (none)`. `launchctl print "gui/$(id -u)/com.ronen.threadbase" | grep last\ exit` shows `0`. `~/.threadbase/prod-suspended.json` exists.
**Cause:** The suspension marker is present, so the shim is exiting 0 on every launchd start attempt. Because the plist has `KeepAlive: SuccessfulExit=false`, launchd does not respawn. Two sub-cases:
- `userHeld: true` → a dev session previously took the port and exited cleanly (SIGINT / SIGTERM). Prod is intentionally held down.
- `userHeld: false` and `devPid` is still alive → a dev session is currently using the port; this is expected.
- `userHeld: false` and `devPid` is dead → stale marker. Should not happen because the shim auto-clears it on the next launchd retry; if you see it, the agent may have been booted out (`launchctl list` would not show it).

**Diagnosis:** `cat ~/.threadbase/prod-suspended.json | jq` and check `userHeld` + whether `devPid` is alive (`ps -p <devPid>`).

**Fix:**
- If `userHeld: true` and you want prod back: `tb-streamer prod start` (clears marker + kickstarts).
- If `devPid` is alive: nothing to do; the dev session is using the port. Confirm with `lsof -iTCP:8766 -sTCP:LISTEN`.
- If marker looks stale: `tb-streamer prod doctor --fix` (clears markers whose `devPid` is dead and `userHeld` is false).

---

### `tb-streamer serve` hangs on a prompt and there is no TTY *(macOS)*

**When:** Running `tb-streamer serve` from a non-interactive context (CI, a background job, a launchd-but-not-marked-prod plist) and the process appears to hang.
**Cause:** Prod is running on the requested port, the action enters the conflict path, and the interactive prompt is reading from a closed stdin.
**Fix:** Pass `--replace-prod` (always take the port) or `--port <N>` with a different port. For launchd-spawned services, the shim's plist already includes `--prod` which short-circuits the prompt logic entirely; if you wrote a custom plist, add `--prod`.

---

### Dev process crashed but launchd isn't restarting prod *(macOS)*

**When:** Dev process was killed (`kill -9`, OOM, panic). Marker file at `~/.threadbase/prod-suspended.json` still exists with `userHeld: false` and the dead PID. Prod still appears down.
**Cause:** Crash recovery happens inside the shim. The shim only runs when launchd attempts a start; with `KeepAlive: SuccessfulExit=false` launchd waits for a non-zero exit OR an explicit `kickstart`. The previous start exited 0 (from the live-dev branch), so launchd is idle.
**Fix:** `tb-streamer prod start` (clears the marker and kickstarts). On the next start attempt the shim sees no marker and `exec`s `cli.js`. Or run `tb-streamer prod doctor --fix` if you want the marker cleared without restarting prod.

---

### Plist still references `cli.js` directly after upgrade *(macOS)*

**When:** `cat ~/Library/LaunchAgents/com.ronen.threadbase.plist | grep ProgramArguments -A8` shows `<string>$HOME/.threadbase/cli.js</string>` instead of `launchd-entry.cjs`. Symptoms: `--replace-prod` works but a clean dev exit doesn't suppress prod because the shim isn't in the chain.
**Cause:** Old plist from before the lifecycle work was deployed. The deploy script's `ensure_plist_healthy` self-heals this on the next `npm run deploy`, but if you haven't re-deployed yet the old layout persists.
**Fix:** `cd <repo> && npm run deploy` — the self-heal rewrites three stale layouts: missing `EnvironmentVariables`, ProgramArguments pointing at `cli.js`, and bare-bool `KeepAlive`. Backup is saved to `*.plist.bak.<epoch>`.

---

### Marker file is malformed (manual edit gone wrong) *(macOS)*

**When:** `tb-streamer prod status` logs `marker at /Users/.../prod-suspended.json is malformed; treating as absent`.
**Cause:** `readMarker` validates via the `MarkerSchema` (zod). Any missing field, wrong type, or invalid `shimVersion` returns null. JSON parse errors do the same.
**Fix:** The shim already treats malformed markers as absent. Delete the file: `rm ~/.threadbase/prod-suspended.json` and then `tb-streamer prod start` to restore prod.

---

### `tb-streamer prod status` reports `agent: NOT loaded` after a successful deploy *(Windows)*

**When:** `scripts\deploy.ps1` finished without errors, but `tb-streamer prod status` says the task isn't loaded.
**Cause:** Either the task name differs from `Threadbase` (e.g. `$env:THREADBASE_TASK_NAME` was set during install but isn't exported in the shell where you ran the status command), or the task was disabled by an earlier `tb-streamer prod stop`.
**Diagnosis:** `Get-ScheduledTask -TaskName Threadbase` from a fresh PowerShell — if it returns the task with `State: Disabled`, run `tb-streamer prod start` to re-enable + start. If it reports "not found", confirm `$env:THREADBASE_TASK_NAME` matches at both deploy time and runtime.

---

### `tb-streamer serve` from a dev shell hangs without printing the prompt *(Windows)*

**When:** Port 8766 is bound (prod is running). You run `tb-streamer serve` from a regular PowerShell. Nothing happens for >30s.
**Cause:** `process.platform === "win32"` so the dev branch fires, but `readline.question` is waiting on a stdin that's been redirected (e.g. running inside a non-terminal IDE pane or under PowerShell ISE).
**Fix:** Run from `cmd.exe` or `powershell.exe` directly, not from VS Code's integrated terminal in a backgrounded debug session. Or pass `--replace-prod` to skip the prompt entirely.

---

### `--replace-prod` succeeds but prod restarts immediately *(Windows)*

**When:** `tb-streamer serve --replace-prod` reports "prod stopped" but within seconds the same port is reclaimed by the prod task.
**Cause:** Task Scheduler's `Stop-ScheduledTask` returns before the underlying node process exits. If the at-logon trigger has retried, a second instance can start in the window between dev's bind attempt and the OS releasing the port.
**Fix:** Verify the task is disabled: `Get-ScheduledTask -TaskName Threadbase | Select-Object State` should show `Disabled`. If it shows `Ready`, the disable failed; re-run from an elevated PowerShell. If it's already Disabled but the port is still held, find and kill the lingering process: `netstat -ano | findstr :8766` shows the PID; `Stop-Process -Id <pid> -Force`.

---

### `task-scheduler.getAgentPid()` returns null even though the task is running *(Windows)*

**When:** `tb-streamer prod status` shows `agent: loaded, pid: (none)`. `Get-Process node` shows a node process. `netstat -ano | findstr 8766` shows the port bound.
**Cause:** The WMI query in `getAgentPid` filters by `CommandLine -like '*cli.js*serve*'`. If `launch.cmd` was hand-edited to use a different invocation pattern, the query returns nothing.
**Fix:** Either revert `launch.cmd` to the deploy-script-generated form (run `npm run deploy:windows` to trigger `Repair-LaunchCmd`), or update the WMI filter in `src/lifecycle/task-scheduler.ts` to match your custom command line.

---

## Native modules / ABI mismatches

### `better-sqlite3` `ERR_DLOPEN_FAILED` after a Node major upgrade

**When:** Server starts and accepts requests, but `~/.threadbase/logs/stderr.log` repeats:
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

---

### `npm test` (and therefore `npm run deploy`) fails with `NODE_MODULE_VERSION` mismatch on `better-sqlite3`

**When:** Running `npm run deploy` (or `npm test` directly) shortly after a system Node upgrade. The test step prints dozens of failures shaped like:
```
The module '.../node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 137.
→ Cannot read properties of undefined (reading 'close')
```
The `Cannot read properties of undefined` is a red herring — it's the `afterEach` calling `.close()` on a `cache` variable that was never assigned, because `ConversationCache.open()` threw on the native `require`.

**Cause:** Sibling problem to the "deployed `releases/node_modules` after a Node major upgrade" entry above — but for the *repo's* `node_modules`, not `~/.threadbase/releases/node_modules`. The repo's prebuilt `better-sqlite3` binary is locked to whatever Node ABI was current when `npm install` last ran. Once the system Node moves to a new major (or sometimes minor) the ABI no longer matches and every test that touches the cache fails.

**Fix:** `npm test` (and `npm run deploy`) now run `npm rebuild better-sqlite3` automatically via a `pretest` hook — just re-run the failing command and it will self-heal:
```sh
npm run deploy
```
If you also see `node-pty` complain (it didn't in this incident, but it's the other native dep), rebuild it manually: `npm rebuild node-pty`.

**Staying on the right Node version:** the repo pins its Node version in `.nvmrc`. Use your version manager's auto-switch to avoid stale ABIs in the first place:

- **macOS / Linux (nvm):** `nvm use` in the repo root, or add `nvm use --silent` to your shell's `cd` hook via `nvm`'s `--auto-use` option.
- **Windows (fnm):** install [fnm](https://github.com/Schniz/fnm), then add `fnm env --use-on-cd | Out-String | Invoke-Expression` to your PowerShell profile (`$PROFILE`). fnm reads `.nvmrc` automatically on `cd`.
- **nvm-windows:** reads `.nvmrc` but requires a manual `nvm use` — no auto-cd hook.

**Diagnosis cue:** the `NODE_MODULE_VERSION 127 / 137` mismatch is the real signal. If you only see "Cannot read properties of undefined (reading 'close')" you're looking at the cascade, not the cause — scroll up in the test output for the `NODE_MODULE_VERSION` line.

---

## Menubar packaging

The menubar (`vendor/menubar`) is shipped as an installed `.app` under `/Applications/Threadbase Menubar.app`. `scripts/deploy.sh` builds via electron-builder, mounts the produced `.dmg`, and copies the app into place. Several gotchas emerged during the initial rollout — collected here.

### `npm run package:mac` aborts with `CSSMERR_TP_CERT_REVOKED`

**When:** Building the menubar on a Mac whose login keychain has any revoked code-signing identity (commonly a stale Apple Development cert from a previous device or EAS-managed build).
**Cause:** electron-builder auto-discovers signing identities by scanning the keychain. If `mac.identity` is unset and the first match is a revoked cert, `codesign --verify` aborts the build with `CSSMERR_TP_CERT_REVOKED`.
**Fix:** the menubar's `electron-builder.config.js` sets `mac.identity` conditionally. When `APPLE_TEAM_ID` is unset (work-Mac path), `identity` is explicitly `null` — forcing ad-hoc signing and bypassing keychain discovery. When `APPLE_TEAM_ID` is set (signing-config sourced), `identity` becomes `"(<team>)"` so only certs belonging to that team are considered. Don't remove the conditional even if your keychain happens to be clean today.

### `Application entry file "dist/main.js" … does not exist` despite the file being present

**When:** Running `npm run package:mac:dir` and seeing the build fail with this error, even though `dist/main.js` clearly exists.
**Cause:** electron-builder isn't loading `electron-builder.config.js`. Auto-discovery only handles `.yml` / `.yaml` / `.json` configs; `.js` configs require explicit `-c <path>`. Without the flag, electron-builder uses only the `package.json` `build` block (or its defaults) — which point at different output dirs, different `productName`, and may not match the rest of the toolchain.
**Fix:** the `package:mac` and `package:mac:dir` scripts in `vendor/menubar/package.json` already pass `-c electron-builder.config.js`. If invoking `npx electron-builder` by hand, pass it yourself.

### `open -a "Threadbase Menubar"` launches the wrong `.app`

**When:** After `scripts/deploy.sh menubar` reports success, the running process is from `vendor/menubar/release/mac-arm64/...` instead of `/Applications/Threadbase Menubar.app`.
**Cause:** macOS LaunchServices caches a registry of `.app` bundles by ID, and `open -a "<name>"` resolves through that registry. If the cache was populated by a previous `package:mac:dir` run (which left a `.app` under `release/`), it can win over the freshly-installed copy.
**Fix:** `ensure_menubar_deployed` in `scripts/deploy.sh` calls `lsregister -f "$target"` after copying the new bundle into place to refresh the registry, then uses direct-path `open "$target"` (not `open -a`). If you debug by hand, do the same: `lsregister -f /Applications/Threadbase\ Menubar.app && open /Applications/Threadbase\ Menubar.app`.

### Tray icon is invisible on a dark menu bar

**When:** Menubar runs (verified via `pgrep -f "Threadbase Menubar"`) but no tray icon appears on the menu bar.
**Cause:** the tray PNGs are state-coloured rounded squares (dark green / near-black / dark red) on a transparent background. Against macOS Dark-mode menu bars, the dark-green / near-black variants have very low contrast — the icon is rendered but easy to miss.
**Fix:** confirm the icon is actually there before assuming it's broken. Check the right side of the menu bar carefully, or hide a few icons with Bartender / Hidden Bar to make space. Long-term fix is to switch to template-image style (monochrome glyph that auto-tints to match menu bar appearance) — tracked but not implemented.

### `--publish-menubar` refuses to upload

**When:** Running `scripts/deploy.sh --publish-menubar` errors with one of:
- `--publish-menubar requires ~/.threadbase/menubar-signing.env`
- `--publish-menubar requires gh CLI`
- `--publish-menubar requires gh auth — run 'gh auth login' first`
- `refusing to publish unsigned build — source ~/.threadbase/menubar-signing.env first`

**Cause:** the publish flow has hard preconditions: signing config + `gh` CLI + `gh auth`. The flag fails fast before doing any work to avoid spending 5 minutes building a `.dmg` only to refuse the upload.
**Fix:** this is by design. The intended workflow (per the project's two-Mac split) is to run `--publish-menubar` only on the build machine that has the Developer ID cert + App Store Connect API key. On a work Mac without the cert, run plain `scripts/deploy.sh` (or `scripts/deploy.sh menubar`) — that builds and installs locally without publishing.

### `git submodule update --init` resets `vendor/menubar` to an older SHA

**When:** Running parts of `scripts/deploy.sh` in a way that triggers the submodule-init code path *before* the parent's submodule pointer has been bumped.
**Cause:** `git submodule update --init` is destructive. If the parent repo's pinned SHA is older than the working tree of the submodule, the working tree is reset to the pinned SHA — wiping uncommitted submodule work.
**Fix:** when iterating on the menubar in tandem with deploy-script changes:
1. Always commit and push the submodule first
2. Bump the submodule pointer in the parent (`git add vendor/menubar`) and commit
3. Only then re-run anything in `scripts/deploy.sh` that might call `git submodule update`

If you've already lost work, it's not gone if you pushed: `git -C vendor/menubar fetch origin main && git -C vendor/menubar reset --hard origin/main`.

### `npm ci` fails inside `ensure_menubar_deployed`

**When:** Deploy fails at `cd vendor/menubar && npm ci`.
**Cause:** `package-lock.json` is out of sync with `package.json`. Common after manually editing dependencies without re-running `npm install`.
**Fix:** run `cd vendor/menubar && npm install` to regenerate the lockfile, commit it, push the submodule, bump the parent pointer, then retry deploy. The script intentionally uses `npm ci` (strict) rather than `npm install` (loose) so that locked dependency versions are guaranteed at deploy time.

## Auto-update

### `threadbase-streamer update` prints "No update config found"

**When:** First invocation on a fresh install, before `~/.threadbase/update.yaml` exists.
**Cause:** Auto-update is opt-in. Without the config file the updater refuses to guess a repo.
**Fix:** copy `update.yaml.example` from the repo root to `~/.threadbase/update.yaml` and edit. The minimum required line is `github_repo: <owner>/<name>`.

### Scheduled updater installed but never fires

**When:** `scripts/install-auto-update.sh` (or `.ps1`) reported success, but `~/.threadbase/logs/updater.log` is empty hours later.
**Possible causes:**
1. `auto_update:` was not set to `true` in `update.yaml` at install time. The installer skips registration silently in that case. **Fix:** edit `update.yaml`, then rerun the installer to register the job.
2. macOS: the launchd plist's `StartInterval` is measured in seconds, not minutes. Confirm via `launchctl list | grep updater`.
3. Linux: the systemd timer isn't enabled. `systemctl --user list-timers | grep threadbase` should show next-fire time.
4. Windows: a typo in `poll_interval_minutes` results in a task with no repetition. `Get-ScheduledTask -TaskName Threadbase-Updater | Get-ScheduledTaskTrigger` shows the actual schedule.

### `sha256 mismatch` on every install attempt

**When:** Updater fails right after download with `sha256 mismatch for threadbase-streamer-...`.
**Cause:** The release's `manifest.json` and the tarball it references were produced on different runs (or different commits) and don't agree on the hash. This typically means the matrix workflow uploaded a partial set before the manifest job ran.
**Fix:** re-run the failed matrix job(s) on the same release, or delete the GitHub release and re-trigger `release.yml`. The updater's refusal is correct — never bypass the hash check.

### Active-session check defers forever

**When:** `threadbase-streamer update` prints `Deferred: cannot determine active sessions (...)` repeatedly, even when no sessions are running.
**Cause:** The running streamer is reachable but returning errors to `GET /api/sessions?status=...`. Different from "streamer down" which would `proceed` instead of `defer`.
**Fix:** check the streamer's stderr log for what's actually breaking the request. As an interrupt-safe one-off, use `threadbase-streamer update --force` to override the defer. Don't make `--force` your scheduled-job flag — it interrupts live sessions.

### POST /api/__update returns 401 even with the correct shared secret

**When:** Webhook caller is signing with the right secret but receives 401.
**Cause:** the signature is over the *exact raw body bytes*. The most common mistake: signing a pretty-printed JSON string but POSTing minified JSON (or vice versa), or signing with a trailing newline the body doesn't include.
**Fix:** ensure caller signs and sends byte-identical content. The verifier expects either a bare hex string or `sha256=<hex>` in the `X-Threadbase-Signature` header.

### Update succeeds but `current` still points at the old version on Windows

**When:** Streamer restarts on the old version after a reported-successful update.
**Cause:** the copy-deploy hit `EBUSY` because the streamer was still holding open handles inside `current/dist/cli.cjs`. `stopService()` should have been called first; if it failed silently, the copy completes on the `.new` directory but `rename` won't overwrite the live tree.
**Fix:** run `Stop-ScheduledTask -TaskName Threadbase`, then `scripts/install-auto-update.ps1` won't be needed — just rerun `threadbase-streamer update`. If this is repeatable, file a bug — `install.ts` is supposed to handle this on Windows.

---

## PTY / terminal output

### SSH passphrase prompt leaks into streamed terminal output *(macOS)*

**When:** A session is started on a Mac where the SSH agent is not running or the key is not loaded into it. The PTY output contains `Enter passphrase for key '/Users/<you>/.ssh/id_ed25519':` which is streamed verbatim to WebSocket clients — visible in the tb-mobile terminal view mid-conversation.

**What it looks like:** The mobile app shows the session as `Running` with a normal prompt count, but the terminal output contains:

```
Enter passphrase for key '/Users/ronenmars/.ssh/id_ed25519':
  Sonnet 4.6 | ~/Desktop/dev/ai-tools/tb-mobile  fix/ship-branch-sync-check ...
```

**Cause:** tb-streamer streams raw PTY bytes to all WebSocket subscribers without filtering for interactive prompts. When `SSH_AUTH_SOCK` is absent or points to a dead socket, SSH falls back to prompting the PTY directly. The PTY captures the prompt and it becomes part of the output stream.

Common root causes:
- `~/.ssh/config` has `IdentityAgent` pointing at a 1Password socket (`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`) that no longer exists.
- The macOS SSH agent (`com.openssh.ssh-agent`) is running but `SSH_AUTH_SOCK` is not exported into the PTY's environment (set in the launchd plist or shell but not inherited by the PTY subprocess).
- The key has never been added to the Keychain, so the agent starts empty after every reboot.

**Fix:**

1. Replace the 1Password `IdentityAgent` in `~/.ssh/config` with native macOS keychain settings:

```
Host *
  UseKeychain yes
  AddKeysToAgent yes
  IdentityFile ~/.ssh/id_ed25519
```

2. Add the key to Keychain (one-time, prompts for passphrase once):

```sh
eval "$(ssh-agent -s)"
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

3. Ensure the agent starts in every new shell (add to `~/.zshrc` or equivalent):

```sh
if ! ssh-add -l &>/dev/null; then
  eval "$(ssh-agent -s)" &>/dev/null
fi
```

After this, `SSH_AUTH_SOCK` resolves correctly in PTY subprocesses and the passphrase prompt never appears.

**Note:** tb-streamer does not filter PTY output for interactive prompts by design — the terminal view is meant to be a faithful mirror of what would appear in a local terminal. The fix is always on the SSH agent side, not in the streaming layer.

**Related entry in tb-mobile:** see "SSH passphrase prompt appears mid-conversation in the terminal view" in `docs/troubleshooting.md`.

---

## Native module / Node.js version mismatch

### `better-sqlite3` compiled against wrong Node ABI — cache fails to open, `/api/conversations/count` returns 500

**When:** After upgrading Node.js (e.g. via Homebrew), the prod service starts but the SQLite cache never opens. Every call to `/api/conversations/count`, `/project-chats`, or `/api/conversations` returns 500. Mobile shows "Couldn't refresh sessions from \<server name\>".

**Symptom in `~/.threadbase/logs/stderr.log`:**
```
ConversationCache failed to open (running without cache): The module
'/Users/<you>/.threadbase/releases/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 147. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

**Cause:** `better-sqlite3` is a native Node addon. The deployed release in `~/.threadbase/releases/` bundles a prebuilt binary compiled for a specific Node ABI. When the Node.js version used by launchd (set via `ProgramArguments` in the plist) changes — typically because Homebrew upgraded Node — the ABI no longer matches and the module refuses to load.

**Critical detail:** launchd runs the binary specified in the plist (`/opt/homebrew/bin/node`), which may differ from the `node` on your interactive shell `$PATH` (e.g. nvm-managed). Rebuilding with the wrong Node silently fixes nothing.

**Fix:**

1. Identify the Node binary launchd uses:
```sh
grep -A2 'ProgramArguments' ~/Library/LaunchAgents/com.ronen.threadbase.plist | grep node
# e.g. /opt/homebrew/bin/node
```

2. Rebuild `better-sqlite3` using **that exact Node** (via its paired `npm`):
```sh
cd ~/.threadbase/releases
/opt/homebrew/bin/npm rebuild better-sqlite3
```

3. Restart the prod service:
```sh
tb-streamer prod restart
```

4. Verify the cache is working:
```sh
curl -s -H "Authorization: Bearer <api_key>" http://localhost:8766/api/conversations/count
# should return {"total":<N>}, not a 500 or module error
```

**Note:** This needs to be repeated any time Homebrew upgrades the Node formula (`brew upgrade node`). The auto-updater does not currently rebuild native addons after a Node upgrade — that is a known gap.

---

## Windows: deploy script and auto-updater conflict on `launch.cmd` entry point

**When:** On Windows, after running `npm run deploy:windows` following a previous auto-update (or vice versa), the streamer fails to start and the healthcheck times out.

**Cause:** The two update paths write to different entry points and do not stay in sync:

| Path | What it writes | What `launch.cmd` should use |
|---|---|---|
| `scripts/deploy.ps1` | `~/.threadbase/cli.js` (copies built `dist/cli.cjs` directly) | `cli.js` |
| Auto-updater (`update` command) | `~/.threadbase/current/dist/cli.cjs` (extracts tarball into `current/`) | `current\dist\cli.cjs` |

After a local deploy, `launch.cmd` points to `cli.js`. After an auto-update, `current/` holds the new binary but `cli.js` is stale. After a local deploy following an auto-update, `cli.js` is updated but `launch.cmd` may still point to `current\dist\cli.cjs`.

**Fix (permanent — v1.18.3+):** `swapCurrent()` now syncs `cli.js` after every auto-update swap on all platforms — Windows copies the file, macOS/Linux atomically repoints the symlink. The service entry point (`launch.cmd` / launchd plist / systemd unit) always resolves to the correct binary via `cli.js`.

**Manual fix (before v1.18.3 or when the service won't start):**

1. Check which path `launch.cmd` currently uses:
```cmd
type %USERPROFILE%\.threadbase\launch.cmd
```

2. If it points to `current\dist\cli.cjs` but `cli.js` was just updated by the deploy script, change it back:
```powershell
(Get-Content "$env:USERPROFILE\.threadbase\launch.cmd") `
  -replace 'current\dist\cli\.cjs', 'cli.js' |
  Set-Content "$env:USERPROFILE\.threadbase\launch.cmd"
```

3. Restart the task:
```powershell
Stop-ScheduledTask -TaskName 'Threadbase'
$p = Get-NetTCPConnection -LocalPort 8766 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
if ($p) { Stop-Process -Id $p -Force }
Start-ScheduledTask -TaskName 'Threadbase'
```

**Note:** After any auto-update, also run `npm rebuild` in `~/.threadbase/current/` if the Node.js version on the machine differs from the one the release was compiled for — see the `better-sqlite3` Node ABI mismatch section above.

---

## `npm run build` fails DTS step with `TS5101: Option 'baseUrl' is deprecated`

**When:** The `build` job (CI or local) fails only at the `DTS Build` step with:

```
error TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0. Specify compilerOption '"ignoreDeprecations": "6.0"' to silence this error.
```

The ESM/CJS bundles build fine — only declaration generation fails.

**Cause:** `tsconfig.json` **must** keep `"ignoreDeprecations": "6.0"`. The deprecated `baseUrl` is **not** in our tsconfig — tsup's DTS worker injects `baseUrl` internally when generating declarations, and TypeScript 6.0 flags that injected option. `ignoreDeprecations: "6.0"` is the only way to silence it. Removing the option (on the mistaken belief that TS 6.0 dropped it — it didn't; that happens in TS 7.0) breaks the build. This is exactly what closed PR #152 did.

**Fix:** Keep `"ignoreDeprecations": "6.0"` in `tsconfig.json`'s `compilerOptions`. `main` already has it (added in the TS 6.0 bump, #119). Do not remove it.

**TypeScript 7.0 heads-up:** `ignoreDeprecations: "6.0"` stops working in TS 7.0, so this recurs on that upgrade. The real fix then is to move DTS generation off tsup's worker (which is what injects `baseUrl`) — e.g. a separate `tsc --emitDeclarationOnly` pass — rather than touching our tsconfig.

---

## Host machine grinds to a halt, PowerShell windows flash every few seconds

**When:** A Windows machine that has ever run this project under PM2 (not this repo's own Task Scheduler-based deploy) becomes severely slow — high CPU/disk I/O, Defender constantly scanning, and a console/PowerShell window briefly flashing every second or so.

**Cause:** Not a bug in this repo. On one dev machine, a PM2 process named `threadbase-streamer` was pointed at a **stale global npm install under the old, pre-rename package scope** — `C:\Program Files\nodejs\node_modules\@threadbase\streamer\dist\cli.cjs` (note: no `-sh`). That scope never held a working install (its `node_modules` had gone missing, and `@threadbase/streamer` 404s on the public npm registry — this repo has only ever published as `@threadbase-sh/streamer`). Every PM2 launch attempt hit `MODULE_NOT_FOUND` and crashed instantly; PM2's default restart-on-crash has no backoff, so it respawned as fast as it could crash — **22,832,283 restarts** over ~2.5 months (`pm2 describe threadbase-streamer` showed the counter; `pm2 list` showed status `stopped` because it had exceeded PM2's internal crash-loop detection).

Two side effects compounded the damage:
- The per-app error log (`~/.pm2/logs/threadbase-streamer-error.log`) grew to **18.8 GB** — the same `MODULE_NOT_FOUND` stack trace written millions of times.
- The **PM2 daemon's own log** (`~/.pm2/pm2.log`, separate from the per-app log) grew to **9 GB** over the same period, mirroring every `starting → online → exited` cycle. This is easy to miss if you only clean up the per-app log.

This PM2-managed install is entirely separate from this repo's supported deploy/update path: production instances on Windows run via **Task Scheduler** (`Threadbase` + `Threadbase-Updater` tasks, see "Prod/dev coordination" in `CLAUDE.md`), pointing at `~/.threadbase/cli.js`. That path was healthy the whole time — the hourly `Threadbase-Updater` task only touches `~/.threadbase/`, never `Program Files\nodejs\node_modules`. The auto-updater did not cause and could not have caught this.

**Fix (host-side, once per affected machine):**
```powershell
pm2 stop threadbase-streamer; pm2 delete threadbase-streamer
pm2 save --force                                          # persist the now-empty process list so it doesn't resurrect on next login
Remove-Item 'C:\Users\<user>\.pm2\logs\threadbase-streamer-error.log' -Force
Remove-Item 'C:\Users\<user>\.pm2\pm2.log' -Force          # don't forget the daemon log, not just the per-app one
Remove-Item 'C:\Program Files\nodejs\node_modules\@threadbase' -Recurse -Force   # empty leftover scope dir, if present
```

Check `pm2 list` and `Get-CimInstance Win32_StartupCommand | Where-Object Command -match 'pm2'` afterward — PM2 itself (via `pm2-windows-startup`) still resurrects on login, it will just start with zero registered processes.

**Prevention:** This repo does not use PM2 anywhere in its build, deploy, or update tooling, and should not gain a dependency on it. If you ever do supervise a Threadbase process with PM2 for local experimentation, always set crash-loop protection so a bad start fails loud instead of eating the disk:
```js
{ max_restarts: 10, min_uptime: 5000, restart_delay: 2000 }
```
and install `pm2-logrotate` so no single log can grow unbounded.
