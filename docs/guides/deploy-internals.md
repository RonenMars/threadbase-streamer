# Deploy internals

Reference for what the deploy scripts (`scripts/deploy.sh`, `scripts/deploy-linux.sh`, `scripts/deploy.ps1`) install and how. High-level summary lives in `CLAUDE.md`.

## Migrations

`npm run build` copies three migration trees into `dist/`: the SQLite conversation cache (`src/db/migrations/`), the SQLite session registry (`src/db/runtime-migrations/`), and Postgres (`src/db/pg-migrations/`). Deploy only ships the two SQLite ones to `~/.threadbase/` — Postgres persistence is dormant in production.

The registry tree is separate because it applies to a separate database file: `~/.threadbase/runtime.db`, which is authoritative and must survive a cache reset, rather than `cache/cache.db`, which is derived and disposable. Each file carries its own `schema_migrations` table.

## Global commands (`tb-streamer` / `threadbase-streamer`)

Every deploy installs two global commands wrapping `~/.threadbase/cli.js`: `threadbase-streamer` (entrenched name) and `tb-streamer` (short alias). Both work for every subcommand (`pair`, `update`, `serve`, ...).

- **macOS / Linux**: symlinks at the install dir.
- **Windows**: `.cmd` wrappers (symlinks aren't reliable without admin/Developer Mode).

Default install dir is the OS-standard location, falling back to a user-local dir if it's not writable:

| OS | standard | user-local |
|----|----------|-----------|
| macOS Apple Silicon | `/opt/homebrew/bin` | `~/.local/bin` |
| macOS Intel | `/usr/local/bin` | `~/.local/bin` |
| Linux | `/usr/local/bin` | `~/.local/bin` |
| Windows 10+ | `%LOCALAPPDATA%\Programs\threadbase-streamer\bin` | `%USERPROFILE%\.threadbase\bin` |

Interactive by default; non-interactive via `--install-shim=<standard|user-local|custom|skip>` / `--path-update=<print|auto|skip>` flags (or `TB_INSTALL_SHIM` / `TB_PATH_UPDATE` env vars; PowerShell equivalents `-InstallShim` / `-PathUpdate`). Shim install failures are non-fatal — the streamer itself is already up at that point.

The legacy `tb` shim (`scripts/install-tb.*`) is deprecated but still supported for existing installs; its one advantage is `THREADBASE_CLI`, an env var to point it at a custom CLI path without redeploying.

## Homebrew distribution

`brew install RonenMars/threadbase/tb-streamer` is an alternate end-user install. The formula (in `RonenMars/homebrew-threadbase`) is auto-regenerated on every stable release. `brew services` runs `serve --prod` under the `homebrew.mxcl.tb-streamer` launchd label (systemd on Linux). The prod/dev lifecycle resolves the loaded label at runtime, so `tb-streamer prod …` controls a brew-supervised instance the same way it controls a `scripts/deploy.sh` one. Manual test: [testing/homebrew-prod-manual-test.md](../testing/homebrew-prod-manual-test.md) (PR #71).

A machine can have the Homebrew install **or** the `scripts/deploy.sh` install, not both — they'd fight over port 8766.

## Menubar install

On macOS, `scripts/deploy.sh` ends every deploy by bringing the installed menubar up to the version the repo pins (`ensure_menubar_current`).
The same step runs on its own as `scripts/deploy.sh menubar`, with no streamer restart.

1. **Pinned version** — the `version` in `package.json` at the commit the `vendor/menubar` pointer records (`git rev-parse HEAD:vendor/menubar`), not the submodule checkout, which a `git pull` leaves behind.
2. **Installed version** — `CFBundleShortVersionString` of `Threadbase Menubar.app` in `/Applications`, then `~/Applications`.
3. **Compare** — the update runs only when pinned is strictly newer (`semver.gt`). Equal is "up to date"; a newer installed app is left alone.
4. **Download** — the release asset `Threadbase.Menubar-<version>-universal.dmg` from the menubar repo's `v<version>` release, cached in `~/.threadbase/releases/menubar/` (the two newest are kept).
5. **Verify** — the mounted bundle must report the pinned version, pass `codesign --verify --deep --strict`, and be accepted by Gatekeeper (`spctl -a`). Nothing has been touched up to here.
6. **Swap and relaunch** — the running app is asked to quit, the old bundle moves to `~/.threadbase/releases/menubar/previous.app`, the new one is copied in and opened by path.

The step is non-fatal: a missing release, a failed check or a failed copy logs a warning, leaves (or restores) the old app, and the deploy still reports success.
It skips when the app is not installed — a first install is manual, from the release `.dmg` — and when `vendor/menubar` is not initialised, as in a fresh worktree.
To roll back, quit the app and move `previous.app` back over it.

Linux and Windows deploys do not touch the menubar.
To run it from source instead, use the `deploy-menubar` skill (`.claude/skills/deploy-menubar`).

During install/update the streamer is briefly down (a few seconds); the menubar shows "disconnected" until its next 5s health poll. If that gap exceeds ~10s, something's wrong with the restart step — check `~/.threadbase/logs/updater.{log,err}`.

## Windows local deploys

Use `npm run deploy:windows` for the normal linted and tested deployment, or `npm run deploy:windows:force` when intentionally deploying a non-main integration checkout. The force path visibly skips lint, tests, the dirty-tree guard, and the advisory npm published-version lookup, so it never waits on an unavailable npm registry before building the selected checkout.

For a normal deploy where the registry lookup should be skipped but checks should still run, invoke PowerShell directly with `pwsh scripts/deploy.ps1 deploy -SkipVersionCheck`.

The Task Scheduler restart can finish after the script's 15-second healthcheck window. If it reports a timeout, verify the active release rather than redeploying blindly:

```powershell
curl.exe --max-time 5 http://127.0.0.1:8766/healthz
Get-ScheduledTaskInfo -TaskName 'Threadbase'
Get-Content "$env:USERPROFILE\.threadbase\version.txt"
```

An HTTP 200 with the expected version and `LastTaskResult` of `0` confirm that the deployment completed; see [the troubleshooting entry](../troubleshooting.md#deployps1-reports-healthcheck-failed-but-the-server-actually-started-fine-windows) for failure diagnosis.
