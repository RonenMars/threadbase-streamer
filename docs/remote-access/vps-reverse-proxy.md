# VPS reverse proxy

> Stub. Scripted onboarding for a VPS-hosted reverse proxy is not in this pass — see the [remote-access hub](../remote-access.md) for the current state.

## When to pick a VPS reverse proxy

This is the "I'll just host it myself" option: rent a small Linux VM somewhere (Hetzner, Fly.io, DigitalOcean, OVH, your own homelab), point a domain at it, run nginx or Caddy with HTTPS, and reverse-proxy `https://yourdomain/` → `http://<your-machine>:8766`.

Use this when:

- You want zero dependencies on a third-party tunnel service.
- You're already running other things on a VPS and adding one more `server { }` block costs you nothing.
- You want unusual auth shapes (mTLS, custom OAuth, IP allowlists not supported by Cloudflare Access, etc.).

The catch: **your local machine has to be reachable from the VPS.** Most home internet connections are behind CGNAT, so you'll typically still need a tunnel (`cloudflared`, `tailscale`, `frp`, `headscale`, `wireguard`) from the VPS into your machine. At that point you've reinvented Cloudflare Tunnel with extra steps — fine if you have a reason.

If your VPS *is* the machine running the streamer (i.e. you're not at home), this is the cleanest setup: nginx terminates HTTPS, proxies to `127.0.0.1:8766`, and you're done.

## Manual setup outline (nginx, streamer co-located on VPS)

```nginx
# /etc/nginx/sites-available/threadbase
server {
    listen 443 ssl http2;
    server_name tb.example.com;

    ssl_certificate     /etc/letsencrypt/live/tb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tb.example.com/privkey.pem;

    # Streamer REST + WebSocket
    location / {
        proxy_pass http://127.0.0.1:8766;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/threadbase /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tb.example.com
```

Then point the streamer at its public hostname:

```yaml
# ~/.threadbase/server.yaml
public_url: https://tb.example.com
```

## Adding an identity layer

The Bearer-auth baseline still applies. If you want an outer ring (a la Cloudflare Access), the common nginx-stack options are:

- **Caddy with `forward_auth`** to oauth2-proxy.
- **nginx `auth_request`** to oauth2-proxy or vouch-proxy.
- **Basic auth via `htpasswd`** for the simplest possible thing.

All of these gate the proxy upstream of the streamer, so the streamer still sees authenticated traffic and applies Bearer on top.

## What's coming

Reference nginx + Caddy configs and a scripted bootstrap (`scripts/remote-access/vps-bootstrap.sh`) for a fresh Debian VPS are tracked as a follow-up. PRs welcome.
