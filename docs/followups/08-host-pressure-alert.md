# Implement host-pressure WS (tb-streamer only)

Paste this whole file into a new agent session. Work only in a **sibling worktree** of `tb-streamer`. Do not touch `tb-mobile`.

Opening several live agents loads the **host** (N `claude`/`codex` PTYs + one Node event loop). The phone cannot see that. This PR is the server half: sample cheap host signals and push a coarse `host_pressure` frame when the box is starved. Inform only — do not hold, kill, or refuse sessions.

Mobile consumes this in a separate prompt (`docs/followups/mobile/08-host-pressure-alert.md` in tb-mobile). Independent of `unsubscribe_session`. Do not fold that work in.

## Setup — do this first

Worktrees live **outside** the repo root, as siblings. Nested worktrees poison test and lint tooling.

```bash
cd ~/dev/ai-tools/tb-streamer
git fetch origin
git worktree add ../tb-streamer-worktrees/feat-host-pressure \
  -b feat/host-pressure origin/main
cd ../tb-streamer-worktrees/feat-host-pressure
npm ci
```

Move the agent root to that worktree. Open one PR against `main`. Do not merge. Do not push to `main`.

## Wire contract (freeze this; do not invent a parallel shape)

Additive. Old mobile ignores unknown WS types. Do not put live readings on `/api/info` — it is polled. A capability flag is enough.

### `GET /api/info`

```ts
hostPressure: true  // this build samples and pushes host_pressure
```

### WS frames (server → every connected client)

```ts
type HostPressureLevel = 'elevated' | 'critical'
type HostPressureReason = 'memory' | 'event_loop' | 'load' | 'agents'

{
  type: 'host_pressure'
  level: HostPressureLevel
  reasons: HostPressureReason[]   // non-empty; worst-first
  liveAgents: number              // PTY-attached live sessions, not historical stubs
  updatedAt: string               // ISO 8601
}

{
  type: 'host_pressure_cleared'
  updatedAt: string
}
```

Replay `host_pressure` on every `handleWsOpen` while currently warned, next to the existing cache-alert replay (`src/server-wiring.ts` `handleWsOpen`). Stay silent on open when ok (no `host_pressure_cleared` on a fresh process that never warned).

No hostnames, usernames, PIDs, command lines, or RSS-per-process. `liveAgents` is a count. Reasons are an enum, not English.

Broadcast with `wsHub.broadcast`, not `broadcastToClients`. This is a host-wide condition.

Do **not** arm hold/grace, kill PTYs, or refuse `POST /api/sessions/start` from this sampler.

### Diagnostics (optional)

Extra `GET /api/diagnostics` check `id: "host"` with `status: "ok" | "degraded" | "failed"` (elevated→degraded, critical→failed), remediation `NONE`. Keep existing remediation codes unchanged. If this bloats the PR, skip it and keep WS + `hostPressure: true` only.

## Implementation

New module, e.g. `src/services/host-pressure/hostPressure.ts`. Do not dump sampling into `server.ts`.

**Sample every 5s** (constant, not config). Classify. Emit only on **level change** (including first enter and clear). Dispose the histogram and the interval on server `close()`.

**Inputs (all cheap, no `child_process`, no `ps`):**

| Input | Source | Notes |
|---|---|---|
| `liveAgents` | `ptyAttachedIds().size` or sessionStore live+ptyAttached | Same notion `/api/info.activeSessions` already exposes |
| `memFreeRatio` | `os.freemem() / os.totalmem()` | Fine if conservative on macOS |
| `eventLoopP99Ms` | `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` | Enable once at sampler start; `percentile(99) / 1e6` |
| `load1` | `os.loadavg()[0]` | POSIX only. Compare to `os.cpus().length`, not a raw number. |
| `cpuBusyRatio` | consecutive `os.cpus()[].times` deltas | **`process.platform === "win32"` only** (covers 32- and 64-bit Windows; Node has no `win64`). Sampler does not snapshot times on linux/darwin. `loadavg` is zeros on Windows. 0–1 busy fraction. Reason on the wire is still `load`. |

**Classifier (lock in unit tests; tune numbers only there):**

Hysteresis: entering a level uses the higher bar; leaving uses the lower bar. No flicker on a 14.9% ↔ 15.1% free-mem wiggle.

Starting bars (change only with a test update):

- `critical` if any: `memFreeRatio < 0.08`, `eventLoopP99Ms > 250`, (POSIX) `load1 / ncpu > 1.5`, (win32) `cpuBusyRatio > 0.97`
- else `elevated` if any: `memFreeRatio < 0.15`, `eventLoopP99Ms > 100`, (POSIX) `load1 / ncpu > 0.9`, (win32) `cpuBusyRatio > 0.85`, **or** `liveAgents >= 4` together with any elevated-or-worse resource signal
- else `ok`

`liveAgents >= 4` alone is **not** enough (a quiet box with four `waiting_input` sessions). Pair it with a resource signal.

`reasons` lists every firing signal, worst-first: `memory`, `event_loop`, `load`, `agents`.

Add the frames to `WSMessage` in `src/types.ts`.

## Tests

`__tests__/host-pressure.test.ts`:

- Classifier: ok / elevated / critical, hysteresis (one sample above enter bar, one between bars stays), win32 ignores loadavg and uses cpu busy instead.
- Sampler: fake clock + injected `HostSample` (pure function — do not spy live `os.freemem()` from production code). A level change calls `broadcast` with the frozen shape; a same-level sample does not.
- WS open: a warned server unicasts `host_pressure` to the new socket (extend an existing open-replay test if one exists; otherwise a focused `createApiDeps` test).
- `GET /api/info` includes `hostPressure: true`.

Update `docs/compatibility/tb-mobile.md` with one additive bullet for the two WS types + the info flag. Grep the mobile checkout (`host_pressure` in `../tb-mobile/{services,hooks,stores,components,types}`) and report the miss in the PR body — expected until the mobile PR lands.

```bash
npm run lint && npx vitest run __tests__/host-pressure.test.ts
```

Also run any WS-open test you touched.

PR title: `feat(ws): push host_pressure when the box is starved`

## Repo rules

- Conventional commits, imperative, lowercase, no trailing period.
- No AI attribution anywhere (commits, PRs, comments).
- One sentence per line in commit/PR bodies.
- Never comment on GitHub PRs/issues.
- No `any` / `unknown` without asking.
- Comments only when non-trivial.
- Worktrees stay siblings. Do not nest under the repo.
- Do not hold, SIGINT, or refuse sessions because pressure is high.
- Do not sample with `ps`/`lsof`/WMI. OS + `perf_hooks` + the session registry only.
- Standing approval to commit and push **this feature branch** and open a PR. No merge, no force-push to `main`.

## Stop and ask only if

- You would need `any`/`unknown`.
- The WS union in `src/types.ts` cannot accept these frames without a breaking rename.
- Classifier tests cannot be isolated without injecting a `HostSample` type — then do inject it; that is the intended seam.

Trivial naming/file placement is yours.

## Done when

1. PR is up against `main`.
2. Classifier + emit-on-change + info-flag tests are green.
3. PR body states the frozen contract, that old mobile ignores the frames, and that this does not stop agents.
4. Report the PR URL.
