# Provider Version Drift Check

**Date:** 2026-07-27
**Status:** Proposed
**Scope:** tb-streamer — daily scheduled probe, server startup surfacing, tb-mobile update prompt, mobile-triggered consent-gated update flow

---

## Problem

Claude Code and Codex CLI ship new versions almost daily. `VERIFIED_AGAINST` (`src/services/providers/providerHealth.ts`) records the versions our detectors and fixtures were captured against, and `compareToVerified()` already warns when the installed version falls outside that range (see `docs/architecture/2026-07-24-provider-compatibility.md`, "C2"). That warning is a report, not a check — nothing runs the newly-released CLI to find out whether it actually still behaves the way our detectors and parsers assume.

At the release cadence these providers ship at, waiting for a user to hit a stuck session is too slow a feedback loop, and manually re-verifying every release is too much toil to sustain. We want a mechanism that empirically checks new releases on a schedule and tells us — concretely, not by guessing from changelogs — whether anything structural changed.

## Goals

- Catch real structural drift (JSONL schema changes, broken prompt detection) within a day of a new release, without a human doing the check by hand.
- Never guess. The check is grounded in actually running the CLI and diffing real output against a known-good fixture — not an LLM inferring risk from public docs.
- Zero cost on days nothing changed.
- Warning-only: never blocks CI, never blocks a release, never writes code to the repo unattended.
- Keep the repo's existing rules intact: no direct pushes to main, no unreviewed code changes landing automatically.
- Give mobile a real, consented way to trigger an update when the server reports it's outdated (for either provider drift or a normal streamer release), instead of a banner with no action behind it.
- Any update triggered from mobile is explicit and informed: the user sees the consequences (active sessions that will be interrupted) before approving, and sees a second, separate approval before anything is hard-killed.

### Non-goals

- Making detection itself version-proof or provider-agnostic (out of scope; see C2's "Known limits").
- Any LLM/agent call for judgment. Every decision in this pipeline is deterministic code.
- Changing `ci.yml` or its PR-triggered jobs — this is a separate, independently scheduled workflow.
- Auto-merging or auto-committing anything. The daily job's only repo-visible side effect is opening a GitHub issue.

---

## Design

### Component 1 — Daily probe workflow

New file: `.github/workflows/provider-drift-check.yml`, triggered by:
- `schedule:` (daily cron)
- `workflow_dispatch:` (manual re-run)

For each provider (`claude-code`, `codex`), the job:

1. **Detect latest.** `npm install -g` (or provider-equivalent) the CLI at `@latest`; capture the resolved version string via the same `parseVersionOutput()` used today.
2. **Short-circuit.** If that version equals `VERIFIED_AGAINST[provider].captured[0]`, stop here — nothing to check, zero probe cost. This is the common case on most days.
3. **Probe.** Otherwise:
   - `mkdtemp` a fresh, empty scratch project directory.
   - Spawn the CLI through the existing spawn path (`pty-manager.ts` / `codex-pty-runner.ts`) in bypass/auto-approve mode, so a first-run trust/permission gate is exercised and auto-handled rather than hanging.
   - Send the prompt `"print Hello on the screen"`.
   - Wait for our existing `waiting_input` detection to fire (reusing real detection code — this is itself a live check that prompt-marker detection still works against the new version).
   - Read the JSONL the CLI wrote into the scratch directory.
4. **Structural diff.** Run `collectKeySets()` (new helper) over the probe's JSONL: group lines by their discriminator field (e.g. `type` for Codex, envelope shape for Claude) and record the set of keys seen per group. Compare against `collectKeySets()` run over the baseline fixture at `__tests__/fixtures/providers/<provider>/<VERIFIED_AGAINST[provider].captured[0]>/`.
5. **Branch on outcome:**
   - **PASS** — probe reached `waiting_input` cleanly, and the key-sets match exactly (no added/removed/changed keys per envelope type). No notification, no issue — nothing needs a human's attention, so nothing is raised. The only trace is the workflow run itself in the Actions history.
   - **FAIL** — probe never reached `waiting_input` (crash, timeout, gate never resolved), or the key-set diff is non-empty. Open a GitHub issue via a fixed template containing: old/new version, the concrete key diff (added/removed keys per envelope type) or the failure point with a raw terminal/JSONL excerpt, and a link to the workflow run. Notify Telegram: `⚠️ <provider> <old> → <new>: structural change detected, issue #NNN opened — needs review.`

**No PRs, no commits, from this job — ever.** The only repo-visible side effect, and only on FAIL, is opening a GitHub issue. A human decides when and how to act on it (typically: manually bump `VERIFIED_AGAINST.captured` and refresh the fixture in a normal reviewed PR).

The issue template is fixed text with interpolated facts (versions, diff, excerpt) — no LLM call anywhere in this pipeline.

### Component 2 — Telegram notification

- A new, dedicated Telegram bot (created and owned by the user; not the bot backing the existing `TELEGRAM_BOT_TOKEN` convention used elsewhere).
- New repo secrets: `PROVIDER_WATCH_TELEGRAM_BOT_TOKEN`, `PROVIDER_WATCH_TELEGRAM_CHAT_ID`.
- Delivery is a plain HTTP POST to `https://api.telegram.org/bot<token>/sendMessage` — no `semantic-release` plugin involved; `semantic-release` only runs on tb-streamer's own release push and has no hook for an external, scheduled check like this.
- Fires only on FAIL, only from the daily job. A PASS is silent (see Component 1). Startup never notifies via Telegram.

### Component 3 — Server startup (existing mechanism, new surfacing)

- No change to the startup check itself: it keeps calling the existing `providerHealth()` → `compareToVerified()` version-string comparison. No probe, no Telegram, no repo writes.
- New: the resulting warning becomes visible to tb-mobile. Exact wire shape (extending `/api/providers`, or another existing session/status payload mobile already polls) is a decision for the implementation plan — this spec fixes the *behavior*, not the wire format.
- Mobile copy: **"Threadbase-Streamer is outdated — press here to update and restart the streamer."**
- Tapping it drives the mobile-triggered update flow defined in Component 4 below — **not** the existing `POST /api/__update` webhook (see Component 4 for why that endpoint doesn't fit).

### Component 4 — Mobile-triggered update flow

**Why this can't reuse `POST /api/__update` as-is.** That webhook (`src/api/routes/misc.routes.ts:208`) is HMAC-signed (`X-Threadbase-Signature`, verified against `webhook_secret` in `update.yaml`), not Bearer-authed — mobile only ever holds the regular API key, never the webhook secret, and extending mobile to know it would mean shipping a shared secret to every device. It also always calls `update --force`, which skips `defer_if_active_sessions` entirely and gives no chance for a client to see or approve the consequences first. It exists for CI-triggered "just update now" calls, not a user-consented, observable flow. It stays as-is for that purpose; the mobile flow is new, separate, and Bearer-authed like every other mobile-facing endpoint.

**Install-kind scoping.** `runInstall()` (`src/updater/install.ts:54`) already refuses on Homebrew installs (`isBrewInstall()`) and tells the caller to run `brew upgrade tb-streamer` manually — the updater's file-swap never touches the Homebrew Cellar. This flow does not attempt to work around that: a Homebrew-installed streamer reports `installKind: "homebrew"` and mobile shows an honest "can't self-update — run `brew upgrade tb-streamer` on the host machine" message instead of offering the update button. Only npm/tarball installs get the full flow, matching what the CLI updater already supports.

**Endpoints** (all Bearer-authed, alongside the existing mobile API):

```
GET  /api/update/status
  -> { installKind: "npm" | "tarball" | "homebrew" | "unsupported",
       current: string, latest: string | null, activeSessions: number }

POST /api/update/start
  Body: {} to begin, or { jobId, hardKill: true } to escalate an existing
  stuck job. Returns { jobId } either way. Idempotent on a stuck jobId: calling
  it again without hardKill while state === "stuck" is a no-op that just
  returns the existing jobId — only hardKill:true advances a stuck job.

GET  /api/update/progress?jobId=<id>
  -> { state: "holding" | "stuck" | "installing" | "restarting" | "done" | "failed",
       stuckSessions?: string[] }
  Mobile polls this to drive its own UI through the flow.
```

One endpoint drives the whole flow instead of a separate force-kill route — folding "continue this job, forcing through stuck sessions" into the same `start` call keeps there being exactly one place that knows how to advance a job, rather than splitting that logic across two handlers that'd each need their own jobId lookup.

**Flow, driven by `POST /api/update/start`:**

1. **Check** (`GET /api/update/status`, called by mobile before showing the prompt). Reports install kind, current/latest version, and current active-session count — this is the data behind Component 3's banner and the "informing of consequences" step.
2. **Inform + approve.** Mobile shows the banner/prompt with the session count so the user understands sessions will be interrupted, and only calls `POST /api/update/start` (empty body) on explicit tap-through. This is the sole consent gate — once called, the flow proceeds through active sessions rather than deferring (matching `update --force` semantics), because the user already saw the count and approved.
3. **Graceful hold.** For every currently-running session, the server calls the existing `PTYManager.putOnHold()` — the same mechanism the `hold_session` WS message and the grace-timer already use (SIGINT + screen disposal, history intact, session resumable afterward). This is not a new kill path; it reuses the one safety property the app already relies on elsewhere.
4. **Bounded wait.** The flow waits up to a fixed timeout (exact value TBD at implementation time, ballpark 10–15s) for every held session to reach `on_hold`. Sessions that settle within the window proceed normally.
5. **Stuck escalation.** Any session still not `on_hold` when the timeout elapses stops the flow there: `GET /api/update/progress` reports `state: "stuck"` with the list of stuck session ids. Mobile must show a second, explicit approval ("N sessions aren't responding — force-close them?") before calling `POST /api/update/start` again with `{ jobId, hardKill: true }`. No silent hard-kill, and no silent indefinite wait — the flow always surfaces the stuck state and asks again rather than picking a default on the user's behalf.
6. **Install.** Once sessions are held (or hard-killed via the `hardKill` escalation), the flow calls `runInstall({ force: true, runningServer: {...}, ... })` — the same `src/updater/install.ts` entry point the CLI `update` command and the existing webhook already use. No new download/swap/restart logic; this only adds a new, consent-gated caller of the existing installer.
7. **Restart + report.** `runInstall` already handles the platform-specific restart (`restartService()`, `waitForRestartHealth()`) and Windows' `stopService()`-before-swap ordering. `GET /api/update/progress` reflects `installing` → `restarting` → `done`/`failed` so mobile can show real progress instead of a blind spinner.

**Reused, not rebuilt:** `runInstall()`, `PTYManager.putOnHold()`, `isBrewInstall()`, `restartService()`/`waitForRestartHealth()`, the entire download/verify/swap/prune pipeline. This component adds a new Bearer-authed, consent-gated entry point in front of that existing machinery — it does not duplicate any of it.

**Known limits (Component 4):**
- The stuck-session timeout value needs tuning against real hold latency; too short produces false "stuck" escalations, too long makes mobile feel unresponsive during a legitimate update.
- `jobId` state needs to survive the process restart triggered by the update itself for `GET /api/update/progress` to report `done` rather than going unreachable mid-flow — mobile should treat a progress-poll connection failure during `restarting` as expected, not as `failed`, and fall back to polling `/healthz` for the new version.
- Concurrent update requests (two devices tapping "update" near-simultaneously) are not addressed here; the implementation plan should decide whether a second `POST /api/update/start` while a `jobId` is in flight returns the existing job or rejects.

---

## Data / new artifacts

- `collectKeySets()` — new pure function (proposed location: alongside `providerHealth.ts` or a new `src/services/providers/structuralDiff.ts`), used by both the daily job script and (indirectly) by nothing else — this is a new capability, not a repurposing of existing test code, since today's fixture tests assert against frozen captures rather than live CLI output.
- New GitHub Actions workflow file.
- New repo secrets for the dedicated Telegram bot.
- New issue templates (fixed text, not `.github/ISSUE_TEMPLATE` — generated inline by the job script since they interpolate diff data).

## Known limits

- The probe only exercises one path: a trivial prompt in a fresh directory, auto-approved. It does not exercise structured-question menus, resume semantics, or any gate beyond the first-run trust gate. A structural change confined to a code path this probe never reaches will not be caught. (Same caveat C2 already states about detection in general — this narrows but does not close that gap.)
- API cost: each version bump costs one real API call per provider to run the probe. Bounded by the short-circuit (step 2), so cost only occurs on days a version actually changed — expected to be near-daily given the stated release cadence, but never more than once per provider per day.
- The daily job needs real, dedicated API credentials in CI (a repo secret) — a new secret-management surface that doesn't exist today.
- This does not make detection itself more robust — it only shortens the time between a breaking release and us finding out about it.

---

## Test plan

| Requirement | Test |
|---|---|
| Short-circuit | Given installed version == `VERIFIED_AGAINST.captured[0]`, the probe step is skipped entirely |
| Key-set diff, clean | Probe output with identical envelope key-sets to the baseline fixture yields PASS |
| Key-set diff, drift | A synthetic probe output with an added/removed key yields FAIL with the specific diff reported |
| Probe failure | A probe that never reaches `waiting_input` (simulated timeout) yields FAIL with a failure-point excerpt, not a false PASS |
| No repo writes | Neither branch creates a commit, branch, or PR — the only GitHub API call the job ever makes is issue-creation, and only on FAIL |
| Silent PASS | A PASS produces zero GitHub API calls and zero Telegram messages |
| Telegram delivery | FAIL produces exactly one Telegram message with the expected content shape |
| Startup unaffected | Server startup behavior (log line, `/api/providers` warning) is unchanged by this work except for the new mobile-facing field |
| Homebrew refusal | `GET /api/update/status` reports `installKind: "homebrew"` and `POST /api/update/start` refuses with a message pointing at `brew upgrade`, matching `runInstall()`'s existing behavior |
| Consent gate | `POST /api/update/start` is never called by mobile without the user first seeing `GET /api/update/status`'s active-session count (an integration/UX assertion on the mobile side, not just the server) |
| Graceful hold reused | The update flow's hold step calls the same `PTYManager.putOnHold()` path as the existing `hold_session` WS message — no parallel kill mechanism introduced |
| Stuck escalation | A session that never reaches `on_hold` within the timeout produces `state: "stuck"` with its id listed, and `POST /api/update/start` with `hardKill: true` is rejected unless progress currently reports `stuck` |
| Install reuse | The flow's install step calls the existing `runInstall()` with `force: true` — no duplicated download/verify/swap/restart logic |

## Implementation order

1. `collectKeySets()` + structural diff logic, unit-tested against the existing fixtures (no CI wiring yet).
2. Probe script: spawn + prompt + JSONL capture, runnable locally against an installed CLI.
3. GitHub Actions workflow wiring the probe + diff + issue creation, gated behind `workflow_dispatch` first for manual validation before enabling `schedule:`.
4. Telegram notification step.
5. `GET /api/update/status` — read-only, install-kind + version + active-session reporting. Safe to ship alone; nothing calls it yet.
6. `POST /api/update/start` + `GET /api/update/progress` + the hold → wait → escalate (via `hardKill`) → install → restart state machine, built on the existing `runInstall()`/`PTYManager.putOnHold()`/`restartService()` primitives.
7. Mobile-facing startup surfacing (wire shape + copy) and wiring the update button to steps 5–6 — coordinated with tb-mobile per the existing backward-compatibility rules.

Each step is independently revertible; steps 5–7 are additive endpoints/fields only and touch no existing mobile contract until step 7, which should follow the existing `docs/compatibility/tb-mobile.md` process.
