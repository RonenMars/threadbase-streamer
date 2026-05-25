# Cloudflare Tunnel

This guide covers two phases:

1. **Quick-tunnel** — 5-minute, no-account, throwaway URL. The right start point for "does the mobile pairing flow even work?"
2. **Named tunnel** — your own hostname, persistent, optionally protected by Cloudflare Access. The right end-state for always-on exposure (and the setup this repo's `tb-pc.rbv1000.win` deployment uses).

Start with phase 1. If the answer to "do I want this to stay up?" is yes, graduate to phase 2.

---

## Phase 1 — Quick-tunnel (start here)

A quick-tunnel is `cloudflared`'s zero-config mode. You run one command, Cloudflare hands back a `https://<random>.trycloudflare.com` URL, traffic to it forwards to `http://127.0.0.1:8766`. No Cloudflare account, no domain, no DNS. The URL rotates every time you run `cloudflared`.

### Scripted path (recommended)

We ship a script that does the dependency check, brings up the tunnel, serves a small "✅ you made it" page through it, and asks you to open the URL on your phone to confirm the loop works.

```sh
# macOS / Linux / WSL / Git Bash
bash scripts/remote-access/cloudflare.sh

# Anywhere `pwsh` is installed — Windows native, or macOS/Linux via Homebrew
pwsh scripts/remote-access/cloudflare.ps1
```

Optional Go TUI wrapper with the same flow, nicer progress UI:

```sh
cd scripts/remote-access/tui
go run .
```

The Claude Code skill `setup-cloudflare-tunnel` runs the same script — useful if you'd rather have the agent walk you through it.

### Manual path

If you'd rather see what the script does:

```sh
# 1. Install cloudflared
brew install cloudflared                              # macOS
winget install --id Cloudflare.cloudflared            # Windows
# Debian/Ubuntu: see https://pkg.cloudflare.com/cloudflared/

# 2. Bring the tunnel up
cloudflared tunnel --url http://127.0.0.1:8766
```

`cloudflared` prints something like:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                          |
|  https://chocolate-mountain-shore-onion.trycloudflare.com                                  |
+--------------------------------------------------------------------------------------------+
```

That URL is what you give to the mobile app (or paste into `THREADBASE_PUBLIC_URL` if you want the QR to encode it). Kill the process with Ctrl-C to take the tunnel down.

### What you should know before relying on this

- **The URL rotates every run.** Don't put it in `~/.threadbase/server.yaml`'s `public_url:` — the next launch will break pairing silently.
- **It's anonymous.** Cloudflare Access cannot attach to `*.trycloudflare.com` (you don't own the hostname). The streamer's Bearer auth is the only gate. Fine for a 5-minute pairing flow; not fine to leave running unattended.
- **Cloudflare imposes no published SLA on quick-tunnels.** They're documented as "intended for testing only." If your URL stops responding mid-demo, that's the deal.

When you're ready for something persistent, jump to Phase 2.

---

## Phase 2 — Named tunnel (when you want it always-on)

A named tunnel is yours: it lives in your Cloudflare account, it routes through a hostname you own, you can attach Cloudflare Access policies to it, and it survives restarts. This is what `tb-pc.rbv1000.win` in this repo is.

### Prerequisites

- A Cloudflare account.
- A domain whose DNS is managed by Cloudflare (the zone must live in the same Cloudflare account you'll authenticate `cloudflared` against). You can't use a subdomain of `trycloudflare.com` — it's not yours.
- `cloudflared` installed locally (Homebrew, MSI, `.deb`/`.rpm`).

### The checklist

```sh
# 1. Authenticate (opens a browser, lets you pick a zone, writes ~/.cloudflared/cert.pem)
cloudflared tunnel login

# 2. Create the named tunnel (writes ~/.cloudflared/<UUID>.json credentials)
cloudflared tunnel create tb-streamer

# 3. Bind a hostname to it (creates a proxied CNAME for you)
cloudflared tunnel route dns tb-streamer tb-pc.example.com

# 4. Write ~/.cloudflared/config.yml — see below

# 5. Test it interactively
cloudflared tunnel run tb-streamer

# 6. Once it works, install as a service so it survives reboot
sudo cloudflared service install            # macOS / Linux
cloudflared.exe service install             # Windows (run as Administrator)
```

### `~/.cloudflared/config.yml`

```yaml
tunnel: <UUID-from-step-2>
credentials-file: /Users/<you>/.cloudflared/<UUID-from-step-2>.json
ingress:
  - hostname: tb-pc.example.com
    service: http://127.0.0.1:8766
  - service: http_status:404
```

### Tell the streamer about its public hostname

Once the named tunnel is up and you can `curl -H "Authorization: Bearer <key>" https://tb-pc.example.com/healthz` successfully, point the streamer at it so the pairing QR encodes the right URL:

```yaml
# ~/.threadbase/server.yaml
public_url: https://tb-pc.example.com
```

Or via env var: `THREADBASE_PUBLIC_URL=https://tb-pc.example.com`.

### Platform-specific gotchas (the ones that bite people)

- **macOS — pick agent OR daemon, not both.** `sudo cloudflared service install` registers a LaunchDaemon that runs as root and reads `/etc/cloudflared/config.yml`. `cloudflared service install` (no sudo) registers a LaunchAgent that runs as you and reads `~/.cloudflared/config.yml`. Running both produces duplicate tunnel connections — the dashboard will show two connectors for the same tunnel.
- **macOS — if you used the daemon, copy your config and credentials to `/etc/cloudflared/`.** It does not read `~/.cloudflared/`.
- **Windows — after editing `config.yml`, restart the service.** `Restart-Service cloudflared`. The service caches the config at start; edits to the file are not picked up automatically. This repo's `CLAUDE.md` notes the same thing for `config-system.yml`.
- **`cloudflared service install <TOKEN>` is a different thing.** That's the remotely-managed form for tunnels you created in the Cloudflare dashboard. It ignores your local `config.yml`. For the locally-managed config above, omit the token.

---

## Phase 3 — Cloudflare Access (recommended once you're on a named tunnel)

Cloudflare Access puts an identity check in front of your tunnel — Google SSO, GitHub, email-OTP, service tokens, IP rules, whatever. It's the difference between "anyone who guesses the URL can hit the Bearer-auth wall" and "the URL doesn't respond at all unless the caller is on your allow-list."

This repo's existing `tb-pc.rbv1000.win` tunnel runs behind Access. The streamer's own Bearer auth still applies on top — Access is the outer ring, Bearer is the inner ring.

### Why Access can't protect a quick-tunnel

Access policies attach to an **Application**, which is scoped to a hostname in a zone you own. `trycloudflare.com` is not your zone — there's no Application object to attach a policy to, no DNS record under your control, no way to enforce anything at the edge. This is a Cloudflare product constraint, not a missing feature.

Practically: Service Tokens, mTLS, and `cloudflared access` headers all live downstream of an Access Application. None of them apply to `*.trycloudflare.com` either.

**Translation:** if you want identity in front of the streamer, you must be on a named tunnel.

### Setting up an Access Application (high level)

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. **Application domain:** the hostname from Phase 2 (e.g. `tb-pc.example.com`).
3. **Identity providers:** at minimum, enable one (Google / GitHub / One-time PIN to your email is the easiest start).
4. **Policy:** "Allow" with a rule like "Emails ending in `@yourdomain.com`" or "Specific email: you@example.com".
5. Save. Hitting `https://tb-pc.example.com` now redirects to a Cloudflare login page; only allowed identities reach the streamer.

### Mobile app + Access

The mobile app sends `Authorization: Bearer <api_key>`. If Cloudflare Access requires interactive login, the mobile app's plain HTTPS request will get a `302` to a Cloudflare login URL — which it won't follow, so pairing fails.

Two workable patterns:

- **Service Token** in front of the named tunnel: Access → Service Auth → create a Service Token, then add an Access policy with rule "Include Service Token". The mobile app's HTTP client sends the two `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers on every request. (Mobile-side support for this needs to be checked separately — out of scope for this doc.)
- **Bypass Access entirely** on the tunnel hostname and rely on Bearer + named-tunnel DNS obscurity. Weaker than Access; still vastly stronger than a quick-tunnel.

The pragmatic answer for now: leave Access turned on for browser/laptop access, and treat the mobile client as if it's making a direct headless call (Service Token or Access-off depending on your appetite).

---

## When to use what

| Situation | Use |
|-----------|-----|
| "I just want to see the QR pair from my phone right now" | Phase 1 — quick-tunnel script |
| "I want this URL to stay the same and survive reboots" | Phase 2 — named tunnel |
| "I want only me (or my team) to be able to hit it" | Phase 2 + Phase 3 — named tunnel + Access |
| "I want to share this with a non-Cloudflare user one-off" | Phase 1 — quick-tunnel script, then tear it down |

## Troubleshooting

- **`401 Unauthorized` from `/healthz` over the named tunnel** — Access is in front of it. Either log in via browser, configure a Service Token, or remove the Access policy. Direct `http://localhost:8766/healthz` will still work because Access is at the CF edge, not on the streamer.
- **Quick-tunnel URL works on laptop, mobile app can't pair** — check the mobile app is sending the Bearer token; quick-tunnel hosts don't bypass the streamer's auth.
- **Named tunnel returns 502** — `cloudflared` can't reach `127.0.0.1:8766`. Check the streamer is actually running (`curl http://127.0.0.1:8766/healthz` locally) and that `config.yml`'s `service:` line matches the port.
- **macOS — duplicate connectors in dashboard** — you have both the LaunchAgent and the LaunchDaemon running. Pick one, `launchctl unload` the other.

For runtime issues unrelated to the tunnel (PTY/launchd/etc.) see [`docs/troubleshooting.md`](../troubleshooting.md).
