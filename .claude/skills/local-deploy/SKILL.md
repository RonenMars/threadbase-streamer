---
name: local-deploy
description: Build, stamp, and (re)launch threadbase-streamer locally via scripts/deploy.sh. On a fresh install (no ~/.threadbase/cli.js or launchd plist), prompt the user to pick PostgreSQL persistence vs memory-only mode and bootstrap the launchd job before the first deploy. Use when the user says "deploy locally", "redeploy threadbase", "ship a local build", "install threadbase on this machine", or wants to update the running streamer.
---

# Local deploy

Wraps `scripts/deploy.sh` plus first-run setup. The deploy script (already in this repo) handles build → stamp → atomic symlink swap → launchd kickstart → healthcheck. This skill adds the missing fresh-install bootstrap.

## Prerequisites

- macOS. The deploy script uses `launchctl`. On Linux/Windows, fall back to manual `npm run build && node dist/cli.cjs serve --port <p>` and tell the user this skill is macOS-only for now.
- `node` (>=18) on PATH.
- Repo on `main` with a clean working tree (or use `--force`).

## Step 1 — Classify the install state

Check both signals:

```bash
test -L "$HOME/.threadbase/cli.js" && echo "have-symlink" || echo "no-symlink"
launchctl print "gui/$(id -u)/com.ronen.threadbase" >/dev/null 2>&1 && echo "have-job" || echo "no-job"
```

- Both present → **update**, skip to Step 3.
- Either missing → **fresh install**, do Step 2 first.

## Step 2 — Fresh install bootstrap

### 2a. Ask the user about persistence mode

Use `AskUserQuestion` with two options:

- **postgres** — managed sessions survive restarts; requires a `postgresql://…` URL (Neon, RDS, local Docker, etc.).
- **memory** — sessions held in-memory only, lost on restart. Zero config.

If they pick **postgres**, ask for the connection URI as a follow-up. Don't assume a default; require an explicit string.

### 2b. Generate an API key if missing

```bash
mkdir -p "$HOME/.threadbase"
chmod 700 "$HOME/.threadbase"
if [ ! -f "$HOME/.threadbase/server.yaml" ]; then
  printf 'api_key: tb_%s\n' "$(openssl rand -hex 16)" > "$HOME/.threadbase/server.yaml"
  chmod 600 "$HOME/.threadbase/server.yaml"
fi
```

### 2c. Write the launchd plist

Confirm the port with the user (default 8766). Resolve the absolute `node` path: `command -v node`. Then write `~/Library/LaunchAgents/com.ronen.threadbase.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ronen.threadbase</string>
  <key>ProgramArguments</key>
  <array>
    <string>{NODE_BIN}</string>
    <string>{HOME}/.threadbase/cli.js</string>
    <string>serve</string>
    <string>--port</string>
    <string>{PORT}</string>
    <string>--verbose</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{HOME}/.threadbase</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>{HOME}</string>
    {DB_BLOCK}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/threadbase.log</string>
  <key>StandardErrorPath</key><string>/tmp/threadbase.err</string>
</dict>
</plist>
```

`{DB_BLOCK}` is empty for memory mode, or:

```xml
<key>THREADBASE_DATABASE_URL</key>
<string>postgresql://…</string>
<key>THREADBASE_INSTANCE_ID</key>
<string>{HOSTNAME}</string>
```

for postgres mode (use `hostname -s` for the instance id).

### 2d. Bootstrap the launchd job

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ronen.threadbase.plist
```

The job will fail to start until Step 3 places `cli.js`, but `keepalive` will retry. That's expected.

## Step 3 — Deploy

```bash
npm run deploy
```

Variants worth offering when relevant:

- `npm run deploy:force` — skip lint + tests + dirty-tree check. Use for quick iteration only.
- `npm run deploy:update-scanner` — bump `vendor/scanner` to its remote main before building (also commit the submodule bump afterwards).

The script does: predeploy check → ensure scanner built → lint + tests → `npm run build` → stamp `~/.threadbase/releases/cli.<sha>.cjs` → atomic swap of `~/.threadbase/cli.js` → `launchctl kickstart -k gui/$(id -u)/com.ronen.threadbase` → healthcheck on `http://localhost:8766/healthz`.

## Step 4 — Report and verify

After deploy, run `npm run deploy:status` and summarize back to the user:

- Active release filename
- launchd PID and last-exit status
- Healthcheck result
- If the user has the `tb` shim installed, remind them they can now `tb pair` against the running server

If the healthcheck failed, surface the tail of `/tmp/threadbase.err` (the deploy script already prints the last 20 lines) and stop. Do not claim success.

## Out of scope

- Installing Node.js. If `node` is missing, fail with `https://nodejs.org/` and stop.
- Provisioning Postgres. We trust whatever URI the user provides.
- Editing shell rc files (lazy-nvm, PATH).
- Linux/Windows deployments — those need their own service-management story.
