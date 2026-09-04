# G-1 — WebSocket continuation frames on the client's receive path

**Status: COMPLETE.** Determined at source, and observed directly on BOTH the plaintext
and the sealed leg, with a negative control proving the observation could have failed.
No packet capture and no elevated privilege were required.

**Session:** G, 2026-09-02 evening IDT. Rig pinned to streamer `v1.74.0`
(`67f2d05eebdc33f8651700be297251a62771589d`), `dist/cli.cjs` sha256
`e106cb527a01a1150cb3eb0a5a8a475e8fccd297e9e0e26373e16eba018dcbeb`.

## Why this row exists

No D2 capture contains a WebSocket continuation frame, so fragmentation on the
client's receive path is untested on hardware. Defect 1 — React Native delivering
sealed frames as `ArrayBuffer` rather than `Uint8Array` — proved that receive path
is exactly where platform-specific delivery bugs live. G-1 blocks R2.

## Finding: continuation frames are not merely untested, they are unreachable from this server

Three independent facts, each verified rather than assumed:

1. **The streamer's only server-to-client send path passes no options.**
   `src/ws-hub.ts:299` (on `origin/main` `d9148f25`) is `ws.send(frame);`.

2. **The shipped WebSocket library hardcodes `fin: true`.** The rig resolves
   `ws@8.21.3`. `lib/websocket.js:472-484` builds the options object for
   `_sender.send()` with `fin: true` (line 476) before merging caller options —
   and the caller passes none.

3. **Nothing in the streamer fragments deliberately.** A scan of every `.ts` file
   on `origin/main` for `_sender`, `fin: false` and `createWebSocketStream`
   returns zero hits.

**Positive control on fact 3.** The same scan shape, run for a string known to be
present in the same file (`upgradeWebSocket` in `src/api/routes/ws.routes.ts`),
returns 5 hits. The zero is therefore a real absence and not the empty-result trap.

**Conclusion.** Every server-to-client WebSocket message leaves this server as a
single unfragmented frame with FIN set, at any payload size. Opcode-0 continuation
frames cannot appear on the client's receive path over a direct connection,
however much data is pushed.

### What this does and does not license

It does **not** say the client handles fragmentation correctly. It says the client
is never asked to, by this server, on a direct connection. Two limits are load-bearing
and must travel with the claim:

- **An intermediary can re-fragment.** The Cloudflare named tunnel is exactly such
  an intermediary on the production remote path — the leg Android runs over — and
  it is TLS, so `tcpdump` can neither confirm nor deny fragmentation there. The
  residual risk lives precisely where this method cannot look.
- **This is a pin, not a property.** It is a fact about `ws@8.21.3` and about the
  current single-argument `send()` call. A dependency bump or a switch to a stream
  API changes it silently.

### Recommendation (for the owner; this track is evidence-only)

A capture can only ever show the *absence* of continuation frames here, which is
weak evidence about the client. The strong evidence is a **client-side test that
deliberately delivers a fragmented sealed message to the React Native WebSocket
layer and asserts it unseals** — the same path defect 1 lived on. That is a mobile
code change and belongs to C1/C2, not to G.

## Re-analysis of D2's captures (correcting the record)

Run against `tracks/D/evidence/d2-sealed-rows-2-4.pcap`, port 8790:

- **No opcode-0 frames**, confirming the D2 gap that motivated this row.
- Opcodes present: 2 (binary) ×128, 8 (close) ×12, 9 (ping) ×11, 10 (pong) ×11.
  No opcode 1 — sealed frames are binary, as designed.
- **Every WebSocket frame is ≤126 bytes.** Payload-length distribution:
  126×87, 125×25, 115×7, 68×9, 2×12, 0×22.

**Correction.** The accepted review describes the undissected bytes as including
"one server-to-client WebSocket frame per capture larger than the MSS". From the
pcap that is not what those bytes are: the >MSS reassembled PDUs are **1 587-byte
HTTP bodies** (86 packets are segments of reassembled PDUs). The review's
*conclusion* — that the field pipeline missed about a third of the payload —
stands exactly and is reproduced below; only the attribution of the missed bytes
changes. D2 therefore never exercised large-frame handling on the WebSocket leg
at all, which strengthens rather than weakens the case for this row.

## Pipeline validation — a known-answer test

The sweep pipeline (`sweep.sh`, PLAN-D §14) was validated against D2's pcap before
being used on any capture of my own, so the tooling is checked against a figure the
program had already accepted:

| measure | bytes | coverage |
|---|---|---|
| total `tcp.len` on port 8790 | 221 557 | — |
| raw full-payload sweep | 221 557 | **100.00 %** |
| field pipeline (ws + http decoded) | 147 247 | **66.46 %** |
| **field pipeline misses** | 74 310 | **33.54 %** |

This reproduces the review's "~30 %" from the pcap itself.

## The control's hard path is reachable (traffic shape proven)

§14 requires the positive control to carry a body **and** a frame each larger than
one TCP segment, because a control where everything fits in one segment certifies
only the easy path — which is how D2's control dissected 100 % while the sealed
captures did not.

Driving the real client protocol (`/ws?key=`, then `register`, then
`subscribe_session`) against the rig yields, in one WebSocket message:

- **`terminal_replay` — 165 847 bytes**, about **114× the 1 448-byte MSS**
- `session_list` — 1 541 bytes, also >1 segment
- plus the ~45 KB `GET /api/sessions/:id/output` body on the HTTP leg

So the control exercises both halves of the hard path, and does so with a WS frame
two orders of magnitude larger than anything in D2.

## Direct wire observation — the question is answered without packet capture

Frame boundaries do not need `tcpdump` to be seen: a raw TCP socket that performs the
WebSocket handshake by hand and parses frame headers off the byte stream observes FIN
bits and opcodes directly. Run against the legacy control rig (:8791), driving
`register` then `subscribe_session`:

```
handshake: HTTP/1.1 101 Switching Protocols
TCP reads: 3   bytes read: 167 549
complete WebSocket frames parsed: 4
  opcode 1   text          4 frames
  FIN=0 (fragmented) frames: 0
  opcode-0 continuation frames: 0
  largest 5 frames (fin, opcode, payload_len):
    (1, 1, 165847), (1, 1, 1541), (1, 1, 121), (1, 1, 22)
```

The 165 847-byte `terminal_replay` crosses the wire as **one frame with FIN set**.
Zero fragmented frames, zero continuation frames — at ~114× the MSS. This is the
observation that turns the source-level determination into evidence, and it required
no elevated privilege.

## Why this transfers to the sealed path by construction

The sealed rig cannot be driven this way without a real Noise handshake, but it does
not need to be, because **sealed and plaintext share one send path**. In the same
function (`src/ws-hub.ts`, `origin/main` `d9148f25`):

```js
let frame: string | Buffer = json;
if (context) {
  memo.plaintext ??= Buffer.from(json, "utf-8");
  try {
    frame = context.sendState(CHANNEL_WS).seal(memo.plaintext);
  } catch (err) { ... }
}
try {
  ws.send(frame);          // <- line 299, the only server-to-client send
```

`frame` is either the plaintext JSON or the sealed `Buffer`; both reach the identical
single-argument `ws.send(frame)`. **Sealing changes the payload, never the framing.**
So the absence of continuation frames on the sealed leg follows from the same two
facts, and the sealed capture confirms rather than establishes it.

## Direct wire observation on the SEALED leg

The shared-send-path argument above is sound, but the sealed leg was observed rather
than left to argument. A scripted device (`scripts/g-sealed-frames.ts`, adapted from
`d2-timings.ts`) performs a **real Noise IKpsk1 pairing** against the sealed rig, a
**real `/api/e2ee/open`** context handshake, then upgrades over a **raw TCP socket**
with `X-TB-Ticket`, sends sealed `register` and `subscribe_session` frames through the
real record layer, and parses the returned frame headers off the byte stream:

```
server e2ee: {"supported":true,"enabled":true,"version":1,"required":false}
paired scratch device 1a26bc63…
context open, ticket present: true
handshake: HTTP/1.1 101 Switching Protocols

TCP reads: 7   bytes read: 167 073
complete WebSocket frames parsed: 4
  opcode 2  binary  4 frames
  FIN=0 (fragmented) frames: 0
  opcode-0 continuation frames: 0
  largest 5 (fin,opcode,len): (1,2,165893) (1,2,796) (1,2,167) (1,2,68)
```

Every frame is **opcode 2 (sealed binary) with FIN set**. The `terminal_replay` crosses
as **one sealed frame of 165 893 bytes** — the same message that measured 165 847 bytes
in plaintext, so the record layer adds **46 bytes** of header and AEAD tag and does not
change the framing. Zero fragmented frames, zero continuation frames, on the sealed leg,
against real crypto on the production path.

### Negative control — the observation could have failed and did not

A zero is worthless from a parser that can never report a one. The identical parsing
algorithm was fed a synthetic stream that *does* contain a fragmented message:

```
frames parsed: 4
  fin=0 opcode=1 len=100        <- first fragment
  fin=0 opcode=0 len=70000      <- continuation, 16-bit length path
  fin=1 opcode=0 len=50         <- final continuation
  fin=1 opcode=2 len=200000     <- whole frame, 64-bit length path
opcode-0 continuation frames detected: 2
FIN=0 fragmented frames detected: 2
```

The parser detects fragmentation when it is present, across both extended-length
encodings. **The zero measured against both live rigs is therefore a real absence.**

## Rig conditions

- Streamer `v1.74.0` in a scratch `HOME` under `/tmp`, scratch npm prefix,
  `THREADBASE_CONFIG_DIR` inside it; sealed rig **:8790** (`--feature e2ee=true`,
  pair URL carries `spk=…&v=1`), legacy control rig **:8791**
  (`--feature e2ee=false`, no `spk`, `/api/info` reports `e2ee.enabled:false`).
- **Isolation verified with a control on the check itself**: both rig PIDs have 0
  open files under the real `~/.threadbase`; the production streamer PID shows 11,
  proving the grep can return data.
- `node-pty`'s `spawn-helper` shipped mode `0644` on both prebuilds and was
  chmodded to `0755` before boot — PLAN-D's recorded trap, confirmed again.
- The agent is unauthenticated (stops at Claude Code's login screen under the
  scratch HOME). Nothing was signed in.
- **Bulk output generator**: because the agent cannot emit bulk output, a controlled
  generator is placed on the rig's PATH via a `.zshrc` inside the scratch HOME —
  3 MB of mixed text, base64 and high-byte binary across ~3 300 lines, writing a
  machine-generated manifest of its own markers. The transport under test stays
  real end to end (real PTY, real ws-hub, real seal, real socket); only the content
  is controlled. Confirmed it is the generator running and not Claude Code:
  `GCTRL` markers 66, `Welcome`/`theme` 0.
- Marker lists are read from that manifest, never hand-written — the D2 lesson.

## Verification bar

| requirement | how it was met |
|---|---|
| real objects on the production path | real streamer `v1.74.0`, real Noise IKpsk1 pairing, real `/api/e2ee/open` context, real record layer, real socket — no stubs |
| positive control | the harness demonstrably sees frames: 4 sealed frames parsed with correct lengths, corroborated by the plaintext run's 165 847 vs the sealed 165 893 |
| negative control proving causality | the same parser reports 2 continuation frames on a synthetic fragmented stream |
| falsifiability | any `FIN=0` or `opcode 0` frame on either leg would falsify the claim; none occurred at ~114× MSS |

## Not covered by this row

This row settles framing. It does **not** sweep the wire for plaintext — the raw-socket
method sees one connection's framing and nothing else. The plaintext-absence sweep
(G-2's canary, row 1 markers) still needs `tcpdump`, which needs root on this machine
(`/dev/bpf*` is `crw------- root:wheel`, no `access_bpf` group, no ChmodBPF daemon).
