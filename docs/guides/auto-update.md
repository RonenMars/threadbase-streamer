# Auto-update

The streamer can update itself from GitHub Releases via three independent
triggers:

1. **Manual** — `threadbase-streamer update` (or `update --check`) pulls
   the newest release matching your channel/allow rules, swaps the
   `~/.threadbase/current` symlink, and asks the platform service manager
   to restart the process. Always available once `update.yaml` exists.
2. **Scheduled** — `scripts/install-auto-update.{sh,ps1}` registers a
   *second* platform job (separate from the streamer service itself) that
   runs `threadbase-streamer update` every `poll_interval_minutes`.
   Requires `auto_update: true` in `update.yaml`; idempotent; supports
   `uninstall`.
3. **Webhook** — `POST /api/__update` with HMAC-SHA256 signature header
   triggers an immediate update. Returns 404 when `webhook_secret` is
   unset in `update.yaml`, 401 on bad signature, 202 on success.

## Setup

Copy the sample config into place:

```sh
cp docs/update.yaml.example ~/.threadbase/update.yaml
```

Edit `github_repo:` if you publish to a fork. Without this file the `update`
command exits with a no-op message; that is the intended "disabled" state.

## Commands

- `threadbase-streamer update --check`
  Hits the GitHub Releases API for the configured channel, compares against
  the running version, and prints a `Status:` line — up to date, a pending
  version diff with its semver class, or blocked by the allow-list. Never
  writes to disk.

- `threadbase-streamer update`
  Same checks as `--check`, then downloads the platform tarball into
  `~/.threadbase/releases/.tmp/`, sha256-verifies it against the release's
  `manifest.json`, unpacks into `~/.threadbase/releases/<version>/`, atomically
  repoints `~/.threadbase/current` (Windows: copy-and-rename), prunes
  older releases beyond the most recent 2, and asks the platform service
  manager to restart the streamer.

- `threadbase-streamer update --dry-run`
  Walks the check + manifest fetch but stops before downloading. Useful
  for verifying that a release has the right tarball + manifest attached.

- `threadbase-streamer update --version v1.2.3`
  Pin to a specific release tag (with or without `v` prefix). Honors the
  channel-independent semver check; pair with `--allow-major` if needed.

- `threadbase-streamer update --force`
  Skip the active-session defer check. The default behavior asks the
  running streamer's `/api/sessions?status=running,waiting_input` endpoint
  and refuses the install if any session is mid-conversation.

## Release tarball layout

The CI workflow (`.github/workflows/release.yml`) builds one tarball per
platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64`) using
`scripts/pack-platform.mjs`. Semantic-release then runs
`scripts/build-manifest.mjs` to emit `manifest.json`, attaches every
tarball + the manifest to the GitHub Release, and tags `main`/`next`.

The tarball contains `dist/`, `package.json`, `package-lock.json`, and
`node_modules/node-pty` (the only native dependency that cannot be
rebundled). The streamer's deploy scripts and the in-place updater both
expect this exact layout.

## Service-manager restart

After the swap, the updater calls the platform's service manager so the
running streamer picks up the new binary. `scripts/install-auto-update.{sh,ps1}`
registers a *second*, separate platform job that runs `threadbase-streamer
update` on a timer (`poll_interval_minutes` in `update.yaml`; gated on
`auto_update: true`; `... uninstall` removes just this job, leaving the
streamer service untouched). Logs land in `~/.threadbase/logs/updater.{log,err}`.

| Platform | Manager     | Default service label      | Default updater-timer label    | Override env var          |
|----------|-------------|-----------------------------|---------------------------------|---------------------------|
| macOS    | launchctl   | `com.ronen.threadbase`      | `com.ronen.threadbase.updater`  | `LAUNCHD_LABEL`           |
| Linux    | systemctl   | `threadbase.service`        | `threadbase-updater.timer`      | `THREADBASE_SYSTEMD_UNIT` |
| Windows  | schtasks    | `Threadbase`                | `Threadbase-Updater`            | `THREADBASE_TASK_NAME`    |

If the restart fails (e.g. the service was never installed by the deploy
script), the installer still returns success — the new release is on disk
and `current/` is repointed; the next manual restart picks it up. The CLI
prints `Status: failed: <reason>` so the failure is visible.

**Windows ordering caveat.** On macOS/Linux the swap is an atomic
`symlink → rename` and the running streamer keeps its old inode open
across the swap. On Windows there is no usable symlink, so the updater
replaces the `current/` directory wholesale — and Windows refuses to
delete a directory whose files are open. The installer therefore calls
`stopService` (`schtasks /End`) **before** `swapCurrent` on Windows, then
`restartService` brings the task back on the new version. Cost: a brief
downtime window during the swap (typically <2s). Not done on macOS/Linux
because it's unnecessary and would interrupt active sessions for no reason.

## Failure modes

- **sha256 mismatch.** Download is deleted, error thrown, swap not
  attempted. Re-run `update`; the next attempt re-downloads.
- **Manifest missing or malformed.** Same — no side effects.
- **Disk full mid-unpack.** The new release dir is left partially
  populated. Manually remove `~/.threadbase/releases/<version>/` and
  retry. The previous `current` symlink is still pointing at the old
  release.

## Webhook

When `webhook_secret` is set in `update.yaml`, `POST /api/__update`
accepts a signed request and spawns the updater in detached mode. The
endpoint deliberately bypasses Bearer auth — the HMAC over the raw body
is the only credential.

```
POST /api/__update
X-Threadbase-Signature: sha256=<hex hmac-sha256 of body with webhook_secret>
Content-Type: application/json

{"event":"release","version":"1.2.3"}
```

The release CI can fan out webhooks to known servers for low-latency
updates. Servers behind NAT (no inbound) fall back to polling.

## Webhook signature mismatches

The signature is computed over the *exact raw body bytes*. The most common
mistake is signing pretty-printed JSON while posting minified (or vice
versa). Sign and send byte-identical content; the verifier accepts either
a bare hex string or `sha256=<hex>` in the header.

## Releases

semantic-release runs on `main` (stable) and `next` (prerelease) per
`.releaserc.json`. Bumps are computed from conventional-commits messages:
`feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` → major. `chore:`,
`docs:`, `test:`, `build:`, `ci:` do not trigger a release.
(`@semantic-release/changelog` overwrites `CHANGELOG.md` on first run —
the stub in this repo is a placeholder.)

The `next` branch does not exist by default. Create it
(`git switch -c next && git push -u origin next`) only when you want
canarying — servers with `channel: next` in `update.yaml` will consume
from it. To promote a prerelease to stable, merge `next` → `main`.

`package.json` sits at `0.1.0` today, with no prior `vX.Y.Z` tag, so the
first `release.yml` run on `main` computes its bump from the full commit
history — a `feat:` commit produces `0.2.0`, not `1.0.0`. If you want
`1.0.0` as the baseline, manually tag `v1.0.0` on `main` before triggering
the workflow, or include `BREAKING CHANGE:` in a commit body.

**Rollback.** There is no automated rollback. Manual options:

1. **Single server, older version:** `threadbase-streamer update --version 1.4.2`
   re-installs the older tarball (still attached to its GitHub Release).
2. **Yank for everyone:** delete the GitHub Release (keep the git tag) so
   the GitHub API stops returning it as `latest`. Servers polling on
   `channel: stable` then stay on whatever they currently have.
3. **Forward-only fix:** ship `1.4.3` reverting whatever broke. Usually
   cleanest.
