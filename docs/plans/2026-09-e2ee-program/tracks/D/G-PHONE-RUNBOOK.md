# G — the single phone trip: exact commands, exact taps

Written ahead so the trip happens **once**. Nothing here has been run. Every step is
gated on the owner's go; steps B and E change the user's device.

**Rig facts as they stand right now** (verify before use — the rig may have been torn
down by the time this is read):

| | |
|---|---|
| sealed rig | `http://192.168.68.125:8790` — `--feature e2ee=true` |
| legacy control rig | `http://192.168.68.125:8791` — `--feature e2ee=false` |
| capture interface | **en0** (192.168.68.125) — the address the rig advertises |
| iOS device | **iPhone 17 Pro**, UDID `00008150-00115DEA1A40401C` — the only device `xctrace` reports |
| mobile worktree | `~/dev/ai-tools/tb-mobile-worktrees/g-device-run` @ `26815a16`, `npm ci` and `pod install` both done |

The 17 Pro is the only device `xcrun xctrace list devices` reports, so it is the only
one `dev-device.sh` can target. The 13 Pro shows as "connected" to `devicectl` but is
not available for development.

---

## Step 0 — CONFIRM the stale entries are gone (one line, before anything else)

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

## Step E — Android  (second visit, after the build exists)

Route is a **local SDK install** (decided; explicitly **not** EAS). Command-line tools
and `platform-tools` are already installed — 210 MB, removable with
`brew uninstall --cask android-commandlinetools`. The **NDK is still an open question
with the owner**, because five modules compile C++ from source and none ship prebuilt
`.so` files.

**`adb devices` currently returns an empty list — the device is not connected.**
Before anything else, the user does this once:

1. Plug the Android device into the Mac by **USB**.
2. On the phone: Settings → About phone → tap **Build number** seven times to unlock
   Developer options.
3. Settings → System → Developer options → enable **USB debugging**.
4. A dialog appears on the phone: **Allow USB debugging** → tap **Allow**
   (tick "Always allow from this computer").

Then, on the Mac, this identifies it and the model goes in the addendum:

```
/opt/homebrew/share/android-commandlinetools/platform-tools/adb devices -l
```

**Do not capture a single Android packet until the artefact on the device is verified
to contain `443771a8`.** A build that cannot unseal a WS frame produces exactly the
empty-looking pass that §14 trap 1 warns about, and it would be the third trap of that
shape in one day.

When it does run: row 1 plus the **chosen-plaintext canary**. The canary is a string
the **user** chooses seconds before sending, **at least 14 characters** (two-character
tokens produced coincidental hits inside base64 and ciphertext in D2). Prove the server
received it, then show it absent from the full sweep **and** the raw pcap.

Android runs over **plain LAN http**, not the tunnel — mobile #727 is closed, fixed by
`13e21e22`. Running it over the tunnel would make the canary absent because of TLS
rather than because of E2EE, which is a false pass on the row that gates the flip.

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
