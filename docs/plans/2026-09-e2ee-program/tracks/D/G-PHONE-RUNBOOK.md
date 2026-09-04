# G — the single phone trip: exact commands, exact taps

Written ahead so the trip happens **once**. Nothing here has been run. Every step is
gated on the owner's go; steps B and E change the user's device.

**STATUS 2026-09-04: the rigs below are TORN DOWN.** They were shut down deliberately at the
owner's instruction, not lost — an idle scratch rig held for days is a liability, and PLAN-D
§§3–4 rebuilds it in about ten minutes. The addresses are kept because the rebuild will reuse
them. Verify everything before use.

| | |
|---|---|
| sealed rig | `http://192.168.68.125:8790` — `--feature e2ee=true` |
| legacy control rig | `http://192.168.68.125:8791` — `--feature e2ee=false` |
| capture interface | **DERIVE IT — do not copy a value from here.** See "Choosing the capture interface" below. |
| iOS device | **iPhone 17 Pro**, UDID `00008150-00115DEA1A40401C` — the only device `xctrace` reports |
| mobile worktree (iOS) | `~/dev/ai-tools/tb-mobile-worktrees/g-device-run` @ `26815a16`, `npm ci` and `pod install` both done |
| mobile worktree (Android) | `~/dev/ai-tools/tb-mobile-worktrees/g2-android` @ **`c64fab5e`**, own `npm ci` done |
| **Android device** | **Xiaomi 2109119DG**, Android 14 / API 34, `arm64-v8a`, adb id `eb57e2b6` |
| **Android app** | **INSTALLED**: versionCode **63**, debug dev client, built from `c64fab5e`, arm64-v8a. Needs Metro to run. |

The 17 Pro is the only device `xcrun xctrace list devices` reports, so it is the only
one `dev-device.sh` can target. The 13 Pro shows as "connected" to `devicectl` but is
not available for development.

---

## Choosing the capture interface — DERIVE IT, never copy it

**This section replaces the `en0` that used to sit in the table above as a fact.** It was
correct on 2026-09-04 and it was correct *by luck*, which is the problem.

`src/lan-url.ts::resolveServerUrl` on `origin/main` returns `publicUrl` when set and otherwise
`firstLanIPv4()` — **the first non-internal IPv4 that `os.networkInterfaces()` happens to
enumerate**. Nothing pins the winner, and on this machine the candidate list is four entries,
not two:

```
en0     192.168.68.125     <- today's winner
en9     192.168.68.102
en12    169.254.185.52     (link-local)
utun16  100.122.246.79     (Tailscale)
```

**The `utun` candidate is the worst case and is not merely "a different address".** If a
Tailscale interface wins the enumeration, the rig advertises a VPN address, the device's
traffic leaves over the VPN, and **the LAN-only scope that every ciphertext claim in this
program depends on no longer holds**. That is a *scope violation*, not a missed capture: the
row would be measuring a tunnel it never declared, and a clean-looking sweep of `en0` would
certify nothing at all. If the advertised address is not on the LAN subnet, **stop** — do not
capture, and do not reason about which interface "should" have won.

**Do this, in order, every time:**

1. Print the pair URL / read the rig's advertised address from the rig itself.
2. Confirm that address is on the expected LAN subnet. If it is a `100.x` (Tailscale),
   `169.254.x` (link-local) or anything else unexpected — stop and fix the rig, do not capture.
3. Resolve that address to an interface: `ifconfig | grep -B4 <address>`.
4. **Prove that interface carries traffic before trusting any capture that is supposed to
   return nothing** (Step A1's control, run on *that* interface).
5. Record the interface's own total `tcp.len` byte count beside the coverage figure, so a later
   reader can see the capture was non-empty for a stated reason rather than by assumption.

---

## Step 0 (NEW, 2026-09-04) — DELETE THE STALE RIG ENTRIES FIRST. Nothing else works until you do.

**This is now certain rather than precautionary.** Session G tore the rigs down on the owner's
instruction, so `192.168.68.125:8790` and `:8791` no longer exist — but the phones still hold
server entries pointing at them. The Android device is additionally confirmed to hold at least
one stored server (`srv_7xgq3m`), observed auto-connecting when the app was launched.

**Symptom if you skip this**, quoted from the app so it is recognisable on sight:

> "This address is already in your list. Delete that server first if you want to re-add it."
> (`pair.scanner.errors.alreadyAdded`)

The pairing fails at the **first tap**, before anything under test has run. Worse than the
delay: a stale entry can reconnect mid-capture and put traffic on the wire that nobody
accounted for, which contaminates a row you will then have to discard.

**Do this on BOTH devices before scanning anything:** open Threadbase → the server list →
delete every `192.168.68.x` entry and every `trycloudflare.com` entry. Then say what you see
before tapping anything else.

Note the ordering hazard: the rebuilt rig will very likely land on the **same** host:port, so
the entry looks superficially valid and the app will still refuse it.

---

## Step 0b — the original check (kept, now subordinate to step 0)


The user is clearing them themselves, so this is a check, not a task.

**Look:** open Threadbase → the server list. **Confirm there is no entry for
`192.168.68.x` and none for a `trycloudflare.com` hostname.** Say what you see before
tapping anything else.

Why it is worth a line of the user's time: the app refuses a repeat pairing outright —
*"This address is already in your list. Delete that server first if you want to re-add
it."* (`pair.scanner.errors.alreadyAdded`). A leftover entry fails the pairing at the
first tap, and worse, a stale entry can reconnect mid-capture and put traffic on the
wire that nobody accounted for.

---

## Step A — grant packet capture (the user runs this; approved)

```
sudo chgrp admin /dev/bpf* && sudo chmod g+rw /dev/bpf*
```

Reverts on reboot; while it stands any process running as the user can capture packets.
Scope is recorded in the teardown record rather than left undocumented.

### RUN THIS IMMEDIATELY BEFORE THE CAPTURE — it does not survive node recreation

**This grant has now failed to land twice, and the reason is mechanical rather than
forgetfulness.** `/dev/bpf*` nodes are created **on demand**. The glob only touches the nodes
that exist at the moment it runs, so a grant issued an hour earlier — or last night — does not
cover a node the kernel creates when your capture starts. Observed directly: `/dev/bpf0` was
re-created at 02:44 and again at 02:52 on 2026-09-04, root-owned each time, after the user had
already run the command.

So: **the user runs step A, and step A1 runs within the same sitting, immediately before the
capture.** Do not carry a grant across a break and assume it still holds — re-prove it.

### A1 — prove the permission, do not infer it

**Before relying on any capture that is supposed to return nothing**, prove `tcpdump`
can actually open the device. "tcpdump silently could not open the device" is an empty
result that reads as a clean pass — the same hazard class as §14 trap 1 wearing a new
hat.

```
/usr/sbin/tcpdump -i en0 -c 5 -w /tmp/g-permission-control.pcap && \
  /opt/homebrew/bin/tshark -r /tmp/g-permission-control.pcap 2>/dev/null | wc -l
```

**This must print a non-zero count on a busy interface.** If it errors or prints 0, stop
— every later "no plaintext found" is worthless until it does not.

---

## Step B — build and install the iOS app  (CHANGES THE DEVICE)

Plug the **iPhone 17 Pro** in by USB and unlock it. Then:

```
cd ~/dev/ai-tools/tb-mobile-worktrees/g-device-run
DEVICE_UDID=00008150-00115DEA1A40401C npm run dev:device
```

Why a rebuild rather than the app already on the phone: both phones report Bundle
Version 1, which is what any local dev build reports, so the installed build's commit
cannot be read off the device. The worktree is at `origin/main` with the ArrayBuffer
fix (`443771a8`) **verified as an ancestor** — without it the client cannot unseal WS
frames at all and every sealed row would fail for the wrong reason.

This also starts **Metro on :8081**, which was free at session start and goes into the
teardown record.

Trust the developer certificate on the phone if iOS prompts
(Settings → General → VPN & Device Management).

---

## Step C — pair to the sealed rig and run the row

**Mac side.** Start the capture first, then print the QR (pair codes expire in 180 s,
so print immediately before scanning):

```
# 1. capture — leave running for the whole row
SCRATCH=<scratchpad>/g-rig
sudo /usr/sbin/tcpdump -i en0 -s 0 -w "$SCRATCH/g1-sealed-row.pcap" 'port 8790'

# 2. in a second terminal: fresh pair QR on the SEALED rig
HOME="$SCRATCH" THREADBASE_CONFIG_DIR="$SCRATCH/.threadbase" \
  "$SCRATCH/npm-global/bin/tb-streamer" pair --port 8790
```

**Taps, in order:**
1. Threadbase → add a server → **scan the QR** shown in the rig's terminal.
2. The confirmation gate appears with a fingerprint and machine name. **Check the
   identity code on screen matches the one the rig printed**, then tap **Add server**.
   If it does not match, tap Cancel — that is the gate doing its job.
3. Open the server → open the running session → let the terminal stream.
4. Leave it streaming ~30 s.

---

## Step D — C1's revocation storm and the client log

Reproduction: **revoke the paired device server-side while the app is open.**

**The client log is Metro's output, not the app's Diagnostics screen.** The app's
Diagnostics feature explicitly excludes prompts, terminal output and server addresses
(`feedback.diagnostics.excluded`), so it carries no request cadence. This is a **dev
build**, so the app's own `console` output streams to Metro — that *is* the device's
client log, and it needs no taps. The rig's HTTP log supplies the server-side cadence
with timestamps.

```
# 1. find the paired device id
HOME="$SCRATCH" THREADBASE_CONFIG_DIR="$SCRATCH/.threadbase" \
  "$SCRATCH/npm-global/bin/tb-streamer" devices list --port 8790

# 2. with the app OPEN and on the session, revoke it
HOME="$SCRATCH" THREADBASE_CONFIG_DIR="$SCRATCH/.threadbase" \
  "$SCRATCH/npm-global/bin/tb-streamer" devices revoke <deviceId> --port 8790

# 3. server-side cadence, with timestamps
grep -E '"path":"/api/e2ee/open"|429' "$SCRATCH/logs/rig-8790.log" | tail -40
```

**Taps:** keep the app open and on the session throughout; do not background it. Report
the observed interval between retries and which layer emits them.

If the storm does not reproduce, say so plainly — C1 ships item 1 alone.

---

## Step E — Android  (BUILD AND INSTALL ARE DONE — 2026-09-04)

**Everything that did not need a human is finished.** Do not rebuild and do not re-download the
SDK unless something below fails.

Done and verified this session:
- Xiaomi **2109119DG**, Android **14**, API **34**, `arm64-v8a`, adb id `eb57e2b6`, USB debugging
  authorised.
- App **installed**: `com.ronenmars.threadbase` **versionCode 63**, `DEBUGGABLE`,
  `primaryCpuAbi=arm64-v8a`, built from `c64fab5e` with `-PreactNativeArchitectures=arm64-v8a`.
  Installed with `adb install -r`, so existing app data was preserved.
- **It runs**: launched via the dev-client deep link and confirmed from the device's own log —
  `Running "main" … fabric:true`, `[boot] app module loaded`, 0 fatals.
- `443771a8` **verified present** in the Android bundle Metro serves, with two positive controls.
  Re-verify at capture time — commands in `PLAN-G2.md` §7.
- Device reaches the rig over plain LAN http: `:8790` → 200, `:8791` → 200, dead-port control
  `:8799` → 000.

**The SDK and NDK were installed under a scratch `sdk_root` and DELETED at teardown.** A rebuild
therefore costs the ~5.3 GB download again — so avoid rebuilding unless the installed app is
genuinely unusable.

**What still needs a human, and cannot be worked around:**
1. **The `bpf` grant, run IMMEDIATELY before the capture** — `/dev/bpf*` nodes are re-created on
   demand, so a grant issued earlier does not cover a node created later. Then prove it with
   step A1 before trusting any capture that is supposed to return nothing.
2. **The canary** — user-chosen, seconds before sending, **≥14 characters**.
3. **The taps** — step 0 first, then scan the QR and confirm the identity code.

**Launch the app pointed at a specific Metro without touching the phone:**
```
adb shell am start -a android.intent.action.VIEW \
  -d "threadbase://expo-development-client/?url=http%3A%2F%2F192.168.68.125%3A8081"
```
The scheme is `threadbase` (read from the APK manifest; `com.ronenmars.threadbase://…` does
**not** resolve). **A debug dev client has no bundled JS — start Metro first or it cannot run.**

**Client log for cadence: `adb logcat`**, filtered on `ReactNativeJS`. OS-level timestamps, no
taps, and not contingent on a bundler being attached.

**Capture rule for every row here:** record the accepted interface's own **total
`tcp.len` byte count** next to the coverage figure, and the **opcode breakdown with an
explicit continuation-frame count**. A capture that is empty for an unstated reason is
indistinguishable from a channel that is sealed.

---

## Teardown — compare against the start-of-session record

Record: `scratchpad/start-of-session-2026-09-02-G.txt`.

- [ ] Kill both rig streamers (:8790, :8791)
- [ ] Kill Metro (:8081) if step B ran
- [ ] Kill any `fakebin/generate.py` generators
- [ ] Confirm the production streamer **PID 13943 on :8766** is still running and was
      never touched, and both pre-existing `cloudflared` tunnels are intact
- [ ] Confirm no simulator or emulator was left booted (none were booted by this session)
- [ ] Delete the phone's rig server entries
- [ ] `git worktree remove` the two scratch worktrees
      (`tb-mobile-worktrees/g-device-run`, `tb-streamer/.worktrees/spike/g-sealed-frames`)
- [ ] Scrub before anything leaves the scratchpad: rig API keys, pair tokens, device
      tokens, `spk`/tickets, and any quick-tunnel hostname
- [ ] If step A ran, note that `/dev/bpf*` permissions stay widened until reboot
