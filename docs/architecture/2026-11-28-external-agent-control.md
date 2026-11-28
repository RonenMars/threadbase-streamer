# External agent control ("Connect live") — phase 0 findings and phase 1

**Date:** 2026-11-28
**Status:** phase 1 implemented behind `externalControl` (off by default). Phases 2–4 not started.

## Problem

An agent the user starts in a terminal is discovered and listed as External, but the app can only rename or terminate it, or Adopt it, which kills the desktop process and respawns the conversation under the streamer.
There is no way to look at, or type into, the same running process from the phone and then return to it at the desk.

Connect live addresses the agent where it already runs: the tmux pane it was started in.
The agent keeps its pid, conversation and cwd. This is a separate action from Adopt (which terminates the owner) and Hand off (which stops the streamer's own copy and resumes it in tmux).

## What phase 1 ships

| Piece | Where |
| --- | --- |
| tmux client: `-N -S <socket>`, timeouts, `TMUX*` env stripped, hex literal builder | `src/tmux/client.ts` |
| Socket allowlist: default socket + locally registered ones; owner, 0700 dir, no symlink | `src/tmux/server-registry.ts` |
| Pane inventory: numeric fields + tty only, linked windows deduped | `src/tmux/pane-inventory.ts` |
| Process table, start identity, foreground proof | `src/tmux/process-table.ts` |
| Bounded, sanitized `capture-pane` snapshot | `src/tmux/screen.ts` |
| Discovered process → exact pane | `src/services/external-control/resolver.ts` |
| Grant check, status, screen | `src/services/external-control/service.ts` |
| Grants table (`runtime.db`, migration 012) | `src/services/external-control/repository.ts` |
| `GET /api/sessions/:id/external-control`, `GET …/external-control/screen` | `src/api/routes/external-control.routes.ts` |
| `tb-streamer external-control setup\|grant\|list\|revoke` | `cli/externalControl.ts`, `cli/index.ts` |

Discovery is unchanged. A connection is never ownership: nothing here touches `SessionStore`, auto-resume, the reaper, adopt, terminate or handoff.

### Enablement

All three are required:

1. The `externalControl` feature flag (`THREADBASE_FEATURE_EXTERNAL_CONTROL=1` or `feature_flags: {"externalControl":true}`). Off, every route answers 404 `EXTERNAL_CONTROL_DISABLED`.
2. `tb-streamer external-control setup` on the machine (`~/.threadbase/external-control.json`, mode 0600). macOS and Linux only.
3. A grant per device and binding: `tb-streamer external-control grant --session <id> --device <id> --ttl 1h`. It resolves the binding locally, shows the provider, pid and pane, and asks for a yes. TTL is capped at 24 h.

There is no API to create a grant. The shared API key never satisfies one (`DEVICE_CREDENTIAL_REQUIRED`): only a device principal holding `session:control` can.
`requiredCapability` classifies every `/api/sessions/:id/external-control*` method as `session:control`, a GET included, because a terminal can show what the transcript does not.
Revoking a device (API or CLI) revokes its grants.

### API

`GET /api/sessions/:id/external-control`

```json
{ "available": false, "reason": "CONTROL_NOT_GRANTED", "runtime": "tmux",
  "capabilities": { "screen": false, "input": false } }
```

A granted device additionally gets `bindingId`, `bindingRevision` (always 0 until input exists), `grantExpiresAt` and `paneInMode`. Nothing else identifying (socket path, pid, tty, pane id) leaves the server.
Reasons: `NOT_CONFIGURED`, `TMUX_VERSION_UNSUPPORTED`, `NOT_EXTERNAL`, `PROVIDER_UNSUPPORTED`, `IDENTITY_UNVERIFIED`, `CONVERSATION_CHANGED`, `TMUX_UNAVAILABLE`, `NOT_IN_TMUX`, `NOT_FOREGROUND`, `AMBIGUOUS`, `DEVICE_CREDENTIAL_REQUIRED`, `CONTROL_NOT_GRANTED`, `GRANTS_UNAVAILABLE`.

`GET /api/sessions/:id/external-control/screen` → `200 { bindingId, cols, rows, cursor, lines, screenRevision, capturedAt, truncated }`, `Cache-Control: no-store`.
Errors: `403 CONTROL_NOT_GRANTED`, `409 EXTERNAL_BINDING_STALE` (with `reason`), `503 TMUX_UNAVAILABLE`.
Lines are the visible screen plus up to 200 history lines, newest kept within 256 KiB, every C0/C1 control except tab stripped.

`/api/info` carries `externalControl: { runtime: "tmux", screen: true, input: false }` when the flag and the local setup are both on, absent otherwise.

## Phase 0 findings (tmux 3.4, Linux; measured 2026-11-28)

### argv does not bypass tmux's command parser

`execFile` keeps a shell out, but tmux parses its own argv as a command sequence. Measured with a pane whose foreground program records every byte it reads:

| argv to `send-keys -l -t %0 --` | bytes the program read |
| --- | --- |
| `a;` | `a` — the `;` was taken as a command separator |
| `;` | nothing |
| `b\;` | `b;` |
| `-x`, `#{pane_id}`, `"q"`, `x'y`, `$HOME`, `{`, `%if`, `c ; d`, UTF-8 | verbatim |

So literal text in argv is unsafe even without a shell: a prompt ending in `;` loses data, and the separator is exactly the hazard the spec warns about.
`send-keys -H <hex bytes>` is byte-exact for all of the above, UTF-8 and emoji included, because a hex token cannot contain anything the parser reacts to. `hexKeyArgs` is the only input builder; `isSafeLiteral` bounds it (4 KiB, no C0/C1, no DEL, no lone surrogates, no newline — Enter is a separate action).
Both are locked by `__tests__/external-control-tmux.test.ts` against a real server, including that `c ; kill-server` arrives as text and the server survives. Phase 1 exposes no input route; the builder exists because the phase 0 gate is "prove safe literal input".

### Foreground binding

The binding is proved, not inferred: the agent pid must be on the pane's tty (`ps -o tty=` vs `#{pane_tty}`), descend from `#{pane_pid}`, and its process group must equal the tty's foreground group (`pgid == tpgid`).
Verified on a real server: an exec'd foreground program passes; `sleep 300 &` in an interactive bash fails as `background`; a process on another pane's tty fails as `tty_mismatch`, which is also what a nested tmux's inner pane looks like from the outer one.
Two discovered agents in one foreground group are `AMBIGUOUS`; so is one agent matching two panes. Cwd, pane titles, window names and `pane_current_command` are never read.

The conversation is re-read from the exact source at bind time — the Claude registry (`readClaudeSessionRegistry`, start-checked) or the Codex rollout the pid holds open — so an in-TUI `/resume` reads as `CONVERSATION_CHANGED` before the next discovery sweep. Cursor, Copilot and Claude teammates have no exact live source and are `PROVIDER_UNSUPPORTED`.

### Identity

- Process: Linux `/proc/<pid>/stat` field 22 (start ticks); elsewhere `ps -o lstart=` (one-second resolution). Unreadable is `IDENTITY_UNVERIFIED`, never a guess.
- Server generation: hash of boot id (Linux `boot_id`, macOS `kern.boottime`), server pid, `#{start_time}` and the socket inode. A server restarted on the same path gets a new generation (tested).
- The grant pins `sha256(provider, conversation, pid, start, serverRef, generation, paneId)`. Any change is a different binding with no grant, so nothing transfers to a new process, pane, server or conversation.
- `-N` on every call: a query against a socket whose server is gone cannot start one (tested).

### The race that remains

Check and use are not atomic. Between the bind and the capture the agent can exit and its shell take the pane; the screen route re-verifies pane, start token and foreground after capturing and answers 409 rather than serving a shell screen.
For input (phase 2) the same window exists between the last check and `send-keys`, plus desktop typing that no lease can stop. This is for trusted same-user terminals, not an isolation boundary.

### Not yet verified

- macOS: the code paths are portable (`ps -o tpgid=,tty=`, `sysctl kern.boottime`), but the real-tmux test has only run on Linux here. CI's macOS runner skips it when tmux is absent.
- Real Claude Code / Codex panes: the binding is exercised with stand-in processes. A pilot on a real agent pane is the next check before phase 2.
- Minimum tmux: the code requires 3.2 (`-N`); the spec proposes 3.3a. Only 3.4 has been run.

## Alternatives considered

- **A tmux-backed `SessionRunner`.** Rejected: it would make the session managed, so the registry, busy probe, reaper and auto-resume would treat a desktop process as the streamer's to stop or resume.
- **`send-keys -l` with the text as one argv element.** Rejected after measurement, above.
- **`pipe-pane`, global hooks, or writing to `/dev/tty*`.** Rejected: each mutates the user's tmux or bypasses it.
- **Grants over the API.** Rejected for phase 1: a remote caller could then grant itself. The grant is a local act by the user who owns the tmux server.

## Next phases

- **2**: writer lease (30 s TTL, per device and connection), `connect` / `renew` / `input` / `disconnect`, typed text and explicit key actions over `hexKeyArgs`, `external_control_receipts` (pending → accepted / rejected / unknown, never retried), `liveControl` on session responses, and the mobile Connect live screen.
- **3**: provider adapters that recognise a verified composer and route prompt answers through the existing prompt registry.
- **4**: control-mode streaming.
