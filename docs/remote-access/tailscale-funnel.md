# Tailscale Funnel

> Stub. Scripted onboarding for Tailscale Funnel is not in this pass — see the [remote-access hub](../remote-access.md) for the current state.

## When to pick Tailscale Funnel

Tailscale Funnel is interesting if you already live on Tailscale — your laptops/phones/servers are on a tailnet, and you want **one** of those services (the streamer) reachable from the public internet without exposing the rest.

- **Free for personal use.** Funnel is included in Tailscale's free Personal plan.
- **Persistent hostname tied to your tailnet** (e.g. `tb.tail-scale.ts.net`). No domain purchase needed.
- **Identity layer = Tailscale ACLs.** You control which devices/users can hit the funnel via your tailnet's ACL config.
- **Limited port set.** Funnel only forwards ports 443, 8443, and 10000 by default — the streamer runs on 8766, so Funnel terminates HTTPS on one of its allowed ports and proxies internally to 8766.

If you don't already use Tailscale, the setup overhead (install tailscaled, join a tailnet, enable Funnel for the node) is higher than a Cloudflare quick-tunnel. Worth it if you're already on Tailscale; otherwise start with Cloudflare.

## Manual setup outline

```sh
# 1. Install Tailscale (https://tailscale.com/download) and join your tailnet
tailscale up

# 2. Enable Funnel for this node (one-time)
tailscale funnel 443 on

# 3. Forward Funnel traffic to the streamer
tailscale serve --bg --https=443 http://127.0.0.1:8766

# 4. See your funnel URL
tailscale funnel status
```

Your funnel URL looks like `https://<host>.<tailnet>.ts.net`. Set it as `THREADBASE_PUBLIC_URL` or `public_url:` in `~/.threadbase/server.yaml` so the pairing QR encodes it.

## What's coming

A scripted onboarding (`scripts/remote-access/tailscale.sh` + `.ps1`) handling the tailscaled-presence check, funnel toggle, success-page handshake, and teardown is tracked as a follow-up. PRs welcome.
