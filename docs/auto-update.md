# Auto-update

The streamer can update itself from GitHub Releases. Today the flow is
**manual** — you run `threadbase-streamer update` (or `update --check`) and
it pulls the newest release that matches your channel/allow rules, swaps the
`~/.threadbase/current` symlink, and asks the platform service manager to
restart the process. Background polling (`auto_update: true`,
`poll_interval_minutes`) is reserved in the config schema but not yet wired
up.

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
  the running version, and prints `Status:` with one of: `Already up to
  date`, `Would install X → Y (minor)`, `Diff 'major' not in allow list …`,
  `Major bump … re-run with --allow-major`. Never writes to disk.

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
running streamer picks up the new binary. The defaults match what the
existing deploy scripts create:

| Platform | Manager     | Default label              | Override env var          |
|----------|-------------|----------------------------|---------------------------|
| macOS    | launchctl   | `com.ronen.threadbase`     | `LAUNCHD_LABEL`           |
| Linux    | systemctl   | `threadbase.service`       | `THREADBASE_SYSTEMD_UNIT` |
| Windows  | schtasks    | `Threadbase`               | `THREADBASE_TASK_NAME`    |

If the restart fails (e.g. the service was never installed by the deploy
script), the installer still returns success — the new release is on disk
and `current/` is repointed; the next manual restart picks it up. The CLI
prints `Status: failed: <reason>` so the failure is visible.

## Failure modes

- **sha256 mismatch.** Download is deleted, error thrown, swap not
  attempted. Re-run `update`; the next attempt re-downloads.
- **Manifest missing or malformed.** Same — no side effects.
- **Disk full mid-unpack.** The new release dir is left partially
  populated. Manually remove `~/.threadbase/releases/<version>/` and
  retry. The previous `current` symlink is still pointing at the old
  release.
- **Restart fails.** `current/` is on the new version but the running
  process is on the old one. Restart the service manually or reboot.

## Known limitations

- No background poller yet — `auto_update` and `poll_interval_minutes` in
  `update.yaml` are inert until that's wired up in `server.ts`.
- Webhook-triggered update (`webhook_secret`) is reserved but unimplemented.
- The release workflow needs a `SCANNER_TOKEN` repo secret with read access
  to `RonenMars/threadbase-scanner`. Without it, the build jobs fail at the
  submodule init step.
