# Deploy internals

Detail reference for the deploy scripts' install steps: the global command shims, Homebrew distribution, migrations-at-deploy layout, and the menubar install flow. The high-level summary lives in `CLAUDE.md`.

## Migrations at deploy

`npm run build` copies both `src/db/migrations/` (SQLite) and `src/db/pg-migrations/` (Postgres) into `dist/`. Deploy scripts currently copy only `dist/migrations/` (SQLite). That is sufficient for the SQLite-first runtime. `dist/pg-migrations/` is NOT shipped to `~/.threadbase/`; the Postgres path is dormant. If/when Postgres persistence is re-enabled in production, the deploy scripts must be extended to copy `dist/pg-migrations/` alongside `dist/migrations/`.

- macOS/Linux: symlink makes `__dirname` = `~/.threadbase/releases/` → copy SQLite migrations to `~/.threadbase/releases/migrations/`
- Windows: `cli.js` is a real copy at `~/.threadbase/` so `__dirname` = `~/.threadbase/` → copy SQLite migrations to `~/.threadbase/migrations/`

## Global `threadbase-streamer` / `tb-streamer` command

At the end of every deploy, the three deploy scripts (`scripts/deploy.sh`, `scripts/deploy-linux.sh`, `scripts/deploy.ps1`) install **two** global commands that both wrap `~/.threadbase/cli.js`:

- `threadbase-streamer` — the entrenched name, used throughout existing docs (auto-update guide, troubleshooting) and by `scripts/install-auto-update.{sh,ps1}` to invoke the updater from a scheduled job.
- `tb-streamer` — short alias matching the npm package + repo name. Functionally identical.

Both names work for every subcommand: `pair`, `update`, `serve`, etc.

Shared helpers live in `scripts/lib/install-shim.sh` (sourced by both bash deploy scripts) and `scripts/lib/install-shim.ps1` (dot-sourced by `deploy.ps1`). Each platform's wrapper is different:

- **macOS / Linux**: two symlinks at the install dir → `~/.threadbase/cli.js`.
- **Windows**: two `.cmd` wrappers at the install dir that run `node "%USERPROFILE%\.threadbase\cli.js" %*`. Symlinks aren't reliable on Windows without Developer Mode or admin.

Adding or removing a name is a one-line edit to `_shim_command_names` (bash) / `Get-ShimCommandNames` (PowerShell).

Default install dir is "standard" per OS — but the deploy will fall back to user-local automatically if the standard dir isn't writable:

| OS | standard | user-local |
|----|----------|-----------|
| macOS Apple Silicon | `/opt/homebrew/bin` | `~/.local/bin` |
| macOS Intel | `/usr/local/bin` | `~/.local/bin` |
| Linux | `/usr/local/bin` | `~/.local/bin` |
| Windows 10+ | `%LOCALAPPDATA%\Programs\threadbase-streamer\bin` | `%USERPROFILE%\.threadbase\bin` |

Default behavior is **interactive prompt**. Non-interactive overrides (for CI / `local-deploy` skill / scripted invocations):

- Bash: `--install-shim=<standard|user-local|custom|skip>` flag, `--path-update=<print|auto|skip>` flag, or `TB_INSTALL_SHIM` / `TB_PATH_UPDATE` env vars. Custom dir via `TB_CUSTOM_INSTALL_DIR`.
- PowerShell: `-InstallShim <…>` / `-PathUpdate <…>` params, or the same env vars.

`path-update=auto` appends an `export PATH=…` line to `~/.zshrc` or `~/.bashrc` (detected from `$SHELL`) with a marker comment so re-runs are idempotent. On Windows, `auto` updates the User PATH via `[Environment]::SetEnvironmentVariable(...)` — the change requires opening a new terminal to take effect.

Shim install failures are **non-fatal**: the deploy logs a warning and continues. The streamer itself is already healthy at that point — only the convenience command is at stake.

## Homebrew distribution

`brew install RonenMars/threadbase/tb-streamer` is an alternate install path for end users. The formula lives in `RonenMars/homebrew-threadbase` and is regenerated on every stable release by `scripts/build-formula.mjs` + `scripts/publish-formula.sh`, invoked from `.github/workflows/release.yml` after `semantic-release` finishes.

Homebrew installs the binary into `libexec/`, exposes `tb-streamer` on PATH, and registers `brew services start tb-streamer` to run it under launchd (macOS) or systemd (Linux). The formula's `service` block uses port 8766 and `--prod` is NOT passed — Homebrew installs are not part of the prod/dev lifecycle scheme.

Pre-releases (`next` channel) are NOT published to the tap. Pre-release users continue to use the GitHub release tarball.

A user can have either the Homebrew install OR the `scripts/deploy.sh` install, not both — both bind port 8766 with different launchd labels. Detection is deferred (see `docs/ROADMAP.md` "Homebrew vs `scripts/deploy.sh` plist conflict-check at startup"). Caveats in the formula warn users.

## Menubar install flow — download first, build only as fallback

The deploy scripts no longer build the menubar locally by default. Each deploy:

1. Resolves the submodule HEAD commit SHA.
2. Calls `scripts/lib/fetch-menubar.{sh,ps1}` to look up a GitHub Release on `RonenMars/threadbase-menubar` whose underlying commit SHA matches the submodule. The matching strategy handles both rolling pre-releases (where `target_commitish` is the commit SHA, e.g. `latest-main`) and tagged releases (where the tag ref is resolved and annotated tags are peeled). First match wins.
3. On match: downloads the OS-specific artifact via plain HTTPS (no `gh` CLI dependency — only `curl` + `node` on Unix, native `Invoke-WebRequest` on Windows). Installs it:
   - macOS: mount `.dmg`, `cp` `.app` to `/Applications/Threadbase Menubar.app`, `lsregister -f`.
   - Linux: write `.AppImage` to `~/.local/bin/threadbase-menubar.AppImage`, `chmod +x`, launch via `nohup`.
   - Windows: run NSIS installer with `/S` (silent), which installs to `%LOCALAPPDATA%\Programs\Threadbase Menubar\`.
4. On miss (no release for this SHA, or release exists but lacks the OS-specific artifact): falls back to the per-OS local build/run flow — electron-builder `.dmg` on macOS, in-tree `npx electron .` on Linux/Windows.
5. On fetch error (network, GH API rate limit, parse failure): prints the issues URL (`https://github.com/RonenMars/threadbase-menubar/issues`) + the path to the error log (`~/.threadbase/logs/menubar-fetch.log`) and then falls back to local build/run.

The unified install sentinel is `~/.threadbase/menubar-installed-sha` (all three OSes). The previous per-platform sentinels (`vendor/menubar/dist/.build-sha` on Linux/Windows) were unreliable because `npm install` clobbers the `dist/` directory; the streamer-side `~/.threadbase/` location survives rebuilds.

**`--publish-menubar` forces a local build** (it would make no sense to upload a downloaded artifact). `scripts/deploy.sh` and `scripts/deploy.sh menubar --publish` both pass `force_build` into `ensure_menubar_deployed`, bypassing the download path.

**`gh` CLI is NOT a dependency** of the fetch path — only `--publish-menubar` still requires it. Plain `curl` + `node` (already required by the streamer) hit `https://api.github.com/repos/RonenMars/threadbase-menubar/releases` anonymously. The repo is public, so no token is needed for reads.

**Auto-update interaction:** during an install, the streamer is briefly down — typically a few seconds between `stopService()` (Windows only) / `swapCurrent()` and `restartService()`. The menubar will flicker to "disconnected" then reconnect on the next 5s poll. This is expected and not a bug. If the gap stretches beyond ~10s, something is wrong with the restart step (`launchctl kickstart` failing on macOS, `systemctl --user` not finding the unit on Linux, scheduled task hung on Windows) — check `~/.threadbase/logs/updater.{log,err}` and the platform service status before assuming the menubar itself is at fault.
