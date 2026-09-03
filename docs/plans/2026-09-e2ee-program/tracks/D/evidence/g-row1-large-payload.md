# G — row 1 at scale: terminal output sealed, 3 MB, no packet capture required

**Status: PASS.** Session G, 2026-09-02 evening IDT. Rig: streamer `v1.74.0`
(`67f2d05e…`), sealed rig :8790 (`--feature e2ee=true`), legacy control rig :8791
(`--feature e2ee=false`).

## What this row is, and why it is not a duplicate of D2 row 1

D2's row 1 established that terminal output is sealed. Its entire evidence base is
**221 557 payload bytes across three captures, with no WebSocket frame above 126
bytes**. This row repeats the question at a scale D2 never reached:

| | D2 | this row |
|---|---|---|
| bytes generated through the session | not recorded; captures total 221 557 B | **3 000 224 B** in **4 241 lines** |
| largest WebSocket frame | 126 B | **165 893 B sealed** (165 847 B plaintext) |
| frame vs MSS | 0.09× | **~114×** |

The content is mixed text, base64 and high-byte binary from a controlled generator
(see the addendum in `D2-REPORT.md` for why a generator, and what stays real).

## Method — and its honest limits

Both legs were driven over a **raw TCP socket** that performs the WebSocket handshake
by hand, so **every byte the server transmitted on that connection is written to a
file** and swept. The sealed leg used a real Noise IKpsk1 pairing, a real
`/api/e2ee/open` context and a real ticketed upgrade, so the bytes swept are the
output of the real record layer.

This is **not** a substitute for `tcpdump`, and the difference matters:

- It sees **one WebSocket connection, server-to-client only**. It does not cover the
  REST/HTTP leg, other connections, or the client-to-server direction.
- It therefore **cannot replace the full-payload sweep** for a whole-wire claim.
- What it does give, without elevated privilege, is the exact ciphertext the server
  put on the wire for the traffic under test — at a scale no capture in this program
  has previously reached.

`tcpdump` still needs root here (`/dev/bpf*` is `crw------- root:wheel`, no
`access_bpf` group, no ChmodBPF daemon), which is why this route was taken.

## Marker derivation — from the run's artefacts, never from memory

D2's method note, applied literally. The marker list is assembled at sweep time from:

1. the generator's **machine-written manifest** (`manifest-<RUN>.json`, 214 markers);
2. the **session id** the server minted;
3. the **project name** (`g-demo`);
4. **literal 40-byte slices of the output as the server itself recorded it**, read
   back from `GET /api/sessions/<id>/output` at sweep time.

222 markers were tested per leg. No marker was typed by hand.

## Result

### Positive control — legacy rig :8791, plaintext, identical run

```
wire bytes: 167 549
DERIVED markers tested: 222   markers FOUND on the wire: 15
generic plaintext probes:
  "type":                4
  terminal_replay        1
  sessionId              2
  the quick brown fox  216
  GCTRL                164
  GSEAL                  0
```

The sweep finds plaintext when plaintext is present, in the same invocation shape.

**Why 15 of 222 and not more, stated so it is not mistaken for a weak control:** the
PTY scrollback is a bounded virtual terminal — 3 000 224 bytes were written but only
~45 KB are retained and replayed, so most manifest markers scrolled off and were never
transmitted at all. The markers that *were* transmitted are found, and the volume
signals are unambiguous (`GCTRL` 164, `the quick brown fox` 216).

### Sealed rig :8790, same generator, same 3 MB, same sweep

```
wire bytes: 166 945
DERIVED markers tested: 222   markers FOUND on the wire: 0
generic plaintext probes:
  "type":                0
  terminal_replay        0
  sessionId              0
  the quick brown fox    0
  GCTRL                  0
  GSEAL                  0
```

**Zero of 222 derived markers. Zero on every generic probe.** Frame-level: 4 frames,
all opcode 2 (sealed binary), all FIN set, largest 165 893 B.

`GSEAL` reads 0 on the legacy leg and `GCTRL` reads 0 on the sealed leg because each
leg ran its own generator instance — the cross-terms are expected and are recorded so
the table cannot be misread.

## Verification bar

| requirement | how it was met |
|---|---|
| real objects on the production path | real streamer, real PTY, real ws-hub, real Noise handshake, real record layer, real socket |
| positive control | the identical sweep on the identical run over the legacy rig finds markers (15/222, `GCTRL` 164) |
| negative control | `GSEAL`/`GCTRL` cross-terms read 0 as expected; the frame parser's fragmentation control is in `g1-continuation-frames.md` |
| falsifiability | a single derived marker appearing in the sealed bytes falsifies the row; none did across 222 |

## What this row does NOT establish

- Nothing about the **REST/HTTP leg** — not swept here.
- Nothing about **client-to-server** frames — not dumped here.
- Nothing about the **tunnel leg**, which is TLS and opaque to every method in this
  program.
- It is **LAN/loopback scope**, like every ciphertext claim in D2.

The whole-wire sweep that covers those still needs `tcpdump`, and so still needs root.
