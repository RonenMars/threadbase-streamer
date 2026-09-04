# D2 row 9 — Cloudflare Access in front of a streamer blocks E2EE outright

Hostname `<test-tunnel-host>`, routed by tunnel `tb-e2ee-d2-20260901` to the scratch rig on `:8790` (v1.73.0, e2ee on). Owner created a self-hosted Access application over that hostname at 16:31 IDT, one policy `owner only` (Allow / Emails / owner), built-in one-time PIN, no identity provider configured. The tunnel was left untouched — Access sits in front of it.

## Before and after, same probes

| Probe | No Access (15:44) | With Access (16:32) |
|---|---|---|
| `GET /healthz` | 200 | **302 → `<team>.cloudflareaccess.com/cdn-cgi/access/login/…`** |
| `GET /api/info` | 401 (the streamer's own auth) | **302 → same login** |
| `POST /api/e2ee/open`, no `Authorization` | 400 (streamer refusing the deliberately bad `noise`) | **302 → same login**, body is HTML |
| **Control:** same POST direct to `127.0.0.1:8790` | 400 | 400 |

The control matters: the request shape still reaches the streamer and is still refused *by the streamer* on the LAN path. Through the edge it never arrives at all.

## What this settles (review carry-in N-L1)

A sealed request carries **no** `Authorization` header by design, and interactive Access rejects credential-less requests at the edge before the tunnel. So **an E2EE device cannot pair with, or open a context against, a streamer behind an interactive Access gate.** Not degraded — blocked, at the first handshake.

Cloudflare's own redirect states the alternative: the meta JWT carries `"service_token_status": false`. The supported paths are therefore:

1. **Access off** for the hostname the devices use, or
2. **A Service Token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) presented by the device, with a Service Auth policy on the application.

Never a third option that re-adds `Authorization` to sealed requests — that reintroduces exactly the credential the envelope exists to remove, and the design forbids it.

This belongs in R's rollout guide and in the stage-2 escalation, both of which already name it as an open question. It is now measured rather than predicted.

## Interaction with the retry defect found earlier today

Through Access, the client would receive **HTML** where it expects a sealed JSON envelope. That fails the handshake, and per `d2-row8-revocation-and-the-429-laundering.md` the failure is retried indefinitely — so a user who puts Access in front of their streamer gets a permanently broken app that also hammers the edge. The two defects compound.

## Confirmed on a real device (16:50 IDT)

The owner scanned a pairing QR pointing at the Access-gated hostname (`url=https://<test-tunnel-host>`) on the wired iPhone, keeping the working LAN entry as a control.

The app **failed closed**, with a specific and accurate message:

> **Pairing failed** — "This server offered an encrypted pairing and then did not finish it. Generate a fresh pairing code on your server and scan it again."

Access returned an HTML redirect where message 2 belonged, and the client refused the pairing rather than completing it in plaintext. That is the guardrail from the program brief — *after msg1, a missing msg2 is a failed pairing, never plaintext success* — holding on hardware against a real edge gate, not only in a unit test.

Server side, the streamer log for that window contains **no `POST /api/pair/exchange` line at all**: the request never arrived. The only traffic in the same seconds is the LAN control entry working normally (`/api/e2ee/open` 200, session and conversation fetches 200), which isolates the failure to the edge rather than the rig.

Two notes on the message itself: it is honest about the symptom but attributes the cause to the server "not finishing" the handshake, when in fact an intermediary answered on the server's behalf. A user behind Access would regenerate pairing codes forever without a hint that the gate is the problem. That is a copy/diagnosis gap, not a protocol fault, and it belongs with the other client findings from today.

## Scope and what was not tested

- Function only. The tunnel leg is TLS-wrapped and opaque to `tcpdump`; nothing here is a wire-secrecy claim.
- **A Service Token was not tested, and cannot be tested on a device today.** Creating one needs Access edit rights the available `CF_API_TOKEN` lacks (`auth.forbidden`, code 1010) — but the blocker is bigger than that: `tb-mobile` has **no support for Cloudflare service-token headers at all** (no `CF-Access-Client-*`, no custom-header plumbing anywhere in `services/`, `app/` or `hooks/`). So "use a Service Token" is not a remedy a user can apply today; it is client work first. That narrows the real options for a streamer behind Access to **remove Access from the hostname** or **Bypass the paths devices use** — and since the streamer is all `/api` with no separate human-facing UI, those two are nearly the same thing.
- The phone's **existing** entry was never re-pointed at the tunnel: it reached the rig over LAN at `192.168.68.125:8790` throughout and kept working, which is what makes it a valid control for the failed tunnel pairing above.

## Cleanup owed

The Access application `tb-secured` is still live and must be deleted when D2 closes — the owner created it by hand, so the deletion is theirs to make (or a token with Access edit rights would let it be scripted). The tunnel and its DNS route stay.
