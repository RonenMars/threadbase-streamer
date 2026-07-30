# Session source visibility and control — spec

**Date:** 2026-07-30
**Branch:** `plan/live-sessions-persistence`
**Companion:** [live-sessions-persistence-plan.md](./live-sessions-persistence-plan.md) — separate feature stream, shares the `ownership` / `lifecycle` vocabulary
**Scope:** tb-streamer + tb-mobile

Three capabilities: tell the user **where a running session came from**, let them **stop one they don't own**, and let them **take one over** — the last two only behind explicit confirmation.

---

## 1. What already exists

Establishing this first, because two of the three asks are largely built and the work is smaller than it looks.

| Capability | Status | Where |
|---|---|---|
| Distinguish streamer-owned from externally-discovered | **Exists** | `ownership: "managed" \| "external" \| "historical"` on `SessionResponse`; `discoveredToResponse`, `src/session-store.ts:252` |
| Know an external process is alive | **Exists** | `processLiveness: "alive"`, set on every discovered session (`src/session-store.ts:266`); already typed in mobile's `types/api.ts` |
| Enumerate external processes | **Exists** | `discoverClaudeProcesses()`, `src/process-discovery.ts` — one `ps -eo pid=,args=` sweep on POSIX, one CIM query on Windows |
| Stop a **streamer-owned** session | **Exists** | `POST /api/sessions/:id/stop` → NDJSON `stopping` → `stopped`/`timeout`, `src/server.ts:4207` |
| Interrupt a streamer-owned turn | **Exists** | `POST /api/sessions/:id/cancel` (SIGINT), `src/server.ts:4196` |
| Take over an external session | **Exists** | `POST /api/sessions/:id/adopt` — kill, `waitForProcessExit`, respawn via resume, with pre-flight refusals for unknown cwd and missing project dir (`src/server.ts:4262`) |
| Mobile overtake | **Exists** | `useSessionActions().adoptSession`; take-over button in `app/conversation/[id].tsx:433`; `DiscoveredSessionScreen` in `app/session/[id].tsx` |
| Wait for a signalled process to actually die | **Exists** | `waitForProcessExit(pid, timeoutMs, pollMs)`, `src/server.ts:4962` |

| Gap | Detail |
|---|---|
| **No source detection** | Nothing records *how* an external session was launched |
| **No ownership/source filter** | `/api/sessions` accepts only `limit`, `cursor`, `sortBy`, `order`, `status` (`parseSessionListQuery`, `src/server.ts:5081`) |
| **Stop refuses external sessions** | `handleStopSession` returns `404` when `ptyManager.getSession()` is null — an external process cannot be stopped at all |
| **No post-stop navigation** | Mobile leaves the user on a dead terminal screen |
| **Overtake is deliberately hidden** | See §4 — two guards, both intentional, both being reversed by this spec |

---

## 2. Feature 1 — Session source

### 2.1 The JSONL answers it for the desktop app

Measured directly by running one session of each kind side by side (2026-07-30):

- terminal — `fa195f30-5e5b-4748-bc79-6364f0b4c9cc`, cwd `~/dotfiles/shell/tmux/plugins/tmux-ai-necromancer`
- desktop app — `bb94c668-42b2-40d2-8773-75bffe3941cc`, cwd `~/dev/cv`

The desktop session's transcript carries its own entrypoint:

```
44  "entrypoint":"claude-desktop"     ← desktop-app session
 1  "entrypoint":"cli"                ← nested inside one attachment payload
```

versus the terminal session, which is `cli` throughout. **The first byte-offset occurrence in the desktop file is `claude-desktop`**, so `isAgentConversation.ts`'s existing chunked early-exit scan already reads the right value with no change to how it scans.

Whole-corpus counts on the same machine:

```
83100  "entrypoint":"cli"
  931  "entrypoint":"sdk-py"
   51  "entrypoint":"sdk-cli"
   44  "entrypoint":"claude-desktop"
```

`claude-desktop` is rare only because it is new to this machine — an earlier sample of the same corpus, taken ten minutes before the desktop session was opened, contained none at all. **Do not conclude from a low count that a value is unreliable; conclude that the corpus is a snapshot.**

**Caveat — the value is not strictly uniform per file.** The desktop transcript contains one `cli` occurrence nested inside an attachment payload. Reading the **first** occurrence (what the existing scan does) is correct: it comes from the earliest-written record. Any future consumer that scans for *any* occurrence, or takes the last, would misclassify.

So `entrypoint` distinguishes **desktop-app, VS Code and SDK** traffic authoritatively and for free. What it cannot do is separate a *terminal* launch from any other host that also reports `cli` — that is what ancestry is for.

### 2.2 Process ancestry covers the rest

Probed live on macOS, both sessions running simultaneously:

```
# terminal — pid 9305, cwd ~/dotfiles/.../tmux-ai-necromancer
tty  = ttys002
argv = claude --dangerously-skip-permissions
      claude ← -zsh ← tmux ← launchd

# desktop app — pid 61556, cwd ~/dev/cv
tty  = ??
argv = ~/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude
       --output-format stream-json --input-format stream-json --verbose
       --permission-prompt-tool stdio --include-partial-messages
       --effort high --model claude-sonnet-4-6 --permission-mode default
       --mcp-config {…} --plugin-dir … (×20)
      claude ← Claude.app/Contents/Helpers/disclaimer ← /Applications/Claude.app/Contents/MacOS/Claude ← launchd
```

Four independent signals, any of which identifies the desktop app:

- **controlling tty** — a real tty (`ttys002`) means a terminal launch; `??` means none.
- **ancestor chain** — walk `ppid` up a few levels and match the ancestor's executable. The desktop app's chain reaches `/Applications/Claude.app` in two hops.
- **binary path** — the desktop app runs a *bundled per-version copy* at `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`, never the `claude` on `PATH`.
- **argv shape** — `--output-format stream-json` is decisive on its own (see §2.3).

Ancestry remains necessary even with `entrypoint` available: it is the only signal that works on a process whose conversation has not been identified yet, and the only way to separate `terminal` from `unknown` among the `cli` population.

### 2.3 The desktop app is not a terminal session — it is headless

The single most consequential finding, and it is not about labelling.

```
--output-format stream-json --input-format stream-json --permission-prompt-tool stdio
```

The desktop app does **not** run an interactive TUI. It drives the CLI headlessly over pipes, with permission prompts routed to the app over stdio rather than painted on a screen. There is no prompt marker, no rendered screen, and no terminal to attach to.

Everything the streamer's live-session machinery assumes — `CLAUDE_PROMPT_MARKERS`, screen scraping, OSC-777 permission gates, bracketed-paste submit — is meaningless against this process. It cannot be attached to, and taking it over is not "moving a terminal session to the phone": it is killing the agent out from under a running GUI application that is still open and still expects it. §4.4 sets the resulting policy.

### 2.4 Detection rules

`resolveSessionSource({ entrypoint?, ancestry?, tty?, exePath? }) → SessionSource`, evaluated in order. JSONL evidence first because it is authoritative and already read; process evidence second because it is available even when no conversation has been bound.

| Order | Result | Rule |
|---|---|---|
| 1 | `sdk` | `entrypoint` is in the configured agent-entrypoint set (`sdk-cli`, `sdk-py`, …) |
| 2 | `desktop-app` | `entrypoint === "claude-desktop"` |
| 3 | `editor` | `entrypoint === "claude-vscode"` |
| 4 | `desktop-app` | an ancestor resolves inside `Claude.app`, **or** `exePath` is under `Library/Application Support/Claude/claude-code/`, **or** argv contains `--output-format stream-json` together with a GUI ancestor |
| 5 | `editor` | an ancestor is a known editor host (`Code Helper`, `code`, `Cursor`, JetBrains launchers) |
| 6 | `terminal` | a controlling tty is present **and** an ancestor is a shell or terminal emulator (`zsh`, `bash`, `fish`, `sh`, `tmux`, `screen`, `Terminal`, `iTerm2`, `ghostty`, `WezTerm`, `Alacritty`, `kitty`) |
| 7 | `unknown` | anything else, or ancestry unreadable |

**`remoteControlled` is resolved separately and does not participate in this table** (§2.8). It is true when argv carries the `remote-control` subcommand or the `--remote-control` / `--rc` flag, and it composes with any `source` value above.

Rules 1–3 need no process at all, so a *historical* conversation can be labelled too — the source survives in the transcript after the process is gone. Rules 4–6 need no conversation, so a live process with no bound conversation can still be labelled. The two halves are deliberately independent.

### 2.5 Desktop-app sessions are invisible to `/api/sessions` today

Discovery derives a session's conversation id from argv:

```ts
// src/process-discovery.ts:374
export function extractResumeId(args: string): string | null {
  const eq = args.match(/(?:--resume|-r)=(\S+)/);
  …
}
```

The desktop app's argv carries **neither `--resume` nor `--session-id`** (verified against pid 61556 above). So `conversationId` is `null`, and `SessionStore.list()` drops it outright:

```ts
// src/session-store.ts:73
if (!d.conversationId) continue;
```

**A running desktop-app session therefore does not appear in `/api/sessions` at all** — not as external, not as anything. The user's ask "list running sessions started by an unknown source" cannot be satisfied for the desktop app without fixing this, and it is not a filtering problem.

**Two concurrent desktop sessions in one directory is a real configuration, not an edge case.** It occurred within an hour of writing this section:

```
pid 61556  started 11:02:16   →  bb94c668…  first record 11:02:17.466   Δ +1.5s
pid 47336  started 11:11:10   →  4ada75ca…  first record 11:11:11.163   Δ +1.2s
```

Same cwd, same argv shape, same ancestry, indistinguishable by every signal in §2.2. So "newest transcript in the directory" is not a usable rule — with two live sessions it is a coin flip, and the loser gets the user's actions attached to the wrong conversation.

**Rejected: bind by open file descriptor.** The obvious mechanism does not work. `lsof` on either transcript returns exactly one holder — pid 55430, the **streamer itself**, at `fd=20r` / `fd=21r`, its own read-mode watchers. Neither `claude` process holds its transcript open; the CLI opens, appends and closes per write. Verified directly; do not re-attempt.

**Fix — bind by cwd plus start-time correlation.** For a discovered process with a resolvable cwd and no argv id:

1. Map cwd → the encoded project directory under `~/.claude/projects/`.
2. Read each candidate transcript's **earliest record timestamp**.
3. Bind the candidate whose first record falls within a short window **after** the process start time — measured at +1.2 s and +1.5 s above; allow a few seconds for clock skew, as `watchForCodexRollout` already does with its 5 s slack (`src/server.ts:4711`).
4. Reject any candidate whose first record predates the process start: that transcript belongs to an earlier run.
5. Confirm the candidate's `entrypoint` is not an agent value before binding.

This is the same shape the Codex rollout binder already uses (cwd match + creation timestamp at/after session start), so the pattern and its guards are established in this codebase rather than invented here.

**If two candidates still correlate within the window, bind nothing.** Two sessions started in the same directory within seconds of each other is rare enough to leave unresolved, and an unbound session is honest where a guessed one is not.

A binding reached this way is **inferred, not observed**, and must be reported as such rather than presented like an argv-derived id — same discipline as `statusConfidence`.

#### Implementation note: project directory names begin with `-`

The encoded project directories under `~/.claude/projects/` start with a dash — `-Users-ronenmars-dev-cv`, `-Users-ronenmars-dev-ai-tools-tb-scanner`. Every POSIX tool that parses leading dashes as options mis-handles them:

```bash
head -1 -Users-ronenmars-dev-cv/x.jsonl      # head: invalid option -- U
grep -o 'pat' -Users-…/x.jsonl               # silently matches nothing, exit 1
basename -Users-…/x.jsonl                    # basename: illegal option -- U
```

`grep` is the dangerous one: it **fails silently**, producing an empty result that reads as a legitimate "no match". While writing this document that bug twice produced a confident, wrong conclusion — first that no `RemoteTrigger`-carrying transcript had an `entrypoint`, then that the field was largely absent from the corpus. Both were artefacts of unguarded paths. Correct form is `./` or `--`:

```bash
grep -aom1 'pat' -- "./$f"
```

**The streamer itself is unaffected** — Node's `fs` APIs take paths as data and never parse them as flags. This matters for two things:

1. Any diagnostic script, `doctor` check, or one-off investigation that shells out against these paths.
2. `__tests__/discover-bind-by-cwd.test.ts`, which must build fixture directories with the **real** leading-dash names rather than sanitised stand-ins — otherwise it passes against a directory shape that does not exist in production.

`streamer` is the sixth value and is never *detected* — it is assigned to every session this streamer spawned, so `?source=streamer` and `?ownership=managed` describe the same set from two angles.

**`unknown` is a first-class answer, not a failure.** Same discipline as `processLiveness: "unknown"` and `statusConfidence: "inferred"`: a guess must never be presented as an observation. A session whose ancestry cannot be read is `unknown`, and the UI must say so rather than defaulting to `terminal`.

### 2.6 Cost

Cheaper than it sounds, because discovery already sweeps the process table.

**POSIX** — one *additional* whole-table sweep per discovery cycle:

```
ps -eo pid=,ppid=,tty=,comm=
```

giving a `pid → { ppid, tty, comm }` map that the chain walk consumes in memory. Deliberately **not** folded into the existing `ps -eo pid=,args=` sweep: `parsePsOutput`'s `/^(\d+)\s+(.*)$/` would silently mis-parse extra columns, and that function is load-bearing for shim-install discovery. One new call, no edit to working code.

Caveat: macOS truncates `comm` (the probe above shows `Helper`, not `Claude Helper (Renderer)`). Where `comm` is ambiguous, resolve that one ancestor with `ps -o command= -p <ppid>`. Bounded by the walk depth.

**Windows** — free. `discoverWindowsViaCim` already pulls every `Win32_Process` row and filters in JS; add `ParentProcessId` to the `Select-Object` list and the ancestry map falls out of the rows already in hand. `tty` has no Windows analogue, so detection there leans entirely on ancestry.

**Walk depth: 4 levels, hard cap.** Enough for `claude ← zsh ← tmux ← launchd`, and it cannot loop.

### 2.7 Wire

Additive optional field on `SessionResponse` (`src/types.ts`):

```ts
export type SessionSource =
  | "streamer"     // this streamer spawned it
  | "terminal"     // launched from a shell / terminal emulator
  | "desktop-app"  // launched by the Claude desktop app
  | "editor"       // VS Code / Cursor / JetBrains host
  | "sdk"          // agent SDK or hook invocation
  | "unknown";     // ancestry unreadable or unrecognised

source?: SessionSource;

/**
 * Session is (or was) driven from claude.ai/code or the Claude app via
 * Remote Control. ORTHOGONAL to `source` — see §2.8. Absent means "not
 * observed as remote-controlled", which is weaker than "not remote-
 * controlled"; §9.2 records the case that cannot be detected.
 */
remoteControlled?: boolean;
```

`DiscoveredProcess` (`src/types.ts:132`) gains `source: SessionSource`, `remoteControlled: boolean` and `ppid?: number`, populated in `discoverUnix` / `discoverWindowsViaCim`; `discoveredToResponse` passes both through; `managedToResponse` emits `"streamer"` and `false`.

### 2.8 Why `remoteControlled` is a flag, not a `SessionSource` value

An earlier draft of this spec made `remote-controlled` a seventh `SessionSource`, ranked above `terminal`. That was wrong, and the reason is worth recording so it is not reintroduced.

Remote Control is not a *launch host*; it is a capability layered **on top of** one. Every combination is reachable:

| Invocation | Launch host | Remote-controlled |
|---|---|---|
| `claude --remote-control` in a terminal | `terminal` | yes |
| `/remote-control` in VS Code | `editor` | yes |
| Desktop app with "Enable remote control by default" | `desktop-app` | yes |
| `claude remote-control` (server mode) | `terminal` | yes |
| plain `claude` | `terminal` | no |

Collapsing the two into one enum forces a precedence rule that **destroys the launch host** — the very thing `source` exists to report. A user filtering `?source=terminal` would lose their remote-controlled terminal sessions, which is the opposite of useful.

Two fields, each answering one question: `source` = *where did this come from*, `remoteControlled` = *is something else already steering it*. The second is what `adopt` keys on (§4.4); the first is what the UI labels.

### 2.9 Persistence

Live detection is in-memory and cheap — discovery recomputes it every 15 s. Persistence buys three things it cannot: a **historical** conversation keeps its label after the process is gone, `?source=` / `?remoteControlled=` keep working across a restart, and diagnostics can answer "what was this session" retrospectively.

**Migration `016_add_conversation_source.sql`** — additive, on the cache DB:

```sql
-- How this conversation was launched, and whether something else was
-- steering it. Both are LAST OBSERVED values, not current truth.
--
-- Asymmetry that matters: `source` values derived from the transcript
-- (desktop-app, editor, sdk) can be recomputed from the JSONL at any time,
-- because `entrypoint` is written into the file itself. `terminal` and
-- remote_controlled are derived from process argv, which exists only while
-- the process does. Once it exits, they can never be re-derived — so these
-- columns are the only record, and a NULL means "never observed live",
-- which is strictly weaker than "false".
ALTER TABLE conversation_meta ADD COLUMN source TEXT;
ALTER TABLE conversation_meta ADD COLUMN remote_controlled INTEGER;
```

**Migration number coordination.** The persistence plan claims `015` for `boot_token`. Whichever of the two lands second takes the next free number — check `src/db/migrations/` before writing the file rather than trusting either document.

**Write path.** `ConversationCache` records both when a live session is observed for a conversation: on discovery binding (§2.5), on managed spawn, and on the `conversation_updated` write. Never on a plain scan — a scan sees no process and would overwrite a real observation with `unknown`.

**`remote_controlled` is sticky and past-tense.** Once observed true it stays true, and it means *"this conversation was observed under Remote Control"*, not *"it is right now"*. A conversation remote-controlled yesterday is not being steered today.

**Therefore the `adopt` refusal (§4.4) must key on the LIVE value, never this column.** Using a stale sticky flag to refuse an overtake would permanently lock a conversation the user has since taken back into a plain terminal. The column is for display and filtering; the decision is for live discovery.

**Not added to `managed_sessions`.** A streamer-spawned session is `source: "streamer"` by construction and is never remote-controlled — the streamer does not pass `--remote-control`. One edge case is reachable: `claudeExtraArgs` is an unvalidated escape hatch, so an operator *could* inject `--remote-control` into every spawn. If that turns out to happen in practice, the honest fix is to reject it in flag validation rather than to model it in the schema.

### 2.10 Filters

Three new query params on `GET /api/sessions`. `ownership` and `source` are comma-separated multi-value, validated exactly like the existing `?status=` (unknown member → `400`); `remoteControlled` is a single boolean.

```
GET /api/sessions?ownership=managed&status=running     # running, streamer-owned
GET /api/sessions?ownership=external                   # everything we don't own
GET /api/sessions?source=terminal,desktop-app          # by launch origin
GET /api/sessions?source=unknown&limit=50              # the ones we can't classify
GET /api/sessions?remoteControlled=true                # already steered elsewhere
GET /api/sessions?source=terminal&remoteControlled=false   # plain terminal only
```

That last pair is the case §2.8 exists to preserve: with a single collapsed enum it would be unexpressible, because a remote-controlled terminal session would no longer report `source=terminal` at all.

Implemented in `parseSessionListQuery` with `VALID_OWNERSHIPS` / `VALID_SOURCES` constants alongside `VALID_STATUSES`, and applied in `SessionStore.paginate` next to the existing status filter. No new endpoint: cursor pagination, sorting and the response envelope all come for free, and there is no second surface to keep in sync.

`remoteControlled` filters on the **live** value for discovered sessions and falls back to the persisted column (§2.9) for historical ones — where it means *"was observed remote-controlled"*. A row that has never been observed live has `NULL` and matches neither `true` nor `false`, because "unobserved" is not "no".

**All three params apply to the paginated envelope only** — a bare `GET /api/sessions` with no params keeps returning the legacy plain array, unchanged.

---

## 3. Feature 2 — Stop a session the streamer does not own

### 3.1 Contract

`POST /api/sessions/:id/stop` gains a body. Streamer-owned sessions are **unchanged** — no body required, same NDJSON stream, same semantics.

When the target is an external session with a known pid:

**Without `{ "confirm": true }`** → `409`, describing exactly what would be killed so the client can name it to the user:

```json
{
  "error": "This session was not started by the streamer. Stopping it will terminate the process.",
  "code": "STOP_REQUIRES_CONFIRM",
  "target": {
    "pid": 9305,
    "source": "terminal",
    "projectPath": "/Users/…/tb-streamer",
    "projectName": "tb-streamer",
    "startedAt": "2026-07-30T07:12:44.000Z"
  }
}
```

**With `{ "confirm": true }`** → the existing NDJSON stream, `SIGTERM` then `waitForProcessExit(pid, 5000)`:

```
{"event":"stopping","sessionId":"…","target":{"pid":9305,"source":"terminal"}}
{"event":"stopped","sessionId":"…"}          // or {"event":"timeout","sessionId":"…"}
```

### 3.2 SIGTERM only — no escalation

On timeout the server reports `timeout` and **stops**. It does not escalate to `SIGKILL`.

This is deliberate. `SIGTERM` lets the CLI flush its transcript; `SIGKILL` does not, and a killed-mid-write JSONL is the one outcome that costs the user actual work. A process that ignores `SIGTERM` for five seconds is doing something, and the honest report is "it didn't stop", not a harder signal chosen on the user's behalf from a phone. Escalation, if ever wanted, is a separate explicit action.

### 3.3 Mobile

- Any stop on an `ownership: "external"` session shows a confirmation dialog **before** the request, naming the pid, the source (*"started from your terminal"*, *"started by the Claude desktop app"*), and the project. Only on confirm does it send `{ confirm: true }`. A `409 STOP_REQUIRES_CONFIRM` reaching the UI is a bug, not a flow.
- On `{"event":"stopped"}` — **and on `stopped` only** — navigate to the read-only conversation view: `router.replace('/conversation/<conversationId>?server=<serverId>')`. The transcript is intact and is what the user wants to see; the terminal screen is now dead.
- On `timeout`, stay put and surface *"the process did not stop"* with the option to retry. Navigating away would imply success.

---

## 4. Feature 3 — Overtake as a first-class action

### 4.1 What is being reversed, and why it was there

Overtake works today but is reachable **only** as recovery from a `409 CONVERSATION_BUSY` during resume. Two deliberate guards:

- `src/session-store.ts:263` forces every discovered process to `status: "idle"` — *"reporting `running` would route mobile to the destructive Overtake screen"*
- `app/session/[id].tsx:711` gates `DiscoveredSessionScreen` on `session.ownership !== 'external'` — *"External sessions are read-only — never surface the Overtake path (which SIGTERMs the user's real terminal process)"*

Both exist because overtake is destructive-then-restorative and nothing stood between a stray tap and the death of a real terminal session. This spec adds that something: an explicit confirmation contract. The guards come off; the protection moves from *hiding the action* to *requiring consent*.

### 4.2 Server

No new endpoint. `POST /api/sessions/:id/adopt` gains the same gate as stop:

- without `{ "confirm": true }` → `409` / `ADOPT_REQUIRES_CONFIRM` with the same `target` descriptor
- with it → today's behaviour exactly, including every existing pre-flight refusal (`ADOPT_NO_PROJECT_PATH`, missing project directory), which stay **ahead** of the kill

The `status: "idle"` forcing in `discoveredToResponse` **stays**. Reporting `running` for a discovered process would be a status-semantics change on a field shipped clients switch on, and it is not needed: `processLiveness: "alive"` is already emitted for exactly these sessions and is already typed in mobile's `types/api.ts`. The signal exists; nothing on the server has to change to expose liveness.

### 4.3 Mobile

`app/session/[id].tsx:709-718` changes so an external session that is alive routes to a screen offering **Overtake** and **Stop**, both behind confirmation dialogs that name pid, source and project. `ownership: 'external' && processLiveness === 'alive'` is the routing condition — no dependence on `status`.

An external session that is *not* alive (`processLiveness !== 'alive'`) keeps today's read-only behaviour: nothing to take over.

### 4.4 Overtake is refused for `source: "desktop-app"`

The confirmation contract in §4.2 is calibrated for a terminal session: the user owns that window, killing it frees the conversation, and the respawned PTY genuinely replaces what was destroyed. §2.3 shows the desktop app does not fit that model in any respect.

| | Terminal session | Desktop-app session |
|---|---|---|
| What the process is | an interactive TUI the user is looking at | a headless `stream-json` worker driven over pipes |
| Who else is attached | nobody | a running GUI application, still open |
| Effect of killing it | the user's window returns to a shell | the app loses its agent mid-turn, with no notification path the streamer controls |
| Does respawn restore it | yes — resume rebuilds an equivalent TUI | no — the app is not reconnected to the new process; the user has a broken window *and* a PTY they did not ask for |

So `adopt` **refuses** when the resolved source is `desktop-app`:

```json
{
  "error": "This session belongs to the Claude desktop app and cannot be taken over. Close it there first, then resume it here.",
  "code": "ADOPT_SOURCE_UNSUPPORTED",
  "source": "desktop-app"
}
```

Checked in `handleAdopt` **before** the kill, alongside the existing `ADOPT_NO_PROJECT_PATH` and missing-project-directory refusals — the same discipline that file already applies: every reason it cannot restore is checked while the target is still alive.

`stop` is **not** refused for `desktop-app`. Stopping is an honest, complete action — the user asked for the process to end and it ends. It is only *replacing* it that the streamer cannot do. The confirmation text should say plainly that the desktop app will lose this session.

**`remoteControlled === true` is refused on the same grounds**, with its own code, independently of `source` (§9.2): that session already has a second controller steering it from the user's phone or browser, and adding a third is worse than either alone.

```json
{
  "error": "This session is being controlled remotely from claude.ai or the Claude app. Disconnect Remote Control there first.",
  "code": "ADOPT_REMOTE_CONTROLLED",
  "source": "terminal",
  "remoteControlled": true
}
```

Two constraints on this refusal:

- It must read the **live** value from discovery, never the sticky `conversation_meta.remote_controlled` column (§2.9). A stale flag would permanently lock a conversation the user has since taken back into a plain terminal.
- It is **uncalibrated** — no observed Remote Control session exists on this machine to test against (§9.1) — so verify it against a real one before relying on it.

`source: "unknown"` is treated as **not** desktop-app, so it stays overtakeable behind confirmation. Refusing on uncertainty would block the ordinary terminal case whenever ancestry happens to be unreadable, and the confirmation dialog already shows pid and project path — facts, not inferences.

---

## 5. tb-mobile compatibility

| Change | Impact |
|---|---|
| `source` on `SessionResponse` | Additive optional. Old clients ignore it. |
| `remoteControlled` on `SessionResponse` | Additive optional boolean. Old clients ignore it. |
| `?ownership=` / `?source=` / `?remoteControlled=` | New optional params. Absent → today's behaviour. |
| `ADOPT_REMOTE_CONTROLLED` | New `409` code. Old clients show it as a generic adopt failure, which is correct — the action genuinely did not happen. |
| Migration `016` | Two nullable columns on `conversation_meta`. An older streamer against the newer DB ignores them. |
| `409 STOP_REQUIRES_CONFIRM` | Old clients calling `/stop` on an external session get `409` where they used to get `404`. Both are errors; neither client acts on the difference. Strictly more informative. |
| `409 ADOPT_REQUIRES_CONFIRM` | **Breaking for the existing mobile overtake flow** — today's `adoptSession.mutate()` sends no body and would start failing. Must ship with the mobile change, or land server-side behind a grace period where a missing `confirm` is logged and allowed for one release. |
| `target` in the `stopping` NDJSON event | Additive field in an existing event. |
| `status` values | **Unchanged.** No new value; `discoveredToResponse` keeps forcing `idle`. |

The `adopt` row is the only real coordination point in this spec, and it needs a decision at implementation time: **either** ship streamer + mobile together, **or** default `confirm` to true for one release with a deprecation log. Recommendation: ship together — overtake is a low-frequency action and a coordinated pair is cleaner than a temporary permissive default that could outlive its release.

---

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| S1 | Source misdetection labels a desktop-app session `terminal`, and the user kills the wrong thing | `unknown` is a real answer; confirmation dialogs always show **pid + project path**, which are facts, not inferences |
| S2 | Extra `ps` sweep per discovery cycle | One whole-table call, not per-pid; discovery is already TTL-cached at 15 s (`DISCOVERY_TTL_MS`) |
| S3 | Ancestry walk loops or runs deep | Hard cap of 4 levels, stop at pid 1 |
| S4 | `SIGTERM` lands mid-JSONL-write | Provider flushes on `SIGTERM`; no `SIGKILL` escalation (§3.2) |
| S5 | Stray tap kills a real terminal session | Two-layer: mobile confirms before sending, server refuses without `confirm` |
| S6 | Old mobile breaks on the adopt confirm gate | §5 — ship coordinated, or one-release permissive default |
| S7 | Windows has no tty signal | Detection there is ancestry-only; more results land on `unknown`, which is correct rather than guessed |
| S8 | Sources proliferate as new hosts appear | `unknown` absorbs them; adding a value is additive on both sides |
| S9 | Start-time binding (§2.5) attaches a desktop process to the wrong conversation | Correlate first-record timestamp against process start (measured Δ ≈ 1.2–1.5 s); reject transcripts predating the process; bind **nothing** when two candidates correlate inside the window; report the binding as inferred |
| S10 | Overtaking a desktop-app session leaves the user with a broken app window and an unwanted PTY | Refused outright (§4.4), checked before the kill |
| S11 | `--output-format stream-json` stops being the desktop app's signature in a future release | It is one of four independent signals, and `entrypoint: "claude-desktop"` is the primary; detection degrades to `unknown`, never to a wrong label |
| S12 | A diagnostic or test shells out against a `-Users-…` project path and silently gets an empty result | §2.5 implementation note; guard every such path with `./` or `--`. Node code paths are unaffected |
| S13 | The sticky `remote_controlled` column is used for the `adopt` refusal and permanently locks a conversation the user has taken back into a plain terminal | The refusal reads the **live** discovery value only; the column is display/filter-only. Asserted by test |
| S14 | A session that enabled Remote Control via `/remote-control` mid-run is overtaken because its argv never changed | Not detectable (§9.2). Documented rather than mitigated; the confirmation dialog is the only remaining guard |
| S15 | Migration number collides with the persistence plan's `015` | Check `src/db/migrations/` at implementation time; whichever spec lands second takes the next free number (§2.9) |
| S16 | A plain scan overwrites an observed `source` / `remote_controlled` with `unknown` / `NULL` | Write only on live observation, never from a scan (§2.9) |

---

## 7. Test plan

### Add

| File | Covers |
|---|---|
| `__tests__/session-source.test.ts` | `resolveSessionSource` decision table across all six values; `entrypoint: "claude-desktop"` wins over ancestry; entrypoint-only path (no process) and ancestry-only path (no conversation); truncated `comm`; unreadable ancestry → `unknown`; depth cap; loop guard |
| `__tests__/discover-bind-by-cwd.test.ts` | §2.5 binding: argv-less process binds to the transcript whose first record falls just after its start time; **two concurrent sessions in one directory each bind to the correct transcript** (the 11:02 / 11:11 case); rejects a transcript whose first record predates process start; binds nothing when two candidates correlate inside the window; skips agent-entrypoint candidates; binding flagged inferred. **Fixtures must use real leading-dash directory names** (`-Users-…`) — see §2.5's implementation note |
| `__tests__/adopt-source-refusal.test.ts` | `ADOPT_SOURCE_UNSUPPORTED` for `desktop-app` and `ADOPT_REMOTE_CONTROLLED` for `remoteControlled`, both checked before any signal is sent; refusal reads the **live** value and a stale sticky column never blocks (S13); `unknown` stays overtakeable; plain `terminal` unaffected |
| `__tests__/session-source-persistence.test.ts` | Migration `016` applies once and is idempotent; `source` / `remote_controlled` written only on live observation, never from a scan (S16); sticky `remote_controlled` stays true once set; `NULL` matches neither `?remoteControlled=true` nor `=false` |
| `__tests__/process-ancestry.test.ts` | `ps -eo pid=,ppid=,tty=,comm=` parsing; CIM `ParentProcessId` parsing; chain walk on synthetic maps |
| `__tests__/sessions-filter-params.test.ts` | `?ownership=` / `?source=` single and comma-separated; invalid member → `400`; interaction with `?status=` and cursor pagination; bare `GET` still returns the legacy array |
| `__tests__/stop-external-session.test.ts` | `409 STOP_REQUIRES_CONFIRM` without confirm; NDJSON stream with confirm; `SIGTERM` sent once; timeout path reports `timeout` and does **not** `SIGKILL`; owned sessions unaffected |

### Modify

| File | Covers |
|---|---|
| `__tests__/process-discovery.test.ts` | `source` and `ppid` on `DiscoveredProcess`; `parsePsOutput` unchanged by the new sweep |
| `__tests__/session-store.test.ts` | `source` in `discoveredToResponse` / `managedToResponse`; filtering in `paginate` |
| `__tests__/server.test.ts` | adopt confirm gate; stop confirm gate; filter params end-to-end |
| `__tests__/codex-api.test.ts` | source detection for Codex-provider discovered processes |
| `__tests__/contracts/mobile-contracts.test.ts` | `source` optional; no new `status` value |
| `docs/compatibility/tb-mobile.md` | `source` field, both query params, both `409` codes, the `target` descriptor |

---

## 8. PR checklist

**Streamer**

- [ ] **S1** — process ancestry: extra POSIX `ps` sweep, `ParentProcessId` on the CIM query, `ppid`/`tty` on `DiscoveredProcess`. No behaviour change yet
- [ ] **S2** — `resolveSessionSource` + `SessionSource` type; **plus the orthogonal `remoteControlled` detection** (§2.8); both emitted by `discoveredToResponse` and `managedToResponse`
- [ ] **S2a** — migration `016`: `conversation_meta.source` + `conversation_meta.remote_controlled`; write on live observation only
- [ ] **S2b** — bind argv-less discovered processes by cwd + transcript recency (§2.5), so desktop-app sessions appear in `/api/sessions` at all. **Prerequisite for the whole feature** — without it there is nothing to filter or act on
- [ ] **S3** — `?ownership=`, `?source=` and `?remoteControlled=` in `parseSessionListQuery` + `SessionStore.paginate`
- [ ] **S4** — stop for external sessions: confirm gate, `SIGTERM` + `waitForProcessExit`, `target` in the NDJSON stream
- [ ] **S5** — adopt confirm gate (`ADOPT_REQUIRES_CONFIRM`), plus `ADOPT_SOURCE_UNSUPPORTED` for `desktop-app` and `ADOPT_REMOTE_CONTROLLED` for remote-controlled sessions (§4.4); existing pre-flight refusals unchanged and still ahead of the kill
- [ ] **S6** — `docs/compatibility/tb-mobile.md` update

**Mobile**

- [ ] **M3** — `source` and `remoteControlled` in `types/api.ts`; both shown on session rows and the session screen
- [ ] **M4** — stop confirmation dialog; `{ confirm: true }`; navigate to the read-only conversation view on `stopped` only
- [ ] **M5** — route `ownership: 'external' && processLiveness === 'alive'` to a screen offering Overtake + Stop, both behind confirmation; send `{ confirm: true }` on adopt *(ships with S5)*
- [ ] **M6** — source filter chips on the sessions list, backed by `?source=` / `?ownership=` / `?remoteControlled=`

Order: S1 → S2 → **S2a → S2b** → S3. S2b gates everything downstream for desktop-app sessions. S5 and M5 ship together (§5). S4 before M4.

---

## 9. Evidence

Every claim about the desktop app in this document was measured on 2026-07-30, macOS, with both sessions live simultaneously — not inferred from documentation.

| Claim | How it was established |
|---|---|
| `entrypoint: "claude-desktop"` exists and is first in the file | `grep -o '"entrypoint":"[^"]*"'` over both transcripts; first byte-offset occurrence checked separately |
| The desktop app runs a bundled per-version binary | `ps -o args= -p 61556` |
| It runs headless, not as a TUI | `--output-format stream-json --input-format stream-json --permission-prompt-tool stdio` in that argv |
| Its ancestry reaches `/Applications/Claude.app` | `ps -o ppid=` walk: `claude ← Claude.app/Contents/Helpers/disclaimer ← Claude.app/Contents/MacOS/Claude ← launchd` |
| It has no controlling tty | `ps -o tty= -p 61556` → `??`, against `ttys002` for the terminal session |
| Its argv carries no `--resume` / `--session-id` | grep over the full argv; hence `extractResumeId` returns null and `SessionStore.list()` drops it |
| Two desktop sessions can run concurrently in one cwd | pids 47336 and 61556, both cwd `~/dev/cv`, transcripts `4ada75ca…` and `bb94c668…` |
| The CLI does not hold its transcript open | `lsof` on both files returned only pid 55430 — the streamer's own read-mode watchers at `fd=20r`/`fd=21r` |
| Process start correlates with first record to ~1.5 s | `ps -o lstart=` against the minimum `timestamp` in each transcript: 11:11:10→11:11:11.163, 11:02:16→11:02:17.466 |

A corpus sample taken ten minutes earlier contained **zero** `claude-desktop` entries and led to the opposite conclusion — that the JSONL could not distinguish these sources. It was wrong because the session did not exist yet. Anything re-derived from a corpus snapshot later should be re-measured the same way rather than trusted from this table.

### 9.1 `RemoteTrigger` is not a signal

Checked because it appeared in a desktop transcript and looked like it might mark a mode. It does not:

| entrypoint | files containing `RemoteTrigger` |
|---|---|
| `cli` | 141 |
| `sdk-cli` | 3 |
| `claude-desktop` | 2 |

146 of 956 transcripts, exactly 2 occurrences each, across many unrelated projects. Both hits are the deferred-tool **name list** injected as a system reminder (`…"PushNotification","RemoteTrigger","SendMessage"…`). It marks "this session had deferred tools available" — a recent CLI capability present in ordinary terminal sessions — and carries no information about launch host or remote execution. Neither the transcript nor the process argv of either desktop session contained any remote/cloud/sandbox flag.

**Specifically tested: is `RemoteTrigger` a marker of [Remote Control](https://code.claude.com/docs/en/remote-control)?** No. Three independent disproofs:

1. The Remote Control documentation never mentions a `RemoteTrigger` tool. It names entirely different markers — see §9.2.
2. **Zero `tool_use` invocations** of `RemoteTrigger` across all 956 transcripts. It appears only inside the tool *name list*, never as a call.
3. **Zero overlap.** 146 transcripts contain `RemoteTrigger`; 5 contain `remote-control`; the intersection is empty. If it were the marker, the overlap would be near-total instead of nil.

Those 5 `remote-control` files are conversations *about* the feature, not sessions using it — the largest (91 occurrences) is the session in which this document was written. **The corpus contains no evidence Remote Control has ever actually been used on this machine**, which is also why it cannot be used to calibrate detection.

**Two intermediate results during this check were wrong**, both from the unguarded-path bug in §2.5's implementation note: first "all 146 files have no entrypoint", then "the field is largely absent from the corpus". Both were `grep` silently failing on `-Users-…` arguments. The table above is the corrected measurement, taken with `--` guards.

### 9.2 Remote Control is an orthogonal attribute, and it matters

Investigating §9.1 surfaced something more useful than the answer. [Remote Control](https://code.claude.com/docs/en/remote-control) is Anthropic's first-party version of what this streamer does: a local `claude` process, driven from claude.ai/code or the Claude mobile app, with execution and filesystem access staying on the machine.

A session under Remote Control is therefore **already being steered from the user's phone by another controller**. Overtaking it, or stopping it, means intervening in a session someone may be actively driving from a second device — a different situation from both a terminal session (nobody else attached) and a desktop-app session (attached, but local).

Unlike the desktop app, the markers are unambiguous and live entirely in argv, which discovery already reads:

| Invocation | argv shape |
|---|---|
| server mode | `claude remote-control …` (subcommand) |
| interactive | `claude --remote-control` or `claude --rc` |
| from a running session | `/remote-control` / `/rc` — leaves no argv trace; the process was already running |
| supporting flags | `--name`, `--spawn`, `--capacity`, `--create-session-in-dir`, `--remote-control-session-name-prefix` |
| env | `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` |
| kill switch | `disableRemoteControl` setting |

**Handling**, consistent with §4.4's reasoning:

- `remoteControlled: boolean` on `SessionResponse`, **orthogonal to `source`** (§2.8), set from the `remote-control` subcommand or the `--remote-control` / `--rc` flag.
- Persisted as `conversation_meta.remote_controlled` (§2.9) so the label survives the process, with sticky past-tense semantics.
- `adopt` **refuses** when the live value is true — `ADOPT_REMOTE_CONTROLLED`. Two controllers steering one agent is worse than either alone.
- `stop` is allowed with confirmation, and the confirmation must say the session is being controlled remotely.

**Known limit, stated rather than papered over.** The `/remote-control` slash command enables Remote Control on an *already-running* process, so its argv never changes. That session reports `remoteControlled: false` and is indistinguishable from a plain terminal one by every signal in §2.2. The docs describe a `/rc active` footer indicator, but that is rendered TUI text the streamer cannot read from outside the process. This case is **not detectable** with the mechanisms in this spec.

That is precisely why `remoteControlled` absent or `false` must be read as *"not observed as remote-controlled"* rather than *"not remote-controlled"* — and why the `adopt` refusal is a guard against the detectable case, not a guarantee about the undetectable one.

Detection here is also **uncalibrated**: the corpus contains no session that actually used Remote Control (§9.1), so these rules are derived from documentation rather than from observed transcripts. They should be verified against a real Remote Control session before the refusal in `adopt` is relied upon.
