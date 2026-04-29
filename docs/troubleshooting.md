# Troubleshooting Guide

Collected from fixed bugs, deploy incidents, and CLAUDE.md/SKILL.md history. Each section describes a symptom, its root cause, and the fix. Use this before digging into source.

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

### Tunnel routes to wrong port after config change

**When:** `cloudflared` service is running but traffic goes to the old port.
**Cause:** Two config files exist and must be kept in sync:
- `~/.cloudflared/config.yml` — used when running `cloudflared` manually
- `~/.cloudflared/config-system.yml` — used by the Windows service (SYSTEM account); this is the one that matters

**Fix:** Edit **both** files, then restart: `Restart-Service cloudflared`.

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
