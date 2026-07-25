# Recent

```

# Recent

## 2026-07-24

Session-name visibility + warmup-lock thrash across tb-scanner/tb-streamer/tb-mobile. Scanner 0.12.0 derives names from first user msg; streamer emits `session_name` in detail meta + maps to cache `title`; mobile wires sessionName through adapters. Fixed streamer warmup-gate thrash (concurrent reconciles 503ing readers) by backgrounding auto-reconcile, un-gating `refreshCountInBackground`. Opened 4 PRs (#53 merged+released v0.12.0, #267/#270/#376 open); verified end-to-end in prod (list/detail now show session names). Deployed 1.33.0+4889912 stable under load. Identified 3 mobile perf bugs (freezeOnBlur missing, blank-terminal WS replay fallback, VT scrollback unbounded); committed 3 fixes (#385/#386/#387). Updated grace-timer feature (4.5m inactivity default via `--pty-grace-period-ms`). Verified tb-streamer worktree sync (local ↔ origin c8a37d7, 0/0 divergence); scanned all 15 streamer + 24 mobile worktrees for post-05:00 drift (none found).