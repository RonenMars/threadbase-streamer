---
name: deploy-menubar
description: Build and launch the Threadbase menubar Electron app from vendor/menubar. Run this after the streamer server is healthy (post local-deploy). Ensures the submodule is checked out, deps are installed, TypeScript is compiled, and the app is running. Use when the user says "launch the menubar", "start the tray app", "deploy menubar", or "set up the menubar".
---

# Deploy menubar

Builds and launches the `vendor/menubar` Electron app. Always run this **after** the streamer server is healthy — the menubar polls `/healthz` and needs the server up to show a green icon.

## Step 1 — Verify OS support

This skill supports macOS and Linux only. Windows does not have a supported Electron launch path here.

Check with `uname -s`:
- `Darwin` → macOS, proceed
- `Linux` → Linux, proceed
- Anything else → stop and tell the user this skill doesn't support their platform

## Step 2 — Ensure submodule is checked out

```bash
cd <repo-root>
if [[ ! -f vendor/menubar/package.json ]]; then
  git submodule update --init --recursive vendor/menubar
fi
```

## Step 3 — Install deps (idempotent)

Only run `npm install` if `node_modules` is missing or `package.json` is newer than `node_modules`:

```bash
cd vendor/menubar
if [[ ! -d node_modules ]] || [[ package.json -nt node_modules ]]; then
  npm install --silent
fi
```

## Step 4 — Build (idempotent)

Only recompile if `dist/` is missing or any `src/` file is newer than `dist/`:

```bash
cd vendor/menubar
need_build=0
if [[ ! -d dist ]]; then
  need_build=1
else
  newest_src="$(find src -type f -newer dist -print -quit 2>/dev/null || true)"
  [[ -n "$newest_src" ]] && need_build=1
fi

if (( need_build )); then
  npm run build
fi
```

## Step 5 — Check if already running

Skip launch if an Electron process for the menubar is already up:

```bash
pgrep -f "vendor/menubar" >/dev/null 2>&1 && already_running=1 || already_running=0
```

If `already_running=1`, report "menubar is already running" and stop — do not kill and relaunch unless the user explicitly asked for a restart.

## Step 6 — Launch

Run Electron detached so it survives the terminal session:

```bash
cd vendor/menubar
nohup npx electron . </dev/null >>/tmp/threadbase-menubar.log 2>&1 &
disown
```

Wait up to 3 seconds, then verify the process is still alive:

```bash
sleep 1
pgrep -f "vendor/menubar" >/dev/null 2>&1 && echo "menubar running" || echo "menubar exited immediately — check /tmp/threadbase-menubar.log"
```

## Step 7 — Report

On success: "Menubar launched. Tray icon should appear — gray until the streamer responds, then green."

On immediate exit: surface the last 20 lines of `/tmp/threadbase-menubar.log` and stop. Do not claim success.

## Notes

- The menubar default port is `3456`. If the streamer is running on a different port, set `THREADBASE_PORT=<port>` before launching:
  ```bash
  THREADBASE_PORT=8766 nohup npx electron . …
  ```
- `vendor/menubar` uses `tsc` (not tsup) — output lands in `dist/` with `main.ts` → `dist/main.js`.
- The renderer (`src/renderer/index.html`) is referenced as `../src/renderer/index.html` from `dist/` — this is intentional for dev; do not change the path.
- First launch: `config.json` won't exist yet, so the menubar auto-shows its popup for the "Launch at login" preference. This is expected behavior.
- Login-item registration (launch at login) is handled inside the app via the popup toggle — this skill does not configure it separately.
