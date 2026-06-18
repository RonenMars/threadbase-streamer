# Tailscale Serve (tailnet-private HTTPS)

> Use this when your phone and your Mac/PC are both on the same tailnet and you want the streamer reachable **privately, over any network (incl. cellular), with valid HTTPS** — without exposing anything to the public internet.

This is **not** [Tailscale Funnel](./tailscale-funnel.md). Funnel publishes a service to the *public* internet; Serve keeps it **tailnet-only** (only your own devices can reach it). For the tb-mobile app on your own phone, Serve is the right tool.

## Why you need it (the iOS gotcha)

The streamer answers plain HTTP on `:8766`. On the **same Wi-Fi**, `http://<LAN-IP>:8766` (e.g. `http://192.168.68.104:8766`) works fine because:

- The LAN IP is routable on that Wi-Fi, **and**
- iOS App Transport Security (ATS) **exempts private RFC-1918 ranges** (`192.168.x`, `10.x`, `172.16–31.x`) and `.local` names, so it tolerates plaintext `http://` to them.

The moment the phone leaves Wi-Fi (cellular/5G), the LAN IP is unroutable → **"Unreachable."** The obvious fix is to point the app at the machine's **Tailscale IP** (`100.x`) instead. But that fails too, with a different error — **"Fetch failed"** — and *nothing arrives in the streamer log*. Why:

- Tailscale uses the `100.64.0.0/10` **CGNAT** range. iOS ATS treats `100.x` as a **public** address (it is *not* in the RFC-1918 exemption), so ATS **requires HTTPS** and **kills the plaintext `http://100.x:8766` request before a packet leaves the phone.**

So you can `tailscale ping` the phone successfully, `curl` the `100.x` IP from the Mac successfully, and *still* the app shows "Fetch failed" — because the block is in iOS, client-side, not on the wire or the server.

> **Tell-tale signature:** Fly/`https://` servers connect, both `http://` servers fail, and `grep` of `~/.threadbase/logs/stdout.log` shows **zero** requests from the phone's Tailscale IP / `CFNetwork` user-agent during the failure.

**The fix:** put valid HTTPS in front of `:8766` with `tailscale serve`. ATS is satisfied, and the URL works on any network.

## One-time prerequisite: enable HTTPS for the tailnet

Tailscale Serve needs to mint a Let's Encrypt cert for your `*.ts.net` name. Enable it once in the admin console:

1. Open <https://login.tailscale.com/admin/dns>
2. Under **HTTPS Certificates**, click **Enable HTTPS**.

(If you skip this, `tailscale serve` / `tailscale cert` fails with a "HTTPS not enabled" error.)

## Setup

```sh
# 1. Confirm this node's tailnet name and that the daemon is running
tailscale status --json | python3 -c "import sys,json;print(json.load(sys.stdin)['Self']['DNSName'])"
#   -> e.g. ronens-macbook-pro.tail5adf8e.ts.net.

# 2. Put HTTPS (port 443) in front of the streamer's local port.
#    --bg makes it persistent and detached; the daemon restores it on reboot.
tailscale serve --bg --https=443 http://127.0.0.1:8766

# 3. Verify
tailscale serve status
#   https://ronens-macbook-pro.tail5adf8e.ts.net (tailnet only)
#   |-- / proxy http://127.0.0.1:8766
```

`tailscale serve` mints the cert automatically; you do **not** need to run `tailscale cert` separately, and you do **not** need to keep any `.crt`/`.key` files on disk — Serve manages the cert internally. (If you ran `tailscale cert <name>` while debugging, it drops a `.crt` **and a private `.key`** into your *current working directory* — delete them. Never commit a private key.)

## Point the app at it

In tb-mobile, set the server URL to exactly:

```
https://ronens-macbook-pro.tail5adf8e.ts.net
```

with the same Bearer API key.

- **`https://`**, not `http://` — this is the whole point.
- **No port** — `https://` defaults to **443**, which is where Serve listens. The `:8766` is now an internal detail (Serve → `127.0.0.1:8766`). Adding `:8766` would hit the bare HTTP streamer and fail TLS.
- **Use the hostname, not the IP.** The TLS cert is issued for `…ts.net`, so `https://100.122.246.79` is rejected with a certificate-mismatch error.

## Architecture

```
phone ──HTTPS:443──▶ Tailscale Serve (TLS terminate) ──▶ streamer http://127.0.0.1:8766
   (cellular OK)       ronens-…ts.net, port 443              (unchanged, still 8766)
```

Two listeners now exist: the streamer on `8766` (untouched) and a Serve proxy on `443`. The streamer never learns a tunnel is in front of it — Bearer auth still applies to every request.

## Persistence across reboots

`tailscale serve --bg` writes the config into the Tailscale daemon state. On the **macOS standalone app** (`io.tailscale.ipn.macsys`) and on Linux `tailscaled`, the daemon starts at boot and **restores the serve config automatically** — no launchd/systemd unit of your own is required. Confirm after a reboot with `tailscale serve status`.

Cert renewal is automatic (the daemon re-mints before the ~90-day Let's Encrypt expiry).

## Teardown

```sh
tailscale serve --https=443 off
```

## When to use Serve vs. the alternatives

| Want… | Use |
|-------|-----|
| Reach the streamer from **your own** phone over any network, privately | **Tailscale Serve** (this doc) |
| Reach it from a device **not** on your tailnet (public internet) | [Cloudflare named tunnel](./cloudflare.md) or [Tailscale Funnel](./tailscale-funnel.md) |
| Quick "does pairing even work" demo | [Cloudflare quick-tunnel](./README.md#start-here-5-minute-cloudflare-quick-tunnel) |
