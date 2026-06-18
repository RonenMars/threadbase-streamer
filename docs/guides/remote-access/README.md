# Remote access

The streamer binds to `127.0.0.1:8766` and never opens itself to the network on its own. The mobile app (`tb-mobile`) can only reach it when *something else* — a tunnel, a funnel, or a reverse proxy — forwards HTTPS traffic to that local port. This document is the hub for every supported way of doing that.

## The mental model

```
tb-mobile ──HTTPS──▶ <public hostname> ──▶ [tunnel/funnel/proxy] ──▶ http://127.0.0.1:8766
                            │                                              │
                            └── optional identity layer here                └── always: Bearer auth
                                (Cloudflare Access, Tailscale ACLs,
                                 nginx basic-auth, …)
```

Three things are always true regardless of which provider you pick:

1. **The streamer is the source of truth for auth.** Every request — REST and WebSocket — must carry `Authorization: Bearer <api_key>` (or `?key=<api_key>` for the WebSocket URL). The pair-exchange endpoint mints that key once via QR code; mobile stores it. Nothing about adding a tunnel changes that.
2. **The streamer doesn't know or care which tunnel sits in front of it.** Provider choice is purely an ops decision. Swapping Cloudflare for Tailscale Funnel doesn't touch a single line of `src/`.
3. **`public_url` in `~/.threadbase/server.yaml` is the only place the streamer "sees" the public hostname** — it gets embedded into the pairing QR so mobile dials the public URL instead of `localhost`. If you don't set it, the QR shows the LAN IP, which only works on the same Wi-Fi.

## Pick a provider

| Provider | Best for | Cost | Account needed | Persistent hostname | Identity layer in front |
|----------|---------|------|-----------------|---------------------|-------------------------|
| **Cloudflare Tunnel — quick** | First-time onboarding, "does this even work?", demos | Free | None | ❌ Random `*.trycloudflare.com` per run | ❌ Anonymous (Bearer is your only gate) |
| **Cloudflare Tunnel — named** | Always-on personal deployment, the setup this repo uses | Free | Cloudflare account + domain on Cloudflare DNS | ✅ Your own hostname | ✅ Cloudflare Access (recommended) |
| **ngrok** | Same niche as quick-tunnel but with optional named domains on paid plans | Free tier with random URLs; paid for reserved | ngrok account | Paid tier only | ✅ ngrok OAuth/keys |
| **Tailscale Serve** | Reaching the streamer from **your own** devices over any network (incl. cellular), **tailnet-private** — not public | Free for personal use | Tailscale account | ✅ Tied to your tailnet | ✅ Tailnet membership (devices only) |
| **Tailscale Funnel** | Private-by-default networks where you also want a public endpoint | Free for personal use | Tailscale account | ✅ Tied to your tailnet | ✅ Tailscale ACLs |
| **VPS reverse proxy** | Full control, self-hosted, want one box doing many things | VPS rental | Anywhere you can rent a Linux box | ✅ Whatever DNS you point at it | ✅ Whatever you configure (nginx auth, Caddy, etc.) |

## Start here: 5-minute Cloudflare quick-tunnel

The fastest path from "streamer is running on my machine" to "mobile app paired over the internet" is a Cloudflare quick-tunnel. No Cloudflare account, no domain, no DNS. You get a random `*.trycloudflare.com` URL that rotates every time you run it — perfect for proving the pairing flow works, **not** for persistent exposure.

We ship a script for this:

```sh
# macOS / Linux / WSL / Git Bash
bash scripts/remote-access/cloudflare.sh

# Windows (or anywhere pwsh is available)
pwsh scripts/remote-access/cloudflare.ps1
```

It checks `cloudflared` is installed, brings the tunnel up, serves a small "✅ you made it" page through that tunnel, and asks you to open the URL on your phone to confirm the round-trip works. When you confirm, it tears everything down.

There's also an optional Go TUI wrapper that renders the same flow with a nicer progress UI:

```sh
cd scripts/remote-access/tui && go run .
```

The Claude Code skill `setup-cloudflare-tunnel` runs the same script and handles the prereq checks for you — useful if you'd rather talk to the agent than touch the shell.

Full Cloudflare guide (quick-tunnel walkthrough + how to graduate to a persistent named tunnel + how Cloudflare Access fits in): **[remote-access/cloudflare.md](./remote-access/cloudflare.md)**.

## Per-provider guides

- **Cloudflare Tunnel** — [remote-access/cloudflare.md](./remote-access/cloudflare.md) (full guide; this is the path this repo's `tb-pc.rbv1000.win` deployment uses)
- **ngrok** — [remote-access/ngrok.md](./remote-access/ngrok.md) (stub; scripted onboarding coming)
- **Tailscale Serve (tailnet-private HTTPS)** — [tailscale-serve.md](./tailscale-serve.md) (the path for reaching your own machine from your own phone over cellular; covers the iOS ATS plaintext-`http`-to-`100.x` gotcha)
- **Tailscale Funnel** — [remote-access/tailscale-funnel.md](./remote-access/tailscale-funnel.md) (stub; scripted onboarding coming)
- **VPS reverse proxy (nginx / Caddy)** — [remote-access/vps-reverse-proxy.md](./remote-access/vps-reverse-proxy.md) (stub; scripted onboarding coming)

## Security baseline (read this no matter which provider you pick)

- **Always set a strong API key.** The streamer generates one on first run and writes it to `~/.threadbase/server.yaml`. Don't share it; don't check it in.
- **Bearer auth is mandatory for everything except `/healthz` and `POST /api/pair/exchange`.** Those two are intentionally open — the pair-exchange endpoint uses a separate single-use, 180-second pairing token instead.
- **Quick-tunnels (Cloudflare/ngrok free tier) are anonymous.** The only thing stopping a stranger from hammering your streamer is the Bearer key. Treat them as ephemeral by design — bring them up for onboarding, then tear them down.
- **For always-on exposure, put an identity layer in front.** Named Cloudflare tunnels + Cloudflare Access is the path documented in this repo. Tailscale Funnel + ACLs and nginx + OAuth2-proxy are equivalent shapes.
- **The streamer trusts whatever's on the other end of the TCP connection.** It does not validate origin, IP, or TLS-client cert. Whatever access controls you want — IP allowlists, geo blocks, MFA — belong in the provider layer, not in the streamer.

## Skills for other agents

The Claude Code skill `setup-cloudflare-tunnel` lives at `.claude/skills/setup-cloudflare-tunnel/`. Equivalent skills for other agent runtimes (Codex, Cursor, Gemini, GitHub Copilot, Antigravity) are not in this pass — the underlying scripts (`cloudflare.sh`, `cloudflare.ps1`) and the Go TUI are agent-agnostic, so any agent that can run a shell command can drive them today. Native skill files for those runtimes are tracked as a follow-up.

If you're writing one of those skills yourself, the contract is:
- Detect OS, prefer the Go TUI (`cd scripts/remote-access/tui && go run .`) when `go` is on `PATH`, otherwise run `bash scripts/remote-access/cloudflare.sh` (Unix) or `pwsh scripts/remote-access/cloudflare.ps1` (Windows or anywhere).
- Parse the line-prefixed protocol (`STATUS:`, `URL:`, `PROMPT:`, `DONE:`) from the script's stdout for stepwise UI.
- Don't touch `~/.threadbase/server.yaml` without asking. Quick-tunnel URLs rotate; pinning one in `public_url:` will silently break pairing on the next run.
