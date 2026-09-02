# G — device evidence: continuation frames and Android

**Model: Opus 5. Effort: high.** Reason: the failure mode here is a green result that is actually a blind spot. D2's capture method was wrong three separate ways, two caught by a control and one caught only by an outside reviewer re-deriving the numbers from the pcaps. Wall clock is dominated by hardware, so a faster model buys nothing and costs the careful reading §14 now demands.

## What you are proving

Two named gates on the R row of `tracks/STATUS.md`:

- **G-1 — continuation frames.** No D2 capture contains a WebSocket continuation frame, so **fragmentation on the client's receive path is untested on hardware**. Defect 1 — React Native delivering sealed frames as `ArrayBuffer` rather than `Uint8Array` — proved that receive path is exactly where platform-specific delivery bugs live. G-1 blocks R2.
- **G-2 — Android.** Every D2 row is iOS on one device model. Row 1 (terminal output sealed) plus the chosen-plaintext canary, repeated on Android. G-2 blocks the stage-2 default flip.

Plus one favour for another group: **capture the device's own client log** while the storm from mobile defect 2 is reproducible. Group C1 needs it to identify the layer issuing the retries, and the rig will already be up. Reproduction: revoke the paired device server-side while the app is open.

## The rig

Stand it up **once**, for all three purposes. Recipe and isolation rules: `tracks/D/PLAN-D.md` §§3–4. In short: `tb-streamer` installed into a scratch `HOME`/config/DB under `/tmp`, `--feature e2ee=true` on one port, plus a legacy `--feature e2ee=false` control rig on another, `--browse-root` pointed at a throwaway project so sessions can start.

Two traps from 2026-09-02, both of which cost time:

- **`posix_spawnp failed` on every session start** means `node-pty`'s `spawn-helper` lost its execute bit, because the install ran with postinstall scripts blocked. `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`. No restart needed.
- **A rig launched from a sandboxed shell cannot spawn a PTY at all.** Launch it unsandboxed.

The scratch `HOME` has no agent credentials, on purpose. The agent's login prompt is fine — what is under test is the transport, so an unauthenticated agent's output is evidence exactly like an authenticated one's. Do not sign anything in.

## Method — read `PLAN-D.md` §14 in full first

It was rewritten on 2026-09-02 because the original was wrong. The parts that matter most:

**The raw full-payload sweep is the primary grep.** Grepping tshark's decoded fields greps a subset of the wire: anything not dissected into an `http` or `websocket` field never reaches the decoded files, and on D2's sealed captures that was ~30 % of all payload bytes — including one server-to-client frame per capture larger than the MSS, the class most likely to carry terminal output.

```
tshark -r cap.pcap -Y "tcp.len>0 && tcp.port==<rig>" -T fields -e tcp.payload \
  | tr -d ':\n' | xxd -r -p > all-payload.bin
```

Run the field pipeline **as well**: client-to-server WebSocket frames are XOR-masked, so the raw sweep cannot read them and only the dissector unmasks them. Neither method alone is sufficient; say so in the report.

**The positive control must exercise the hard path.** A body **and** a frame each larger than one TCP segment — a session streaming a few hundred KB does both. **Report the control's own coverage**: total `tcp.len` bytes versus bytes reaching the decoded files. If the control does not reach ~100 %, the pipeline is not ready to certify anything. D2's control dissected 100 % *because everything fitted in one segment*, which is precisely why it certified a pipeline blind to a third of the real traffic.

**Derive the marker list from the run's own artefacts** — project name, session name, the prompt text, the agent output as the server recorded it. Never compose it from memory. Two independent reviewers hand-wrote D2's list and both were incomplete, in opposite directions; only the pair caught it.

**In the clear by design. Expect these; list them; do not report them as findings:** request paths and query strings (D-7 — including things like `GET /api/browse?path=<project>`), the `X-TB-Env` and `X-TB-Ctx` headers, the `{"e2ee":{"v":1,"noise":"…"}}` handshake bodies, and the plaintext `429` refusal body from `/api/e2ee/open`.

## G-1 specifically

Stream a few megabytes of **mixed text and binary** through a session — enough to force continuation frames and multi-segment bodies. Confirm from the capture that continuation frames are actually present (`websocket.opcode == 0`) before you claim the row covers them; if none appear, the row has not been run, however much data moved.

Then sweep, and report frame counts by opcode alongside the marker results.

## G-2 specifically

Android, row 1 plus the canary. The canary is a string the user chooses seconds before sending it, long enough not to collide by chance — D2 used 14 characters after two-character tokens produced coincidental hits inside base64 and ciphertext. Prove the server received it (the session name, or the server's own record), then show it is absent from the full sweep **and** from the raw pcap.

Note in the report what is different about Android's transport: it is the leg that runs over the named tunnel in production, per the original D2 brief.

## Reporting

Write an **addendum** to `tracks/D/D2-REPORT.md`. D2 itself is accepted and signed — do not reopen or restructure it. The addendum carries: the rig conditions, the control's coverage figure, the opcode breakdown, the marker table for each row, and an explicit statement of what the two methods together do and do not cover.

Then tell the owner, so G-1 and G-2 can be cleared on the R row.

## Documents you keep current

The owner commits the record after each of your milestones, into the streamer's public copy. It can only commit what you have written, so write as you go rather than at the end:

- `tracks/D/D2-REPORT.md` — the addendum, built up as each row lands rather than in one pass.
- `tracks/D/evidence/<row>.md` — one write-up per row, carrying the control's coverage figure, the opcode breakdown, the marker table, and what the two pipelines together do and do not cover.
- `tracks/D/PLAN-D.md` — if you find a §14 trap that is not already recorded, add it. That section exists because three earlier traps were not.
- A note to the owner naming the client-log path and the observed cadence, for C1.

Your milestones, for the owner's cadence: rig up with the control's coverage known · G-1 captured and swept · G-2 captured and swept · addendum written · rig torn down. Tell the owner at each; do not batch them.

## Scope and stop-work

LAN only for every ciphertext claim; `tcpdump` cannot see through the tunnel's TLS, so tunnel rows prove function, never secrecy.

Stop and tell the owner immediately if: a private key, device token or API key appears in any log, evidence or capture; a plaintext frame appears on a channel declared sealed; or the capture cannot be made to cover the traffic you are claiming about. The last one is not a failure to hide — it is the finding.

Scrub before anything leaves the scratchpad, and shut down every rig and simulator you start, comparing against a start-of-session record.
