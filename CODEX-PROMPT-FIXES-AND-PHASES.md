# Codex prompt — #327 follow-ups, then plan PRs 8–10

> ## ⚠️ COMPLETE — historical record, do not execute
>
> Job A merged as **#328**; B1 as **#329** plus follow-up **#330**; B2 as **#331**; B3 as **#332**.
>
> Kept because the framing of each task — particularly the duplicate-session trap and the Windows observed-vs-assumed constraint — is what made the resulting PRs come out right, and is worth reusing.

Paste everything below the line into Codex, run from `/Users/ronenmars/dev/ai-tools/tb-streamer`.

---

You are working in the `tb-streamer` repo (`/Users/ronenmars/dev/ai-tools/tb-streamer`). Read `AGENTS.md` and `CLAUDE.md` in the repo root first — they carry the project's conventions and are binding.

Two jobs, in order. **Job A is three small follow-ups to a merged PR. Job B is three feature PRs.** Do them as four separate PRs total (A is one PR; B is three).

## Ground rules

- Working branch for everything: **`integration/missing-prs-2026-07-23`**, tip **`091ba1d`**. Base every PR on it and target it: `gh pr create --base integration/missing-prs-2026-07-23`.
- **One PR at a time**: rebase onto the branch tip → CI green → squash-merge → next. Each merge advances the tip, so the next PR must be rebased again.
- **Show the staged diff and the proposed commit message, and wait for approval before committing.**
- Work in your own git worktree under `~/dev/ai-tools/tb-streamer-worktrees/`, never in the repo root.
- Conventional-commit titles (`<type>(<scope>): <description>`, imperative, lowercase, no trailing period).
- **No AI attribution** anywhere — no `Co-Authored-By`, no "generated with", no robot footers. All work is attributed to the repo owner.
- All GitHub-bound prose (commit bodies, PR descriptions) is **one sentence per line**, never wrapped mid-sentence.
- **Do not comment on, review, or react to any GitHub PR or issue.** Report findings in your reply instead.
- Every behaviour change needs tests in `__tests__/`.
- Anything touching `SessionResponse` needs a `docs/compatibility/tb-mobile.md` entry in the same commit.

## Environment notes (hard-won — read before debugging)

- Node comes from `.nvmrc` (v24.15.0): `source ~/.nvm/nvm.sh && nvm use`.
- A fresh worktree has no `node_modules`. If `git rev-parse HEAD:package-lock.json` matches the root checkout's, symlinking `/Users/ronenmars/dev/ai-tools/tb-streamer/node_modules` into the worktree is instant and pre-approved — **remove the symlink before `git add`**. Otherwise ask before running `npm ci`.
- Verify with `npm run lint && npm test`.
- **The local test suite degrades badly under sustained load.** Baseline flakes, all 15-second timeouts, all passing in isolation: `cors-middleware` ×2, `codex-resume` ×1–2. Under load `pair-endpoints`, `watch-for-jsonl`, `webhook-update` and `discovery-cache` join them; one run late in a long session produced 19 failures on a tree CI had already passed. **Always re-run a failing file in isolation before concluding anything, and treat CI on clean runners as the verdict.**
- Use `/usr/bin/grep` and `/opt/homebrew/bin/git` — plain `grep`/`git` are unreliable in this environment's subshells.
- `gh pr merge --squash --delete-branch` prints `fatal: '<branch>' is already used by worktree` from its local-checkout step **after the merge has already succeeded**. Verify with `gh pr view <n> --json state`, not the exit code.

---

# Job A — three follow-ups to PR #327 (one PR)

PR #327 (`feat(sessions): auto-resume interrupted sessions at boot`, merged as `091ba1d`) implemented plan Phase 7c. It is sound — the collision probe is respected, `force` is never passed, the eligibility rules and caps are correct. A post-merge review found three gaps. Fix all three in **one** PR.

Relevant files: `src/server.ts` (`autoResumePreviousSessions`, `rehydratePreviousSessions`), `src/services/sessions/autoResumeOnBoot.ts`, `__tests__/auto-resume-on-boot.test.ts`.

### A1 — Auto-resumed sessions are never broadcast (the real one)

`autoResumePreviousSessions` calls `this.resumeSession(...)`, which adds the session to `SessionStore` but **does not broadcast**. The broadcast lives in `handleResume`, because it needs the HTTP `req` to unicast to the requesting client (see PR #324, which extracted `resumeSession` out of `handleResume`).

Consequence: sessions started at boot produce no `session_update` / `session_list`. A WebSocket client that connects *during* the resume sequence — which can run for several seconds, given the 500 ms stagger plus per-resume discovery probes — receives a partial list and never learns about the rest.

Fix: broadcast the session list once after the resume loop completes, using `this.wsHub.broadcast(...)`. Do **not** broadcast per session — a burst of five list broadcasts at boot is worse than one. Look at how `broadcastOrUnicastSessionList` builds its payload and reuse the same message shape so clients see nothing novel.

Test: a client connected before boot-time auto-resume receives a session-list message covering the resumed sessions.

### A2 — The `sessionRehydration` kill switch no longer stops boot-time agent starts (document, do not "fix")

#327 changed `rehydratePreviousSessions` so it queries `listRecoverable()` and returns the rows **even when `featureFlags.sessionRehydration` is off**, so auto-resume can use the same bounded row set. That is a deliberate, defensible decision — the two settings are independent — and the code comment says so.

But it is invisible from outside: an operator who turns `sessionRehydration` off reasonably expects nothing session-related to happen at boot, and agents can still be started.

Fix: **documentation only, no behaviour change.** In `CLAUDE.md`, in the feature-flags table entry for `sessionRehydration` and in the auto-resume section, state explicitly that `sessionRehydration=off` does **not** disable `auto_resume_on_boot`, and that the only switch for unattended starts is `auto_resume_on_boot: false`. Keep it to a couple of sentences.

### A3 — Per-row skip logging is noisy (cosmetic)

`autoResumePreviousSessions` emits one info line per ineligible row. With the setting on and a full 25-row recoverable set, that is up to 25 info lines every boot, most of them `not_shutdown` — which is the *normal* state for most rows, not a problem worth a line each.

Fix: log a **single info line carrying counts by reason** (mirror the `skippedBy` shape already used by the `sessions.rehydrated` event), and drop the per-row detail to `debug`. Keep `ceiling_reached` overflow rows at **info** and per row — those are the ones a user might act on, and the plan explicitly requires overflow to be reported rather than silently dropped.

Do not remove the reasons themselves; they are the point.

---

# Job B — plan PRs 8, 9, 10 (three PRs)

The pty-host feature: keep an agent alive across a streamer restart by having the PTY master fd held by a process that is not being restarted. See `docs/plans/live-sessions-persistence-plan.md` (Phase 6) and `docs/architecture/2026-07-24-durable-session-runtime.md` (alternative D).

**What already exists and is merged, but is wired to nothing:**

- `src/pty-host/protocol.ts` — newline-delimited JSON protocol, `HostRequest`/`HostEvent`/`HostSession`, `LineDecoder`, `reviveSession`, `PTY_HOST_PROTOCOL_VERSION = 1`
- `src/pty-host/remote-session-runner.ts` — `RemoteSessionRunner implements SessionRunner`; keeps a local mirror seeded by `status` inside `connect()`, which is the only constructor
- `src/pty-host/host.ts` — `SessionHost`; the idle reaper runs **inside the host**
- `src/pty-host/socket.ts` — `hostSocketPath()`, `connectToHost()`, `listenForStreamers()`
- `src/pty-host/spawn-host.ts` — `connectOrSpawnHost()` / `spawnDetachedHost()`, currently called by nothing
- CLI subcommand: `tb-streamer pty-host --socket <path>`
- Tests: `__tests__/pty-host-protocol.test.ts` (28, in-memory transport), `__tests__/pty-host-process.test.ts` (12, real socket)

## B1 — Plan PR 8: reconnect on boot (Phase 6c)

The first **non-additive** step; everything before it is inert by construction.

Gate it behind a **`ptyHost` feature flag** in `src/feature-flags.ts`, **default off**. Follow the existing `sessionRehydration` entry as the pattern; note flags resolve at boot only.

- `LiveSessionManager` selects `RemoteSessionRunner` instead of the in-process runners when the flag is on; the streamer calls `connectOrSpawnHost()` at startup.
- Re-adopt live sessions and report `lifecycle: "attached"` with `lifecycleSource: "reconcile"` — the first time that pair is reachable after a restart.
- Serve `terminal_replay` from the host's screen; the `replay` request already returns `{ lines, output }`.
- Phase 1 rehydration becomes the fallback for whatever the host could not keep.

**The duplicate-session trap — verified against the mobile source, not hypothetical.** A host-owned session and a Phase 1 rehydration stub must never *both* appear in `GET /api/sessions`. In tb-mobile on branch `land/integration-prep`:

- `hooks/useSession.ts:82` pushes every returned session with **no dedupe**
- the FlatList key is `` `${item.session.serverId}::${item.session.id}` `` (`components/sessions/classic/ClassicSessionsList.tsx:87`)

Two entries for one id collide on the React key. (`hooks/useConversations.ts:53` has a `dedupeByServerAndId`; the *sessions* list does not.) Two server-side guards hold today — `SessionStore.managed` is a `Map` keyed by id, and `rehydratePreviousSessions` skips a row already in the store — but PR 8 is the first time a live session is reconstructed from something other than a spawn this process performed. **Write an explicit test that one id yields exactly one entry in `GET /api/sessions` after a host reconnect.**

**Process discovery will start finding host-spawned agents.** They are children of the host, not the streamer, so `discoverClaudeProcesses()` sees them. `SessionStore.list()` skips a discovered process whose `conversationId` matches a managed session (`src/session-store.ts:71`) — which holds for Claude (argv carries the id) and for fresh Codex (no id in argv, so `conversationId` is null and the `!d.conversationId` guard drops it). **Confirm both still hold once the host owns the spawns.**

## B2 — Plan PR 9: supervision (Phase 6d)

- **Version handshake** — a host built from a different streamer version is killed and respawned rather than driven. `PTY_HOST_PROTOCOL_VERSION` already rides on the `status` response.
- **Heartbeat.**
- **Orphan-host reaping** when no registry row references it.
- A **`tb-streamer prod doctor`** check reporting host liveness and version.

## B3 — Plan PR 10: Windows / ConPTY qualification (Phase 6e)

`SETSID` and controlling-terminal hangup are POSIX semantics; ConPTY teardown differs. Assert **observed** behaviour, do not assume parity, and document whichever way it resolves — **including "the host buys nothing on Windows", if that is the answer.**

**Already established, do not re-derive.** In `.github/workflows/ci.yml`: the full suite (`Test (Node 20/22/24)`) runs on **ubuntu-latest only**. There is a `windows-latest` runner, but it runs only `npm run test:smoke` and is `continue-on-error: true` — informational, never a merge gate.

So "observed behaviour" is reachable by adding assertions to the smoke suite and reading that job's output: real observation, roughly five minutes per round trip, and it cannot block a merge. **State plainly in the PR which Windows claims were observed and which remain assumed.** Do not assert POSIX parity you have not seen.

---

## Hard constraints across every PR here

- **No wire change without a `docs/compatibility/tb-mobile.md` entry.** `attached` is already in the `SessionLifecycle` union — the host makes it *reachable after a restart*, it does not introduce it. tb-mobile reads neither `lifecycle` nor `lifecycleSource` (grepped: zero hits on `land/integration-prep`); it keys on `status` and `ptyAttached`. Additive changes only.
- **A machine reboot is unchanged.** After a reboot the host is gone too, and Phases 1–5 are still what recovers the session. Do not regress that path.
- **With `ptyHost` off, behaviour must be byte-identical to today.**
- G7 (the weak `projectPath` argv token for an unbound Codex session) is **accepted residual risk** — do not widen scope to fix it.

## Known loose end — flagged, deliberately out of scope

`enrichResumedSessionAsync` in `src/server.ts` mutates the object returned by `sessionStore.get()`, which is a fresh object built by `managedToResponse` — so its `sessionName` / `model` / `preview` writes never reach the store. Its repository writes (project upsert, `updateConversationProjectId`) do take effect. Pre-existing, found during PR #324. **Do not fix it inside another change** — if you touch it at all, give it its own PR.
