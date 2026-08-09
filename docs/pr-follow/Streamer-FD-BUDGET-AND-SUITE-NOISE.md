# Streamer — two follow-ups from the JSONL fd investigation

Spun out of **PR #467** (`fix(watcher): report ENOSPC watch-handle exhaustion instead of dropping it`, merged to `main` at `23ffacd` on 2026-08-09).
Neither of these was in scope for that PR. Both are things the investigation surfaced that outlive it.

Working notes — not committed, not PR'd. Re-verify before acting; the measurements are a snapshot of one machine on one day.

---

## 1. Node does not raise its own fd soft limit

### What was measured

| Observation | Value |
|---|---|
| Node v24.15.0 under a forced `ulimit -n 256` | **EMFILE at 249 open fds** |
| Live prod streamer (pid 42549) steady-state | 2415 fds (~88% `.jsonl` watch handles) |
| `launchctl limit maxfiles` — the default handed to *new* launchd jobs | **256 soft** / unlimited hard |
| Effective ceiling in the live process's domain | 122 880 (`kern.maxfilesperproc`) |
| Conversation corpus driving the demand | 2133 files, ~41/day average, 253 on a peak day |

The load-bearing fact: **Node does not raise `RLIMIT_NOFILE` for itself.** It was a reasonable assumption that it did — it does not. The live process is comfortable purely because its launchd domain happened to pass down the unlimited-soft inheritance, not because anything in our stack asked for headroom.

### Why it matters

Neither service definition sets a limit today — verified, not assumed:

- `scripts/deploy.sh` — the plist generator emits `Label`, `ProgramArguments`, `EnvironmentVariables`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval`, `StandardOutPath`, `StandardErrorPath`. **No `SoftResourceLimits` / `NumberOfFiles`.**
- `scripts/deploy-linux.sh:263` — the `[Service]` block has `ExecStart`, `Restart`, `StandardOutput`, `StandardError`. **No `LimitNOFILE`.**

So on any machine where the supervisor actually applies the 256 default, the streamer hits EMFILE at ~249 descriptors — roughly **8× below its current steady-state demand**, and it would be broken from the first boot with a populated `~/.claude`.

The failure mode is the nasty part. It does not present as "the watcher is broken". It presents as unrelated `fs` calls failing all over the server — a PTY spawn, a cache write, a migration — with nothing pointing at conversation count. Exactly the shape that costs a day to diagnose.

### Recommendations, ranked

**R1 — Set the limit explicitly in both service definitions.** *(do this one)*
launchd: add a `SoftResourceLimits` dict with `NumberOfFiles` to the plist generator in `scripts/deploy.sh`.
systemd: add `LimitNOFILE=` to the `[Service]` block in `scripts/deploy-linux.sh`.
Deterministic, needs no runtime detection, and it is the only recommendation here that actually removes the risk rather than reporting on it.

**Suggested value: 16384.** Justified rather than picked — about 7× today's 2415, which covers several years of corpus growth at the observed rate, while staying trivially under the 122 880 per-process ceiling. Do not use "unlimited"; a real number is what makes a runaway visible as a failure instead of as swap pressure.

**R2 — Linux needs a second, separate knob.** *(do this one)*
`LimitNOFILE` does **not** cover inotify. The watch handles are billed to the per-user `fs.inotify.max_user_watches`, which can be as low as 8192 and is shared with every other watcher the user is running (editors, language servers, other agents). At 2133 the corpus already sits at ~26% of that. Document the `sysctl` in the Linux deploy guide alongside R1 — raising the fd limit alone will look like a fix and will not be one.

**R3 — The backstop already shipped.** *(done, #467)*
ENOSPC on a watcher now logs as `watcher.limit_exhausted` naming the remedy, and other watcher errors as `watcher.error`. Previously `onError` was declared, forwarded to by the watcher, and never wired by `server.ts` — so all of it was discarded. This turns a silent degradation into a log line, but it is a backstop, not a fix: R1 and R2 are what prevent the state.

**R4 — Do *not* build a boot-time "check my own rlimit and warn" check.** *(recommend against)*
It cannot be made truthful cross-platform for a price worth paying:
- `process.report.getReport().header` carries no `rlimit` on darwin (verified — the key is absent).
- Shelling out to `ulimit -n` reports the *shell's* limit, not the running process's. It would have printed "unlimited" here and been wrong in general.
- Reading the real value needs native code, or `/proc/self/limits` — which is Linux-only.

A check that is right on Linux and blind on macOS is worse than no check, because it reads as coverage. R1 needs no detection at all, which is why it outranks this.

### Where this should land

`docs/troubleshooting.md` (symptom → cause → fix, per the repo convention) once R1/R2 are implemented, plus a line in the deploy-internals guide. Ship the doc with the code change, not before it.

---

## 2. The local full suite is noise — CI is the authority

### What happened

The full local suite reported **34 failures across 9 files**. CI on the same commit passed **all three Node versions (20, 22, 24) clean**, along with Lint, Build and both Smoke jobs — 11/11 green.

Every single local failure was a **timeout**, not an assertion:

```
Error: Test timed out in 15000ms.
Error: Hook timed out in 30000ms.
```

Three of the nine files were **not** on the documented known-flaky list: `codex-api`, `codex-resume`, `server-bind-retry`. The documented six (`pair-endpoints`, `security-hardening`, `watch-for-jsonl`, `webhook-update`, `cors-middleware`, `discovery-cache`) all appeared too.

### Recommendations

**R5 — Stop maintaining the flaky *list*; document the *signature* instead.**
The list was already incomplete by three files, and it will drift again every time the box gets busier or a suite gets slower. The durable fact is the shape: on this hardware, load-induced failures are **timeouts**, never assertion failures.

**R6 — Triage by failure kind before spending anything.** *(the actual rule worth adopting)*

```sh
grep -c "timed out"    <output>   # load
grep -c "AssertionError\|toBe\|toEqual" <output>   # possibly real
```

All-timeouts ⇒ load, not the change. Push and let CI decide.
Any assertion failure ⇒ the base-commit comparison rule applies in full.

This is a ~5-second check that replaced a ~10-minute base-suite run in this session, and it would have reached the same conclusion.

**R7 — Locally, run focused suites only.** The five watcher suites finished in seconds and were green throughout, including `watch-for-jsonl` — which failed under full-suite load in the same session. Focused runs on this box are trustworthy; the full run is not. Reserve full `npm test` for when CI is unavailable.

**R8 — This scopes the "verify against base before blaming your change" rule; it does not repeal it.** The rule remains correct and it is what prevented a false attribution here. What changed is the *cheapest honest way to satisfy it*: for an all-timeout failure set, CI on a pushed branch is a better oracle than a local base run, because it is a clean box running all three Node versions.

**R9 — A base comparison can be invalidated mid-flight.** The `f9df468` base run started in this session became moot the moment the PR was retargeted from the integration branch to `main` — it would have been comparing the wrong tree. Another reason to prefer CI, which always compares against the base you are actually merging into.

### Where this should land

The `Testing` section of `tb-streamer/CLAUDE.md`, replacing the enumerated flaky-file list with the signature rule (R5/R6). Worth a matching update to the `verify-against-base-before-blaming-your-change` memory so the triage step comes first.

---

## Suggested order

1. **R6/R5** — free, pure process, saves time on the very next suite run.
2. **R1 + R2** — one small change to each deploy script plus a troubleshooting entry. Docs-only portion gets `[skip-ci]`; the script change does not.
3. **R4** — explicitly decide *not* to do it, so it is not proposed again.
