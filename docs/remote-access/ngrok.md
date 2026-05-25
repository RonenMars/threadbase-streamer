# ngrok

> Stub. Scripted onboarding for ngrok is not in this pass — see the [remote-access hub](../remote-access.md) for the current state.

## When to pick ngrok over Cloudflare quick-tunnel

ngrok and Cloudflare quick-tunnels solve the same problem (random public URL to your `localhost`), but a few things separate them:

- **ngrok requires an account** (free) even for ephemeral URLs. Cloudflare quick-tunnels don't.
- **ngrok's paid tier gives you reserved subdomains and custom domains.** Cloudflare's equivalent is a named tunnel — also free, but requires a domain on Cloudflare DNS.
- **ngrok has built-in auth in front of the tunnel** (basic auth, OAuth, IP allowlists) on paid tiers. With Cloudflare you'd graduate to a named tunnel + Cloudflare Access for the same shape.

If you already have an ngrok account and a workflow built around it, it's a fine choice. If you're starting fresh, the Cloudflare quick-tunnel script (`scripts/remote-access/cloudflare.sh` / `.ps1`) is zero-account and gets you running in under a minute.

## Manual setup outline

```sh
# 1. Install
brew install ngrok                               # macOS
winget install ngrok.ngrok                       # Windows
# Linux: see https://ngrok.com/download

# 2. Authenticate (one-time)
ngrok config add-authtoken <your-token>

# 3. Start the tunnel
ngrok http 8766
```

ngrok prints a `https://<random>.ngrok-free.app` URL — that's what tb-mobile connects to. The Bearer-auth rules from the [remote-access hub](../remote-access.md) apply.

## What's coming

A scripted onboarding (`scripts/remote-access/ngrok.sh` + `.ps1`) mirroring the Cloudflare flow — install check, tunnel up, success-page handshake, clean teardown — is tracked as a follow-up. PRs welcome.
