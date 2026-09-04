# D2 sealed LAN capture — rig :8790 (v1.73.0, --feature e2ee=true), 2026-09-02 11:39 IDT

Capture: `sudo tcpdump -i en0 -s 0 -w sealed-8790.pcap 'tcp port 8790'` → 92 packets.
Decode: `tshark -d tcp.port==8790,http`, hex payloads converted back to bytes before any grep (PLAN-D §14, corrected).

## Counts

- WS frames: 4 (all opcode 2 / binary; 3 server→client 192.168.68.125→.130, 1 client→server), 442 bytes decoded
- HTTP bodies: 25, 4412 bytes decoded; one 101 upgrade, all others 200

## Marker hits

| Leg | Marker | Legacy control (:8791) | Sealed (:8790) |
|---|---|---|---|
| WS | `"type":` | 1 | **0** |
| HTTP | `"conversations":` / `"sessions":` / `"serverIdentityKey":` | 4 | **0** |

`strings -n 6` over the decoded WS bytes returns **nothing** — no printable run of 6+ characters in 442 bytes of frames.

## What is legitimately in the clear (by design, not a finding)

- Request paths and query strings: `GET /api/sessions?limit=50&sortBy=…`, `GET /api/conversations?limit=50&offset=0`, `POST /api/e2ee/open` — D-7 keeps paths and query plaintext.
- The Noise handshake bodies themselves: `{"e2ee":{"v":1,"noise":"<base64>"}}` on the two `POST /api/e2ee/open` requests. This is the handshake, not application data.

Everything else on both legs is opaque.

## Coverage — what this capture does and does not cover

Covered: the post-restart re-handshake (one REST context + one WS context opened, `e2ee.context_opened` ×2, no user-visible failure — PLAN-D §14 row 7), the REST session/conversation list traffic, and the WS frames that flowed.

**Not covered — the scratch rig had no live session**, so the app never streamed terminal output, never replayed, and no user message was sent:

- Row 1 (terminal output) — not exercised
- Row 2 (replay, incl. the 2 s HTTP fallback) — not exercised
- Row 4 (user messages) — not exercised

Row 3 (conversation events) is only partially covered: the conversation *list* fetch was sealed, but the list was empty, so no event payload flowed.

## Scope

LAN only. The tunnel leg (`<test-tunnel-host>`, Cloudflare) is TLS-wrapped and opaque to this method; nothing here is a wire-secrecy claim about it.
