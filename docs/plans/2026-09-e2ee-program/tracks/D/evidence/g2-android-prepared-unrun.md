# G-2 — Android row 1 + canary: **PREPARED, NOT RUN**

**Status: BLOCKED ON CAPTURE, not failed.** Session G, 2026-09-04 IDT. Everything that does
not need a human is done and verified; the two things that do — root for `tcpdump`, and the
user at the phone to choose a canary and scan a QR — were unavailable and are not
substitutable. This row does **not** clear the stage-2 default flip. It leaves the next
session needing a rig and a capture rather than a 5 GB download, a build and a re-derivation.

## What is now true, stated positively

| | |
|---|---|
| Device | **Xiaomi 2109119DG** (`lisa_global`), **Android 14**, API **34**, `arm64-v8a`, security patch 2025-08-01 |
| Provenance bonus | same device family mobile **#727** was originally reported on |
| App installed | `com.ronenmars.threadbase` **versionCode 63**, `DEBUGGABLE`, `primaryCpuAbi=arm64-v8a`, installed 03:10:55 |
| Built from | mobile `origin/main` = **`c64fab5e`**, worktree `tb-mobile-worktrees/g2-android`, own `npm ci` (1436 packages) |
| Build | `:app:assembleDebug -PreactNativeArchitectures=arm64-v8a`, 110 132 956 B, `lib/arm64-v8a/` only |
| Toolchain | NDK **27.1.12297006**, cmake **3.22.1**, buildTools **36.0.0**, compileSdk/targetSdk **36**, JDK **22** |
| `443771a8` in the served bundle | **verified**, added lines present, removed lines absent, two positive controls (see below) |
| App runs current JS on this shell | **verified on the device** — `Running "main" … fabric:true`, `[boot] app module loaded`, 14 `ReactNativeJS` lines, 0 fatals |
| Device reaches the rig over plain LAN http | **`:8790` → 200**, `:8791` → 200, dead-port control `:8799` → **000** |
| Capture interface | **en0 / 192.168.68.125** — today's answer, *re-derive it at capture time* (§14 trap 7) |
| Sweep pipeline | **validated as a known-answer test**: raw **100.00 %**, field **66.46 %**, miss **33.54 %** on `d2-sealed-rows-2-4.pcap` |

## Artefact verification — the part that would otherwise fail silently

An Android build that cannot unseal a sealed frame produces a capture with nothing in it,
which is indistinguishable from encryption working. So this was done first, not last.

A debug dev-client APK carries **no `index.android.bundle`** (confirmed by `unzip -l`), so the
native shell and the JS are verified separately. Against the Android bundle Metro serves
(`/.expo/.virtual-metro-entry.bundle?platform=android`, 28 375 345 B, HTTP 200 — note
`/index.bundle` **404s**, because `package.json` `main` is `expo-router/entry`):

| String | Role | Expected | Found |
|---|---|---|---|
| `sealed socket received a non-binary frame` | **positive control** (in both versions) | present | **1** |
| `recv.unseal(` | **positive control** | present | **1** |
| `event.data instanceof ArrayBuffer` | added by `443771a8` | present | **1** |
| `recv.unseal(frame)` | added by `443771a8` | present | **1** |
| `recv.unseal(event.data)` | removed by `443771a8` | absent | **0** |
| `!(event.data instanceof Uint8Array)` | removed by `443771a8` | absent | **0** |

Both controls fire, so a zero on the "removed" rows is a result rather than a broken grep.

**This must be re-run against the bundle served during the row** — commands in `PLAN-G2.md` §7.
For a dev client this is a *strength*: a release bundle is verified once at build time, whereas
the dev client's JS is verified at the moment of use.

**Provenance, and a correction to §14 trap 6.** Trap 6 records that a local dev build reports
Bundle Version 1 regardless of commit, so the installed build cannot be identified from the
device. That is an **iOS** limitation. On Android `versionCode` **63** versus the pre-existing
**56** is readable straight off the device with `dumpsys` and does identify the build.

## Why the August APK on the device was not reused

The Xiaomi already carried a `DEBUGGABLE` versionCode-56 dev client (installed 2026-08-19)
with no bundled JS, which could in principle have taken the fix from Metro with no native
build at all. It was rejected on evidence: `android/` changed only by versionCode bumps since
19 August, but `package.json` did not — RN → 0.86.3, expo → 57.0.18,
**react-native-gesture-handler 2.32.0 → 3.2.1** (a major native bump), pager-view,
keyboard-controller, NativeWind v5, and `feat(ui): adopt native liquid glass` (#924). Current
JS on an August native shell is a mismatch that fails *quietly*, which is the one shape this
row cannot have. No CI artefact was usable either: `e2e.yml` builds
`assembleRelease -PreactNativeArchitectures=x86_64` — **emulator arch, not the device's
arm64-v8a** — and never uploads it. All **six** modules declaring `externalNativeBuild`
(`expo-modules-core`, `expo-updates`, `react-native-gesture-handler`, `react-native-screens`,
`react-native-pager-view`, `@sentry/react-native`) ship **zero** prebuilt `.so`.

The rejection is now vindicated rather than merely argued: the freshly built shell was launched
on the device and **does** run current JS.

## Why one native shell serves both Metros — evidence, not assumption

`26815a16 → c64fab5e` is nine files. `package.json` and `package-lock.json` are
**byte-identical**, so the native module set is provably the same, and the only `android/`
change is one line — the versionCode bump 62 → 63. The rest is JS and tests. This is what makes
the Phase A / Phase B two-Metro plan sound.

## What is NOT covered, said plainly

- **No packet capture was taken. There is no ciphertext claim on Android.** `/dev/bpf*` is
  `crw------- root:wheel`; the grant did not land and the node is re-created on demand.
- **No chosen-plaintext canary.** It must be user-chosen seconds before sending, ≥14 characters.
- **No pairing, no session, no terminal output.** Pairing is a QR scan plus a confirmation-gate
  tap; taps were unavailable.
- **`adb shell curl` reaching the rig is LAN routing, not the app's cleartext policy.** `curl`
  is a system binary and is not subject to the app's network-security config. This row does
  **not** re-verify mobile #727, and on a **debug** build it is further removed: a debug
  network-security config may permit cleartext for reasons unrelated to `13e21e22`.
- The app's *own* network stack reaching the rig is therefore still unproven.

## The trap this row was built to avoid, recorded so it stays avoided

`PLAN-D` §5's Android note is **stale**: it routes Android over the rig's own tunnel because a
release build supposedly cannot reach `http://`. Mobile **#727 is CLOSED**, fixed 2026-08-15
by `13e21e22`. Following §5 would have run this row over the tunnel's TLS, where the canary is
absent **because of TLS rather than because of E2EE** — a row that gates the stage-2 flip
recording a pass that proves nothing. Android runs over **plain LAN http**, never the tunnel.
