# The no-root capture fallback — built and validated end to end

**Status: WORKS, and deliberately UNUSED.** Session G, 2026-09-04. Built because the `/dev/bpf*`
grant has now failed to land twice and the next session should not discover a third failure
with the user standing at the phone.

## What it is

A ~40-line logging TCP relay (`relay.js`). It listens on a LAN address, forwards to the rig,
and writes every payload byte in both directions to `c2s.bin` / `s2c.bin`. It needs **no
elevated privilege**, which is the entire point.

It is put in the path without hand-editing a QR because of how the streamer picks its
advertised address: `src/lan-url.ts::resolveServerUrl` returns `publicUrl` when set, so the rig
can be told to advertise the relay. `spk` is the server's **static** key and is
host-independent, so pairing through a different host:port is sound.

**Safety guard, proven rather than asserted:** the relay refuses port **8766** — the user's
launchd-supervised production streamer — and exits before creating any output directory. Run as
a check: it printed the refusal, exited **2**, and created nothing.

## Self-validation — real crypto, no human, through the relay

Driven by the previous session's scripted device (`scripts/g-sealed-frames.ts`), pointed at
`http://192.168.68.125:8792` (relay) → `127.0.0.1:8790` (sealed rig). It performed a **real
Noise IKpsk1 pairing**, a **real `/api/e2ee/open` context with a ticket**, and a **real ticketed
WebSocket upgrade**:

```
server e2ee: {"supported":true,"enabled":true,"version":1,"required":false}
paired scratch device 12d600c9…
context open, ticket present: true
handshake: HTTP/1.1 101 Switching Protocols
TCP reads: 4   bytes read: 1684
complete WebSocket frames parsed: 3
  opcode 2  binary  3 frames
  FIN=0 (fragmented) frames: 0
  opcode-0 continuation frames: 0
```

Relay recorded **6 617 payload bytes** — 2 064 client→server, 4 553 server→client.

## The sweep, with its controls **inside the same capture**

This is the part that makes the method usable: causality is demonstrated in one stream rather
than across two rigs.

**Positive controls — plaintext by design, and all found:**

| Marker | Found |
|---|---|
| `GET /` | 3 |
| `Upgrade: websocket` | 2 |
| `101 Switching Protocols` | 1 |
| `"e2ee"` (handshake bodies) | 5 |

**Sealed-channel markers — all absent:**

| Marker | Found |
|---|---|
| session id `fb85cae2-…` | **0** |
| `"type":` (a WS frame field) | **0** |
| `terminal_replay` | **0** |
| `sessionId` | **0** |

**Longest printable runs in the server→client stream**, which is the real demonstration:

- **988** — `{"ciphertext":"…","nonce":"…"}` — the sealed REST envelope, correctly opaque.
- **608** — a **plaintext** `/api/info` JSON body.
- **251** — `{"e2ee":{"v":1,"noise":"…"}}` — in the clear by design.

The 608-byte plaintext body is the strongest single line of evidence here: **the same relay and
the same sweep read application plaintext where plaintext exists, and found nothing where
sealing applies.** A zero on the sealed markers is therefore a result, not a broken pipeline.

**That plaintext `/api/info` is expected and is not a finding.** It is the pre-E2EE bootstrap
the scripted device performs with `Authorization: Bearer` to learn `serverIdentityKey` — a
**public** key. It is a property of this harness's bootstrap, and says nothing about whether the
mobile app seals its own REST leg. Add it to the in-the-clear-by-design list **for the harness**,
not for the app. (It also carries a real machine name, so it is scrubbed from anything leaving
the scratchpad.)

## Limits — why this stays the fallback, not the method

- It is a **relay hop, not the LAN segment**. It proves what **leaves the device**; it does not
  observe what crosses the wire between two other hosts. Every other ciphertext claim in D2
  rests on a segment capture, and mixing methods across rows makes the report harder to read.
- Its compensating strength is real: **100 % of payload in both directions with no dissection
  gap**, against `tcpdump` + tshark's field pipeline which missed **33.54 %** on D2's own
  captures.
- Client→server WebSocket frames are still XOR-masked, exactly as in a pcap; the relay holds
  complete frames, so they can be unmasked, but that is work the field pipeline does for free.
- It adds a hop, so timing evidence taken through it is not the device's true timing.

**Preferred order stays: the `bpf` grant first, this second.** One command, and it observes the
segment. This exists so that a third failed grant costs minutes, not a trip.

## Operational note

`nohup … &` from a tool call did **not** keep the relay alive — it received SIGTERM when its
launching shell ended, and its own totals report fired, which is how this was caught rather than
misread as a crash. It must be started as a long-lived background process in its own right.
