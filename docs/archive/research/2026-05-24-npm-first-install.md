# tb-streamer npm-first install: research dossier

Date: 2026-05-24
Author: research-only pass (no design, no code changes)
Scope: facts and decision space for converting `@threadbase-sh/streamer` from its current "build → tarball → release dir + symlink → launchd/systemd/Task Scheduler" install model to an `npm install -g threadbase-streamer` + `threadbase-streamer setup` model.

This is a research document. It does not pick an approach. Where uncertainty exists, it is called out explicitly. File paths are absolute; line numbers reference `main` at HEAD.

---

## 0. Current install layout in one diagram

```
~/.threadbase/
  cli.js                   -> symlink (Unix) or real file (Win) of the active cli.cjs
  releases/
    cli.<sha>.cjs          (build output, kept ~5 deep)
    .history               (append-only activation log)
    .tmp/                  (download staging used by updater)
  releases/<semver>/       (only after the in-place updater unpacks a tarball)
  cache/cache.db           (SQLite conversation cache)
  logs/{stdout,stderr,updater}.{log,err}
  server.yaml              (api_key, browse_root, optional public_url, port, cache_dir, tail_size)
  update.yaml              (auto-update config; optional)
  menubar-installed-sha    (last menubar submodule SHA installed to /Applications)
  menubar-signing.env      (Developer ID + ASC API key; optional)
  current/                 (updater-only — see §1, conflicts with deploy.sh layout)

Service registration (out-of-band):
  macOS    ~/Library/LaunchAgents/com.ronen.threadbase.plist
  Linux    ~/.config/systemd/user/threadbase.service
  Windows  Task Scheduler task name "Threadbase" (+ launch.cmd / launch.vbs in $installDir)
```

**Important discrepancy.** The deploy scripts (`scripts/deploy.sh:25-27`, `scripts/deploy-linux.sh:26-28`, `scripts/deploy.ps1:33-37`) write a single artifact `~/.threadbase/cli.js` pointing at `releases/cli.<sha>.cjs`. The in-place updater (`src/updater/paths.ts:5-7`, `src/updater/swap.ts:25-49`) writes `~/.threadbase/current/` (a symlink or copied directory) pointing at `releases/<semver>/` (an *unpacked tarball*). These two layouts are not compatible in the same `releases/` dir. The deploy-installed system on the owner's machine today uses the `cli.js → releases/cli.<sha>.cjs` layout (verified via `ls -la ~/.threadbase`), while `scripts/install-auto-update.sh:18` references `current/dist/cli.cjs`. **As of today the in-place updater has never been exercised on a deploy-script-installed system without first migrating the layout, and the deploy scripts overwrite nothing the updater wrote.** Any npm-first redesign needs to decide which (if either) layout to keep.

---

## 1. Code-path inventory: install / update / service surface

### 1.1 `scripts/deploy.sh` (macOS launchd)
- Single bash entry point at 782 lines. Subcommands: `setup`, `deploy` (default), `rollback`, `status`, `healthcheck`, `menubar`. Flags: `--force`, `--update-scanner`, `--publish-menubar`.
- Resolves install dir from `$THREADBASE_INSTALL_DIR` or `~/.threadbase`. Hard-codes label `com.ronen.threadbase`, port 8766, health URL.
- Phases: predeploy git check → `check_active_sessions` (probes localhost `/api/sessions` for `ptyAttached:true`) → `cmd_check_browse_root` (prompts interactively if missing) → scanner submodule init/build → `npm run lint && npm test && npm run build` → stamps `releases/cli.<sha>.cjs`, copies SQLite + PG migrations, copies external native modules (`node-pty`, `better-sqlite3`, `bindings`, `file-uri-to-path`) into `releases/node_modules/` → atomic symlink swap → `cmd_setup` (write plist) or `ensure_plist_healthy` (rewrite stale plist) → `launchctl kickstart -k` → 15s healthcheck loop → GC + menubar deploy.
- **npm-first touchpoints**: the `setup` subcommand (`write_plist` at line 398, `launchctl bootstrap` at line 453, the `EnvironmentVariables` PATH block) is the part that needs to become `threadbase-streamer setup`. Everything else (lint, test, build, stamp release dirs, swap, GC, menubar) is dev-loop machinery that disappears in an npm-first world because npm itself handles install layout. The `check_active_sessions` HTTP probe (line 351) is roughly equivalent to what the updater already does in `src/updater/active-sessions.ts` and could be reused.

### 1.2 `scripts/deploy.ps1` (Windows Task Scheduler)
- 517-line pwsh script. Same subcommands. Generates two files in `$installDir`: `launch.cmd` and `launch.vbs`. The Task Scheduler action runs `wscript.exe launch.vbs`, which in turn runs `cmd.exe /c launch.cmd`, which `cd`s into the install dir and runs `node cli.js serve`. This double-shim exists so Task Scheduler doesn't flash a console window.
- **Differences from deploy.sh**:
  - `cli.js` is a real file, not a symlink (no admin rights for `mklink`).
  - `Invoke-KillStalePort -Port 8766` step (line 240) — Stop-ScheduledTask doesn't kill orphaned node processes, so the script parses `netstat -ano` and kills anything bound to 8766 before starting the new task.
  - The healthcheck failure log path is `$env:TEMP\threadbase.err`, not `$installDir/logs/stderr.log`.
- **npm-first touchpoints**: equivalent `setup` flow needs to (a) materialize a vbs-style hidden wrapper around `threadbase-streamer serve` (Windows-only requirement), (b) register a per-user Task Scheduler task, (c) handle the stale-port problem before starting, (d) handle the `pwsh.exe`-as-executor + inline-redirection pattern for logs because Task Scheduler can't redirect natively.

### 1.3 `scripts/deploy-linux.sh` (systemd --user)
- 419 lines, structurally a near-clone of `deploy.sh`. Service unit at `~/.config/systemd/user/threadbase.service`. Restart via `systemctl --user restart`.
- Linux deploy is the simplest — `ExecStart=$node_bin $ACTIVE_LINK serve --port $PORT --verbose`, no `EnvironmentVariables` block needed because systemd-user inherits the user's PATH.
- **npm-first touchpoints**: equivalent to deploy.sh, but only the `cmd_setup` block (lines 202-243) is novel. systemd-user setup is the cleanest of the three platforms.

### 1.4 `scripts/install-auto-update.sh` (macOS/Linux scheduled updater job)
- 162 lines. Reads `~/.threadbase/update.yaml`, requires `auto_update: true`. On macOS writes a separate launchd plist `com.ronen.threadbase.updater` with `StartInterval = poll_interval_minutes * 60`. On Linux writes a `.service` + `.timer` pair (`threadbase-updater.{service,timer}`).
- **Critical**: line 18 hard-codes `ACTIVE_LINK="$INSTALL_DIR/current/dist/cli.cjs"`. This path does not exist on a deploy-script-installed system (which writes `$INSTALL_DIR/cli.js`). Either the scheduled-updater installer was written against a future layout, or it is currently broken on any system not initially installed by the in-place updater.
- **npm-first touchpoints**: an npm-installed CLI lives at e.g. `~/.nvm/versions/node/v24.14.1/bin/threadbase-streamer`, *not* at any path under `~/.threadbase/`. The scheduled-job command becomes `threadbase-streamer update` (which works as long as the bin is on PATH; for Task Scheduler / launchd on macOS that requires `/usr/local/bin` or `/opt/homebrew/bin` to be in `EnvironmentVariables`). The relationship between `npm update -g threadbase-streamer` and `threadbase-streamer update` is the open design question (§5).

### 1.5 `scripts/install-auto-update.ps1`
- 103 lines. Registers `Threadbase-Updater` Task Scheduler task. Action is `pwsh.exe -NoProfile -Command "& '<node>' '<cli>' update *>> '<log>' 2>> '<err>'"`. Uses `New-ScheduledTaskTrigger -Once -At … -RepetitionInterval` so the task fires every N minutes.
- Same `current/dist/cli.cjs` mismatch as the sh version (line 20).

### 1.6 `src/updater/` — full directory

Files and roles:
- `paths.ts` (15 lines) — constants: `THREADBASE_ROOT`, `RELEASES_DIR`, `CURRENT_SYMLINK`, `DOWNLOAD_DIR`. The "current symlink" layout is hard-coded here. **In an npm-first world this whole file disappears or pivots.**
- `github-releases.ts` (108 lines) — wraps the GitHub Releases REST API. Stable vs prerelease channel, by-tag lookup.
- `manifest.ts` (36 lines) — zod schema for `manifest.json` attached to each release. `pickArtifact()` indexes by `${process.platform}-${process.arch}` (e.g. `darwin-arm64`).
- `download.ts` (94 lines) — streams tarball + sha256 verifies against the manifest. Deletes partial file on hash mismatch.
- `unpack.ts` (14 lines) — wipes `destDir`, untars into it. Trivial.
- `swap.ts` (87 lines) — `swapCurrent(version)` atomically swaps `~/.threadbase/current` to point at `releases/<version>/`. macOS/Linux: `symlinkSync(target, tmp); renameSync(tmp, current)`. Windows: `cpSync(target, tmp); rmSync(current); renameSync(tmp, current)`. `pruneOldReleases` keeps the most recent 2 by semver.
- `restart.ts` (105 lines) — `restartService()` shells out to `launchctl kickstart -k`, `systemctl --user restart`, or `schtasks.exe /End` + `/Run`. `stopService()` is a no-op on Unix; on Windows it issues `schtasks /End` so that `swapCurrent` can replace the `current/` directory without `EBUSY`.
- `active-sessions.ts` (68 lines) — probes the running streamer's `/api/sessions` over HTTP, distinguishes three outcomes (`count`, `unreachable`, `error`). Tested behavior: error → defer, unreachable → proceed. This is the "don't kill mid-conversation" safeguard.
- `check-update.ts` (110 lines) — pure version-comparison logic. Normalizes the tsup `+sha-dirty` suffix, applies `allow` list (patch/minor/major), respects `--allow-major`.
- `install.ts` (159 lines) — orchestrator. Calls everything else. Returns a discriminated `InstallResult` (`no-op` / `deferred` / `dry-run` / `installed`).

**npm-first touchpoints**: in an npm-first world,
- `paths.ts`, `swap.ts`, `unpack.ts`, `download.ts`, `manifest.ts`, `github-releases.ts` all become unnecessary if `npm update -g` is the install mechanism — npm handles tarball fetch, integrity, atomic swap.
- `check-update.ts` is still useful — npm has no equivalent of "is there a major bump pending? am I allowed to take it?". The semver/allow-list policy lives in `update.yaml` and the team has a working mental model around it.
- `active-sessions.ts` is still useful — defer-if-active is the most valuable safety feature and has nothing to do with the install mechanism.
- `restart.ts` is still partly useful — after `npm update -g` the running streamer is on the old version until the service restarts. The shell-outs to `launchctl/systemctl/schtasks` are still correct.

### 1.7 Healthcheck logic
- All three deploy scripts implement the same loop: poll `http://localhost:8766/healthz` every 500ms for 15s with `curl -fsS --max-time 2` / `Invoke-RestMethod -TimeoutSec 2`. On failure, tail the stderr log.
- The endpoint itself (`src/api/routes/health.routes.ts:7`) responds `{ ok: true, version: __VERSION__ }`. It is the **only** endpoint exempt from Bearer auth (along with `POST /api/pair/exchange`).
- **npm-first touchpoints**: `threadbase-streamer setup` and `threadbase-streamer update` both want to run this loop after service start. The logic is small enough to live in a shared helper.

### 1.8 server.yaml / update.yaml read paths in code
Found via `grep` across `src/`:
- `src/auth.ts:6-7` — `CONFIG_DIR = ~/.threadbase`, `CONFIG_FILE = ~/.threadbase/server.yaml`. `loadOrCreateApiKey()` reads or generates+writes the `api_key:` line. `loadBrowseRoot()`, `loadPublicUrl()`, `loadCacheDir()`, `loadTailSize()` regex-parse the same file (line 35 onwards).
- `src/server.ts:123` — `this.cacheDir = config.cacheDir ?? loadCacheDir() ?? join(homedir(), ".threadbase", "cache")`.
- `src/config/update-config.ts:7` — `DEFAULT_CONFIG_PATH = ~/.threadbase/update.yaml`. Uses actual YAML parser (the `yaml` package) + zod schema. Throws on invalid YAML; returns null when file missing (auto-update disabled).
- `src/api/routes/misc.routes.ts:82` — `loadUpdateConfig()` called per webhook request to refresh `webhook_secret`.

**npm-first touchpoints**: `~/.threadbase/{server,update}.yaml` are decoupled from the install location and stay where they are. An npm install of the CLI shouldn't and won't disturb them. The owner's existing api_key, browse_root, public_url all carry forward unchanged. **This is the cleanest part of the migration story.**

---

## 2. Native module status

### 2.1 node-pty (declared external in tsup)
- Version 1.1.0. Ships prebuilds for **`darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64`**. No `linux-x64`, no `linux-arm64`. (Verified: `ls node_modules/node-pty/prebuilds/` returns exactly four directories.)
- Install script: `"install": "node scripts/prebuild.js || node-gyp rebuild"`. `prebuild.js` checks for `prebuilds/<platform>-<arch>/` and exits 0 if present, exits 1 if not (then `||` fires `node-gyp rebuild`).
- **Implication**: `npm install -g threadbase-streamer` on Linux triggers a `node-gyp` rebuild. That requires `python3`, `make`, `g++`. The release.yml workflow already documents this (`Install Linux build tools for node-pty` step). On a fresh Ubuntu/Debian box without build-essential, `npm install -g` fails with cryptic gyp errors.
- prebuilds use Node N-API (`node-addon-api` 7.1.0), so a single prebuild covers Node 18 / 20 / 22 / 24. No per-Node-major recompile.
- `postinstall` in `tb-streamer/package.json:33`: `patch-package && node -e "try{require('fs').chmodSync(...spawn-helper, 0o755)}catch{}"`. The chmod is necessary because npm doesn't always preserve the execute bit on extracted files inside `prebuilds/*/spawn-helper`. On macOS this is the difference between sessions starting and `EACCES`-failing instantly.

### 2.2 better-sqlite3
- Version 12.9.0. Engines: `node: 20.x || 22.x || 23.x || 24.x || 25.x` — explicitly **no Node 18 support**, even though `tb-streamer/package.json` declares `engines.node >= 18`. This is a latent inconsistency; npm doesn't enforce engines without `engine-strict`.
- Install script: `"install": "prebuild-install || node-gyp rebuild --release"`. **Does not ship prebuilds in the npm tarball** — `prebuild-install` fetches them from the better-sqlite3 GitHub Releases at install time.
- `prebuild-install` covers (per its README and historical release artifacts) `darwin-x64`, `darwin-arm64`, `linux-x64-glibc`, `linux-x64-musl`, `linux-arm64-glibc`, `linux-arm64-musl`, `win32-x64`, `win32-ia32` for the matching node-abi. Coverage is broader than node-pty's bundled prebuilds.
- Source-compile fallback: `node-gyp rebuild --release`. Requires the same toolchain as node-pty, plus glibc/musl headers.

### 2.3 What a fresh `npm install -g threadbase-streamer` looks like

| Platform | node-pty | better-sqlite3 | User-visible failure mode if unsupported |
|----------|----------|----------------|-------------------------------------------|
| macOS arm64 / x64, Node 20-24 | prebuild | prebuild-install fetches prebuild | none |
| Win10/11 x64 / arm64, Node 20-24 | prebuild | prebuild-install fetches prebuild | none |
| Linux x64 glibc, Node 20-24 | **source compile** | prebuild-install fetches prebuild | needs python3+make+g++ |
| Linux x64 musl (Alpine), Node 20-24 | **source compile** | prebuild-install may fetch musl prebuild | needs build-base; alpine + musl differ from glibc |
| Linux arm64 | **source compile** | prebuild-install fetches prebuild | needs build tools |
| Node 18 | works for node-pty (N-API) | **fails engines check (or works without enforcement)** | runtime crash on first SQLite call |
| Node 25+ (latest) | works | works (newest supported) | none |

**Practical implications for the npm-first install:**
1. macOS + Windows users get a clean `npm install -g` with no toolchain. This covers the majority of expected users.
2. Linux users (including any future CI / Docker setups) need build tools pre-installed, OR the streamer's own published package needs to ship bundled prebuilds for linux-x64/linux-arm64. That means the streamer's own `prepublishOnly` workflow needs to rebuild node-pty for Linux and include the binaries in the published tarball — currently `scripts/pack-platform.mjs:27` includes `node_modules/node-pty` only because the build runs on a Linux runner that just did the compile. For npm-first, that compile output would need to live inside the publishable package, which is unusual for native modules and may not match how `tsup` external resolution works.
3. The `engines.node >= 18` in `package.json` is wrong if better-sqlite3 stays at 12.x. Either bump to `>=20` or pin better-sqlite3 at an older version. Either way it's a pre-publish call.

### 2.4 patch-package patches
- One patch in `patches/`: `qrcode-terminal+0.12.0.patch`. It rewrites `"\033[40m  \033[0m"` → `"\x1b[40m  \x1b[0m"` in `node_modules/qrcode-terminal/lib/main.js` — purely a syntax fix (octal escapes don't work in strict mode under some Node builds).
- `patch-package` runs in `postinstall`. **After `npm install -g threadbase-streamer`, the global `node_modules/qrcode-terminal` *will* have the patch applied** as long as `patch-package` is a dependency of the published package (currently it's only in `devDependencies`).
- **Unresolved**: `patch-package` needs to be moved to `dependencies` (or the patch needs to be bundled into the streamer's own source) for the npm-first install to keep the QR-code fix. Otherwise QR pairing breaks for any user who happened to install with `--ignore-scripts`.
- Alternative: tsup currently bundles every dependency that isn't `node-pty` / `pg` / `better-sqlite3` into `dist/cli.cjs`, which would also bundle the patched `qrcode-terminal`. If the npm-published artifact is `dist/cli.cjs` and not raw source, the patch could be applied at build time once on the publisher's machine — `node_modules/qrcode-terminal/lib/main.js` ends up inlined into the bundle with the patch baked in. Need to verify that the inlined code is the patched version on the publisher's machine.

---

## 3. Cross-platform service registration: implementation survey

The new `setup` subcommand needs to install a per-user service on three OSes. Three realistic approaches; each has tradeoffs.

### 3.1 Approach A — Shell out to the native tools
The deploy scripts already do exactly this. Idiomatic per-platform commands:
- macOS: `launchctl bootstrap gui/$(id -u) <plist>` to install, `launchctl bootout gui/$(id -u)/<label>` to remove, `launchctl kickstart -k gui/$(id -u)/<label>` to restart. The plist is a static XML file the script writes via heredoc.
- Linux: `systemctl --user daemon-reload && systemctl --user enable --now <unit>`. The `.service` file is a static INI file.
- Windows: `New-ScheduledTask*` cmdlets (PowerShell). `schtasks.exe` is the older alternative; `New-Scheduled*` is supported on Win10+ and is what the deploy script already uses.

**Tradeoffs**:
- All three commands exist on default OS installs; no extra deps.
- Already exercised by the deploy scripts — the templates and the gotchas (Windows wscript shim, macOS `EnvironmentVariables` PATH block, Linux `WantedBy=default.target`) are known-correct.
- Three separate code paths in TypeScript instead of one unified API.
- Spawning `pwsh.exe` from a Node CLI on Windows is fine but adds a process; testing it under WSL or PowerShell-not-installed environments needs care.
- Idempotency is the team's problem — currently handled with try/catch + `bootout` before `bootstrap`.

### 3.2 Approach B — node-windows / node-mac / node-linux (Corey Butler)

All three are by `coreybutler` (creator of nvm-windows). Versions, modified dates, last week's downloads (from npm registry):

| Package | Latest | Modified | Weekly downloads |
|---------|--------|----------|------------------|
| node-windows | 1.0.0-beta.8 | 2024-10-22 | 34,818 |
| node-mac     | 1.0.1        | 2022-06-21 | 885    |
| node-linux   | 0.1.12       | 2022-06-21 | 3,129  |

**Tradeoffs**:
- Three separate libraries with three different APIs. The team would write three platform branches anyway.
- node-windows is the most actively used. node-mac and node-linux have not been updated in 4 years.
- node-windows installs services using `winsw.exe` (a bundled .NET wrapper) — that's a **system service**, run as SYSTEM by default, which is not what the streamer needs (it must run as the user so `~/.threadbase` resolves and `claude` is on PATH).
- node-mac uses launchd plists under the hood (effectively the same approach as A, just behind an API). node-linux uses init scripts (`/etc/init.d/`), **not systemd-user** — wrong target for a user-mode daemon.
- All three default to system-mode services and need workarounds for user-mode. The deploy scripts already do user-mode correctly.
- Verdict on inspection: **these libraries do not match the user-mode service requirements the streamer has today.** Recommending them in a fresh design would likely cause regressions.

### 3.3 Approach C — Manual templates + shell out (hybrid)
- Embed the plist / systemd unit / Task Scheduler XML templates as TypeScript template literals in `src/setup/`. Substitute the resolved node path, install dir, label.
- Shell out only to `launchctl bootstrap`, `systemctl --user enable --now`, `Register-ScheduledTask`.
- This is essentially what the deploy scripts do today, just transplanted into Node. The templates already exist (deploy.sh:398-431 for the plist, deploy-linux.sh:219-232 for the unit, deploy.ps1:220-237 for the Windows action).

**Tradeoffs**:
- Smallest code surface — three template strings, three shell-outs.
- Reuses everything the team already knows about each format (e.g. the `EnvironmentVariables` PATH block on macOS, the `wscript.exe` shim on Windows).
- Same testability as approach A — mock `execFile`.
- Loses any "framework" benefit of B (e.g. node-windows' uninstall machinery), but the team already writes uninstall flows by hand.

### 3.4 What's not on the list
- `forever`, `pm2`: process supervisors, not OS service installers. Wrong abstraction.
- `service-installer`, `os-service`, `winser`: low-download single-platform libraries; not worth a dep for the streamer.
- Container approaches (Docker, systemd-nspawn): out of scope — the streamer is explicitly a host-installed daemon that needs to spawn `claude` as the user.

---

## 4. Migration story for existing users

What lives on disk today and what needs to happen during a transition.

| Item | Lives at | Owner | Migration disposition |
|------|----------|-------|----------------------|
| API key | `~/.threadbase/server.yaml` (`api_key:` line) | User | **Keep as-is**. `loadOrCreateApiKey()` reads it from the same place regardless of where the CLI is installed. The mobile-app pairing token depends on this key being stable. |
| browse_root | `~/.threadbase/server.yaml` | User | **Keep as-is**. Read by `src/auth.ts:loadBrowseRoot()` and the deploy scripts' interactive prompt (`cmd_check_browse_root`). |
| public_url | `~/.threadbase/server.yaml` | User | **Keep as-is**. Used by `cli/index.ts:loadPublicUrl()` and the QR pairing flow. |
| cache_dir, tail_size | `~/.threadbase/server.yaml` (optional) | User | **Keep as-is**. |
| update.yaml | `~/.threadbase/update.yaml` | User | **Keep as-is**. The schema doesn't reference the install location; `github_repo` continues to point at `RonenMars/threadbase-streamer`. Decision: do `npm update -g` and `threadbase-streamer update` both consult this file? (See §5.) |
| Conversation cache | `~/.threadbase/cache/cache.db` (+ `-shm`, `-wal`) | Streamer runtime | **Keep as-is**. The cache path is independent of the install. The "stale `disc_*` IDs after server upgrade" troubleshooting entry (docs/troubleshooting.md:9) recommends `cache clear` after a major upgrade — this would still apply. |
| Old release files | `~/.threadbase/releases/cli.<sha>.cjs` (deploy) and/or `~/.threadbase/releases/<semver>/` (updater) | Streamer install | **Safe to leave; better to delete.** Once npm owns the install, these files are dead weight. A `threadbase-streamer setup --migrate` (or a one-time prompt during `setup`) could clean them. The `releases/.history` file is interesting only for the deploy-script rollback path, which goes away. |
| `cli.js` symlink or real file | `~/.threadbase/cli.js` | Deploy script | **Replace or remove.** Some tooling references it directly: the `tb` shim (`bin/tb:7`) defaults to `$HOME/.threadbase/cli.js`. If `cli.js` disappears the shim breaks until users update. Options: (a) keep `cli.js` as a thin shim that `exec`s the npm-installed CLI, (b) update `bin/tb` to call `threadbase-streamer` and rely on PATH, (c) deprecate `bin/tb` entirely. |
| `current/` symlink | `~/.threadbase/current/` (updater-only) | Auto-updater | **Remove on migration.** Only matters if anyone has run the in-place updater; on the owner's machine it doesn't exist. The scheduled-updater installer scripts hard-code `$INSTALL_DIR/current/dist/cli.cjs` (`scripts/install-auto-update.sh:18`), which means **they will need to be rewritten or replaced regardless**. |
| `menubar-installed-sha`, `menubar-signing.env` | `~/.threadbase/` | Deploy script (menubar logic) | **Keep if menubar deploy stays a separate skill.** Out of scope if menubar gets its own DMG distribution. |
| launchd plist | `~/Library/LaunchAgents/com.ronen.threadbase.plist` | macOS service | **Rewrite.** The plist's `ProgramArguments` references `<node-bin> <cli.js>` — both paths change in an npm-first world. A migration step needs to `bootout` the old service, write a new plist pointing at the npm-installed CLI binary, `bootstrap` it. |
| systemd unit | `~/.config/systemd/user/threadbase.service` | Linux service | **Rewrite.** `ExecStart` changes from `<node> <cli.js> serve` to `threadbase-streamer serve` (or the npm bin's resolved path). |
| Task Scheduler task | "Threadbase" | Windows service | **Rewrite.** The current task launches `wscript.exe launch.vbs` → `cmd.exe launch.cmd` → `node cli.js serve`. The new task would launch `threadbase-streamer serve` (probably still through the vbs shim for hidden-window behavior, since that's a Windows constraint, not a deploy-script artifact). |
| Cloudflare Tunnel config | `~/.cloudflared/config-system.yml` (Windows service) or `~/.cloudflared/config.yml` (user) | External (cloudflared service) | **No change required.** Maps `tb-pc.rbv1000.win` → `http://127.0.0.1:8766`. As long as the streamer keeps binding to 8766 and `server.yaml`'s `port:` line stays in sync (for the menubar), cloudflared keeps working. |
| Menubar's port detection | reads `~/.threadbase/server.yaml`'s `port:` line | Electron app | **Constraint, not a migration item.** The npm-first install must continue to write or update `port:` in `server.yaml` when the user sets a non-default port. Or the menubar updates to read from a different source. (See §7.) |

**Existing-user upgrade path** (high-level decisions, not designed):
1. Do users run `npm install -g threadbase-streamer` and then `threadbase-streamer setup`, where `setup` detects the old service + cli.js layout, bootouts/disables/unregisters the old service, removes old release files, and registers the new one?
2. Or do they run a one-shot `threadbase-streamer migrate-from-deploy-script` command first?
3. Or do we ship a transitional `1.x` release that keeps the old layout working alongside, so users can upgrade incrementally?

The simplest path is (1) — `setup` is already idempotent in spirit; making it migration-aware adds maybe 50 lines of file-cleanup logic.

---

## 5. Auto-updater coexistence with npm

### 5.1 What the current updater does that npm doesn't

| Feature | Current updater | npm update -g |
|---------|----------------|---------------|
| Fetch + verify tarball | sha256 against `manifest.json`, sigstore attestation not used | npm verifies tarball integrity from the registry's `dist.shasum` and `dist.integrity` (sha512). For packages with provenance, npm verifies the Sigstore attestation. |
| Channel selection | `stable` vs `next` based on GitHub Release prerelease flag | `latest` tag vs `next`/`beta` dist-tags. Functionally similar; the streamer would need to publish to both dist-tags. |
| Semver allow-list | "patch+minor only; major requires `--allow-major`" enforced in `check-update.ts:72-90` | `npm update -g <pkg>` respects the installed version's range but not allow-list semantics. Major bumps require explicit `npm install -g <pkg>@<version>` or `@latest`. **Closer to allow-list than it seems.** |
| Pinning | `--version v1.2.3` | `npm install -g <pkg>@1.2.3` |
| Active-session defer | `countActiveSessions()` HTTP probe; refuses install if any session is `running` or `waiting_input`; three-way distinction (count / unreachable / error) | **Nothing equivalent in npm.** This is the most valuable safety feature and has no parallel in package managers. |
| Service restart after swap | `launchctl kickstart` / `systemctl --user restart` / `schtasks /End + /Run` | **Nothing.** `npm update -g` leaves the running process untouched. Users would not know to restart manually. |
| HMAC webhook | `POST /api/__update` with X-Threadbase-Signature; spawns updater detached | **Nothing equivalent.** Useful for low-latency push updates from CI. |
| Rollback | `scripts/deploy.sh rollback` reads `releases/.history`, repoints symlink. Updater alone has no rollback — needs to refetch the old tarball. | `npm install -g <pkg>@<previous>` works but is manual. |
| Windows EBUSY pre-stop | `stopService()` before `swapCurrent()` on Windows because process holds open handles | **Same problem applies.** npm install on Windows fails with EBUSY on `~/.npm/cache` files held by a running CLI… though for a globally-installed binary it would actually fail on `<prefix>/node_modules/.bin/threadbase-streamer` or the wrapper script. Need to verify. |
| Auto-update scheduling | Separate platform job (launchd plist with StartInterval / systemd timer / Task Scheduler repetition) running the updater every N minutes | **Nothing native.** Need to either keep the platform scheduler approach with `threadbase-streamer update` as the action, OR ship an in-process timer in the streamer itself, OR rely on the webhook. |

### 5.2 The decision space

Two extremes and several hybrids:

**Pure npm.** Tell users to run `npm update -g threadbase-streamer` themselves; remove all of `src/updater/`. Loses defer-if-active. Loses service restart. Loses webhook. Loses rollback UX. Probably unacceptable for a daemon that other users connect to.

**Pure custom (status quo, but npm-distributed).** Keep `threadbase-streamer update` as the canonical update mechanism. Users do NOT use `npm update -g`. The CLI is installed via npm once (to bootstrap), then self-updates via GitHub Releases just like today. This preserves every safety feature but means the npm publish is essentially a one-time installer.

**Hybrid — `threadbase-streamer update` wraps `npm update -g`.** Run the defer-if-active check first. If clear, exec `npm update -g threadbase-streamer` as a child process. After it returns, call `restartService()`. Pros: simpler than maintaining custom download/swap. Cons: introduces an npm dependency at update-time; if the user's npm is broken, updates break. Also: the npm process replacing the bin file mid-run is the same EBUSY problem swapCurrent has on Windows — needs the same stopService-first sequence.

**Hybrid — keep the policy layer; replace the download layer.** Keep `check-update.ts` and `active-sessions.ts`. Replace `download.ts` + `unpack.ts` + `swap.ts` + `paths.ts` with a single `npmInstall(version)` helper that shells out to npm. Keep `restart.ts` unchanged. This is structurally clean and matches the value-vs-complexity ratio of each piece.

No design decision asked for here — just listing what the decision is between.

### 5.3 Webhook (`POST /api/__update`)
- The webhook spawns `process.execPath cliPath update --force` detached (`src/api/routes/misc.routes.ts:99-107`). In an npm-first world, `cliPath` is `process.argv[1]` which would be the npm-installed binary path. As long as `update` keeps existing as a subcommand, the webhook keeps working.
- Open question: should `update --force` skip the defer check (current behavior) or just the active-session check? The flag name is generic. Worth a name in the design session.

---

## 6. Windows-specific gotchas (CLAUDE.md "Windows-specific notes")

| Gotcha | Source | Affected by npm-first? | Notes |
|--------|--------|------------------------|-------|
| `npm install` before first deploy (fresh clone) | CLAUDE.md, "Windows-specific notes" | **Yes — partly resolved by npm-first.** A user no longer clones the repo; they `npm install -g threadbase-streamer` and npm pulls all deps. The `postinstall` patch-package + chmod step still runs. |
| Path separators (`path.sep`, not `/`) | CLAUDE.md | No. Pure runtime concern; the `setup` subcommand needs to be careful but no new Windows-specific paths beyond what already exists. |
| File timestamps (`birthtimeMs` vs `mtimeMs`) | CLAUDE.md | No. Test/runtime concern, unrelated to install. |
| Task Scheduler log redirection (must use `pwsh.exe` + inline redirection) | CLAUDE.md | **Yes.** `threadbase-streamer setup` on Windows must replicate this. The current `launch.cmd` + `launch.vbs` shim hides the console window AND allows redirection; if we drop the vbs shim, we lose hidden-window behavior; if we keep it, the setup command needs to generate both files in `~/.threadbase/`. |
| Task Scheduler env var inheritance (registry write doesn't update live session) | CLAUDE.md | **Yes.** Affects `THREADBASE_DATABASE_URL`, `THREADBASE_INSTANCE_ID`. If `setup` writes user env vars, it must inline-substitute them into the task action rather than relying on inheritance. Same trap as before. |
| Stale port 8766 from old streamer process before task start | CLAUDE.md, `scripts/deploy.ps1:240` | **Yes.** A migration-aware `setup` needs to kill any process bound to 8766 before starting the new task — same logic as `Invoke-KillStalePort`. |
| Submodule SSH → HTTPS workaround | CLAUDE.md | **No — disappears.** Users no longer clone, so the submodule trap is gone. The streamer team still needs HTTPS auth for the scanner submodule on its CI runners, but that's a publish-side concern. |
| `cli.js` real file vs symlink on Windows | implicit in CLAUDE.md | **No — disappears.** npm handles the install layout. |
| Windows updater needs `stopService()` before `swapCurrent()` | CLAUDE.md "Things that will bite if you forget" | **Persists in modified form.** If the npm-first updater shells out to `npm update -g`, npm might hit EBUSY trying to replace the wrapper script. Whether we still need a pre-update stop depends on whether npm-update-on-running-bin has problems on Windows. **Uncertain — needs empirical test.** |

---

## 7. Menubar coupling

Verified by reading `vendor/menubar/src/main.ts:1-23` and `vendor/menubar/CLAUDE.md`.

**Hard dependencies (must preserve):**
1. **Port detection from `~/.threadbase/server.yaml`** — `readPortFromServerYaml()` regex-parses the file for `port:`. Order: `THREADBASE_PORT` env → `port:` in YAML → fallback 8766.
2. **`GET /healthz` returning `{ ok, version }`** — polled every 5s with a 3s timeout. Sets the tray icon color.
3. **Listening on `127.0.0.1:<port>`** — the menubar is a local Electron app; it does not go through Cloudflare.

**Soft dependencies (preserved by happy accident, not deliberate):**
- Menubar reads `port:` directly, not `api_key:`. It does **not** authenticate to `/healthz` because that endpoint is auth-exempt.
- Menubar has no opinion about the install location, the service label, or whether the streamer is `cli.js`-symlinked or npm-installed.

**Implications for npm-first**: minor.
- `setup` should still write a `port:` line in `server.yaml` if and only if the user picks a non-default port. The owner's machine today does *not* have a `port:` line (verified: `cat ~/.threadbase/server.yaml` would show api_key + browse_root but no port). The menubar falls back to 8766, which matches the deploy script's `--port 8766`. **If `setup` switches the default port, both the service unit and `server.yaml` need updating.**
- The mismatch trap: `server.yaml` has `port: 9999` but the service is configured with `--port 8766` (or vice versa) → menubar polls 9999, streamer listens on 8766, menubar shows red. The deploy scripts don't currently keep these in sync because most users never set a `port:` line. `threadbase-streamer setup` should treat these as a single value.

**Auto-update interaction (already documented in CLAUDE.md):** during update, the streamer is briefly down. Menubar flickers gray → green. This is unchanged.

---

## 8. Cloudflare Tunnel integration

**Code search**: `grep -rn "cloudflared\|cloudflare" src/ cli/ scripts/` returns zero matches in any source or script. Cloudflare Tunnel is purely external infrastructure.

**What lives where:**
- Tunnel mapping `https://tb-pc.rbv1000.win` → `http://127.0.0.1:8766` is configured in `~/.cloudflared/config-system.yml` (Windows SYSTEM service) or `~/.cloudflared/config.yml` (user-mode cloudflared).
- The streamer's only "knowledge" of the tunnel is `public_url: https://tb-pc.rbv1000.win` in `~/.threadbase/server.yaml`, which is read by `src/auth.ts:loadPublicUrl()` and used to embed the right URL in the QR pairing code (`cli/index.ts:221`).
- Cloudflare Access is documented as protecting the tunnel hostname with Bearer auth — but this is an Access policy, not streamer code. Even `/healthz` requires the Bearer header when accessed through the public URL.

**Implications for `threadbase-streamer setup`:**
- **None required.** Cloudflare Tunnel setup is a separate one-time operation the user does once and forgets about. `setup` does not need to create, modify, or even check the cloudflared config.
- **Optional courtesy**: `setup` could prompt the user "do you want to set `public_url` in `server.yaml`?" if cloudflared is running. Detection would be `pgrep cloudflared` or `Get-Service cloudflared -ErrorAction SilentlyContinue`. That's a nice-to-have, not a requirement.
- **No risk**: the npm install does not touch `~/.cloudflared/`. Existing tunnels continue to work.

---

## Open questions for the design session (no answers offered)

1. Layout: keep `~/.threadbase/cli.js` (symlinked or thin shim) for back-compat with `bin/tb`, or break the shim and tell users to call `threadbase-streamer` directly? If keep, what does the symlink point at — the npm-installed binary?
2. Updater scope: does the npm-first world keep `threadbase-streamer update` at all, or does it just say "run `npm update -g`"? If keep, which features survive (defer, webhook, semver allow-list)?
3. Linux native-module strategy: ask users to install build-essential, or ship prebuilds in the published npm package (and how)?
4. `engines.node` fix: bump to `>=20` to match better-sqlite3, or pin to an older sqlite that supports 18?
5. `patch-package` lifecycle: move to `dependencies`, bake the patch into tsup's bundled output, or drop the dependency?
6. Migration UX: does `threadbase-streamer setup` detect-and-clean the old layout, or do we ship a `migrate` subcommand?
7. Windows port-conflict and EBUSY: do we replicate `Invoke-KillStalePort` in `setup` / `update`, or rely on cleaner ordering?
8. Menubar drift: if the npm-first install changes the default port or the server.yaml layout in any way, the menubar needs a coordinated update.
