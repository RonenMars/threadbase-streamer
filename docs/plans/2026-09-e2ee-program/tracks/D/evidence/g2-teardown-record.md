# G-2 session — teardown record (2026-09-04)

A **comparison** against the start-of-session record, never a claim. Rigs were torn down
**deliberately** on the owner's instruction — an idle scratch rig held for days is a
liability, and `PLAN-D` §§3–4 rebuilds it in about ten minutes. Nothing was lost.

```
=== G-2 TEARDOWN RECORD — 2026-09-04 07:52:20 IDT ===
A COMPARISON against scratchpad/start-of-session-2026-09-02-G.txt (session aad06b80)
and against g2-pre-install-state.txt (this session, 02:52, pre-install).

--- ports ---
:8790 free
:8791 free
:8081 free
:8792 free
:8766 LISTENING  node pid 26639

--- disk, against the recorded before-state ---
~/.gradle                          before 6.6G     after 6.6G
~/.android                         before 6.7M     after 6.7M
~/Library/Android                  before 8.0K     after 8.0K
brew cmdline-tools                 before 210M     after 210M
scratch SDK/NDK root               DELETED (was 5.4G)
g2-android worktree                REMOVED (was 4.5G)

--- ~/.gradle delta, measured not estimated ---
1369 files / 75.6 MB added or modified (find -newer against a 02:52 reference,
with a positive control proving the method returns results). Only 4 of those are in
caches/modules-2, so the user's existing caches covered nearly all dependencies.
NOT DELETED, per instruction. du -sh shows 6.6G before and after because 75.6 MB
is below its rounding.

--- residual state, stated rather than left to be discovered ---
* Homebrew android-commandlinetools + platform-tools (210M) KEPT.
  Remove with: brew uninstall --cask android-commandlinetools
* Xiaomi eb57e2b6 has the app at versionCode 63 (was 56). Deliberate: it is the deliverable.
* Both phones retain stale rig server entries -> runbook Step 0.
* /dev/bpf* permissions UNCHANGED (root:wheel) - the grant never landed, so nothing to revert.
* g-sealed-frames.ts patched to read TB_KEY from env; original at .bak-g2.
* Scratch rig API key was exposed in this session's transcript (npx argv echo).
  The rig is now destroyed, so the key is dead. Reported as a stop-work trigger.

--- production streamer :8766 ---
PID at start-of-session record : 13943
PID observed this session 02:45: 23967
PID at teardown                : 26639
It restarted at least twice tonight under launchd. PID CONTINUITY IS NOT CLAIMED.
What IS known: this session never connected to it, signalled it, or changed its config.
The relay carried a hard guard refusing port 8766, proven by running it (exit 2, nothing created).

--- simulators / emulators ---
None booted by this session; none running now (no emulator image was ever downloaded).
```

## The one judgement call, argued

**Homebrew `android-commandlinetools` + `platform-tools` (210 MB) were KEPT.** The case
for removing them is that `~/Library/Android` held 8.0 K before this work and the user
asked for cleanup. The case for keeping them, which I took: the next session's entire job
is the Android capture, and `adb` is how it reaches the device at all — deleting 210 MB to
re-download it in twenty minutes is churn rather than cleanup; the user's condition names
*build files*, which is the 5.4 GB SDK/NDK and the 4.5 GB of build outputs, both gone; and
keeping them is the **reversible** choice, since removal is one documented command whereas
deletion costs a re-download. The command is in the record above so the user keeps the
choice.

**The `g2-android` worktree WAS removed** (4.5 GB, of which ~1.5 GB was native build output
inside `node_modules/*/android/build` and `.cxx`). The deliverable is the APK on the
device, not the tree that produced it. Recreating a Metro source at `c64fab5e` costs one
`git worktree add` plus `npm ci` — about three minutes.
