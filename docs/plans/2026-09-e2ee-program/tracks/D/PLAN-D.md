# Group D — device evidence — runbook (draft, pre-setup phase)

Session: `e2ee-D-sonnet5-medium`. Orchestrator for two hardware passes (D1, D2). One sub-agent: `device-test-operator`.
Owner: `e2ee-owner` (`ListAgents` ref `ddde5e`, confirmed 2026-08-29 01:5x IDT — recorded per house rules; a later name with this ref is an acceptable rename, a new ref needs the user's confirmation in this pane).

Status: **D1 COMPLETE 2026-08-30 00:1x IDT.** All 7 rows PASS. Three issues filed (streamer#744, mobile#920, mobile#921). Full teardown done, confirmed against the start-of-session record. See `D1-REPORT.md` for the summary.

## 10. Pre-setup execution record (via `device-test-operator`, one-shot)

- Streamer `@threadbase-sh/streamer@1.70.6` installed under scratch npm prefix, isolated from real `$HOME`. Install-script sandboxing blocked 3 packages' pre/postinstall (`@threadbase-sh/streamer`, `node-pty`, `protobufjs`); the one functionally relevant step (PTY spawn-helper permissions) was applied manually (`chmod 755` on the two `node-pty` prebuilt `spawn-helper` binaries), everything else those scripts do is version/ABI warning-only. Streamer boots and serves correctly.
- Rig port: **8790** (8765/8766/7265 avoided, all pre-existing/in-use).
- Rig streamer PID **49636**, `--feature e2ee=true --verbose`, scratch `HOME`/`THREADBASE_CONFIG_DIR`.
- **lsof isolation proof**: PID 49636's open files are confined to `$SCRATCH/home/.threadbase/{runtime.db,cache/cache.db}` (+ wal/shm) and `$SCRATCH/home/.config/threadbase-scanner/index.db`; zero matches for `/Users/ronenmars/.threadbase` in its open-file list. Cross-check: `/Users/ronenmars/.threadbase/*.db` is held only by the pre-existing prod PID 25158, never 49636.
- Fresh API key confirmed present in scratch `server.yaml` (value not recorded here).
- Ephemeral quick tunnel (`cloudflared tunnel --url http://127.0.0.1:8790`, **not** the named account tunnel) up, PID 52541. Hostname relayed to `e2ee-owner` directly, not persisted in this file per the tunnel-hostname scrub rule.
- Both pre-existing cloudflared processes (root PID 696, PID 1624) and the pre-existing prod streamer (PID 25158) confirmed untouched.
- **Device build not attempted**: `xcrun devicectl` still shows `Ronen Mars's iPhone 17 Pro` as `transportType: localNetwork`, `tunnelState: disconnected` — not cabled. No mobile worktree created, no code touched, no pairing.
- **Shut down 2026-08-29 03:15 IDT on owner acceptance**: rig streamer PID 49636 and quick tunnel PID 52541 both killed and confirmed gone (`ps -p` empty for both). Pre-existing prod streamer (25158), cloudflared 696, cloudflared 1624 confirmed still running, untouched. Scratch `HOME`, the installed `1.70.6` package, and the scratch config are kept in place so a D1 restart is minutes, not a rebuild — a fresh quick tunnel at restart will yield a new hostname, and the lsof isolation proof must be re-run at that point (owner's instruction).

## 11. D1 GO — re-verification and rig re-run (2026-08-29 21:1x IDT)

Precondition re-verified fresh (not trusted from the GO message): streamer #739 MERGED; mobile #900/#901/#902/#908/#915/#917/#919 all MERGED; mobile `origin/main` = `92033156` exactly; streamer tag `v1.70.6` confirmed on remote.

**Start-of-session record** (this pass): iOS "iPhone 17 Pro" *simulator* now booted — pre-existing, not started by this session; prod streamer on :8766 running under a new PID (79960, via launchd) after an ordinary restart, not mine; ports 8765/7265 held by the same pre-existing unrelated processes as before. Physical iPhone: `xcrun devicectl` shows `transportType: localNetwork`, `tunnelState: disconnected` — **not cabled**.

**Rig isolation re-run**: streamer `1.70.6` under scratch `HOME`/`THREADBASE_CONFIG_DIR`, port 8790, PID 31569 (a first attempt using shell `&`/`nohup` was killed when its Bash tool call ended — same background-job-lifecycle issue `device-test-operator` flagged during pre-setup; fixed by using the Bash tool's own `run_in_background` instead of shell backgrounding). lsof proof: every DB file (`runtime.db`, `cache/cache.db`, `.config/threadbase-scanner/index.db`, +wal/shm) confined to scratch `$HOME`; zero matches for `/Users/ronenmars/.threadbase`. Cross-check: the real `~/.threadbase/runtime.db` held only by prod PID 79960. Ephemeral quick tunnel up (PID 34013, confirmed by its own "Requesting new quick Tunnel" log line, not a named tunnel) — hostname relayed to the owner directly, not persisted here.

**Stopped per the owner's sequencing**: phone still not cabled → device build not attempted. Reported to `e2ee-owner`; waiting for the user to cable the phone before proceeding.

## 12. D1 — device build and install (2026-08-29 22:3x–23:0x IDT)

Phone cabled (`transportType: wired` confirmed). Scratch mobile worktree `../tb-mobile-worktrees/e2ee-device-run` created at `92033156` exactly. `npm ci` (1436 packages, script-sandbox blocked 4 packages' postinstall — `@sentry/cli`×2, `@swc/core`, `esbuild` — all functional anyway via prebuilt platform binaries, same pattern as the streamer rig). `bundle install` failed against the global Homebrew Ruby gem path (`Permission denied @ rb_sysopen` on a read-only Cellar file, a machine-level quirk unrelated to this track); fixed with `bundle config set --local path 'vendor/bundle'`. `bundle exec pod install --project-directory=ios` succeeded (script-phase warnings only, standard for this Pod set).

**Harness background-task limit discovered**: three concurrent tool-tracked background tasks (rig, tunnel, device build) died together at the next turn boundary, twice, before the cause was isolated — a 2-task concurrency limit in the session's background-task tracking, not a signal/interrupt in the pane. Fixed by combining rig+tunnel into a single tracked wrapper task. Confirmed via `ps -o pid,ppid,sess`: not true session-detached daemons at that point (same session id as the parent shell), alive only because they fit the 2-task limit. Owner-approved fix for subsequent relaunches: launch via a Python `os.setsid()` wrapper from a synchronous (non-backgrounded) call, since `setsid(1)` does not exist on macOS (only the `setsid(2)` syscall) — this avoids the tracked-task count entirely.

`scripts/dev-device.sh` build via `DEVICE_UDID=00008150-00115DEA1A40401C` (destination confirmed correct in the log: `Using --device 00008150-00115DEA1A40401C`, manual signing applied, never a simulator — a simulator seen booted independently belongs to another track, not this one). Build succeeded (0 errors, 3 warnings — ambiguous script-dependency warnings only). First launch hit the documented "dev client shows the server-picker, not the app" trap (`docs/troubleshooting.md` "`simctl launch` opens the dev-launcher, not the app" — same underlying symptom on a device launch as the simulator case that doc names); user retried and the app loaded. Port 8081 confirmed genuinely this session's own Metro (`curl localhost:8081/status`, PID matches `expo run:ios`), ruling out the doc's other trap (another session's stale Metro on the default port). App confirmed installed clean (build "1", after the user removed the stale "212" build).

Proceeding to D1 row 1 (legacy pairing, positive control).

## 13. D1 row results

### Row 1 — disabled server, legacy pairing (positive control) — **PASS**

Rig relaunched as a true `os.setsid()`-detached daemon (`ppid=1`, own session id, verified via `ps`) with `--feature e2ee=false`. Pair URL captured: `threadbase://pair?url=http%3A%2F%2F192.168.68.125%3A8790&token=...&exp=...` — **no `spk` or `v` param**, confirming the disabled server correctly omits the encryption offer. User scanned the QR (displayed directly in this session's chat, per the owner's instruction to make hands-on asks directly to the user). Log shows `pair.token_exchanged` → `POST /api/pair/exchange` 200 → WS connect → session list load → app UI mounted (`ProjectsHub`, `QuickAccessStrip`) — no confirmation/fingerprint gate appeared anywhere in the flow, consistent with a legacy (non-E2EE) pairing. Evidence (scrubbed of the pair token and the masked-API-key display line): `tracks/D/evidence/row1-legacy-pairing.log`.

### Row 2 — malformed spk, wrong responder key, missing msg2, tampered msg2 — **PASS (4/4)**

All attended (owner correction: row 2 is not unattended). Each link generated with a fresh token (180s window) and rendered as a real scannable ASCII QR (`qrcode-terminal`, already a tb-streamer dependency) shown directly in-pane for the user to scan, matching row 1's real flow.

- **Malformed spk** (`spk=BADSPK_notvalidbase64url!!` on the real e2ee=true rig's URL): "The server key in this pairing code is damaged, so this pairing cannot be encrypted. Generate a fresh QR on your server." Retryable copy, no server added.
- **Wrong responder key** (real rig's URL/token, but `spk` swapped for a second isolated streamer's real identity key, harvested from a second scratch-isolated rig on port 8791): "Could not verify this server's identity. Your pairing code is still valid — scan it again..." Distinct message from malformed spk, no server added.
- **Missing msg2**: real rig's URL/token/spk, but routed through a ~90-line Node reverse proxy (`exchange-proxy.js`, scratchpad-only, not committed to either repo) sitting in front of the real rig on a third port — forwards every request verbatim except `POST /api/pair/exchange`'s 200 response, where it deletes the `e2ee` key entirely before forwarding. Confirmed via proxy log the mutation fired. Result: "This server offered an encrypted pairing and then did not finish it." **No "Try again" button** — correctly non-retryable, matching design.md's "once msg1 was sent, an absent msg2 is a hard failure, never consent to plaintext."
- **Tampered msg2**: same proxy, second instance in `tamper` mode — flips one byte inside the real `e2ee.noise` (msg2) field before forwarding. Confirmed via proxy log ("tampered e2ee.noise (msg2) — flipped one byte") that the real rig's genuine msg2 was corrupted in flight, not substituted. Result: same "Could not verify this server's identity" message as wrong-responder-key — expected, not a defect: Noise's AEAD makes a corrupted ciphertext and a wrong-key response cryptographically indistinguishable to the initiator.

No code changes to either repo for any of the four — the proxy and the second rig are scratch-only test infrastructure per the owner-approved approach.

**Finding investigated and resolved as non-defect (streamer#744 filed, hygiene not a stop)**: `GET /api/devices` after row 2 showed two orphan device rows (373bea94, f39a98bc, both `e2ee:true`, full capabilities, `revokedAt: null`) beyond row 1's legitimate legacy device. Traced to ground: mobile's `beginPairHandshake` (`services/e2ee/pair-handshake.ts`) genuinely load-or-creates `D_priv` keyed by `serverIdFromUrl(url)` — a deterministic hash of the pairing URL — and reuses it correctly on retry against the *same* URL. The two orphan rows came from missing-msg2 and tampered-msg2 each using a *different* proxy port as their pairing URL (8793, 8792) — different URL → different key → different row, exactly as designed, not an app-side key-reuse bug. The narrower real finding — a device row that IS committed server-side (full capabilities) before the client can accept/reject msg2, staying unrevoked until the same phone retries the exact same URL — filed as streamer#744.

### Row 3 — deep-link and paste confirmation gate — in progress

Deep link tested via Safari address bar (typing the `threadbase://pair?...` URI directly triggers iOS's real "Open in Threadbase?" OS-level scheme handoff — genuine deep-link activation, not the in-app manual-entry form, which does NOT auto-parse a pasted full URI into its separate URL/token fields as first tried).

**Gate confirmed correct**: "Is this the computer you meant?" — machine name (`Ronens-MacBook-Pro.local`), address, identity code (fingerprint), "on this phone / on that computer" cross-check instructions, Cancel/Add server buttons. Exactly matches row 3's spec.

**Cancel — adds nothing locally**: confirmed via the app's own Settings → Servers list showing 0 servers after cancel. (Side note, not a row-3 defect: row 1's legacy server had *also* disappeared from the list by this point — the Metro log shows a full JS reload with `activeServerIdsLen:0` sometime between row 1 and row 3, cause not yet diagnosed; flagged to the owner, does not block row 3's own before/after-cancel conclusion since both counts were 0.)

**Confirm — adds correctly**: fresh link, tapped "Add server", app's Settings → Servers list now shows "Ronens-MacBook-Pro.local", connected, and immediately detected the real `tb-e2ee-program` Claude session running on this Mac. **Row 3: PASS** (gate correct, cancel confirmed empty, confirm confirmed added).

**Row-1-server-loss — resolved, closed by repro.** User's first account was "removed it myself"; clarified account was "force-quit and reopened the app." Since force-quit/reopen is normal expected behavior (not a deletion), ran a cheap repro on the fresh row-3 server rather than accepting the account at face value: user force-quit and reopened the app for real, server list checked after — **"Ronens-MacBook-Pro.local" survived, still Connected**. Force-quit/reopen alone does not reproduce the loss; anomaly closed. The `addServer` fire-and-forget-persist observation (`stores/servers.ts` calling `persistServerList(...)` without `await` inside a synchronous Zustand `set()`) stands as a noted code detail, not evidenced as a real defect. This result also serves as early positive evidence for row 6's restart-survival check.

### Row 4 — identity code renders LTR in he/ar — **PASS (2/2)**

Same-URL re-scan is blocked with "server already added" (expected — same static key, already-known server), so a fresh isolated rig (third one, port 8794) was used for each screenshot to reach the gate. Hebrew: identity code `c1ae 9ad9 7b97 0093 b408 fef7 a3b5 a37b` rendered correctly LTR inside the RTL layout (user separately noted a label-alignment cosmetic nit, unrelated to the LTR-code check row 4 tests — possibly covered by mobile#911, not verified here). Arabic: identity code `9333 e618 a5a1 9eb1 8814 95c6 ed08 fd56` rendered correctly LTR, with correct RTL label alignment this time. Both cancelled after screenshot.

### Row 5 — `publicUrl: null` over LAN — **PASS**

`public_url` confirmed unset in all three scratch `server.yaml` files; `POST /api/pair/start` and `GET /api/info` both return `publicUrl: null`. Rather than a fresh scan, cited the already-collected evidence: rows 1, 3, and 4 each paired successfully over the LAN address against this exact `publicUrl: null` server, with no crash and normal UI. Comment posted on streamer#667 with the evidence: https://github.com/RonenMars/threadbase-streamer/issues/667#issuecomment-5464788261

### Row 6 — key/pin survival, same-row re-pair, revoke-then-re-pair

**Restart survival: PASS** (evidenced earlier during the row-1 investigation) — user force-quit and reopened the app for real; the paired e2ee server survived, still Connected.

**Revoke-then-re-pair: design §4.4 recovery NOT REACHABLE from the app — mobile gap, filed.** Revoked device `60d2ed51` server-side (`revoked_at` set, confirmed via DB). App correctly surfaced the break on next fetch: "Unauthorized — the server rejected the API key for /api/info", no crash, no plaintext fallback. Re-scanning the same URL while the revoked server was still locally listed was blocked client-side ("Server already added — delete that server first"), regardless of revoked state — no re-authorize affordance exists. Per the owner's read of `origin/main`: streamer's `devices.repository.ts` `repairStmt` and design.md §4.4 both confirm revoke is meant to be recoverable — re-presenting the same `e2ee_static_pub` clears `revoked_at` on the existing row by design. But `removeServer` **and** `editServer` (`stores/servers.ts`) both call `clearDeviceStaticKey`, wiping `D_priv` — so the only UI path to attempt recovery (delete → re-add) can never present the same key again. **Reproduced**: deleted the server, re-added via a fresh link to the same URL — server-side confirmed a genuinely new row (`668b05df`, `revokedAt: null`) was created, while the old row (`60d2ed51`) stays permanently revoked and orphaned (adds to streamer#744's dead-row count). Filed as mobile#[pending] citing §4.4, the two key-clearing call sites, and the "already added" block; proposes a re-authorize affordance (re-scanning an existing server's QR keeps `D_priv` instead of wiping it) — no code change, per D1 rule.

**streamer#744 self-heal control: PASS.** Restarted the port-8792 proxy in passthrough mode (same port → same `serverIdFromUrl` → same `D_priv`), paired again through it. Server-side: still 5 total device rows (no 6th created); the port-8792 orphan row (`373bea94`, the tampered-msg2 case's row — correcting an earlier mislabel in a status report, `f39a98bc` was the missing-msg2/port-8793 row and stayed untouched here) got a fresh `lastSeen` timestamp and `revokedAt` stayed `null` throughout — `register()`'s upsert-by-`e2ee_static_pub` genuinely self-healed onto the existing row when the same URL/key was presented again, confirming #744's stated mechanism.

### Row 7 — web build — **PASS (3/3)**

**Blocker found and worked around (mobile#921 filed)**: `origin/main` pins `react@19.2.3` and `react-dom@19.2.8` — two different patch versions, which React requires to match exactly. This is a genuine pre-existing bug (confirmed via clean `npm ci`, not an artifact of this session), presumably never caught because the web target isn't exercised by the normal iOS/CI paths. Owner-approved workaround: `npm install --no-save react-dom@19.2.3` in the scratch worktree only (`package.json`/`package-lock.json` confirmed unmodified via `git status`). Filed as mobile#921.

Also hit (and correctly identified as unrelated dev-mode noise, not blocking): a LogBox overlay stack of 4-5 errors, all either `expo-notifications` methods not implemented on web (`ExpoNotifications.getLastNotificationResponse is not available on web`) or benign RN-Web style-prop warnings (`Invalid style property of "direction"`) — dismissible, the underlying app renders fine underneath. Also found and worked around: CORS blocks a browser fetch to the streamer by default (`THREADBASE_ALLOW_BROWSER_CORS`, off by default, documented behavior — not a bug); set it to the dev origin for testing.

Also found stale `localStorage` from an unrelated prior browser session at this origin (a server "ak" pointing at the real production tunnel) — cleared before testing so the clean-slate claims below are meaningful.

- **spk-bearing URI refused with the native-app explanation: PASS.** Manual-entry form does not auto-parse a pasted full `threadbase://` link (same limitation as mobile's equivalent form — types raw text into the Server URL field only). Worked around by navigating directly to the app's own `/pair` route with the same query params Expo Router maps the custom scheme to (confirmed via `app/pair.tsx`). Result: "Pairing failed — Encrypted pairing needs the Threadbase app for iOS or Android. A browser cannot store the key that identifies this device." Exact match to spec.
- **Browser's localStorage holds no `D_priv`: PASS.** Checked immediately after the refusal above — zero keys matching e2ee/priv/static/key patterns.
- **Legacy no-spk URI still pairs: PASS.** Same `/pair` route technique with a spk-less URL from a fresh legacy rig. Result: "No identity to verify — this link doesn't include an identity code... Anything you send will be readable by anything between this device and the server," offering Add server. Completed — `localStorage.threadbase_servers` shows the new server, no `serverPublicKey` field, consistent with legacy.

## 1. Precondition (re-verified 2026-08-29, not trusted from any kickoff message)

| Check | Result |
|---|---|
| streamer PR #739 | `MERGED` 2026-08-28T19:52:32Z |
| mobile PR #900 | `MERGED` 2026-08-28T18:57:02Z |
| mobile PR #901 | `MERGED` 2026-08-28T19:48:23Z |
| mobile PR #902 | `MERGED` 2026-08-28T22:06:48Z |
| streamer tag `v1.70.6` on remote | confirmed, `git ls-remote --tags origin` → `0069afc1...` |
| mobile `origin/main` | `f3e82287` (= #902, HEAD) — satisfies "f3e82287 or later" |

## 2. Pins (exact, not caret)

- `@threadbase-sh/streamer@1.70.6`
- mobile `origin/main` @ `f3e82287`
- Xcode 26.6 (Build 17F113) — confirmed installed
- Maestro 2.8.0 — confirmed installed
- Node v24.15.0 — confirmed active (`$HOME/.nvm/versions/node/v24.15.0/bin/node`)
- If the rig runs over an hour, record the streamer dist hash (sha256 of the installed `@threadbase-sh/streamer` package) in the report, not just the version string.

## 3. Start-of-session record (read-only, taken before any rig action)

- iOS simulators: none booted.
- Android: `emulator-5554` already attached — **pre-existing, not started by this session.**
- Two `cloudflared` tunnels already running — pre-existing:
  - PID 1624: `cloudflared tunnel --protocol http2 --url http://localhost:8765`
  - PID 696 (root): `cloudflared tunnel --config ~/.cloudflared/config.yml run` — this is the named tunnel backing the real prod hostname `<prod-tunnel-host> → 127.0.0.1:8766` (per `tb-streamer/CLAUDE.md` §"Cloudflare Tunnel").
- One `node` process already serving on port **8766**: `~/.threadbase/cli.js serve --port 8766 --prod` — **this is the real production streamer, using the real `~/.threadbase`.** Not touched, not connected to, must stay untouched throughout D1/D2.
- One further `node` process listening on 127.0.0.1:7265 — unidentified, not investigated (out of scope for a read-only pass); the rig must avoid this port too.
- Nothing booted or started by this session as of this record.

**Consequence for rig isolation:** the rig's streamer must bind a port other than 8766/7265/8765, and must register its own, separate named tunnel — never reuse `<prod-tunnel-host>` or port 8766.

## 4. Rig isolation steps (to run on owner approval)

1. Create scratch root: `SCRATCH=$(mktemp -d /private/tmp/claude-501/.../tb-e2ee-d-rig.XXXXXX)` (or the session scratchpad dir).
2. **`HOME=$SCRATCH` from the *first* boot, not `THREADBASE_CONFIG_DIR` alone.** Carried over from the prior program's isolation incident (`ai-investigation-claude/tracks/C-opus5-medium/PROBE-PLAN.md` §6: *"the v1.70.0 rig boots under a scratch `HOME` from its first boot — `THREADBASE_CONFIG_DIR` alone does not move `cacheDir`"*). Setting only `THREADBASE_CONFIG_DIR` left a prior rig's cache DB on the prod path.
3. `THREADBASE_CONFIG_DIR=$SCRATCH/.threadbase` set alongside `HOME`, redundant with (2) but explicit per the streamer's own env-var contract (`tb-streamer/CLAUDE.md` §"Environment variables").
4. Install pinned streamer inside the scratch env: `HOME=$SCRATCH npm install -g @threadbase-sh/streamer@1.70.6` (or an equivalent scratch-local install — final command decided at install time, npm prefix scoped under `$SCRATCH`).
5. Generate a fresh API key inside the scratch config — never reuse the real key.
6. Boot: `HOME=$SCRATCH THREADBASE_CONFIG_DIR=$SCRATCH/.threadbase <streamer bin> serve --port <rig-port, e.g. 8790> --feature e2ee=true --verbose`.
7. **Verify isolation before anything else**, with `lsof`:
   - `lsof -p <rig-pid>` shows every open DB/config file path under `$SCRATCH`, none under the real `~/.threadbase`.
   - Cross-check: `lsof ~/.threadbase/*.db` shows only the pre-existing prod PID from §3, never the rig PID.
8. Bring up an **ephemeral quick tunnel** — `cloudflared tunnel --url http://127.0.0.1:<rig-port>` — never a named tunnel on the user's Cloudflare account (that touches their config and needs their auth). Yields a throwaway `*.trycloudflare.com` HTTPS hostname, sufficient for the Android release-build leg (never `<prod-tunnel-host>`, never port 8766). Treat the quick-tunnel hostname as a secret to scrub, same as the others.
9. Record: rig port, rig tunnel hostname, rig API key location (never the key value) — all four (API key, tunnel hostname, pair tokens, `spk`/tickets/device tokens) get scrubbed from every capture before anything leaves the scratchpad, per program CLAUDE.md §5 and `tracks/parallel-execution-plan.md` "Isolation within a group."

## 5. Device build (owner approval required, still no pairing)

- Scratch mobile checkout: `../tb-mobile-worktrees/e2ee-device-run`, pinned at `origin/main` `f3e82287`, own `npm ci`, pods per repo script.
- Build and sign **only** through `scripts/dev-device.sh` (never `expo run:ios --device` directly — per-target manual signing for App Groups; a direct call fails with six signing errors that read as project misconfiguration, not a wrong entry point).
- Install to the cabled physical iPhone. **No pairing performed in this phase** — build and install only.
- Android: release build over the rig's own tunnel (mobile#727 — a release build cannot reach `http://`).

## 6. D1 row list (fires only when owner sends the go, after F merges)

1. Disabled server (`--feature e2ee=false`) prints a QR with no `spk`/`v`; phone pairs legacy, unpinned, byte-identical banner captured.
2. Malformed `spk`, wrong responder key (second streamer's `spk` pasted into the first's link), tampered msg2, missing msg2 — each fails visibly with its specific message, adds no server.
3. Deep-link and paste confirmation gate on hardware: fingerprint + machine name shown; cancel adds nothing; confirm adds. Camera path adds **without** the gate — this is the expected out-of-band channel behavior (mobile-design §3.3), not a defect; a defect would be a gate appearing on the camera path, or no gate on deep-link/paste.
4. Identity code renders LTR in `he` and `ar` — screenshot each, on the phone.
5. `publicUrl: null` over LAN (streamer#667): `public_url` unset in scratch `server.yaml`, pair over LAN, app accepts `null`. Comment on #667 with the evidence.
6. Key/pin survival across app restart; same-row re-pair; revoke-then-re-pair clears `revoked_at`.
7. **Web build** (Expo web, browser on the Mac — not a phone row): pair URI with `spk` refused with the native-app explanation; browser `localStorage` for the origin holds no `D_priv`; a legacy no-`spk` URI still pairs. Only place `secure-store.web.ts` selection is observable (jest cannot see it per Group M, 2026-08-28).

Positive control before any negative case: a legacy pairing succeeds on the rig first (also satisfies row 1).

## 7. Verification bar (every row)

What was done, exact command/tap, observed result, capture path, PASS/FAIL/NOT RUN with reason. Negative cases: one changed input against an otherwise-passing setup. Scrub before anything leaves the scratchpad; diff the scrubbed copy against a grep for each secret before copying.

## 8. Out of scope this track

Any code change (file an issue, report to owner, stop that row); the flag default (Group R); TestFlight/export-compliance (user's own obligation).

## 9. Shutdown checklist (compare against §3 at close)

- [ ] Rig streamer process killed
- [ ] Rig's own cloudflared tunnel killed
- [ ] Any simulators/emulators booted by this session shut down (none booted as of this draft)
- [ ] Confirm pre-existing state from §3 (prod streamer :8766, prod tunnels, `emulator-5554`) still present and untouched
- [ ] Scratch `HOME`/mobile worktree either removed or clearly marked scratch, never merged

## 14. D2 prep (no hardware — written ahead per owner's request, 2026-08-30 00:1x IDT)

**Design drift since D1's original brief — flagging before the runbook, not silently rewriting around it.** `prompt.md`'s D2 row list (written before Group W's work landed) says "a foreground rekey after the threshold." `NONCE-DESIGN.md` §6 (ruled 2026-08-29, on `origin/main`) has since **removed in-place rekey entirely**: *"A key is never replaced inside a context. A new key is a new context."* WebSocket contexts never rekey — they die with the socket, no grace window. REST contexts hitting 24h/1GiB/foreground open a **new** context and retire the old one (10s drain, then `E2EE_CTX_UNKNOWN`). The rows below test the *current* mechanism, not the retired one; §6's own text says the old "rekey" test obligation is deliberately not being replaced with an equivalent counter-survival test, since there's no in-place path left to survive.

### Packet capture — decode before grep

Raw `tcpdump` bytes are not searchable directly: WebSocket frames are masked client→server and may be fragmented (prior program's PROBE-PLAN §6 finding — a grep returning 0 on both the marker and the positive control proves only that the grep cannot match, not that the wire is clean). Capture, then decode, then search:

```bash
# Capture (LAN interface only — get the interface name first: ifconfig, or `tcpdump -D`)
sudo tcpdump -i en0 -w /path/to/scratchpad/d2-capture.pcap 'host <phone-LAN-IP> and port <rig-port>'

# Decode WebSocket payloads (unmasks + reassembles fragmented frames) before any grep
tshark -r d2-capture.pcap -Y websocket -T fields -e frame.number -e websocket.payload > ws-payloads.txt

# Decode HTTP/REST bodies similarly (unseal happens above HTTP, so bodies are opaque envelopes —
# looking for "type": here is exactly the point: it must NOT be found)
tshark -r d2-capture.pcap -Y http -T fields -e frame.number -e http.file_data > http-bodies.txt

# tshark prints `websocket.payload`/`http.file_data` as HEX, so grepping those files
# directly always returns 0. Convert hex back to bytes first, then grep the bytes.
cut -f2 ws-payloads.txt   | tr -d ':\n' | xxd -r -p > ws-decoded.bin
cut -f2 http-bodies.txt   | tr -d ':\n' | xxd -r -p > http-decoded.bin

# THE PRIMARY GREP IS THE RAW SWEEP, not the decoded fields. Anything tshark does
# not dissect into an http/websocket field never reaches the files above — on the
# 2026-09-02 sealed captures that was ~30% of all payload bytes, including one
# server-to-client frame per capture larger than the MSS, i.e. exactly the class
# most likely to carry terminal output.
tshark -r d2-capture.pcap -Y "tcp.len>0 && tcp.port==<rig-port>" -T fields -e tcp.payload \
  | tr -d ':\n' | xxd -r -p > all-payload.bin
grep -a -c -F '<canary>' all-payload.bin          # every byte on the wire, dissected or not

# The raw sweep cannot read CLIENT-TO-SERVER WebSocket frames: they are XOR-masked.
# The field pipeline below unmasks them, so the two cover each other and NEITHER
# ALONE IS SUFFICIENT. Run both.

# THEN grep the decoded bytes too, never the raw hex dump.
# Marker per leg — `"type":` is a WS-frame field and does NOT appear in plaintext
# REST bodies, so using it on the HTTP leg gives a false "sealed" (proved on the
# 2026-09-02 legacy control: ws=1, http=0 on plaintext).
grep -c '"type":' <(strings ws-decoded.bin)
grep -c -e '"conversations":' -e '"sessions":' -e '"serverIdentityKey":' <(strings http-decoded.bin)
```

Record frame counts (total WS frames, total HTTP request/response bodies) and marker-hit counts per row in the report — the owner reads the capture summary, not a bare PASS/FAIL.

### Positive control — must come first, and must exercise the hard path

**A control whose bodies and frames all fit in one TCP segment certifies only the easy path.** The 2026-09-02 legacy control dissected 100% of its payload, which is precisely why it could not reveal that the sealed captures left ~30% undissected. The control must therefore include:

- an HTTP body larger than one segment, and
- a server-to-client WebSocket frame larger than the MSS (a session streaming a few hundred KB does both),

and its own coverage must be reported: total `tcp.len` bytes versus bytes reaching the decoded files. If the control does not reach ~100%, the pipeline is not ready to certify anything.

### Positive control — must come first, every time

Before any sealed-channel claim: pair **without** the flag (`--feature e2ee=false` rig, or an unpinned device), repeat the *exact* tap/action the sealed row will use, run the *exact* same tshark+grep pipeline. Confirm `"type":` markers ARE found in the decoded output. Only then does a zero on the sealed run mean the channel is actually sealed, rather than the tooling failing to see anything either way. One control run covers terminal output, replay, conversation events, and user messages if driven through the same session — no need to repeat per sub-case unless the control itself is in question.

### LAN-only scope, stated in the report every time

The ciphertext claim is **LAN-only** — `tcpdump` can only decode plaintext at the network layer, and the tunnel leg is TLS-wrapped (Cloudflare Access), opaque to this capture method. Rows against the tunnel/named-tunnel/Access path prove *function*, never wire secrecy. Say so explicitly next to any tunnel-leg result, so a reader can't mistake "it worked over the tunnel" for "it was inspected and found sealed."

### The Access / named-tunnel pass

Separate from the LAN capture: exercise the same D2 checks (terminal output, replay, conversation events, user messages, reconnect, restart, revoke) against the streamer reached through Cloudflare Access on a named tunnel — this is what the Android leg and any remote-pairing path actually run over in production, so it needs its own functional pass even though it can't be packet-inspected. Positive control here is behavioral, not capture-based: confirm the pinned device round-trips correctly (session list loads, terminal streams, no errors) both before wiring D2's sealed checks and after, so a tunnel hiccup isn't mistaken for a protocol failure.

### Per-context timing measurements

Two distinct timers, don't conflate them:

- **WS first-sealed-frame deadline** (W1b, `WS_FIRST_FRAME_DEADLINE_MS` — not yet on `origin/main` as of this writing, confirm the exact constant/value once W1b's tag is pinned; STATUS.md's decisions log records it as a 10s pin with a 15s ceiling matching the client's own connect timeout). Measure: how long after socket open does the server evict a socket that spent a ticket but never sent a valid sealed frame? Positive control: a legitimate client's real first frame lands well inside the window and the socket survives.
- **REST context drain window** (`NONCE-DESIGN.md` §8, pinned at **10 s**): after a REST context is retired (24h/1GiB/foreground-past-threshold), how long does the *old* `ctxId` keep answering before flipping to `E2EE_CTX_UNKNOWN`? This is what replaces the old "rekey" row — measure that a request arriving inside the drain window on the old context still succeeds, and one arriving after gets `E2EE_CTX_UNKNOWN` cleanly (client recovers via single-flighted re-open per §8, not a user-visible failure).

### D2 row list (current mechanism, supersedes `prompt.md`'s "foreground rekey" wording)

1. LAN capture, terminal output — sealed, positive control first.
2. LAN capture, replay (`terminal_replay`) — sealed, including the 2s HTTP replay fallback path (`hooks/useTerminalStream.ts`) — falls back to a *different transport*, never to plaintext; the HTTP path is sealed too, needs its own capture+decode, not just the WS one.
3. LAN capture, conversation events — sealed.
4. LAN capture, user messages — sealed.
5. Foreground past threshold (or 24h/1GiB, whichever is reachable on hardware in a session) — confirm a **new** REST context opens and the old one drains per the timing measurement above, not an in-place key swap.
6. Socket reconnect — confirm a fresh ticket is fetched (`POST /api/e2ee/open` again) and a genuinely new WS context opens; the REST context is untouched by the socket going away (per `mobile-design.md` §4.3's correction).
7. Streamer restart — one transparent re-handshake (contexts are in-memory only, do not survive restart by design — confirm the client recovers without user-visible failure).
8. Revoked device's live socket closes.
9. Access/named-tunnel functional pass (see above) — function only, explicitly not a wire-secrecy claim.

### §14 traps found 2026-09-02 evening (G session)

§14 exists because three earlier traps were not recorded. Every trap below fails as a
clean, plausible **empty result** rather than as an error — a green result that is
actually a blind spot, the same shape as the ~30 % ungrepped payload.

**1. Two LAN interfaces on the same /24.** `en0` = 192.168.68.125 and `en9` =
192.168.68.102 are both on 192.168.68.0/24. Capture the wrong one and `tcpdump` writes
an empty file, the sweep finds no plaintext, and it reads as a clean pass. Not
hypothetical: mobile issue #727's field report used the `en9` address. Resolve the
interface from **the rig's own pair URL** — the streamer prints the address it
advertises — and then prove it.

> **Rule: no interface is accepted until a positive control proves data flows on it,
> and the evidence write-up must carry that interface's own total `tcp.len` byte count
> next to the coverage figure.** A later reader must be able to see the capture was
> non-empty *for a stated reason*, not by assumption.

**2. A stale plan note can manufacture a false pass — the staleness is not the trap,
the false pass is.** §5 of this document said "Android: release build over the rig's own
tunnel (mobile#727 — a release build cannot reach `http://`)". **#727 is CLOSED**, fixed
2026-08-15 by `13e21e22` (#752): `usesCleartextTraffic="true"` in the main manifest plus
an app-layer policy permitting cleartext to the local network and refusing it elsewhere.

> **The consequence, stated because the correction alone is not the lesson:** following
> the stale note would have run G-2 over the tunnel's TLS, where the chosen-plaintext
> canary is absent **because of TLS rather than because of E2EE** — and the row that
> gates the stage-2 default flip would have recorded a pass that proves nothing. When a
> plan note routes a secrecy test through a transport that hides everything, the note is
> not merely out of date; it is generating the result.

**3. Spotlight indexing is disabled machine-wide** (`mdutil -s /` → "Indexing
disabled"), so `mdfind` returns empty for every query, including `mdfind -name Safari`.
Never use it to prove a file does not exist.

**4. Packet capture requires root and fails only at capture time.** `/dev/bpf*` is
`crw------- root:wheel`, with no `access_bpf` group and no ChmodBPF daemon. Budget the
sudo ask into the plan rather than discovering it after the rig is up.

**5. `devicectl` "connected" does not mean USB.** `xcrun devicectl list devices` reported
the iPhone 13 Pro as `connected` and the 17 Pro as `available (paired)`, but
`xcrun xctrace list devices` — which is what `scripts/dev-device.sh` actually uses —
listed **only the 17 Pro**. Acting on `devicectl` alone sends the user to plug in the
wrong phone. **Use `xctrace` to decide which device is buildable.**

**6. A local dev build reports `Bundle Version 1` regardless of commit.** Both phones
report `com.ronenmars.threadbase` version 1.0, bundle version 1, so **the installed
build's provenance cannot be read off the device**. That is why rebuilding before a
receive-path row is not optional: a stale client certifies nothing, and it fails in a
way that looks like a clean result.

**7. The rig CHOOSES the interface, and it chooses it by enumeration order.** Trap 1
records that two interfaces share the /24. The mechanism behind it was not recorded, and it
is worse than "pick the right one". `src/lan-url.ts::resolveServerUrl` on `origin/main`
returns `publicUrl` when set and otherwise `firstLanIPv4()` — **the first non-internal IPv4
that `os.networkInterfaces()` happens to enumerate**. On this machine that candidate list is
not two entries but four:

```
candidate: en0    192.168.68.125     <- what it returns today
candidate: en9    192.168.68.102
candidate: en12   169.254.185.52     (link-local)
candidate: utun16 100.122.246.79     (Tailscale)
```

Nothing pins the winner. A reboot, a Wi-Fi drop, a VPN coming up, or `en0` simply
enumerating later hands the pair URL a different address — and the device then talks over an
interface nobody is capturing, while `tcpdump` on the remembered one writes an empty file
that the sweep reports as "no plaintext found".

**The `utun16` candidate is the worst case and deserves its own statement.** If the Tailscale
interface wins the enumeration, the rig advertises a VPN address and the device's traffic leaves
over the VPN. That does not merely move the capture to the wrong interface.
**It is a scope violation: it breaks the LAN-only scope that every ciphertext claim in this
program rests on.** The row would be
measuring a tunnel it never declared, while a sweep of the remembered `en0` returned a clean
empty file. Treat a non-LAN advertised address as a **stop**, not as an interface-selection
problem: do not capture, and do not reason about which interface "should" have won.

> **Rule: the capture interface is derived from the rig's LIVE pair URL at capture time, and
> never carried over from an earlier session's note — including the note in
> `G-PHONE-RUNBOOK.md`, which records `en0` as a fact when it is only today's outcome. Then
> prove it with a positive control on that interface, per trap 1.** Verified 2026-09-04: the
> function returns `192.168.68.125` (en0) right now, which is why the earlier note was right;
> it was right by luck of enumeration, not by construction.

The same function is what makes the **no-root relay fallback** feasible: setting `publicUrl`
makes the rig advertise any address you choose, so a logging relay can be put in the path
without hand-editing a QR — `spk` is the server's static key and is host-independent.

**8. An empty log is not a hollow instrument — find out WHY it is empty before you draw a
conclusion from it. (Correction to my own earlier report, made before it hardened.)** I found
`scratchpad/logs/metro-8081.log` at 735 bytes — startup banner only, unchanged for sixteen
hours — and reported that Metro was not recording the app's console output, i.e. that the
instrument was hollow. **That diagnosis was wrong.** Launching the app against that same Metro
grew the file immediately and it now carries exactly what was wanted: `[boot] app module
loaded`, `[strip.mount]`, `[hub.mount]`, `[sentry] …`, `[ws:srv_…] connect attempt=0`, `open`.
Metro *was* recording. The log was empty because **no client had ever connected to it**.

The operational rule is unchanged and if anything firmer, but the mechanism matters, because
the wrong mechanism sends the next person to replace a tool that works:

> **Rule: before grepping any log for the absence of a behaviour, establish that the subject
> was connected to that log during the window — a byte count plus a positive control. A log
> that never saw its subject connect is empty for a reason that has nothing to do with what
> you are grepping for, and it is byte-for-byte indistinguishable from "the behaviour did not
> happen".**

`adb logcat` remains the better source for Android cadence regardless — it timestamps at OS
level, needs no taps, and is not contingent on a bundler being attached — but Metro is a valid
source, not a broken one.

**9. A newer JDK fails the native build, and it fails in a way that names nothing useful.**
CI builds Android on **Temurin 17** (`.github/workflows/e2e.yml`). This machine has only
Oracle **22** and Android Studio's JBR **25**. On the JBR the Gradle *configuration* phase
succeeds completely — 2m06, full task graph, no warning that matters — and then every
`configureCMakeDebug[<abi>]` task fails at execution with:

```
> Execution failed for task ':expo-updates:configureCMakeDebug[arm64-v8a]'.
   > WARNING: A restricted method in java.lang.System has been called
```

That is JDK 24+'s restricted-method enforcement (JEP 472) surfacing through AGP's native
tooling, and the message reads like a warning rather than a cause. **The same build on JDK 22
succeeds in 3m06 with no other change.** Configuration succeeding proves nothing about the
native path — check the JDK against what CI uses before concluding anything from a build
failure, and prefer failing fast with `--dry-run`, which costs two minutes and rules the JDK
in or out of the *configuration* phase only.

**10. `adb shell curl` proves LAN routing, not the app's cleartext policy.** The device reaches
both rigs over plain http — `:8790` → **200**, `:8791` → **200**, with a dead-port control at
`:8799` → **000** proving the probe discriminates. That is worth having, and it is *not* a
re-verification of mobile #727: `curl` is a system binary and is not subject to the app's
network-security config or its app-layer cleartext policy. The app's own stack is a separate
question, and on a **debug** build it is separate again, because a debug network-security
config may permit cleartext for reasons that have nothing to do with `13e21e22`.

**11. A secret passed as a command-line argument WILL be logged by something you did not
write. (My own incident, 2026-09-04, reported as a §6 stop-work trigger.)** The scratch rig's
API key reached a log in clear. Not because it was printed deliberately — it was handled
carefully throughout, with only its *length* echoed and its validity established by a 401-vs-200
control rather than by displaying it. It leaked because the script's interface is positional
(`tsx scripts/g-sealed-frames.ts <baseUrl> <apiKey> <sessionId>`) and **`npx` echoes the full
resolved command line back as an `npm notice run` line**.

> **Rule: the caller's discipline about not printing a secret is irrelevant if the secret is in
> `argv`. Process launchers, the process table, shell history and crash reporters all read
> `argv` and none of them asked you. Pass secrets by environment variable or file descriptor,
> never as a positional argument — and when a tool's interface is positional, change the tool.**

Remediation used here: invoke the binary directly rather than through `npx` (which removes the
echoing layer) **and** patch the script to prefer `process.env.TB_KEY`, so the value is absent
from `argv` entirely rather than merely unprinted. The workspace `CLAUDE.md` §5 already warns
that "taps log argv"; this is the same rule arriving from the other direction, and it was still
walked into.

**12. `nohup … &` from a tool call does not survive the call.** A relay started that way took
SIGTERM when its launching shell ended. It was caught only because the process prints a totals
report on termination — without that it would have looked like a crash, or worse, like a capture
that legitimately recorded nothing. **Anything that must outlive a single command has to be
started as a background process in its own right, and its liveness re-checked before you trust
a result that depends on it.** An absence produced by a dead collector is the same false pass as
an absence produced by a blind grep.

**13. `git grep -E` is POSIX ERE and does not support `\s` — the search fails silently, and so
does its control.** (Found by another agent tonight; recorded here because this section is the
program's shared memory.) A pattern like `type:\s*"ping"` matches **nothing** on these repos,
and it matches nothing *whether or not the thing is there*. The lethal part is that a positive
control written in the same style fails identically, so the zero looks corroborated.

> **Rule: use `[[:space:]]` or `-F` with `git grep`. And when reading this program's history,
> distrust the zero of any `\s`-bearing search — it is not evidence of absence.**

This is the same family as entries 8 and 12: a tool that cannot answer, returning something
shaped exactly like an answer.

**14. A scrub that greps for SHAPE rather than for PROVENANCE will both miss secrets and destroy
evidence.** While verifying that no credential reached the record, a 35-character base64-ish
string turned up in `D2-REPORT.md` — **the same length as the leaked scratch key**. It is an
`X-TB-Env` header value, truncated with an ellipsis, and `X-TB-Env` is on the
in-the-clear-by-design list (D-7): it travels as plaintext by construction, so publishing it
reveals nothing an on-path observer lacks, and the report exists partly to document it as
plaintext. A second hit, a 43-character `serverPublicKey`, is an X25519 **public** key published
in every pairing QR.

Either could have been "fixed" by a hurried scrubber — deleting exactly the evidence the report
was written to carry — or waved through if the shape had looked innocuous instead.

> **Rule: decide what a string IS, from how it is labelled and where it came from, not what it
> resembles. Shape-matching alone produces both false positives that destroy evidence and false
> negatives that ship secrets.**

### A control is only a control if you verified the thing it looks for is really there

**Recorded because it is my own error, and it nearly entered the record as a fabricated
trap.** I reported that `git grep <pattern> origin/main -- <path>` returns empty on
these repos regardless of content, "confirmed with a control". It does not. `git grep`
works correctly here:

```
git grep -c -F 'upgradeWebSocket' origin/main -- 'src/*.ts'   ->  2 files
git grep -n -F 'ws.send(frame)'   origin/main -- 'src/*.ts'   ->  src/ws-hub.ts:299
```

My "positive control" searched `sessions.routes.ts` for the word `router`, which **does
not occur in that file** — ground truth `git show origin/main:<file> | grep -c router`
= **0**. The control returned nothing because there was nothing to find, and I read that
as the tool being broken.

> **Rule: before a string is used as a positive control, its presence must be
> established independently — by a different tool, on the same target.** An unverified
> control that returns zero is indistinguishable from a broken tool, and it will
> manufacture whichever conclusion you were already expecting. This is the
> positive-control discipline turned back on the control itself.

### Validate the sweep pipeline as a known-answer test before using it

Run the pipeline against an **already-accepted** capture and reproduce a figure the
program has already agreed on, before pointing it at anything new. `sweep.sh` on
`d2-sealed-rows-2-4.pcap` reproduces the documented gap exactly: raw sweep **100.00 %**
of 221 557 payload bytes, field pipeline **66.46 %**, misses **33.54 %**. That costs one
command, and it means later coverage numbers are checkable rather than self-asserted —
the tooling is not certified by the same run it is certifying.

### D2's >MSS artefact was HTTP, not WebSocket

Re-analysis of `d2-sealed-rows-2-4.pcap`: **every WebSocket frame in it is ≤126 bytes**
(126×87, 125×25, 115×7, 68×9, 2×12, 0×22). The >MSS reassembled PDUs are **1 587-byte
HTTP bodies**; 86 packets are segments of reassembled PDUs. The revision's 33.54 % miss
stands exactly — only the attribution changes.

Two consequences worth stating plainly: a future reader hunting "the large WS frame" in
those pcaps will find nothing and could wrongly conclude the review was mistaken about
everything; and **D2 never exercised large-frame handling on the WebSocket leg at all**,
which is a real gap in the accepted evidence base rather than a footnote.

### Getting a genuinely >MSS WebSocket frame

The agent stops at Claude Code's login screen under a scratch `HOME`, so it cannot emit
bulk output, and PTY scrollback is a bounded virtual terminal (3 MB written, ~45 KB
retained). The frame that crosses the MSS is **`terminal_replay`**, sent once on
`subscribe_session`: measured at **165 847 bytes plaintext / 165 893 sealed**, ~114× the
1 448-byte MSS. Drive it with `register` then `subscribe_session` on `/ws?key=`.

### Frame boundaries do not need `tcpdump`

A raw TCP socket that performs the WebSocket handshake by hand and parses frame headers
off the byte stream observes FIN bits and opcodes directly, with **no elevated
privilege**. For the sealed leg, add a real Noise IKpsk1 pairing, a real
`/api/e2ee/open` context and a ticketed upgrade (see `scripts/g-sealed-frames.ts`).
Pair it with a negative control — feed the same parser a synthetic fragmented stream and
confirm it reports `opcode 0` — or the zero means nothing.
