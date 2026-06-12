# Fly.io deployment

Two Fly apps host tb-streamer in the cloud:

| Target | App | URL | Config |
|--------|-----|-----|--------|
| demo | `threadbase-demo` | `https://threadbase-demo.fly.dev` | `fly.toml` |
| prod | `threadbase` | `https://threadbase.fly.dev` | `fly.prod.toml` |

Both use `docker/Dockerfile` as the build target. The build context is the repo root, so `src/`, `cli/`, `vendor/`, etc. are all available to `COPY` instructions.

## Prerequisites

```bash
fly auth login    # one-time; persists to ~/.fly/config.yml
fly auth whoami   # verify
```

## Deploy

```bash
npm run deploy:fly                          # demo (default)
npm run deploy:fly -- --prod               # prod
npm run deploy:fly -- --prod --demo        # both in parallel
npm run deploy:fly -- --force              # skip dirty-tree check
npm run deploy:fly -- --verbose            # stream fly output in real time
npm run deploy:fly -- --prod --force --verbose
```

`deploy-fly.sh` runs `fly deploy --remote-only` for each target concurrently, streams output to a temp file per target, and reports pass/fail when both finish. It exits non-zero if any target fails and dumps that target's log to stderr.

The dirty-tree check is on by default — commit or stash your changes before deploying, or pass `--force`.

## Secrets

Secrets are env vars stored encrypted in Fly's secrets store and injected into the container at runtime. They are never logged or printed.

```bash
# Set a secret (staged — takes effect on next deploy)
npm run fly:secrets -- DEMO_API_KEY=tb_…               # demo (default)
npm run fly:secrets -- --prod CLAUDE_API_KEY=sk-ant-…  # prod
npm run fly:secrets -- --prod --demo CLAUDE_CODE_MODEL=claude-haiku-4-5-20251001  # both

# Import from a .env file (# comments and blank lines are stripped)
npm run fly:secrets -- --prod --file .env.prod

# List secret names on both apps (values are never shown)
npm run fly:secrets:list

# Remove a secret
npm run fly:secrets -- --prod --unset OLD_KEY
```

`fly:secrets` uses `--stage`, so the secret is queued but the app is not restarted. Run `npm run deploy:fly` afterward to apply it.

### Secrets reference

| App | Secret | Purpose |
|-----|--------|---------|
| prod | `PROD_API_KEY` | Threadbase API key for mobile pairing |
| prod | `CLAUDE_API_KEY` | Anthropic API key for spawned Claude sessions |
| demo | `CLAUDE_CODE_MODEL` | Model override for demo sessions |

## Runtime differences between demo and prod

| | demo | prod |
|-|------|------|
| `auto_stop_machines` | `stop` (sleeps when idle) | `off` (always on — App Store review) |
| `min_machines_running` | `0` | `1` |
| Build arg `DEMO_MODE` | `true` (seed data baked in) | unset |
| Volume | `demo_data` | `prod_data` |

The prod app is pinned always-on until Apple review completes (see comment in `fly.prod.toml`). Revert to `auto_stop_machines = 'stop'` and `min_machines_running = 0` after approval and redeploy.

## Cloudflare Access

The prod app sits behind Cloudflare Access at `https://tb-pc.rbv1000.win`. Every request — including `/healthz` — requires `Authorization: Bearer <api_key>`. Localhost healthchecks bypass this (they hit `http://localhost:8080` directly inside the container). See `docs/guides/remote-access/cloudflare.md` for tunnel config details.
