# PLAN-G2 — Android row 1 + chosen-plaintext canary, and C1's revocation-storm log

Session G (2026-09-04, Opus 5 / high). Gates the **stage-2 default flip**.
Written before any install so a usage-limit resume continues instead of re-deriving.

## 0. State verified at arrival (checked, not trusted from the dispatch)

| Thing | Claim in dispatch | What I observed |
|---|---|---|
| sealed rig :8790 | pid 20554 | **alive**, uptime 1d 06:38, scratch HOME under session `aad06b80…` |
| legacy control :8791 | pid 20555 | **alive**, same uptime |
| Metro :8081 | pid 10586, serving `g-device-run` | **alive**, 16 h, worktree at `26815a16` |
| production streamer :8766 | pid changed by launchd | **pid 23967** — start-of-session record says **13943**. PID continuity cannot be claimed; recorded as a launchd restart, never as untouched-by-us. |
| Android device | `eb57e2b6` authorised | **confirmed** — Xiaomi `2109119DG`, Android **14**, API **34**, `arm64-v8a` |
| `/dev/bpf0` | grant not landed | **still `crw------- root:wheel`**, node re-created 2026-09-04 02:44 |
| en0 / en9 | both on 192.168.68.0/24 | **confirmed** — 192.168.68.125 / 192.168.68.102 |
| mobile `origin/main` | `c64fab5e` | **confirmed**; `443771a8` is an ancestor |

## 1. The build question — answered by measurement, not assumption

The dispatch authorised ~5–5.5 GB of NDK on the premise that the native modules compile
from source. **I tried to avoid the download and failed for stated reasons**, so the cost
is now confirmed rather than accepted on trust:

1. **An app is already installed on the Xiaomi** — `com.ronenmars.threadbase`, `DEBUGGABLE`,
   versionCode **56**, installed 2026-08-19 21:28. It matches the local
   `tb-mobile/android/app/build/outputs/apk/debug/app-debug.apk` (built 2026-08-19 21:27),
   which carries **no `index.android.bundle`** — a dev client that loads JS from Metro.
   So the JS fix could in principle be delivered without any native build.
2. **But the native shell is too old to trust.** `android/` itself changed only by
   versionCode bumps since 2026-08-19, yet `package.json` did not: RN → **0.86.3**,
   expo → **57.0.18**, **react-native-gesture-handler 2.32.0 → 3.2.1** (a major native
   bump), pager-view, keyboard-controller, NativeWind v5, and `feat(ui): adopt native
   liquid glass (#924)`. Current JS against an August native shell is a mismatch that can
   fail *quietly*, which is the exact shape this row must not have.
3. **No reusable CI artefact exists.** Only `.github/workflows/e2e.yml` builds Android, and
   it runs `:app:assembleRelease -PreactNativeArchitectures=x86_64` — **emulator arch, not
   the device's `arm64-v8a`** — and never uploads the APK (it caches it in-job). Its last
   runs were 2026-08-31, failed/cancelled.
4. **No prebuilt `.so` anywhere.** Checked all six modules declaring `externalNativeBuild`
   (`expo-modules-core`, `expo-updates`, `react-native-gesture-handler`,
   `react-native-screens`, `react-native-pager-view`, `@sentry/react-native`): **0 `.so`
   files** in each. (Dispatch said five; it is six.)

**Conclusion: a local arm64 build with the NDK is unavoidable.** Confirmed independently.

Versions are **whatever the build resolves** — Expo's version catalog overrides the plugin
defaults (`ExpoRootProjectPlugin.kt`: ndk `27.1.12297006`, buildTools `35.0.0`,
compile/target 35), and the installed APK already reports `targetSdk=36`, so the catalog is
in play. I install cmdline-tools, let Gradle name what it wants, install exactly that, and
nothing more. No emulator images — real hardware is present.

### Disk accounting (teardown is a comparison, never a claim)
Pre-install, recorded now: `~/Library/Android` **8.0K** (a `.DS_Store` only, no `sdk/`),
`~/.gradle` **6.6G**, `~/.android` **6.7M**, Homebrew cmdline-tools at
`/opt/homebrew/share/android-commandlinetools` (removable with `brew uninstall --cask`).
Free space 364 Gi.
SDK components install to a **scratch SDK root** with `sdkmanager --sdk_root=` and
`sdk.dir` in the worktree's `local.properties`, so teardown is one `rm -rf` rather than
picking components out of `/opt/homebrew`. `~/.gradle` is **shared and NOT deleted** — the
before-number above is recorded so the report states the delta my build added.
**If the resolved download is materially larger than ~5.5 GB, stop and return to the owner.**

## 2. Artefact verification — already passing on the JS half

The row dies silently if the app cannot unseal a sealed frame, so `443771a8` must be in the
artefact, not merely an ancestor of the branch. The iOS equivalent was done by grepping the
bundle Metro serves. Done for **Android** (`platform=android`, 28 375 345 B, HTTP 200, from
`/.expo/.virtual-metro-entry.bundle` — `/index.bundle` 404s because `main` is
`expo-router/entry`):

| String | Expect | Found |
|---|---|---|
| `sealed socket received a non-binary frame` (in both versions — **positive control**) | present | **1** |
| `recv.unseal(` (**positive control**) | present | **1** |
| `event.data instanceof ArrayBuffer` (**added** by 443771a8) | present | **1** |
| `recv.unseal(frame)` (**added**) | present | **1** |
| `recv.unseal(event.data)` (**removed**) | absent | **0** |
| `!(event.data instanceof Uint8Array)` (**removed**) | absent | **0** |

Added lines present, removed lines absent, and two controls proving the grep can match in
this bundle at all. **To be re-run against the bundle actually served during the row.**

## 3. C1's revocation-storm log — the assumed source is empty

`scratchpad/logs/metro-8081.log` is **735 bytes**: the Metro startup banner and nothing
else. No bundle requests, no client console output, no `platform=android` line, unchanged
for 16 h. Grepping it for retry cadence would have returned nothing and read as "the storm
did not reproduce" — a false negative of the same shape as every other trap in §14.

**Replacement source: `adb logcat`**, verified working (`logcat -d -t 200` → **202 lines**,
a non-zero positive control). It needs no taps and timestamps every line at OS level, which
is strictly better than Metro for cadence. `ReactNativeJS` count is currently 0 only because
the app is not running.

### The ordering constraint nobody has stated yet
**C1's merged fix (`c64fab5e`) is what stops the storm.** Capturing the storm therefore
requires a *pre-fix* JS bundle. One dev-client build serves both, because a dev client can
be pointed at any Metro:

- **Phase A — C1.** Dev client → Metro serving **`26815a16`** (already running on :8081).
  Revoke the paired device server-side with the app open on a session. Capture `adb logcat`
  + the rig's HTTP log. Report the interval and the layer that re-issues.
- **Phase B — G-2.** Dev client → Metro serving **`c64fab5e`** (new worktree, port 8082).
  Row 1 + canary, under capture.

Free bonus, offered not assumed: A-then-B is a **negative control on C1's own fix** on real
hardware — storm present pre-fix, absent post-fix, one variable.

## 4. G-2 capture method

Per §14, both pipelines, neither alone sufficient:
- **primary** raw full-payload sweep (`tcp.len>0 && tcp.port==8790` → `all-payload.bin`);
- **plus** the field pipeline, because client→server WS frames are XOR-masked.
- Interface **accepted only after a positive control proves bytes flow on it**; the write-up
  carries that interface's own total `tcp.len` beside the coverage figure.
- Pipeline validated first as a **known-answer test** against `d2-sealed-rows-2-4.pcap`
  (must reproduce raw 100.00 % / field 66.46 % / miss 33.54 %).
- Markers **derived from the run's artefacts** — generator manifest, server-minted session
  id, project name, literal slices of output as the server recorded it. None hand-written.
- **Canary**: chosen by the user seconds before sending, **≥14 characters**. Prove the server
  received it, then show absent from the full sweep **and** the raw pcap.
- **Android is on plain LAN http, never the tunnel** (#727 closed by `13e21e22`). Over the
  tunnel the canary would be absent because of TLS, not E2EE — a false pass on the row that
  gates the flip.
- Caveat to state in the write-up: a **debug** build may permit cleartext via the debug
  network-security config, so this row does **not** re-verify #727's production fix.

### In the clear by design — expect, list, never report as findings
Request paths and query strings (D-7), `X-TB-Env` / `X-TB-Ctx` headers, the
`{"e2ee":{"v":1,"noise":"…"}}` handshake bodies, the plaintext `429` refusal body from
`/api/e2ee/open`.

### Capture is BLOCKED and has a no-privilege fallback
`/dev/bpf0` is still root-only. **No capture is attempted until the owner confirms the
grant**, and the permission is then proved before any capture that is supposed to return
nothing:
```
/usr/sbin/tcpdump -i en0 -c 5 -w /tmp/g-permission-control.pcap && \
  tshark -r /tmp/g-permission-control.pcap | wc -l    # MUST be non-zero
```
**Fallback if the grant cannot land (needs no root):** a logging TCP relay bound to
192.168.68.125:8792 forwarding to the rig, with the pair URL's host:port rewritten (`spk` is
the server's static key and is host-independent). The device→relay leg is genuinely over
Wi-Fi, and the relay records 100 % of the payload in both directions with no dissection gap.
It would carry its own positive control on the legacy rig and be reported as a different
method with different limits — a relay hop, not the LAN segment.

## 5. What I need from the user (via the owner)
1. **The BPF grant**, close to capture time, then the control above. *(blocking for G-2's capture)*
2. **Go for the NDK download.** *(blocking for the build)*
3. **The canary string**, at capture time, ≥14 chars. *(blocking for the canary row)*
4. **Phone taps** on the Xiaomi: confirm no stale `192.168.68.x` / `trycloudflare.com`
   server entries, scan the pair QR, confirm the identity code, open the session.

## 6. Teardown (comparison against `scratchpad/start-of-session-2026-09-02-G.txt`)
Kill rigs :8790/:8791, both Metros, any generator; **delete the scratch SDK root**; report
the `~/.gradle` delta without deleting it; `brew uninstall --cask` the cmdline-tools only if
the user wants them gone; remove the Xiaomi's rig server entries and the built app if asked;
`git worktree remove` the scratch worktrees; note `/dev/bpf*` stays widened until reboot;
record that :8766 changed PID by launchd, not by us. Scrub pair tokens, device tokens,
API keys, `spk`/tickets and any real hostname before anything leaves the scratchpad.
