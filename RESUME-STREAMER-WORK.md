# Resume prompt — remaining tb-streamer implementation work

> ## ⚠️ COMPLETE — historical record, do not execute
>
> Every item below has shipped. Kept for the reasoning and the environment notes, which are still accurate; the instructions are not.
>
> | Item | Plan PR | Merged as |
> |---|---|---|
> | 1 — redacted `bootTokenMatches` | — | #326 |
> | 2 — auto-resume boot flow | 12 | #327, follow-ups #328 |
> | 3 — reconnect on boot | 8 | #329, follow-up #330 |
> | 4 — supervision | 9 | #331 |
> | 5 — Windows / ConPTY | 10 | #332 |
>
> The live-sessions-persistence plan is finished on the streamer side (PRs 0–12). The only remaining plan item is **M2** in `tb-mobile`, which is optional — see `KICKOFF-M2-interrupted-status.md` in that repo.

Supersedes `RESUME-PRS-8-9-10.md` (deleted). Paste everything below the line into a fresh session.

---

Implement the remaining tb-streamer work from the live-sessions-persistence plan: **Items 3, 4 and 5 below** (plan PRs 8, 9, 10). Each its own PR, in order. Stop and check in if any one turns out bigger than described.

**Items 1 and 2 are already merged — do not implement them.**

## Repo state

- Working branch for everything: **`integration/missing-prs-2026-07-23`**, tip **`091ba1d`**. Base every PR on it, target it with `gh pr create --base integration/missing-prs-2026-07-23`.
- The live streamer is deployed from this branch, but from an **older** build (`1.33.0+c470ce9`) — it predates #326 and #327, so auto-resume is not yet running on the live instance.
- `main` is ~235 commits behind and is *not* what runs. Another session may be landing PRs onto `main` — treat `main` as moving and irrelevant to you.
- #301–#327 are all merged. Nothing of this plan is open.

Plan docs (read the phase you are working on, not all of them):
- `docs/plans/live-sessions-persistence-plan.md` — Phases 6c/6d/6e for items 3–5, Phase 7c for item 2
- `docs/architecture/2026-07-24-durable-session-runtime.md` — alternative D, the pty-host rationale
- `docs/compatibility/tb-mobile.md` — **read before touching any response shape**

## Working agreement

- **One PR at a time**: rebase onto the branch tip → CI green → squash-merge → next. A merged PR advances the tip, so the following one must be rebased again.
- **Show the staged diff and the proposed commit message before committing, and wait for approval.**
- Work in your own git worktree under `~/dev/ai-tools/tb-streamer-worktrees/`, never in the repo root.
- Conventional-commit titles. No AI attribution anywhere. One sentence per line in all GitHub-bound prose.
- Anything touching `SessionResponse` needs a `docs/compatibility/tb-mobile.md` update **in the same commit**.
- Every new feature needs tests in `__tests__/`.

---

## Item 1 — DONE (#326) — context only, do not implement

A defect shipped in #321, found by deploying. `GET /api/diagnostics/sessions` returns `"bootTokenMatches": "[redacted]"` for what is a **boolean**: `redactValue`'s `SECRET_KEY_RE` (`src/services/diagnostics/diagnostics.ts:142`) matches any key containing `token`, so the field is scrubbed as if it were a credential and is useless as shipped.

Rename it to **`recordedThisBoot`** in `src/api/routes/diagnostics.routes.ts` — it does not trip the regex, and it is a truer name for what the field means ("was this pid recorded during the current machine boot, i.e. is it probeable at all"). Add a test asserting the diagnostics payload carries a real boolean, since the whole failure mode is that it silently became a string.

Do **not** weaken `SECRET_KEY_RE`. Its over-broad matching is the safe direction for a payload designed to be pasted into bug reports.

## Item 2 — DONE (#327) — context only, do not implement

`#323` shipped the `auto_resume_on_boot` setting and its one-time prompt; **nothing reads the value**. This closes that loop. Both prerequisites are merged: the setting, and `resumeSession()` extracted from `handleResume` in `#324`.

Runs after Phase 1's rehydration, reusing its row set. A row is eligible only if **all** hold:

1. `status_source = 'shutdown'` — we stopped it; an agent that exited on its own is finished.
2. `status` was `running` or `waiting_input` at shutdown. (`#321` made `recordShutdownState` persist the live status instead of a flattened `idle` — that is what makes this check possible.)
3. `status_updated_at` within `AUTO_RESUME_WINDOW_MS` (15 min) — a restart, not last week.
4. The project directory still exists.
5. `resumeIdForRow(row) != null` — provider resume identity is available (Phase 3).

Then drive `resumeSession()` with a **concurrency cap of 2**, a stagger between spawns, and a hard ceiling of `AUTO_RESUME_MAX` (5) per boot. Anything past the ceiling is left for the user and **logged**, never silently dropped.

**`force` is never passed.** `conversationBusy`'s pre-flight still applies, so a conversation an external terminal already picked up is skipped with a logged reason rather than fought over. This is the whole reason `resumeSession()` was extracted — do not bypass it.

Read `config.autoResumeOnBoot` (already on `ServerConfig`, set by the CLI). Note `#323` deliberately did *not* add a private field on `StreamerServer` because nothing read it — add it now.

## Item 3 — Plan PR 8: reconnect on boot (Phase 6c) — START HERE

The first **non-additive** step in the pty-host work. Everything before it is inert by construction.

Gate it behind a **`ptyHost` feature flag** in `src/feature-flags.ts`, **default off** — follow the `sessionRehydration` entry as the pattern, and note flags resolve at boot only.

- `LiveSessionManager` chooses `RemoteSessionRunner` over the in-process runners when the flag is on; the streamer calls `connectOrSpawnHost()` (already written in `src/pty-host/spawn-host.ts`, currently called by nothing) at startup.
- Re-adopt live sessions and report `lifecycle: "attached"` with `lifecycleSource: "reconcile"` — the first time that pair is reachable after a restart (audit G10).
- Serve `terminal_replay` from the host's screen; the `replay` request already returns `{ lines, output }`.
- Rehydration (Phase 1) becomes the fallback for whatever the host could not keep.

**The duplicate-session trap — verified, not hypothetical.** A host-owned session and a Phase 1 rehydration stub must never *both* appear in `GET /api/sessions`. I checked tb-mobile on `land/integration-prep`:

- `hooks/useSession.ts:82` pushes every returned session with **no dedupe**
- the FlatList key is `` `${item.session.serverId}::${item.session.id}` `` (`components/sessions/classic/ClassicSessionsList.tsx:87`)

Two entries for one id collide on the React key. (`hooks/useConversations.ts:53` has `dedupeByServerAndId`; the *sessions* list does not.) Two server-side guards hold today — `SessionStore.managed` is a Map keyed by id, and `rehydratePreviousSessions` skips a row already in the store — but PR 8 is the first time a live session is reconstructed from something other than a spawn this process performed. **Write an explicit test that one id yields exactly one entry after a host reconnect.**

**Process discovery will start finding host-spawned agents.** They are children of the host, not the streamer, so `discoverClaudeProcesses()` sees them. `SessionStore.list()` skips a discovered process whose `conversationId` matches a managed session (`src/session-store.ts:71`) — fine for Claude (argv carries the id) and for fresh Codex (no id in argv → `conversationId` null → dropped by the `!d.conversationId` guard). **Confirm both still hold once the host owns the spawns.**

## Item 4 — Plan PR 9: supervision (Phase 6d)

- **Version handshake** — a host built from a different streamer version is killed and respawned, not driven. `PTY_HOST_PROTOCOL_VERSION` already rides on the `status` response.
- **Heartbeat.**
- **Orphan-host reaping** when no registry row references it.
- A **`tb-streamer prod doctor`** check reporting host liveness and version.

## Item 5 — Plan PR 10: Windows / ConPTY qualification (Phase 6e)

`SETSID` and controlling-terminal hangup are POSIX semantics; ConPTY teardown differs. Assert **observed** behaviour, do not assume parity, and document whichever way it resolves — **including "the host buys nothing on Windows", if that is the answer.**

**Established already, do not re-derive.** In `.github/workflows/ci.yml`: the full suite (`Test (Node 20/22/24)`) runs on **ubuntu-latest only**. There is a `windows-latest` runner but it runs only `npm run test:smoke`, and it is `continue-on-error: true` — informational, never a merge gate.

So "observed behaviour" is reachable by adding assertions to the smoke suite and reading that job's output: real observation, ~5 min per round trip, cannot block a merge. **State plainly which Windows claims were observed and which are assumed.**

---

## What already exists in `src/pty-host/`

All merged, all inert — nothing wires any of it up:

- `protocol.ts` — NDJSON line protocol, `HostRequest`/`HostEvent`/`HostSession`, `LineDecoder`, `reviveSession`, `PTY_HOST_PROTOCOL_VERSION = 1`
- `remote-session-runner.ts` — `RemoteSessionRunner implements SessionRunner`; mirror seeded by `status` inside `connect()`, which is the only constructor
- `host.ts` — `SessionHost`, idle reaper **inside the host**, `HOST_IDLE_AFTER_MS`
- `socket.ts` — `hostSocketPath()`, `connectToHost()`, `listenForStreamers()`
- `spawn-host.ts` — `connectOrSpawnHost()` / `spawnDetachedHost()`
- CLI: `tb-streamer pty-host --socket <path>`

Tests: `__tests__/pty-host-protocol.test.ts` (in-memory transport, 28), `__tests__/pty-host-process.test.ts` (real socket, 12).

## Hard constraints across all items

- **No wire change without a compatibility entry.** `attached` is already in the `SessionLifecycle` union — the host makes it *reachable after a restart*, it does not introduce it. tb-mobile reads neither `lifecycle` nor `lifecycleSource` (grepped: zero hits on `land/integration-prep`); it keys on `status` and `ptyAttached`. Additive only.
- **A machine reboot is unchanged.** After a reboot the host is gone too, and Phases 1–5 are still what recovers the session. Do not regress that path.
- **With `ptyHost` off, behaviour must be byte-identical to today.**
- G7 (weak `projectPath` argv token for unbound Codex) remains **accepted residual risk** — do not widen scope to fix it.

## Environment notes (hard-won — read before debugging anything)

- Fresh worktree has no `node_modules`. If `git rev-parse HEAD:package-lock.json` matches the root checkout's, symlink `/Users/ronenmars/dev/ai-tools/tb-streamer/node_modules` in — instant, and pre-approved. **Remove the symlink before `git add`.** Otherwise ask before `npm ci`.
- Node from `.nvmrc` (v24.15.0): `source ~/.nvm/nvm.sh && nvm use`.
- **The local suite degrades badly under sustained load.** Baseline flakes, all 15 s timeouts, all passing in isolation: `cors-middleware` ×2, `codex-resume` ×1–2. Under load `pair-endpoints`, `watch-for-jsonl`, `webhook-update`, `discovery-cache` and others join — one run late in a long session hit 19 failures on a tree CI had already passed. **Always re-run in isolation before concluding anything, and treat CI on clean runners as the verdict.**
- Plain `grep` is unreliable in this environment's subshells — use `/usr/bin/grep`. Same for git: `/opt/homebrew/bin/git`.
- `gh pr merge --squash --delete-branch` prints `fatal: '<branch>' is already used by worktree` from its local-checkout step **after the merge has already succeeded**. Verify with `gh pr view <n> --json state`, not the exit code.
- **Deploying**: `npm run deploy` refuses to run off `main`, and `--force` skips *both* the branch check and lint/tests. Run `npm run lint`, `npm run build` and the suite manually first, then `npm run deploy:force`. Check `/api/sessions/count` before deploying — a redeploy restarts the streamer and ends live sessions.

## Known loose ends — flagged, not in scope

- **`enrichResumedSessionAsync` mutates a throwaway copy.** It calls `sessionStore.get()`, which returns a fresh object from `managedToResponse`, so its `sessionName`/`model`/`preview` writes never reach the store; its repo writes (project upsert, `updateConversationProjectId`) do take effect. Pre-existing, found during #324. Worth its own PR — decide deliberately, don't fix it inside another change.
- **Cache integrity alert is live** on the deployed instance: `severity: low, missingCount: 3`, visible in every `/healthz`. Predates this work.

## Not implementable here

- **PR M2** — tb-mobile adopting `interruptedStatus`. Different repo (`~/Desktop/dev/ai-tools/tb-mobile`), optional, purely additive.
- **Landing the integration branch on `main`** — a merge/triage operation, not implementation. See `LANDING-integration-to-main.md`; `main` is 234 commits behind and the gap grows while work continues here.
