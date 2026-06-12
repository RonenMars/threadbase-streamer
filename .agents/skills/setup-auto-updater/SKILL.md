---
name: setup-auto-updater
description: Set up the in-place auto-updater on a deployed threadbase-streamer. Walks the user through creating ~/.threadbase/update.yaml, running `threadbase-streamer update --check`, doing a manual update, and optionally registering the scheduled job. Use when the user says "set up auto-update", "enable auto-update", "configure the updater", "make the streamer self-update", or asks how to keep their deployed streamer current. The full reference (commands, failure modes, restart labels, Windows ordering caveat, release pipeline) lives in docs/guides/auto-update.md — read that first before answering anything beyond the happy-path setup.
---

# Set up the streamer auto-updater

The streamer can update itself from GitHub Releases via three independent triggers (manual / scheduled / webhook). This skill handles the common case: an operator who already has the streamer deployed and wants it to stay current without manual `npm run deploy` runs.

**Authoritative reference**: [`docs/guides/auto-update.md`](../../../docs/guides/auto-update.md). Read it before going beyond the steps below — it has the full command list, env-var overrides, failure modes, the Windows pre-swap stop ordering, and the release/branching model. Don't paraphrase from memory; quote or link.

## Step 1 — Create the config

```sh
cp docs/update.yaml.example ~/.threadbase/update.yaml
```

That's enough for manual updates. The only required field is `github_repo`; everything else has sensible defaults. Without this file, `threadbase-streamer update` exits with a no-op message — that's the disabled state.

## Step 2 — Verify with `--check`

```sh
threadbase-streamer update --check
```

Should print `Current`, `Latest`, `Channel`, `Diff`, `Status`. If `Status` is `Already up to date` or `Would install X → Y (...)`, GitHub auth + config are good.

If the streamer can't reach GitHub, `--check` is where it surfaces.

## Step 3 — One manual install

```sh
threadbase-streamer update
```

Runs the full pipeline: download → sha256 verify → unpack → atomic swap → service restart. On macOS/Linux the swap is a symlink rename; on Windows the updater stops the service before swap (see the Windows ordering caveat in `docs/guides/auto-update.md`). The active-session defer check refuses to interrupt mid-conversation sessions unless you pass `--force`.

Confirm the result: `~/.threadbase/current` should resolve to the new release dir, and the streamer process (launchd / systemd / Task Scheduler) should be running the new version.

## Step 4 (optional) — Schedule background updates

If the user wants the streamer to update itself on a timer:

1. Edit `~/.threadbase/update.yaml`: set `auto_update: true` and adjust `poll_interval_minutes` if 60 is wrong.
2. Run the installer for their platform:
   ```sh
   scripts/install-auto-update.sh        # macOS or Linux
   pwsh scripts/install-auto-update.ps1  # Windows
   ```
   The script registers a *second* platform job — separate from the streamer service — that runs `threadbase-streamer update` on the configured interval. Idempotent: safe to re-run after editing the config.

3. To stop scheduled updates later: same script with `uninstall`.

Logs land in `~/.threadbase/logs/updater.{log,err}`. Refer the user there if something looks wrong after enabling the schedule.

## Step 5 (optional) — Webhook trigger

Only for users running CI that fans out to known servers. Set `webhook_secret` in `update.yaml`, then `POST /api/__update` with an HMAC-SHA256 signature header. Full payload format and signature gotchas: `docs/guides/auto-update.md` § Webhook.

## When to send the user to the docs

- **Channel / allow rules** (stable vs next, opting into major bumps) — `docs/guides/auto-update.md` § Commands + Setup
- **Restart label mismatches** — § Service-manager restart (env-var overrides per platform)
- **Rollback** — § Releases and branching → Rollback (three options: pin older version, yank release, forward-fix)
- **First-release semver question** — § First-release situation (without prior tag, a `feat:` produces `0.2.0` not `1.0.0`)
- **Anything about the release pipeline itself** — § Release tarball layout, § Validating the release pipeline without publishing

Don't try to summarize those sections inline. Link the user.
