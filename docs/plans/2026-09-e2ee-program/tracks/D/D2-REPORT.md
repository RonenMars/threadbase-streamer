# D2 — sealed transport, device evidence

**Date:** 2026-09-02, 11:30–18:10 IDT
**Rig:** isolated streamer `v1.73.0` (`ab15fc2c`) on `:8790`, scratch `HOME`/config/DB, `--feature e2ee=true`
**Device:** wired iPhone 13 Pro (`Rbv1000-13-Pro`), D2 build running the fixed JS bundle from Metro
**Control rig:** streamer `:8791`, `--feature e2ee=false`
**Method:** `tracks/D/PLAN-D.md` §14, with its grep corrected before use (below)

**Verdict: the sealed transport does what the design says it does.** Nine rows and two timing measurements, all on hardware. No plaintext was found on any sealed channel by any probe, including a chosen-plaintext canary. Every defect found today is client-side or operational; none is a protocol fault.

**ACCEPTED 2026-09-02 19:04**, after an independent review that re-derived every number from the pcaps. The reviewer confirmed the coverage gap, the full-payload sweep, the `d2-demo` correction, the revised coverage table, the row 5 write-up, the 429 disclosure and the restored 17 Pro storm. Two gaps stay open — WebSocket continuation frames and Android — and are recorded as **gates on R2 and on the stage-2 flip, not on D2**: they are rollout preconditions, and holding this sign-off for them would conflate the track's deliverable with the gates it feeds.

**Revised 2026-09-02 ~19:05 after review.** The verdict is unchanged, but the evidence behind it is not the evidence the first draft cited. The review found that the field-decode pipeline this report was built on **left a third of the sealed bytes ungrepped**, so the original "0 marker hits" numbers were computed over a subset that excluded, among other things, the one server-to-client WebSocket frame per capture too large for a single segment — the class most likely to carry terminal output. A full raw sweep of every TCP payload byte now supplies the primary evidence, and it is clean. Sections below are rewritten around it; the coverage numbers and the one genuine correction are recorded rather than quietly folded in.

---

## Method, and the three ways it was wrong before it was right

`PLAN-D.md` §14 originally said to run `grep -c '"type":' ws-payloads.txt http-bodies.txt`. Three faults, each of which produces a **false pass**:

1. `tshark` prints `websocket.payload` and `http.file_data` as **hex**, so a grep for JSON text can never match — on ciphertext or on plaintext. *(Caught by the positive control, before any sealed capture.)*
2. `"type":` is a WebSocket frame field. It does not appear in plaintext REST bodies at all, so the REST leg scores 0 even when the wire is fully readable. *(Same.)*
3. **Grepping decoded fields greps a subset of the wire.** Bytes tshark does not dissect into `http` or `websocket` fields never reach the decoded files, and on the sealed captures that is roughly a third of everything. *(Caught in review, after this report's first draft.)*

Fault 3 is the serious one, because the missing bytes are not random:

| Capture | TCP payload | Reached the decoded files | Never dissected |
|---|---|---|---|
| legacy control `:8791` | 5 550 B | all of it | **0 B** |
| rows 1-2-4 | 72 130 B | ~59 % | **~30–41 %** |
| rows 2-4 | 221 557 B | ~67 % | **~33 %** |
| row 4 | 85 796 B | ~64 % | **~28–36 %** |

(The two percentage ranges are the reviewer's measure and mine; they differ on how header segments are attributed and agree on the magnitude.)

The undissected bytes are request-header segments split from their sealed bodies, ping/pong on sockets opened before the capture began, and — the one that matters — **one server-to-client WebSocket frame per capture larger than the MSS that tshark did not reassemble**. That is exactly the class most likely to carry terminal output, so the original grep missed the case the row was written to test.

**The control could not have caught this**, which is its own lesson: on the legacy rig every body and frame fitted in one segment, so 100 % of its payload dissected. A control that exercises only the easy path certifies only the easy path. §14 now requires a control with a body and a frame larger than one segment.

### Primary evidence: the full-payload sweep

Every TCP payload byte on port 8790, dissected or not, from all three sealed captures, searched raw:

| Capture | Bytes swept | Canary | Markers | Screen strings |
|---|---|---|---|---|
| rows 1-2-4 | 72 130 | 0 | 0 | **1** — see the correction below |
| rows 2-4 | 221 557 | 0 | 0 | 0 |
| row 4 | 85 796 | 0 | 0 | 0 |

The longest printable runs in all three are HTTP header lines (`POST /api/e2ee/open HTTP/1.1`, `Host:`, `User-Agent:`, `X-TB-Env:`) and base64 Noise handshake blobs. Nothing else.

**Validity limit, stated because it is not total:** the sweep reads raw bytes, so client-to-server WebSocket frames are XOR-masked and a plaintext string in one would not match a grep. Those frames were dissected and unmasked by the field pipeline, which found nothing, and the only client-to-server bytes left undissected across all three captures are 22 bytes of ping. So the two methods cover each other, and neither alone is sufficient.

### A correction the sweep forced

The first draft reported `d2-demo` as **0 hits on both legs**. In the full sweep it appears **once**, here:

```
…application/octet-stream, Content-Length: 103 … <103 sealed bytes> …
GET /api/browse?path=d2-demo HTTP/1.1
Host: 192.168.68.125:8790
X-TB-Env: AUxQH5jfDbFpIUsR6shDE6cAAAABAAAAAAA…
```

It is in a **plaintext request line**, which D-7 permits by design — paths and query strings are not sealed. The sealed body beside it is opaque. So the finding is unchanged in substance and the original sentence was wrong as written: `d2-demo` is absent from sealed payloads, not absent from the wire.

**Positive control (legacy `:8791`, plaintext by construction):** 83 packets → 8 WS frames, 6 HTTP bodies, 5 550 B of payload, all of it dissected. WS `"type":` found; HTTP `"conversations":`/`"sessions":`/`"serverIdentityKey":` found. Note `grep -c` counts *lines* and the decoded files contain no newlines, so those counts mean "at least one", not "exactly one" — the original report's "1 hit" and "4 hits" should be read that way.

---

## Rows

| # | Row | Verdict | Evidence |
|---|---|---|---|
| 1 | Terminal output sealed | **PASS** | `d2-rows-1-2-3-4.md` |
| 2 | Replay, incl. the 2 s HTTP fallback | **PASS** | same |
| 3 | Conversation / prompt events sealed | **PASS** | same |
| 4 | User messages sealed | **PASS** (canary) | same |
| 5 | REST context rotation + drain | **PASS** | §"Row 5" below (no separate evidence file; `STATUS` 16:35) |
| 6 | Reconnect fetches a fresh ticket | **PASS** | `d2-row6-silence-timer-churn.md` |
| 7 | Streamer restart → transparent re-handshake | **PASS** | `d2-sealed-8790.md` |
| 8 | Revoked device's live socket closes | **PASS** | `d2-row8-revocation-and-the-429-laundering.md` |
| 9 | Access / named-tunnel pass (function only) | **PASS, with a blocking finding** | `d2-row9-access-blocks-sealed-requests.md` |

### Rows 1–4 — nothing readable on the wire

Three captures, 294 + 979 + 514 packets, **379 483 B of TCP payload swept in full**. Across every byte, dissected or not: **zero markers, zero screen strings, zero canary**, with the single `d2-demo` occurrence in a plaintext request line accounted for above.

The two strongest pieces:

- **Screen text.** Every string visible on the phone during the capture — `Let's get started`, `Select login method`, `Dark mode`, `console.log`, `Anthropic Console` — appears **0 times** anywhere in the payload.
- **A chosen-plaintext canary.** The owner picked `ZZTOPMARKER123` seconds before sending it as a new session's first message. The streamer named the session `ZZTOPMARKER123` (`startedAt 12:20:50.680Z`, inside the capture window), proving receipt. The string appears **0 times in the full sweep** of all three captures, and 0 times in the decoded fields.

Opacity measured rather than asserted: outside HTTP header lines and base64 Noise blobs, the longest printable run anywhere in the sealed payload is the server's own plaintext 429 error body.

**In the clear by design, not findings:**

- Request paths and query strings (D-7) — including `GET /api/browse?path=d2-demo`.
- The `{"e2ee":{"v":1,"noise":"…"}}` handshake bodies on `POST /api/e2ee/open`.
- HTTP framing headers, including `X-TB-Env` (the sealed envelope's own base64 carrier) and `X-TB-Ctx`.
- **The rate-limit refusal body**: `HTTP/1.1 429 Too Many Requests` with `{"error":"Too many handshake attempts; try again in a minute"}`. `/api/e2ee/open` is public and pre-authentication, so its refusals have no context to seal with — one of the refusals `NONCE-DESIGN.md` deliberately leaves readable.

**Disclosure: the sealed runs happened under rate-limit pressure**, which the first draft did not say. The replay capture contains **27** `429` responses and row 4 contains **1**; rows 1-2-4 contains none. That is a condition of row 2 worth knowing — and it doubles as negative-pressure evidence: the client was being refused, retrying, and reopening contexts throughout, and still leaked nothing.

Two coincidental two-character hits (`Hi` inside a base64 blob, `hi` inside ciphertext) are recorded in the evidence so nobody rediscovers them as a leak. They are why the canary is 14 characters.

### Row 5 — REST context rotation, and a second plan correction

The owner backgrounded Threadbase for ~15 s and reopened it while the rig logged. Server side, 12:42:53–54 UTC:

```
12:42:53  CONTEXT_OPENED ws     POST /api/e2ee/open 200
12:42:54  CONTEXT_OPENED rest   POST /api/e2ee/open 200
12:42:54  /api/conversations x3, /api/sessions x4, /api/sessions/names, /api/cache/alert   — all 200
```

A **new** REST context, never an in-place rekey (`NONCE-DESIGN.md` §6: a new key is a new context), and **every request across the rotation returned 200**. Nothing user-visible happened, which is the whole purpose of the drain.

**Limit of this row:** the server sees the new context open; it cannot see the client's 10 s drain window, because that window is client state — the app keeps the retired context object alive to decrypt in-flight responses, then destroys it. The operational claim proved here is "no request failed across a real rotation", not "the drain is exactly 10 s".

`PLAN-D.md` §14 describes this trigger as "foreground past threshold". The client has **no threshold**: `services/e2ee/rest-session.ts:60-63` sets `needsRollover` on *every* foreground, unconditionally. The plan's wording predates the implementation. A second consequence, recorded under defect 3: each foreground therefore costs two handshakes.

### Row 7 — free, and worth noting

Restarting the streamer mid-session cleared its in-memory contexts; the client re-handshook transparently, one REST and one WS context, no user-visible failure.

### Row 9 — the finding that changes a rollout

With an interactive Cloudflare Access application on `<test-tunnel-host>`, the phone's pairing **failed closed**: *"This server offered an encrypted pairing and then did not finish it."* The streamer logged **no `POST /api/pair/exchange` at all** — the request never arrived. A sealed request carries no `Authorization` header by design, and Access refuses credential-less requests at the edge.

The guardrail held on hardware: *after msg1, a missing msg2 is a failed pairing, never plaintext success.*

With a `Bypass` policy on the same application, the same phone paired through the same hostname and ran 3 WS + 2 REST contexts with every request 200 — **the encrypted transport functions end-to-end through a Cloudflare tunnel**, which no earlier row had shown. Same hostname, same device, one variable.

Wording matters here: "functions", not "is sealed". The tunnel leg was never packet-inspected, so *sealed* is inferred from the client running in pinned mode and the server opening real contexts — not observed on that wire. Every ciphertext claim in this report is LAN-only.

**A Service Token is not a remedy today**: `tb-mobile` has no `CF-Access-Client-*` support anywhere. The options are Access off for the hostname devices use, or a bypass on the paths they call.

---

## Timing measurements

| Measurement | Constant | Observed |
|---|---|---|
| WS first-sealed-frame deadline | `WS_FIRST_FRAME_DEADLINE_MS = 10_000` | silent socket closed at **10 009 ms**; a socket sending a valid first frame **survived past 25 s** |
| REST provisional deadline | `TICKET_TTL_MS = 30_000` | a context used immediately still answered `200` at **t+35 s**; one never used answered **`409 E2EE_CTX_UNKNOWN`** |

Each is the other's control. Details and the two mistakes made getting there: `d2-timings.md`.

The client's 10 s REST drain is client-side state and is not server-observable; row 5's zero failures across a real rotation is the operational evidence for it.

---

## Defects found (none in the protocol)

| # | What | Where | Status |
|---|---|---|---|
| 1 | RN delivers sealed frames as `ArrayBuffer`; the client accepted only `Uint8Array`, so it rejected the first valid frame, reconnected, and hit the 429 limit | mobile | **Fixed — PR #937 open, CI green** |
| 2 | A permanent refusal launders itself into a retryable one: retries charge the server's failure budget → 429 → mapped to `E2EE_TRANSIENT` (`retryable: true`) → infinite loop, with the on-screen text degrading from the accurate "not paired for encryption" to the false "server is busy" | mobile | Reproduced deliberately (10×403 then 60×429 in under 2 min). Brief written, **not implemented, and not yet accepted** — see below |
| 3 | The 45 s silence timer force-reconnects on an idle session, and each redial now costs a Noise handshake: **3.1 context opens/min at idle against a 5/min limit** | mobile | Documented; no fix yet |
| 4 | A pending prompt blocks sending in the **Terminal** view as well as chat, leaving a session uninteractive | mobile | Documented |
| 5 | The `readMessage1` failure branch logged nothing, so a device pinned to another identity was undiagnosable server-side | streamer | **Fixed locally** (`feat/e2ee-open-refusal-log`) |
| 6 | Nothing warned an operator that Access blocks encrypted devices | streamer | **Fixed locally** — boot probe, `feat/e2ee-access-probe`, verified against a live gate |
| 7 | `node-pty`'s `spawn-helper` lost its exec bit under a script-blocked install → every session start died as `posix_spawnp failed` with no actionable message | environment | Fixed on the rig; documented in the streamer's troubleshooting guide |

Two of my own errors are recorded in the evidence rather than quietly fixed: the first sealed capture was taken against a rig whose PTY could not spawn (defect 7), and an early full-suite run showed a spurious port failure because I was booting a live rig beside it.

**Also on the day, and missing from the first draft:** a *second* device — the iPhone 17 Pro, pinned to a server identity that was not this scratch rig's — held the rig at its failure ceiling for six minutes that morning (168 × 400, 43 × 429, pinned at exactly 30 failures per minute). It is the field observation that first exposed defect 2, and it is also the first live-fire confirmation that `OPEN_SOURCE_FAILURE_LIMIT = 30` behaves as designed, with a healthy device on another address unaffected. Recorded in `d2-field-observation-open-failure-storm.md`; it belonged in this report and was omitted.

### Defect 2 — the retrying layer is still unidentified

The mechanism is proved and reproducible; **the caller is not**. Ruled out so far: the connect-time catch in `ws-client.ts:231` honours `retryable`, and `sealedFetch` throws with `retryable: false`. Neither the close-time path (which goes to backoff with no `retryable` check) nor the 45 s silence timer matches the observed ~1.5 s cadence.

A candidate worth checking first, raised in review and **not yet evidence**: the client-log shipper. Its `POST /api/__client-log` calls are themselves sealed, so every failed open produces log lines that need a context, which needs an open, which fails — a self-feeding loop at roughly the right rate. Confirming it needs the device's own client log, which was never captured.

Consequence for the fix: item 1 of the brief — **a sticky permanent verdict per server that a later 429 cannot reset** — closes every candidate at once and does not depend on identifying the caller. Item 2 does. The brief should not be accepted as a specification until the layer is named.

---

## Scope

**LAN only for every ciphertext claim.** `tcpdump` can only see plaintext at the network layer, and the tunnel leg is TLS-wrapped, opaque to this method. Rows run against the tunnel prove **function**, never wire secrecy — row 9 is explicitly a functional pass.

---

## What D2 does not cover

- **WebSocket continuation frames.** No capture contains one, so **fragmentation on the client's receive path is untested on hardware** — and defect 1 showed that path is exactly where platform-specific delivery bugs live. One row streaming a few megabytes of mixed text and binary through a session, captured and swept, would close it cheaply. **Recommended as a precondition for R2.**
- **Android.** Every row here is iOS on one device model. Row 1 plus the canary on Android is the minimum before any default flip. **Precondition for the stage-2 flip.**
- A Cloudflare **Service Token** end to end: the client cannot present one, and creating one needs Access rights the available API token lacks.
- The client-side 10 s drain boundary, for the reason given under row 5.
- The app's own connect timeout against the server deadlines measured above — the server constants are what was measured; the client side is a lower-priority follow-up.

## Recommended next steps

1. ~~This revision~~ — done; `PLAN-D.md` §14 updated so the raw sweep is primary and the control must exercise multi-segment bodies and frames.
2. **One rig session covering both remaining rows together** — the large-payload iOS row (continuation frames) and the Android row — so they share one rig and one positive control. That control must itself include a body and a frame larger than one segment, and **its coverage figure must be reported beside the sealed runs**. Do not rebuild the rig before then.

### A method note both reviewers earned the hard way

The screen-string marker list was written by hand, twice, and was incomplete both times: this report's list included `d2-demo` but its "0 hits" claim was scoped to decoded fields, and the reviewer's independent sweep omitted `d2-demo` from its list entirely. Neither would have caught it alone; it took both.

**Derive the marker list from the run, don't compose it from memory.** The next capture should take its strings from the session's own artefacts — the project name, the session name, the prompt text, the agent's output as the server recorded it — so the list cannot silently omit the one string that matters.

## Cleanup owed

The `tb-secured` Access application is still live (owner-created; teardown steps in `ACCESS-APP-TEARDOWN.md`). The scratch rigs on `:8790`/`:8791`, the Metro instance, and the paired scratch device rows are all disposable and confined to `/tmp`. The phone holds three server entries, one of which (the tunnel) is broken while the gate is on.

---

# ADDENDUM — G session, 2026-09-02 evening (G-1 and G-2)

**This is an addendum. D2 above is accepted and signed; nothing in it is reopened or
restructured.** It records the rig session that was to close the two named gates D2
left behind — G-1 (continuation frames, blocking R2) and G-2 (Android, blocking the
stage-2 default flip) — plus the client-log capture group C1 asked for.

**Status: G-1 COMPLETE; a large-payload sealed row PASSED; G-2 blocked; client log not
yet captured.** Row detail in `tracks/D/evidence/g1-continuation-frames.md` and
`tracks/D/evidence/g-row1-large-payload.md`.

## Rig conditions

| item | value |
|---|---|
| streamer | `@threadbase-sh/streamer@1.74.0`, tag `67f2d05eebdc33f8651700be297251a62771589d` |
| `dist/cli.cjs` sha256 | `e106cb527a01a1150cb3eb0a5a8a475e8fccd297e9e0e26373e16eba018dcbeb` |
| sealed rig | **:8790**, `--feature e2ee=true`; pair URL carries `spk=…&v=1` |
| legacy control rig | **:8791**, `--feature e2ee=false`; no `spk`; `/api/info` → `e2ee.enabled:false` |
| isolation | scratch `HOME` + `THREADBASE_CONFIG_DIR` + npm prefix under `/tmp` |
| streamer `origin/main` | `d9148f2527422325133a82b64c148c5d6ead1a89` |
| mobile `origin/main` | `26815a16e2169c1b21019a142bd2893e7195121c` |
| capture interface | **en0**, 192.168.68.125 — the address the rig itself advertises |

**Isolation was verified with a control on the check itself.** Both rig PIDs show 0
open files under the real `~/.threadbase`; the production streamer PID shows 11. The
zero therefore means isolation, not a grep that cannot match. The production streamer
on :8766 and both pre-existing `cloudflared` tunnels were untouched throughout.

PLAN-D's recorded trap held again: `node-pty`'s `spawn-helper` shipped mode `0644` on
both prebuilds and needed `chmod +x` before any session could spawn.

## The bulk-output generator, stated plainly

The agent stops at Claude Code's login screen under the scratch `HOME` — by design,
and nothing was signed in — so it cannot emit the megabytes G-1 needs. A controlled
generator was placed on the rig's PATH via a `.zshrc` inside the scratch `HOME`: 3 MB
of mixed text, base64 and high-byte binary across ~3 300 lines, writing a
machine-generated manifest of its own markers.

The transport under test stays real end to end — real PTY, real ws-hub, real seal,
real socket. Only the *content* is controlled, which is the same reasoning PLAN-D
already applies to the unauthenticated agent. Verified the generator and not Claude
Code was running: `GCTRL` markers 66, `Welcome`/`theme` 0. **Marker lists are read
from that manifest, never hand-written** — D2's method note, applied.

## Pipeline validation — a known-answer test before certifying anything

The sweep tooling was validated against D2's own accepted capture
(`d2-sealed-rows-2-4.pcap`, port 8790) before being pointed at anything new:

| measure | bytes | coverage |
|---|---|---|
| total `tcp.len` on the port | 221 557 | — |
| raw full-payload sweep | 221 557 | **100.00 %** |
| field pipeline (ws + http decoded) | 147 247 | **66.46 %** |
| field pipeline misses | 74 310 | **33.54 %** |

This reproduces the revision's "~30 %" figure from the pcap itself, so the coverage
arithmetic is checked against a number the program had already accepted.

### One correction to the revision's attribution

The revision describes the undissected bytes as including "one server-to-client
**WebSocket frame** per capture larger than the MSS". From the pcap that is not what
those bytes are. Every WebSocket frame in that capture is **≤126 bytes**
(126×87, 125×25, 115×7, 68×9, 2×12, 0×22); the >MSS reassembled PDUs are **1 587-byte
HTTP bodies**, and 86 packets are segments of reassembled PDUs.

**The conclusion is unaffected** — the field pipeline missed a third of the payload,
exactly as stated, and the raw sweep remains the primary grep. Only the attribution of
the missed bytes changes: HTTP body reassembly and header/handshake bytes, not a large
WebSocket frame.

Two consequences, both worth stating plainly:

1. **A future reader chasing "the large WebSocket frame" in those pcaps will find
   nothing**, and could easily conclude from that the review was wrong about
   everything. It was not — the 33.54 % miss is exact and reproducible.
2. **D2 never exercised large-frame handling on the WebSocket leg at all.** That is a
   real gap in the accepted evidence base, not a footnote, and it is the gap the 3 MB
   row below fills.

## G-1 — continuation frames: COMPLETE

**Result: the gate as written cannot be satisfied against this server, and that is the
finding rather than a failure to produce one.** Determined at source and observed
directly on both the plaintext and the sealed leg, with a negative control. No packet
capture and no elevated privilege were needed.

Four independent legs:

1. **Source.** `src/ws-hub.ts:299` is the *only* server-to-client send, and it is
   `ws.send(frame)` with no options. Sealed and plaintext share it: `frame` is either
   the plaintext JSON or the sealed `Buffer`, so **sealing changes the payload, never
   the framing**.
2. **Dependency.** The shipped `ws@8.21.3` builds its send options with `fin: true`
   hardcoded (`lib/websocket.js:476`). A scan of every `.ts` file on `origin/main`
   for `_sender`, `fin: false` and `createWebSocketStream` returns zero hits — with a
   positive control (a string known to exist in the same file returned 5), so the zero
   is a real absence.
3. **Direct wire observation.** A raw socket performing the WebSocket handshake by
   hand and parsing frame headers off the byte stream:

   ```
   complete WebSocket frames parsed: 4
     opcode 1  text  4 frames
     FIN=0 (fragmented) frames: 0
     opcode-0 continuation frames: 0
     largest: (fin=1, opcode=1, payload_len=165847)
   ```

   A **165 847-byte** `terminal_replay` — ~**114× the MSS**, and three orders of
   magnitude beyond anything in D2 — crosses as **one frame with FIN set**.

4. **Direct wire observation on the SEALED leg.** A scripted device does a real Noise
   IKpsk1 pairing against the sealed rig, a real `/api/e2ee/open` context handshake,
   then upgrades over a raw socket with `X-TB-Ticket` and sends sealed frames through
   the real record layer:

   ```
   server e2ee: {"supported":true,"enabled":true,...}
   complete WebSocket frames parsed: 4
     opcode 2  binary  4 frames
     FIN=0 (fragmented) frames: 0
     opcode-0 continuation frames: 0
     largest: (fin=1, opcode=2, len=165893)
   ```

   Every frame is sealed binary with FIN set. The same message that measured 165 847
   bytes in plaintext is **165 893 bytes sealed — one frame, +46 bytes** of record
   header and AEAD tag. Sealing changes the payload, not the framing, as observed.

**Negative control.** The identical parser, fed a synthetic stream containing a
fragmented message, reports `opcode-0 continuation frames: 2` and `FIN=0 frames: 2`
across both the 16-bit and 64-bit extended-length paths. **The zero measured on both
live rigs is a real absence, not a blind parser.**

**What this licenses.** Opcode-0 continuation frames do not occur on the client's
receive path over a direct connection, at any payload size.

**What it does not.** It does **not** say the React Native client handles
fragmentation; it says the client is never asked to. Two limits travel with the claim
and must not be dropped when it is quoted:

- **An intermediary can re-fragment.** The Cloudflare named tunnel is exactly such an
  intermediary on the production remote path — the leg the Android client runs over —
  and that leg is TLS, so `tcpdump` can **neither confirm nor deny** fragmentation
  there. The residual risk lives precisely where this method cannot look.
- **This is a fact about `ws` 8.21.3, not a property of the system.** It rests on a
  pinned dependency and a single-argument `send()` call. **A dependency bump could
  reintroduce fragmentation with no code change in this repository at all** — nothing in
  `threadbase-streamer` would have to be edited for the client to start receiving
  continuation frames. That is the sentence a future reader needs.

**Consequently the gate was split** (owner's decision, recorded here): the observed
opcode breakdown gates R2's presentation, while a **client-side test that hands the RN
WebSocket layer a deliberately fragmented sealed message and asserts it unseals** gates
stage 2. The second is a mobile change and is routed to C2; it is not device evidence
and G does not touch mobile code.

**Recommendation (owner's call).** If R2's concern is the client's receive path, the
evidence that closes it is a **client-side test that delivers a fragmented sealed
message to the RN WebSocket layer and asserts it unseals** — the path defect 1 lived
on. That is a mobile change, not device evidence.

## Row 1 at scale — terminal output sealed at 3 MB: PASS

**Why this row was run at all, given G-1 is settled — stated so it is not read as
redundant re-confirmation.** It is not confirming G-1. It exists because **D2's entire
evidence base is 221 557 payload bytes containing no WebSocket frame above 126 bytes**,
and a 3 MB sealed row carrying a single 165 847-byte frame is the large-payload sealed
row D2 never ran. It strengthens the sealing claim on its own terms.

D2's row 1 rests on 221 557 payload bytes with no WebSocket frame above 126 bytes. This
session repeated the question at **3 000 224 bytes** through the session and a
**165 893-byte sealed frame** (~114× MSS), sweeping every byte the server transmitted
on the connection.

Markers were derived at sweep time from the run's own artefacts — the generator's
machine-written manifest (214 markers), the session id, the project name, and literal
40-byte slices of the output *as the server itself recorded it*. 222 markers per leg,
none typed by hand.

| leg | wire bytes | derived markers found | `"type":` | `terminal_replay` | `the quick brown fox` |
|---|---|---|---|---|---|
| legacy :8791 (positive control) | 167 549 | **15 / 222** | 4 | 1 | 216 |
| **sealed :8790** | 166 945 | **0 / 222** | 0 | 0 | 0 |

The control finds plaintext in the same invocation shape, so **the sealed zero is a
real absence**. (15 rather than 222 because the PTY scrollback is a bounded virtual
terminal: 3 MB was written, ~45 KB retained and replayed, so most manifest markers were
never transmitted. The transmitted ones are all found.)

**Limits, stated plainly.** This sweeps **one WebSocket connection, server-to-client
only**. It does not cover the REST/HTTP leg, other connections, or client-to-server
frames, and it does **not** replace the full-payload `tcpdump` sweep for a whole-wire
claim — it was taken because capture needs root here. LAN/loopback scope, as ever.

## G-2 — Android: BLOCKED, and the reason is substantive

**No Android build that can run the row exists.** The ArrayBuffer fix `443771a8`
(#940 — "unseal ArrayBuffer WebSocket frames from React Native") is **not** an
ancestor of `android-v62` (the newest tag, cut 2026-09-02), nor of v61 or v60.
`ios-v215` does contain it; control: `origin/main` contains it. Since that fix *is*
the sealed-frame receive path, any Android build installable today cannot unseal WS
frames, and row 1 cannot run on it. G-2 needs a fresh build from `origin/main`.

**And this machine cannot produce one**: `~/Library/Android/sdk` no longer exists (the
running `adb` fork-server holds a deleted binary), there is no `adb` on PATH and no
emulator. `eas` is installed but reports "Not logged in".

### A stale plan note that would have produced a worthless G-2

`PLAN-D.md` §5 says "Android: release build over the rig's own tunnel (mobile#727 — a
release build cannot reach `http://`)". **Mobile #727 is CLOSED**, fixed 2026-08-15 by
`13e21e22` (#752), which set `usesCleartextTraffic="true"` in the main manifest and
added an app-layer policy permitting cleartext to the local network and refusing it
elsewhere. Android therefore reaches the rig over **plain LAN http and is capturable**.

Had §5 been followed, G-2 would have run over the tunnel's TLS and the canary would
have been absent **because of TLS rather than because of E2EE** — a false pass on the
one row that gates the default flip. Recorded in §14.

## What the two methods together do and do not cover

- **The raw full-payload sweep is primary**: it reaches 100 % of payload bytes on the
  port, dissected or not. It **cannot read client-to-server WebSocket frames**, which
  are XOR-masked.
- **The field pipeline** unmasks those, but reached only 66.46 % of payload bytes on
  D2's capture, so it can never be the primary grep.
- **Neither alone is sufficient. Both were run.**
- **The raw-socket frame parser** answers framing questions exactly, needs no elevated
  privilege, and sees *one connection's* framing — it says nothing about other bytes on
  the wire, so it complements the sweep and does not replace it.
- **LAN only.** Every ciphertext claim here is LAN-scoped; `tcpdump` cannot see through
  the tunnel's TLS, so tunnel rows prove function, never secrecy.

## In the clear by design — expected, listed, not findings

Request paths and query strings (D-7, including `GET /api/browse?path=<project>`), the
`X-TB-Env` and `X-TB-Ctx` headers, the `{"e2ee":{"v":1,"noise":"…"}}` handshake bodies,
the plaintext `429` refusal body from `/api/e2ee/open`, and the `serverIdentityKey`
public key in `/api/info`.

## Outstanding at the time of writing

1. **Packet capture requires root** — `/dev/bpf*` is `crw------- root:wheel`, no
   `access_bpf` group, no ChmodBPF daemon. The sealed-leg capture and the G-2 sweep
   both wait on it.
2. **G-2** waits on an Android build from `origin/main` and on an Android device.
3. **C1's client log** — the revocation-storm capture — not yet attempted; it needs the
   phone, and is batched with the G-1 sealed run.


## Method disclosure: the controlled output generator (approved)

Stated plainly because **a controlled generator that is disclosed is a method; one that
is not is a confound.** The agent stops at Claude Code's login screen under the scratch
`HOME` and nothing was signed in, so it cannot emit the megabytes these rows need. A
generator was placed on the rig's PATH via a `.zshrc` **inside the scratch `HOME`**,
emitting 3 MB of mixed text, base64 and high-byte binary across ~3 300 lines and writing
a machine-generated manifest of its own markers.

Real PTY, real ws-hub, real seal, real socket — **only the content is controlled**,
which is the same reasoning PLAN-D already applies to the unauthenticated agent. It
never leaves the scratch `HOME`. Confirmed the generator and not Claude Code was
running: `GCTRL` markers 66, `Welcome`/`theme` 0.

## Android SDK: pre-install state, for a teardown that is a comparison

The user authorised a **local SDK install** (explicitly not EAS) and attached a
condition in their own words — *"remember to clean up the build files after the tests."*
Recorded **before** installing anything, so teardown can be a comparison rather than a
claim:

| path | state before any install |
|---|---|
| `~/Library/Android` | PRESENT, **8.0 KB** (only `.DS_Store`) — the SDK really was gone |
| `~/.gradle` | PRESENT, **6.6 GB** — large and pre-existing |
| `~/.android` | PRESENT, **3.5 MB**, contains AVDs — pre-existing |
| `android-studio` Homebrew cask | already installed, pre-existing |
| `adb` / `sdkmanager` / `gradle` on PATH | none |

**`~/.gradle` at 6.6 GB belongs to the user's other projects and will not be deleted.**
Having the before-number means the report can say what this session added instead of
guessing.

Installed so far: `android-commandlinetools` via Homebrew (removable with
`brew uninstall --cask android-commandlinetools`) plus `platform-tools` — **210 MB**,
`adb` 1.0.41 / 37.0.1 working. **No emulator images.**

**Escalation raised before pulling anything larger.** Five modules declare
`externalNativeBuild` — `expo-modules-core`, `expo-updates`,
`react-native-gesture-handler`, `react-native-pager-view`, `react-native-screens` — and
**none ship prebuilt `.so` files**, so they compile C++ from source and the NDK plus
CMake are unavoidable. That is roughly **5–5.5 GB** more, against an authorisation for
"an SDK, not an open-ended download". Referred to the owner and the user; nothing
further has been downloaded.
