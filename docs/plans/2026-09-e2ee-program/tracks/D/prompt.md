# Group D — device evidence (orchestrator brief)

Model: **Sonnet 5**. Effort: **low for D1, medium for D2** (one session, `e2ee-D-sonnet5-medium`; the owner tells you when to switch). Reason: D1 is a runbook with device gates and no design decisions; D2's "no plaintext in a capture" is exactly the class of claim that produced three withdrawals in the prior program — a filtered sample reported as exhaustive, a harness that could not see plaintext, a self-inflicted event credited to the release. What used to be this track's user-gated flip (`E2EE_SUPPORTED`) merged in #674/v1.69.0 on 2026-08-23 **without** its device-evidence checklist being ticked — this track produces that evidence now, and the one flip that still needs the user's go (the stage-2 flag default) belongs to Group R.

You are the **orchestrator** for two hardware passes. You own the runbook, the evidence, and the scrubbing. One named sub-agent operates the rig. You report every step to **`e2ee-owner`**; the user is at the phone when you need a hand.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md` — §5 (isolated `HOME`, scrub captures, shut down what you boot, start-of-session record).
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2.
3. `tb-mobile/CLAUDE.md` — "Device Builds — Always Through `dev-device.sh`" (never `expo run:ios --device` directly), "Simulators and Emulators — Shut Down What You Booted", "On-Device Tracing / Dev Client — Two Silent Traps"; `docs/troubleshooting.md` for profiles. `tb-streamer/CLAUDE.md` — feature flags, `THREADBASE_CONFIG_DIR`, Cloudflare tunnel.
4. From streamer `origin/main`: `specs/end-to-end-encryption/remaining-work.md` §5, `design.md` §9, `mobile-design.md` §9, `parallel-kickoff.md` track E; `gh pr view 674` (the five unchecked gates); `gh issue view 667` (streamer, `publicUrl: null`); `gh issue view 727` (mobile, closed — Android release builds cannot reach `http://`, go over the tunnel).
5. The prior program's method notes: `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/C-opus5-medium/PROBE-PLAN.md` §6 and the isolation incident in its STATUS row (a `THREADBASE_CONFIG_DIR` that did not move the cache dir put two streamers on the prod `cache.db`).

## Precondition to re-verify on arrival

- **Pre-setup** (owner sends it when M closes, before F): the start-of-session record and the rig isolation below — scratch `HOME`, streamer installed and verified, tunnel hostname, device build signed — with **no device rows and no pairing**, so the F → D1 gap is minutes, not a rebuild.
- **D1**: P, M and F closed — `gh pr view` `MERGED` for each PR the owner names, or the owner's "no PR" verdict for P/M. Streamer tag pinned exactly (`@threadbase-sh/streamer@1.70.6` unless the owner names a later one); mobile `origin/main` commit pinned; Xcode 26.6 (17F113), Maestro 2.8.0, Node v24.15.0 recorded. If the rig runs over an hour, record the streamer dist hash.
- **D2**: X-client's XC2 PR `MERGED`; the streamer tag containing W1b and X-server on the remote.

## Scope

**Start-of-session record** first: booted simulators/emulators, running streamers and their ports, tunnel state — so "left as found" is checkable.

**Rig**: the pinned streamer under a scratch `HOME` (`HOME=<scratch> THREADBASE_CONFIG_DIR=<scratch>/.threadbase`, verify the cache and runtime DBs land there with `lsof`, not in the real `~/.threadbase`), `--feature e2ee=true`, its own API key, its own tunnel hostname for the Android leg. Never the real `~/.threadbase`, `~/.claude`, or keychains.

**D1 — the pairing gates #674 listed and never checked**, on a cabled physical iPhone via `scripts/dev-device.sh`, then Android over the tunnel (a release build, per #727):
1. A disabled server (`--feature e2ee=false`) prints a QR without `spk`/`v`; the phone pairs legacy, unpinned, byte-identical banner captured.
2. Malformed `spk`, a wrong responder key (a second streamer's `spk` pasted into the first's link), a tampered msg2, and a missing msg2 each fail visibly with the specific message and add no server.
3. The deep-link and paste confirmation gate on hardware: fingerprint and machine name shown, cancel adds nothing, confirm adds; the camera path adds without the gate.
4. The identity code renders LTR in `he` and `ar` — a screenshot each, on the phone.
5. `publicUrl: null` over LAN (#667): `public_url` unset in the scratch `server.yaml`, pair over LAN, the app accepts `null`. Comment on #667 with the evidence.
6. Key and pin survival across an app restart; same-row re-pair; revoke-then-re-pair clears `revoked_at`.
7. **Web build** (Expo web, a browser on the Mac — not a phone row): a pair URI with `spk` is refused with the native-app explanation; the browser's `localStorage` for the origin holds no `D_priv`; a legacy no-`spk` URI still pairs. This is the only place Metro's selection of `secure-store.web.ts` is observable — jest cannot see it (Group M, 2026-08-28), so the constant is unit-tested and the wiring is proven here.

**D2 — sealed transport on hardware** (after X-client): a packet capture on the LAN leg (`tcpdump` on the Mac's interface, filtered to the streamer port) shows no plaintext `"type":` for terminal output, replay, conversation events and user messages; a **context rollover** after the threshold (NONCE-DESIGN §6, ruled 2026-08-29: no in-place rekey — a new key is a new context; REST opens a new context on 24 h / 1 GiB / foreground and retires the old one after a 10 s drain, then `E2EE_CTX_UNKNOWN`); a socket reconnect with a fresh ticket; the 2 s HTTP replay fallback sealed too; a streamer restart → one transparent re-handshake; a revoked device's live socket closes.
- **The ciphertext claim is LAN-only.** The tunnel leg is TLS and cannot be inspected; the Android row proves *function* over the tunnel, not wire secrecy. Say so in the report.
- **Plaintext-visible positive control first, cited by capture path**: on an unpinned pairing with the flag off, the same tap and the same grep find the `"type":` markers. Only then does a zero on the sealed run mean anything.
- **Decode before grep** (prior program PROBE-PLAN §6): WebSocket frames are masked client→server and may be fragmented; grep over raw bytes returning 0 for the marker *and* 0 for the control proves only that the grep cannot match. Reassemble/unmask (e.g. `tshark -Y websocket -T fields -e websocket.payload`) before searching.
- The owner reads the **capture summary** (frame counts, marker hits per row, control hits), not the verdict.
- **Named tunnel behind Cloudflare Access** (re-review N-L1): the quick tunnel is anonymous, so D2 must also run one pass against the production topology — a named tunnel with Access in front (a scratch hostname on the user's zone, set up by the user, never the prod one). Sealed requests carry no `Authorization`; interactive Access 401s credential-less requests at the edge. Record whether E2EE works behind Access as configured, or state "E2EE devices require Access off / a Service Token" as a finding for R. Nobody re-adds `Authorization` to pass Access.
- **Measure the per-socket-context cost** (review M5): foreground-to-first-frame with the extra `/open` round trip, on the LAN and over the tunnel, stated in ms next to the pre-E2EE figure.

Out of scope: any code change (file an issue and report), the flag default (R), TestFlight (the export-compliance approval is the user's and gates it).

## Sub-agent

### `device-test-operator` — speciality: `dev-device.sh`, `cloudflared`, `simctl`/`adb`, `tcpdump`, Maestro

No worktree needed for code; a scratch checkout of mobile `origin/main` at the pinned commit under `../tb-mobile-worktrees/e2ee-device-run` (own `npm ci`, pods per the repo's script) for the device build. Evidence under the scratchpad, then a scrubbed copy under `tracks/D/evidence/`.

## Verification bar

- Every row: what was done, the exact command or tap, the observed result, the capture path, PASS/FAIL/NOT RUN with the reason.
- Positive controls: a legacy pairing succeeds on the same rig before any negative case; a plaintext capture on an unpinned pairing before D2's ciphertext claim (proves the tap sees plaintext when it exists).
- Negative controls: each failure case is provoked by one changed input against an otherwise passing setup.
- **Scrub before anything leaves the scratchpad**: API key, pair tokens, `spk`, tickets, device tokens, tunnel hostnames — taps log their argv. Diff the scrubbed copy against a grep for each secret before copying.

## Gates

- D1 accepted by `e2ee-owner` → no direct successor (X-client's preconditions are F and the streamer tags).
- D2 accepted → R kicks off; D2's evidence is what the user reads before the stage-2 go.

## Rules

- No commits in this track except the #667 comment and any issue you file; if a defect needs code, report it to `e2ee-owner` with the row and stop that row.
- Persist `tracks/D/PLAN-D.md` (the runbook) on approval; `tracks/D/D1-REPORT.md` and `D2-REPORT.md` on completion.
- Report every step to `e2ee-owner`; if the name changes, confirm with the user in your own pane.
- Shut down every simulator, emulator, streamer and tunnel you started; compare against the start-of-session record and say so.
- **Stop-work**: a key or token in evidence outside the scratchpad; a plaintext frame on a channel D2 declares sealed; the rig touching the real `~/.threadbase`.

**Mutation-driver rules (program-wide, from W1a):** revert every mutation in a `finally` and assert `git diff --quiet` after each; a mutated module that fails to parse or import is reported `BROKEN — did not run`, never counted as a pass — absence of a failure line is not evidence, only an observed red is; after any interruption, check for a stranded mutation before anything else.
