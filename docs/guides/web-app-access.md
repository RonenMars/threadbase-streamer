# Using your sessions from the web app (app.threadbase.sh)

The Threadbase web app at **https://app.threadbase.sh** runs in a browser, so it can reach your streamer only if the streamer says it may.
Out of the box it does not: browser CORS is **off by default**, and the app's pairing screen fails with *"Could not reach that server"* even though the streamer is running and the tunnel is up.
The native mobile app is unaffected, because it sends no `Origin` header.

This guide enables the web app in one step.

## Before you start

- The streamer must be reachable over **HTTPS** from the internet (a tunnel, funnel or reverse proxy — see [remote-access](remote-access/README.md)).
  An `https://` page cannot call a plain `http://` server; the browser blocks it as mixed content.
- Run the steps below **on the machine that runs the streamer**.

## Option 1 — run the script

```bash
bash scripts/allow-web-app.sh
```

That adds `https://app.threadbase.sh` to `browser_cors:` in `~/.threadbase/server.yaml`.
It keeps any origins you already listed, does nothing if the origin is already there, and saves a `server.yaml.bak-<timestamp>` copy first.
Pass another origin as the argument to allow a self-hosted build of the web app: `bash scripts/allow-web-app.sh https://web.example.com`.

It does not restart the streamer — see [Apply it](#apply-it).

## Option 2 — edit `server.yaml` yourself

Open `~/.threadbase/server.yaml` and add one line:

```yaml
browser_cors: https://app.threadbase.sh
```

To allow more than one origin, separate them with commas and no spaces:

```yaml
browser_cors: https://app.threadbase.sh,https://web.example.com
```

Rules the streamer is strict about:

- The value is the exact **origin**: `https://` + host (+ port), with **no trailing slash and no path**. `https://app.threadbase.sh/` does not match.
- Write it **unquoted**.
- Do not leave a commented `# browser_cors: …` line above the real one — the streamer reads the first `browser_cors:` it finds in the file, comments included.
- Listing any origin also allows the local dev origins (`http://localhost:8081`, `:19006`, `:3000`).

Prefer an environment variable on a supervised install where you do not want to touch the file?
`THREADBASE_ALLOW_BROWSER_CORS=https://app.threadbase.sh` does the same and **wins over** `server.yaml`.

## Apply it

The setting is read at boot, so restart the streamer:

```bash
tb-streamer service restart
```

**A restart ends live sessions.**
Do it when nothing is running that you care about; `idle` sessions keep their history and can be resumed afterwards.

## Check that it worked

Replay the preflight request the browser sends, with your own hostname:

```bash
curl -si -X OPTIONS https://tb.example.com/healthz \
  -H 'Origin: https://app.threadbase.sh' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
```

- `HTTP/2 204` with `access-control-allow-origin: https://app.threadbase.sh` — allowed. Pair from the web app.
- `HTTP/2 403` with no `access-control-allow-origin` — the origin is not allowed yet. Recheck the value against the rules above, and that the streamer restarted.

If you put **Cloudflare Access** in front of the tunnel and the check still returns 403 after a restart, Access may be answering the preflight itself.
Browsers send preflights without credentials, so the Access policy needs a bypass for the `OPTIONS` method.
See [remote-access/cloudflare.md](remote-access/cloudflare.md).

## Security note

Allowing an origin does not open the streamer: every request still needs the `Authorization: Bearer <api_key>` header, and the API key is what protects your sessions.
`browser_cors:` only lets a web page from that origin *attempt* an authenticated request, so list only origins you trust.

See also: [Troubleshooting → Browser clients](../troubleshooting.md#browser-clients-expo-web).
