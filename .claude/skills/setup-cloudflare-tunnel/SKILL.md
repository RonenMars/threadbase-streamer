---
name: setup-cloudflare-tunnel
description: Walk the user through bringing up a Cloudflare quick-tunnel to expose their local @threadbase/streamer to tb-mobile. Drives scripts/remote-access/cloudflare.sh (or .ps1 on Windows / when pwsh is preferred), explains the quick-tunnel-vs-named-tunnel tradeoff, and — if asked — guides the upgrade to a persistent named tunnel with optional Cloudflare Access. Use when the user says "expose my streamer", "set up a tunnel", "let my phone reach my streamer from outside the LAN", "set up cloudflared", "set up Cloudflare Tunnel", "I want a public URL for the streamer", or asks how to onboard tb-mobile remote pairing. The full reference lives in docs/remote-access.md and docs/remote-access/cloudflare.md — read those first before going beyond the happy-path setup.
---

# Set up a Cloudflare quick-tunnel for the streamer

The streamer binds to `127.0.0.1:8766` and isn't reachable from the network. To pair the mobile app from outside your LAN, you need a tunnel forwarding HTTPS traffic to that local port. A Cloudflare quick-tunnel is the fastest start — no account, no domain, ~30 seconds — and that's what this skill handles. Graduating to a persistent named tunnel (with optional Cloudflare Access) is a separate step the user can opt into at the end.

**Authoritative references** — read these before going beyond the happy path:
- [`docs/remote-access.md`](../../../docs/remote-access.md) — concept hub, provider comparison, security baseline.
- [`docs/remote-access/cloudflare.md`](../../../docs/remote-access/cloudflare.md) — full Cloudflare guide (quick-tunnel + named tunnel + Access). Don't paraphrase from memory; quote or link.

## Step 1 — Make sure the streamer is actually running

```sh
curl -s http://127.0.0.1:8766/healthz
```

Should print `{"ok":true,...}` with a version. If it doesn't, fix that first — the tunnel will be 502-ing if there's nothing on 8766. Send the user to `local-deploy` skill or `scripts/deploy.sh` to bring the streamer up.

## Step 2 — Pick the runner

Prefer the Go TUI when `go` is on `PATH` — it renders progress more clearly. Otherwise run the shell script directly. Both produce identical results.

```sh
# Detection
command -v go >/dev/null 2>&1 && echo "go available" || echo "no go — use plain scripts"
```

**With Go TUI:**
```sh
cd scripts/remote-access/tui
go run .
```

**Plain bash (macOS / Linux / WSL / Git Bash):**
```sh
bash scripts/remote-access/cloudflare.sh
```

**Plain pwsh (Windows native, or macOS/Linux with `pwsh` installed):**
```sh
pwsh scripts/remote-access/cloudflare.ps1
```

The script will:
1. Check `cloudflared` is installed. If not, it prints the install command for the current OS and exits non-zero — install per its hint, then re-run.
2. Start a tiny throwaway HTTP server on a free port (8767–8776) serving a "✅ you made it" page.
3. Start `cloudflared tunnel --url http://127.0.0.1:<that-port>` and parse the `*.trycloudflare.com` URL out of its output.
4. Print the URL big and ask the user to open it on their phone.
5. On `y` confirmation (or Ctrl-C), tear down the tunnel and the HTTP server.

The protocol lines (`STATUS:`, `URL:`, `PROMPT:`, `DONE:`) are intentional — you can parse them to drive your own UI if the user is running you in a non-interactive context.

## Step 3 — Explain what just happened (and what to do next)

When `DONE: ok` lands, give the user three points:

1. **That URL is gone now.** The script tore down the tunnel. Quick-tunnel URLs rotate per run; the next `cloudflared tunnel --url ...` invocation will get a different `*.trycloudflare.com`.
2. **The streamer's Bearer auth was the only gate.** Quick-tunnels can't be put behind Cloudflare Access — Access requires a hostname in a Cloudflare zone you own, and `trycloudflare.com` isn't yours. This is fine for a 5-minute pairing flow; not fine for always-on exposure.
3. **For persistent + protected exposure, graduate to a named tunnel.** Offer to walk them through it — see Step 4.

If `DONE: aborted` or `DONE: error`, the script already tore everything down. Check the `STATUS: ERROR:` lines and the tail of `cloudflared`'s log (the script prints both on failure). Common causes:
- `cloudflared` not on PATH (Step 2's install hint not followed).
- Port 8767–8776 all taken (unusual). Re-run; the bash script falls back to a free port via python.
- Outbound 443 blocked by firewall (corporate networks). Try a different network.

## Step 4 (optional) — Graduate to a named tunnel

**Only do this if the user explicitly asks.** Quick-tunnel is the right answer for "does the mobile pairing work?" — named tunnel is the right answer for "I want this URL to keep working tomorrow."

Walk through the checklist in [`docs/remote-access/cloudflare.md`](../../../docs/remote-access/cloudflare.md) → **Phase 2 — Named tunnel**:

```sh
cloudflared tunnel login                                       # browser auth, picks zone
cloudflared tunnel create tb-streamer                           # writes credentials
cloudflared tunnel route dns tb-streamer tb-pc.example.com      # CNAME bind
# Write ~/.cloudflared/config.yml (template in the docs)
cloudflared tunnel run tb-streamer                              # smoke-test
sudo cloudflared service install                                # persist as service
```

Prerequisites: a Cloudflare account + a domain whose DNS is on Cloudflare. The user must own the domain — Access policies and persistent hostnames both require it.

Once the named tunnel works, set the public hostname on the streamer so the pairing QR encodes it:

```yaml
# ~/.threadbase/server.yaml
public_url: https://tb-pc.example.com
```

**Don't write `public_url:` for a quick-tunnel.** Quick-tunnel URLs rotate per run; pinning one will silently break pairing on the next launch. The docs say this; this skill enforces it.

### Platform gotchas worth a one-line callout

- **macOS:** pick LaunchDaemon (`sudo cloudflared service install`) OR LaunchAgent (no sudo), not both. Running both produces duplicate connectors in the Cloudflare dashboard.
- **Windows:** `Restart-Service cloudflared` after editing `config.yml`. The service caches the config at start.
- **macOS LaunchDaemon reads `/etc/cloudflared/`, not `~/.cloudflared/`** — copy `config.yml` and the credentials JSON over if you went the sudo route.

## Step 5 (optional, advanced) — Cloudflare Access

Once the named tunnel is up, the user can put Cloudflare Access in front of it for identity-based protection (Google SSO, GitHub, email-OTP, service tokens). This is what `tb-pc.rbv1000.win` in this repo uses.

This is **out of scope** for the quick-tunnel onboarding flow. Point at [`docs/remote-access/cloudflare.md`](../../../docs/remote-access/cloudflare.md) → **Phase 3 — Cloudflare Access** and leave the policy authoring to the dashboard. Important caveat the user needs to know: the mobile app sends a Bearer token, not interactive login — so Access policies will need a Service Token rule (or the Access app needs to be off for the mobile-facing endpoint) for `tb-mobile` to pair through it.

## What this skill won't do

- **It won't write `public_url:` into `~/.threadbase/server.yaml` without explicit confirmation.** Mis-pinning a quick-tunnel URL there is the most common foot-gun. If the user asks for a persistent hostname, Step 4 first.
- **It won't bypass `cloudflared`'s install step.** If `command -v cloudflared` fails, instruct the user to install it; don't try to download a binary directly.
- **It won't touch any of the deploy scripts** (`scripts/deploy.sh`, `scripts/deploy.ps1`, `scripts/deploy-linux.sh`). Tunnel onboarding lives in `scripts/remote-access/` deliberately to keep deploy in flight unaffected.
