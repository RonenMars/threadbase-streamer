# Teardown — the `tb-secured` Cloudflare Access application

Created by hand 2026-09-02 16:31 IDT for D2 row 9. **Still live.** Delete it when D2 closes, or sooner if it gets in the way — but read "When to run this" first.

## When to run this

Not yet, if the Access-probe feature (streamer, `feat/e2ee-access-probe`) is still being built or tested: a live gate is the only way to verify the probe reports a real block rather than a synthetic one. Run it once that work is done, or immediately if you need the hostname working again for anything else.

Nothing else in the program depends on the gate. Every other D2 row was taken over LAN.

## What to delete, and what to keep

| Object | Action |
|---|---|
| Access application `tb-secured` (destination `<test-tunnel-host>`, policy `owner only`) | **Delete** |
| Policy `owner only` | Deleted with the app, or separately under Access controls → Policies if it lingers |
| Tunnel `tb-e2ee-d2-20260901` (`<tunnel-id>`) | **Keep** |
| DNS route `<test-tunnel-host>` → that tunnel | **Keep** |
| Service token, if one was created for the probe work | Delete alongside the app |

Deleting the tunnel or the DNS record would break the hostname itself rather than just removing the gate, and the rig still uses both.

## Dashboard route (what the owner used to create it)

1. https://dash.cloudflare.com → left sidebar **Zero Trust**
2. **Access controls** → **Applications**
3. Row `tb-secured` → the **⋯** menu at the right end → **Delete**
4. Confirm

The old `one.dash.cloudflare.com/<account>/access/apps` URLs 404 in the current Cloudflare One redesign; navigate by sidebar rather than by saved link.

## API route (needs a token the current one is not)

`CF_API_TOKEN` in this environment can **read** Access applications but not modify them — creating one returned `auth.forbidden` (code 1010). A token with *Account → Access: Apps and Policies → Edit* can do it headlessly:

```bash
acct=<cloudflare-account-id>
# find the id
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$acct/access/apps" \
  | python3 -c "import json,sys; [print(a['id'], a.get('domain')) for a in json.load(sys.stdin)['result']]"

# delete it
curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$acct/access/apps/<APP_ID>"
```

## Verifying the teardown

The gate is gone when the pre-Access behaviour returns — these were the exact values before it existed:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<test-tunnel-host>/healthz    # expect 200, not 302
curl -s -o /dev/null -w '%{http_code}\n' https://<test-tunnel-host>/api/info   # expect 401 (the streamer's own auth)
```

A 302 to `<team>.cloudflareaccess.com` means the application is still there. Access caches nothing meaningful here; the change takes effect within seconds.

## On the phone afterwards

The failed pairing attempt against the tunnel hostname may have left a broken server entry. Delete that one; keep `http://192.168.68.125:8790` (the working LAN entry) and `http://192.168.68.125:8791` (the legacy control).
