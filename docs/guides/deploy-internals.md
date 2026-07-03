# Deploy internals

Reference for what the deploy scripts (`scripts/deploy.sh`, `scripts/deploy-linux.sh`, `scripts/deploy.ps1`) install and how. High-level summary lives in `CLAUDE.md`.

## Migrations

`npm run build` copies both SQLite (`src/db/migrations/`) and Postgres (`src/db/pg-migrations/`) migrations into `dist/`. Deploy only ships the SQLite ones to `~/.threadbase/` — Postgres persistence is dormant in production.

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

`brew install RonenMars/threadbase/tb-streamer` is an alternate end-user install. The formula (in `RonenMars/homebrew-threadbase`) is auto-regenerated on every stable release. It runs the streamer under launchd/systemd via `brew services`, on port 8766, without `--prod` — Homebrew installs sit outside the prod/dev lifecycle scheme.

A machine can have the Homebrew install **or** the `scripts/deploy.sh` install, not both — they'd fight over port 8766.

## Menubar install

Each deploy tries to download a prebuilt menubar release matching the `vendor/menubar` submodule's commit SHA, and only builds it locally as a fallback (no matching release, or a fetch error). Installed sentinel: `~/.threadbase/menubar-installed-sha`. Force a local build with `--publish-menubar`.

During install/update the streamer is briefly down (a few seconds); the menubar shows "disconnected" until its next 5s health poll. If that gap exceeds ~10s, something's wrong with the restart step — check `~/.threadbase/logs/updater.{log,err}`.
