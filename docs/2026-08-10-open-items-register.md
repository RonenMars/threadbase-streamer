# Open-items register — tb-streamer

> **Audited:** 2026-08-10 against `main` @ `f390d67` (v1.47.0).
> **Supersedes** the three frozen July snapshots, now archived under [`archive/pre-release-snapshots/`](archive/pre-release-snapshots/), and the status tables in [`BACKLOG.md`](BACKLOG.md) / [`ROADMAP.md`](ROADMAP.md) / [`pr-follow/ACTIONS.md`](pr-follow/ACTIONS.md), all three of which were pruned to match this audit on 2026-08-10.

## How to read this

This is a **register**, not a summary: every bug, issue, feature and follow-up found anywhere in `docs/` is listed, including the ones already closed. The closed rows are the point — the recurring failure in this repo is re-opening solved work, and a list that silently drops resolved items cannot prevent that.

**Open items live in the issue tracker, not here.** Every one was filed (section 5), so this document is the audit trail and the record of finished work; GitHub is the worklist. Do not re-rank or re-describe open work in this file — that is how the drift it documents got started.

**Status came from code, not from the source document.** Each row carries the doc's own claim next to a verified status established by reading `main`. Where the two disagree, the verified column wins and the evidence is cited. The drift is large: `BACKLOG.md`'s status table lists eight already-merged PRs as "🔄 In flight", and `pr-follow/ACTIONS.md` (snapshot 2026-08-09 17:45) lists as open an integration branch that landed hours later the same evening.

Verified status vocabulary:

| Status | Meaning |
|---|---|
| `OPEN` | Still real. Reproduced or confirmed absent in code today. |
| `DONE` | Fixed. The closing PR or code site is cited. |
| `SUPERSEDED` | Overtaken by a different design; the original framing no longer applies. |
| `DEFERRED` | Real but deliberately not scheduled — no consumer, or accepted debt. |
| `BLOCKED` | Cannot start; the blocker is named. |
| `DECIDED-NO` | Considered and deliberately rejected. Recorded so it is not proposed again. |

**Scope decisions in force:** Windows **is** in scope for the public release. Live Activity **is** in scope.

### Baseline measured during this audit

- `npx biome check .` → exit 0. `npx tsc --noEmit` → exit 0. `npm ls --depth=0` reports no `invalid:` lines.
- CI green on `main`.
- Full local `npm test`: 33 failed / 1885 passed / 5 skipped. **All 33 failures are 39–97 s timeouts with zero assertion failures**, confined to the known load-sensitive files. Per the repo's own failure-signature rule that is host load, not regression — CI on Node 20/22/24 is the authority and it is green.
- At audit time: 2 open issues (#472, #473) and 2 open PRs, both Dependabot (#475 postcss; #223 TypeScript 7, permanently excluded because it breaks `rollup-plugin-dts`). The tracker has since been brought to full parity with this audit — see section 5.
- Zero `TODO` / `FIXME` / `HACK` / `XXX` markers in `src/`, `cli/`, `scripts/`.

---

## 1. Open items — now in the issue tracker

**Every open item from this audit is a GitHub issue.** This section used to rank them inline; that is now duplication, and a status kept in two places drifts — which is the exact failure this audit was written to fix. The tracker is authoritative for what is open.

| Priority | Count | Query |
|---|---|---|
| P0 — blocks the invite | 4 | [`label:P0`](https://github.com/RonenMars/threadbase-streamer/issues?q=is%3Aissue+is%3Aopen+label%3AP0) |
| P1 — fix before the invite | 2 | [`label:P1`](https://github.com/RonenMars/threadbase-streamer/issues?q=is%3Aissue+is%3Aopen+label%3AP1) |
| P2 — post-release | 14 | [`label:P2`](https://github.com/RonenMars/threadbase-streamer/issues?q=is%3Aissue+is%3Aopen+label%3AP2) |
| P3 — deferred or blocked | 18 | [`label:P3`](https://github.com/RonenMars/threadbase-streamer/issues?q=is%3Aissue+is%3Aopen+label%3AP3) |

The release gate is P0 + P1: [#472](https://github.com/RonenMars/threadbase-streamer/issues/472), [#473](https://github.com/RonenMars/threadbase-streamer/issues/473), [#480](https://github.com/RonenMars/threadbase-streamer/issues/480), [#481](https://github.com/RonenMars/threadbase-streamer/issues/481), [#482](https://github.com/RonenMars/threadbase-streamer/issues/482), [#483](https://github.com/RonenMars/threadbase-streamer/issues/483).

Label vocabulary and issue format: [`threadbase/docs/issue-tracker.md`](https://github.com/RonenMars/threadbase/blob/main/docs/issue-tracker.md).

**What this document still holds that the tracker cannot:** the evidence for work already finished (section 2), the per-document audit trail showing where each claim came from (section 3), and the conflict-ordered execution plan (section 4). Closed work is not an issue, so nothing else records why a doc's claim was dismissed.


## 2. Verified solved — do not re-open

| Claimed open in | Item | Closing evidence on `main` |
|---|---|---|
| BACKLOG table (×8) | #237, #240, #241, #252, #253, #254, #232, #234 | all MERGED |
| BACKLOG | Log truncation sparse/NUL logs | truncate then `kickstart()`, `cli/prod.ts` (#259) |
| BACKLOG | Busy-wait CPU spin in `bootoutAgent` | `Atomics.wait`, `src/lifecycle/launchd.ts:59` (#258) |
| BACKLOG | Partial `prod logs --clear` messaging | combined cleared/failed message, `cli/prod.ts:240-252` |
| BACKLOG | `enrichResumedSessionAsync` writes to a copy | `Readonly<SessionResponse>` guard (#336 / #416) |
| BACKLOG | Degraded-mode `findJsonlPath` ignores `scanProfiles` | #243 |
| BACKLOG | Server tests leak host `codexRoots` | #235 / #239 |
| ACTIONS 1 | fd limits unset in both service definitions | `scripts/deploy.sh:458`, `deploy-linux.sh:266` (#474); live plist shows `NumberOfFiles => 16384` |
| ACTIONS 2 | inotify sysctl undocumented | `docs/troubleshooting.md:1124` |
| ACTIONS 3 | integration-branch endgame undecided | landed on `main` |
| ACTIONS 4 | land #461 / #462 | `6f691aa`, `70b8fe2` |
| ACTIONS 5 | close #441 | CLOSED by dependabot |
| ACTIONS 10 | record the no-rlimit-self-check decision | `docs/troubleshooting.md:1134` |
| Observability R4 | request log prints status `597` | `src/api/app.ts:99` reads `outgoing.statusCode` |
| Observability R6 | watcher `onError` never wired | `src/server.ts:885` (#467) |
| Observability R9 | no `list()` query timing | `src/db/query-timing.ts` (#421) |
| Observability §1.1 | `/api/push/register` is a `{ok:true}` stub | real implementation with `kind` validation, `src/api/routes/misc.routes.ts:131` |
| Live activities | CI red on the stack; downstream PRs unverified | #292 / #293 / #294 all MERGED; biome exit 0 |
| Live activities | "mobile side does not exist yet" | ships in TestFlight |
| Security plan | H2 key rotation | `POST /api/auth/rotate`, `misc.routes.ts:106` |
| Security plan | M2 CORS wildcard | origin allowlist, off by default, `cors.middleware.ts` |
| Security plan | M3 no rate limiting | `checkSessionStartRateLimit` / `checkSessionInputRateLimit`, `server.ts:2844-2849` |
| Security plan | L2 `exchangeAttempts` never pruned | TTL-evict, `server.ts:2831` |
| ROADMAP | forward `thinkingSignature` | mapped as `signature` |
| Session review #8 | `claude_extra_args` silent model/effort revert | #306 — `model`/`effort` are first-class registry entries |

**Resolved as decided, not gaps.** `localNoAuth` remains a full bypass by design and logs a boot warning (`src/server.ts:656`) — it is a dev flag. Security **M1** (move WS auth off `?key=`) cannot be "fixed": `/ws?key=<token>` is a load-bearing tb-mobile compatibility guarantee. Security **L3** (`/healthz` exposes `version`) is depended on by the menubar app, which polls that exact shape.

### 2.1 GitHub issues closed before this audit — re-verified against code

The same "trust the code, not the tracker" rule was applied to GitHub's own `closed` state. All nine hold:

| Issue | Claim | Verified | Evidence |
|---|---|---|---|
| #471 | Linux `max_user_watches` undocumented | `DONE` | `docs/troubleshooting.md:1124` |
| #470 | no fd limit in either service definition | `DONE` | `deploy.sh:458`, `deploy-linux.sh:266`; live plist shows `NumberOfFiles => 16384` |
| #469 / #438 | lifecycle wrong for multi-agent / historical sessions | `DONE` | `isLiveMultiAgent` gate present at **both** call sites, `session-store.ts:251` and `:261` |
| #430 | `list` reports 118 ms; `SELECT *` carries an unused 5.7 KB column | `DONE` | explicit column list, `conversation-cache.ts:305`; `migrations/015` drops `projects.message_count` |
| #409 | per-file invalidation silently upgraded to a full-tree rescan | `DONE` | drained-set guard, `server.ts:702` |
| #393 | external tail not detached on JSONL delete | `DONE` | 3 × `handleJsonlDeleted` in `server.ts` |
| #368 | detail fetches block on a full rescan | `DONE` | "never block the response on a routine reconcile", `server.ts:2977` |
| #358 | three `watch-for-jsonl` assertions cannot fail | `DONE` | 14 live `expect()` calls in the suite |

#469/#438 was the one worth checking rather than assuming: `pr-follow/Streamer-ORPHAN-LIFECYCLE-GATE-FIX.md` warned that a lazy conflict resolution could land the gate at one call site and still merge green. It is present at both.

---

## 3. Full register, by source document

Doc-claimed status is quoted from the source; verified status is this audit's finding.

### `docs/BACKLOG.md`

| Item | Doc claim | Verified | Evidence |
|---|---|---|---|
| Stale conversation history vs. fresh resume | In flight #237 | `DONE` | `9fa1232` |
| Homebrew vs deploy launchd conflict | DONE #238 | `DONE` | `5c450b7` |
| `bootstrapAgent` exit-5 false positive | In flight #240 | `DONE` | `8f14a79` |
| Upload filenames / `@path` spaces | In flight #241 | `DONE` | `173077f` |
| Quiet timeout stuck as `running` | In flight #252 | `DONE` | `3a6b3d6` |
| External session mirror + resume collision guard | In flight #253 | `DONE` | `00a8ba2` |
| Windows adopt working directory | In flight #254 | `DONE` | `c7603dd` |
| Quick Access Recents historical routing | Superseded | `SUPERSEDED` | Favorites-only on modern mobile |
| Degraded-mode `findJsonlPath` / `scanProfiles` | DONE #243 | `DONE` | `67f0827` |
| Server tests `codexRoots` host leak | DONE #235/#239 | `DONE` | `a11c942`, `73f8546` |
| `server.test.ts` grace-timer flake | Partial; #245 open | **`OPEN`** | #245 CLOSED unmerged; flaked twice 2026-08-09 |
| Log truncation sparse/NUL logs | Open — "next action" | `DONE` | #259 |
| Busy-wait CPU spin in `bootoutAgent` | Fixed | `DONE` | `launchd.ts:59` |
| Partial `prod logs --clear` failure | Open | `DONE` | `cli/prod.ts:240-252` |
| Cache integrity alert management | In flight #232 | `DONE` | `5186354` |
| Explicit warm-up status API | In flight #234 | `DONE` | `d9a9a4e` |
| `enrichResumedSessionAsync` throwaway copy | DONE #336 | `DONE` | #416 |
| Auto-resume with no provider history | Open, low | **`OPEN`** | `autoResumeOnBoot.ts:25` — **P1-5** |

### `docs/ROADMAP.md`

| Item | Doc claim | Verified | Evidence |
|---|---|---|---|
| Migrate `/api/search` to HTTP QUERY | Why-not-now | `DEFERRED` | still `app.get`, `scanner.routes.ts:11`; must retain GET |
| Keychain storage for the API key | Why-not-now | `DEFERRED` | no `keytar` dependency |
| Forward `thinkingSignature` | DONE | `DONE` | mapped as `signature` |
| Forward `sourceToolAssistantUUID` | Open, no consumer | `DEFERRED` | absent from `src/` |
| Full `SystemEntry` forwarding | Open, no consumer | `DEFERRED` | absent from `src/` |
| Per-image metadata (`ImageBlock`) | Open, no consumer | `DEFERRED` | only `hasImages` forwarded |
| Windows `prod logs` | Open | **`OPEN`** | `task-scheduler.ts:67` — **P0-1 / #472** |
| Normalize Commander booleans in `prod logs` | Open | **`OPEN`** | `cli/prod.ts:359-361` still `!== false` / `=== true` |
| Codex structured prompt cards | Partial | **`BLOCKED`** | startup gates only; needs a live probe |
| Fully incremental warm-up | Partial | **`OPEN`** | warm-up mode still unlogged, `server.ts:2283` |
| Split `src/server.ts` | Open | **`OPEN`** | 6,502 lines; no `src/api/handlers/` — **P2-8** |

### The three July snapshots — now [`archive/pre-release-snapshots/`](archive/pre-release-snapshots/)

`pre-release-backlog-roadmap-analysis-2026-07-18.md`, `pre-release-open-issues-by-severity-2026-07-18.md`, `pre-release-issues-cursor.md`. Archived on 2026-08-10 as part of this audit. Their 17-row analysis table, S2–S4 severity tables, and TOP-5 lists enumerate the same population as BACKLOG + ROADMAP above; every row resolves to the verified status given there. Snapshot-specific rows:

| Item | Doc claim | Verified | Evidence |
|---|---|---|---|
| P0: stale history regression test without `?refresh=1` | Required before release | `DONE` | #237 |
| P1 set: log clearing, bootstrap verification, Homebrew conflict, Windows logs | Required before release | `DONE` except Windows logs | Windows logs → **P0-1** |
| Coordinate Quick Access fix in tb-mobile | Required before release | `SUPERSEDED` | Favorites-only |
| Preserve `GET /api/search` compatibility | Required before release | `OPEN` (standing constraint) | binds any QUERY migration |
| Doc cleanup: remove `thinkingSignature` entry, narrow Codex entry, update log-truncation entry | Open | **`OPEN`** | folded into **P4** |
| Mobile-side rows (crash consent #343, onboarding polish, multi-attachment #345, abandoned sessions #346, hub stall) | Various | out of scope | tb-mobile repo |
| "Safe to ship-with" accepted debt: Maestro, Expo typecheck, log truncation, keychain, Codex cards | Accepted | `DEFERRED` | recorded as accepted |

### `docs/live-activities-remaining-work.md`

| Item | Doc claim | Verified | Evidence |
|---|---|---|---|
| Fix two pre-existing Biome errors on the base | Blocking | `DONE` | biome exit 0 |
| Rebase stack, confirm Lint green | Blocking | `DONE` | #292/#293/#294 merged |
| Full suite must run on #293/#294 | Blocking | `DONE` | merged with CI |
| `tb-mobile/types/live-activity.ts` absent | Blocking | `DONE` | ships in TestFlight |
| Swift `ActivityAttributes` / `ContentState` | Blocking | `DONE` | ships in TestFlight |
| Mobile POSTs ActivityKit tokens with `kind` | Blocking | `DONE` | `misc.routes.ts:131` validates `kind` |
| No initial push-to-start send path | Missing | **`OPEN`** | `liveactivity_start` read at exactly one site, `liveActivityRenewal.ts:237` |
| Decide whether to start an activity the app never foregrounded | Missing | **`OPEN`** | design decision |
| Send one real push to a physical device | Missing | `DONE` | TestFlight exercises the chain |
| Confirm sandbox vs production host | Missing | **`OPEN`** | works only because `.env` overrides — **P0-2b** |
| Verify key is Team Scoped (All Topics) | Missing | `DONE` | production sends succeed |
| Observe a real ~7.5 h renewal | Missing | **`OPEN`** | never observed in wall-clock |
| Verify elapsed timer does not reset after renewal | Missing | **`OPEN`** | the headline failure mode |
| `APNS_KEY` not wired into any deploy path | Operational | **partly `DONE`** | macOS auto-discovers via `launchd-entry.ts:175`; Windows/Linux/Fly do not — **P0-2c** |
| No metric/health surface for delivery | Operational | **`OPEN`** | `/api/push/health` is per-token only |
| No cleanup for `push_tokens` rows | Operational | `DEFERRED` | retention deliberate |
| Is `THREADBASE_INSTANCE_ID` stable enough as `serverId` | Operational | **`OPEN`** | defaults to `os.hostname()` |
| Temporal not used | Confirm | `DECIDED-NO` | DB deadlines + boot re-arm |
| Postgres `push_tokens` dormant | Confirm | `DECIDED-NO` | SQLite is primary |
| `apns-priority` always 10 | Confirm | `DEFERRED` | lever if iOS throttles |
| Content-state contract must not drift | Constraint | standing | shared with tb-mobile; decode failure is silent |

### `docs/observability-audit.md`

| Item | Doc claim | Verified | Evidence |
|---|---|---|---|
| R1 auth 401 logging | Rank 1 | **`OPEN`** | `auth.middleware.ts` has zero log calls |
| R2 PTY exit log | Rank 2 | **`OPEN`** | no `pty.*` events in `pty-manager.ts` |
| R3 WS connect/disconnect + client count | Rank 3 | **`OPEN`** | `ws-hub.ts` has zero log calls |
| R4 fix `597` in the request log | Rank 4 | `DONE` | `api/app.ts:99` |
| R5 error-middleware log | Rank 5 | **`OPEN`** | `error.middleware.ts` has zero log calls |
| R6 watcher `onError` never wired | Rank 6 | `DONE` | `server.ts:885` (#467) |
| R7 updater structured logging | Rank 7 | **`OPEN`** | zero log calls across `src/updater/` |
| R8 `subscribe_session` log | Rank 8 | **`OPEN`** | — |
| R9 slow-query latency on list | Rank 9 | `DONE` | `db/query-timing.ts` (#421) |
| R10 ring-buffer pressure event | Rank 10 | **`OPEN`** | — |
| §2.1/§2.2 endpoint coverage gaps (11 rows) | Partial | mostly **`OPEN`** | request-log timing exists; per-endpoint success logs do not |
| §3.1 files with zero structured logging (14) | Open | mostly **`OPEN`** | watcher now has `onError`; the rest stand |
| §3.2 silent `catch {}` sites (10) | Open | **`OPEN`** | — |
| §3.3 state transitions with no observability (11) | Open | **`OPEN`** | — |
| §4.3 latency gaps (8) | Open | partly `DONE` | SQLite covered by #421; the rest open |
| §4.4 periodic metrics (6) | Open | **`OPEN`** | — |
| §1.1 `GET /api/profiles` is a stub | Noted | **`OPEN`** | returns `[]` |
| §1.1 `POST /api/push/register` is a stub | Noted | `DONE` | real implementation |

### `docs/2026-07-30-session-review-consolidation.md`

| Item | Doc claim | Verified | Evidence |
|---|---|---|---|
| 2 · Plan docs unprotected on one disk | Open | `DONE` | committed under `docs/plans/` |
| 2b · kickoff staged but meant to stay out | Open decision | `DONE` | present in `docs/plans/` |
| 3 · `adopt` confirm must ship with mobile | Agreed, action open | `DEFERRED` | part of the session-source spec |
| 4 · Write tb-mobile tickets | Acknowledged | out of scope | tb-mobile |
| 6 · Verify model/effort override empirically | Open | `DONE` | #306 + `spawnFlagOverrides()` |
| 7 · Nightly restart kills every live PTY | Open; option (a) chosen | **`OPEN`** | `com.ronen.threadbase-nightly-restart` still loaded |
| 7b · Use nightly restart as a test harness | Suggestion | **`OPEN`** | — |
| 8 · `claude_extra_args` silent revert | Resolved by #306 | `DONE` | `claude-flags.ts:112-113` |
| 8b · `loadDefaultModel/Effort` in `auth.ts` | Superseded | `SUPERSEDED` | #306 |
| 8c · make PUT merge instead of replace | Not recommended | `DECIDED-NO` | — |
| 9 · Codex source-visibility probe not run | Acknowledged | **`OPEN`** | — |
| 10 · PR 0 → PR 12 unwritten | Acknowledged | `DONE` | runtime.db split landed (#385) |

### `docs/plans/` (9 documents)

| Item | Source | Doc claim | Verified |
|---|---|---|---|
| Codex approval detector + 3 open probe questions | `2026-07-04-codex-structured-prompts-followup.md` | Research only | **`BLOCKED`** on a live probe |
| PR 1 reparse-stall guard-rails | `2026-07-12-server-ts-split.md` | Prerequisite | `DONE` |
| PR 2 `ScannerManager` | same | Not started | **`OPEN`** |
| PR 3 conversation read handlers | same | Not started | **`OPEN`** |
| PR 4 session file watchers | same | Not started | **`OPEN`** |
| PR 5 session lifecycle handlers | same | Not started | **`OPEN`** |
| H1 `localNoAuth` bypass | `2026-06-24-security-hardening.md` | HIGH | `DECIDED-NO` — dev flag, warns at boot |
| H2 key rotation | same | HIGH | `DONE` |
| M1 API key in WS query param | same | MEDIUM | `DECIDED-NO` — mobile compat |
| M2 CORS wildcard | same | MEDIUM | `DONE` |
| M3 no rate limiting | same | MEDIUM | `DONE` |
| M4 `isWithinSkew` true on missing header | same | MEDIUM | **`OPEN`** — reverted by #220 |
| M5 `answerKeys` keystroke injection | same | MEDIUM | **`OPEN`** — reverted by #220 |
| L1 `hold_session` ownership | same | LOW | **`OPEN`** — reverted by #220 |
| L2 `exchangeAttempts` never pruned | same | LOW | `DONE` |
| L3 `/healthz` leaks version | same | LOW | `DECIDED-NO` — menubar depends on it |
| L4 WS broadcast client isolation | same | Not a fix item | `DECIDED-NO` |
| R1.1–R1.3 ABI guard gaps | `2026-07-05-test-isolation-hardening.md` | Proposal | **`OPEN`** |
| R2 isolated-scanner-db helper | same | Proposal | **`OPEN`** |
| R3.1–R3.2 drain convention undocumented | same | Proposal | **`OPEN`** |
| R4 shared persistent scanner index | same | Consider | `DEFERRED` |
| §8 perf smoke | `2026-07-13-offset-index-implementation.md` | Deferred | `DEFERRED` |
| 4 build-time risks/decisions | same | Confirm during build | `DONE` (implemented) |
| Latent torn-line gap in the watcher | same | Tolerated | **`OPEN`** |
| Part A ETag / `If-None-Match` | `2026-06-10-conversation-etag-and-paged-tail.md` | Spec | `DONE` |
| Part B bounded page reads | same | Blocked | **`BLOCKED`** on a tb-scanner release |
| PART A.1–A.5 shell-prompt detector | `2026-06-23-prompt-as-question-cross-repo.md` | Spec | `DONE` |
| PART B.1–B.3 mobile | same | Spec | out of scope |
| G1–G12 persistence gaps | `live-sessions-persistence-audit.md` | Open | `DONE` — the PR 0–12 programme landed |
| Constraint: never add a `SessionStatus` value | same | Binding | standing |
| True PTY continuity unavailable in user space | same | Closed finding | `DECIDED-NO` (pty-host is the answer) |
| S1–S6 + M3–M6 session-source work | `session-source-visibility-and-control.md` | Unchecked | **`OPEN`** / `DEFERRED` |
| Remote-Control detection uncalibrated | same | Verification gate | **`BLOCKED`** — corpus has zero samples |
| Migration-number collision with `015` | same | Coordination | `DONE` |
| Rejected: bind by open fd; `remote-controlled` as a 7th source | same | Closed | `DECIDED-NO` |

### `docs/design/` (3 documents)

| Item | Source | Doc claim | Verified |
|---|---|---|---|
| Pieces 1–6 idle-session push notifications | `idle-session-notifications.md` | Proposed | `DEFERRED` — push infra now exists via Live Activities |
| Option A throttle per-file refresh | `live-conversation-reparse-stall.md` | Recommended | `DONE` — `refreshFileGuarded` |
| Option B upstream scanner checkpoint fix | same | Durable fix | `DEFERRED` — cross-repo |
| Option C serve live from cache tail | same | Not recommended | `DECIDED-NO` |
| Phases 1–5 + optional tables | `jsonl-conversation-index-spec.md` | Greenfield spec | `SUPERSEDED` — offset index shipped |

### `docs/pr-follow/` (6 documents)

| Item | Source | Doc claim | Verified |
|---|---|---|---|
| 1 · fd limits in both service definitions | `ACTIONS.md` / FD-BUDGET R1 | Critical, open | `DONE` (#474) |
| 2 · document inotify sysctl | same / R2 | High, open | `DONE` |
| 3 · integration-branch endgame | `ACTIONS.md` | High, open | `DONE` |
| 4 · land #461 / #462 | same | High, open | `DONE` |
| 5 · close #441 | same | Medium, open | `DONE` |
| 6 · CLAUDE.md failure-signature rule | same / R5-R6 | Medium, open | **`OPEN`** — **P2-9a** |
| 7 · verify 3 live Codex ownership scenarios | same / CODEX-FORK | Medium, open | **`OPEN`** — **P2-9b** |
| 8 · prune 2 redundant origin refs | same / ORPHAN-FIX | Low, open | **`OPEN`** — **P2-9c** |
| 9 · update the base-comparison memory | same / R8-R9 | Low, open | `DONE` |
| 10 · record the no-rlimit-self-check decision | same / R4 | Low, open | `DONE` |
| R3 ENOSPC backstop | FD-BUDGET | Done (#467) | `DONE` |
| R7 run focused suites locally | FD-BUDGET | Guidance | standing |
| `6c1ed95` must travel to `main` | ORPHAN-LIFECYCLE-GATE-FIX | Open | `DONE` |
| #223 TypeScript 7 — never merge | OPEN-PRs | Standing exclusion | `DECIDED-NO` |
| #475 postcss left for the owner | OPEN-PRs | Open | **`OPEN`** |
| `package-lock.json` root version stale | OPEN-PRs | Open defect | **`OPEN`** — **P2-10** |
| Mobile Retry affordance restorable | OPEN-PRs / CODEX-FORK | Cross-repo | `DEFERRED` — tb-mobile |
| GitHub auto-restack unreliable | OPEN-PRs | Open question | standing process rule |
| Retire `integration/fresh-2026-08-09`, keep the backup | OPEN-PRs | Cleanup | **`OPEN`** |
| Traps: `gh pr checks` after force-push; `--package-lock-only` overshoot; `isDraft` orthogonal | OPEN-PRs | Process rules | standing |
| Step 1 — measure whether claude holds its JSONL open | `2026-08-09-claude-open-file-collision-prompt.md` | Blocking gate | `DONE` — negative result recorded in #477 |
| Step 2 — add `file_handle` collision signal | same | Conditional | `DECIDED-NO` — the measurement came back negative |

---

## 4. Execution plan — parallel vs serial

Grouping is by **file-conflict domain**, which is what actually forces serialization. `src/server.ts` is the repo's #1 conflict magnet and governs the ordering.

### Serial gate — first, alone

**S0 — stabilize CI (P1-4).** Every other item needs green CI to merge. Touches `__tests__/server.test.ts` only; land the CLAUDE.md failure-signature rule (P2-9a) in the same PR — same concern, no code overlap.

### Then fully parallel — four tracks, zero shared files

| Track | Items | Files |
|---|---|---|
| **A — Docs** | P0-3 README security section; P4 hygiene; P2-6 decision record | `README.md`, `docs/*.md` |
| **B — Windows + APNs** *(largest; internally serial)* | P0-1 Commander gate → `getLogPaths` → `deploy.ps1` redirection; then P0-2c parity, P0-2a provisioning, P0-2b host default | `task-scheduler.ts`, `deploy.ps1`, `deploy-linux.sh`, `deploy.sh`, `cli/launchd-entry.ts`, `cli/prod.ts` |
| **C — Observability** | P2-7 — five mutually independent one-file PRs | `auth.middleware.ts`, `error.middleware.ts`, `ws-hub.ts`, `pty-manager.ts`, `src/updater/*` |
| **D — Chores** | P2-9b Codex probe (manual); P2-9c prune refs (git only); P2-10 release job | `.github/workflows/`, git refs |

Track **B is internally serial** — P0-1 and the APNs work both edit `deploy.ps1`, and the parity fix must first lift `loadApnsKeyIntoEnv` out of the launchd-only entry point before Windows and Linux can call it.
Track **C's five PRs are internally parallel** — one file each, no overlap.

### Serial tail

**S1 — P1-5 (auto-resume `historyExists`).** Touches `src/server.ts` at a single call site; land after Track C so it does not race the observability edits.

**S2 — P2-8 (`src/server.ts` split), last and alone.** Four sequential PRs: `ScannerManager` → conversation handlers → session watchers → session lifecycle. Must land after *every* other item that edits `server.ts`. Do not overlap it with anything.

### Not scheduled

All of P3 — each is blocked on an external dependency: a live Codex probe, a tb-scanner release, or a consumer that does not exist yet.

---

## 5. Issues filed from this register

**Full parity.** Every `OPEN` and `BLOCKED` row in this document is a GitHub issue; nothing open is tracked only here.

Format and label vocabulary: [`threadbase/docs/issue-tracker.md`](https://github.com/RonenMars/threadbase/blob/main/docs/issue-tracker.md).

| Register item | Issue | Labels |
|---|---|---|
| P0-1 Windows logging | [#472](https://github.com/RonenMars/threadbase-streamer/issues/472) | `P0` `bug` `platform` `observability` |
| P0-3 README security posture | [#473](https://github.com/RonenMars/threadbase-streamer/issues/473) | `P0` `documentation` `security` |
| P0-2a/b APNs provisioning + host default | [#480](https://github.com/RonenMars/threadbase-streamer/issues/480) | `P0` `bug` |
| P0-2c APNs launchd-only | [#481](https://github.com/RonenMars/threadbase-streamer/issues/481) | `P0` `bug` `platform` |
| P1-4 grace-timer flake | [#482](https://github.com/RonenMars/threadbase-streamer/issues/482) | `P1` `bug` `ci` `tech-debt` |
| P1-5 auto-resume history | [#483](https://github.com/RonenMars/threadbase-streamer/issues/483) | `P1` `bug` |
| P2-6 security revert #220 | [#485](https://github.com/RonenMars/threadbase-streamer/issues/485) | `P2` `question` `security` |
| P2-7 auth 401 log | [#486](https://github.com/RonenMars/threadbase-streamer/issues/486) | `P2` `enhancement` `observability` `security` |
| P2-7 PTY exit log | [#487](https://github.com/RonenMars/threadbase-streamer/issues/487) | `P2` `enhancement` `observability` |
| P2-7 WS connect/disconnect | [#488](https://github.com/RonenMars/threadbase-streamer/issues/488) | `P2` `enhancement` `observability` |
| P2-7 error middleware log | [#489](https://github.com/RonenMars/threadbase-streamer/issues/489) | `P2` `enhancement` `observability` |
| P2-7 updater logging | [#490](https://github.com/RonenMars/threadbase-streamer/issues/490) | `P2` `enhancement` `observability` |
| P2-7 subscribe_session log | [#491](https://github.com/RonenMars/threadbase-streamer/issues/491) | `P2` `enhancement` `observability` |
| P2-7 ring-buffer pressure | [#492](https://github.com/RonenMars/threadbase-streamer/issues/492) | `P2` `enhancement` `observability` `performance` |
| P2-7 remaining audit gaps | [#493](https://github.com/RonenMars/threadbase-streamer/issues/493) | `P2` `enhancement` `observability` |
| P2-8 split `src/server.ts` | [#494](https://github.com/RonenMars/threadbase-streamer/issues/494) | `P2` `tech-debt` |
| P2-9a CLAUDE.md failure-signature rule | [#495](https://github.com/RonenMars/threadbase-streamer/issues/495) | `P2` `tech-debt` `ci` `documentation` |
| P2-9b Codex ownership scenarios | [#496](https://github.com/RonenMars/threadbase-streamer/issues/496) | `P2` `question` `provider` |
| P2-9c prune origin refs | [#497](https://github.com/RonenMars/threadbase-streamer/issues/497) | `P2` `tech-debt` |
| P2-10 stale lockfile root version | [#498](https://github.com/RonenMars/threadbase-streamer/issues/498) | `P2` `bug` `ci` |
| P3 Codex prompt cards | [#499](https://github.com/RonenMars/threadbase-streamer/issues/499) | `P3` `enhancement` `provider` `ux` |
| P3 keychain API key | [#500](https://github.com/RonenMars/threadbase-streamer/issues/500) | `P3` `enhancement` `security` |
| P3 delta-only warm-up | [#501](https://github.com/RonenMars/threadbase-streamer/issues/501) | `P3` `enhancement` `performance` |
| P3 `/api/search` QUERY | [#502](https://github.com/RonenMars/threadbase-streamer/issues/502) | `P3` `enhancement` |
| P3 unmapped scanner fields | [#503](https://github.com/RonenMars/threadbase-streamer/issues/503) | `P3` `enhancement` |
| P3 Commander booleans | [#504](https://github.com/RonenMars/threadbase-streamer/issues/504) | `P3` `tech-debt` |
| P3 bounded page reads | [#505](https://github.com/RonenMars/threadbase-streamer/issues/505) | `P3` `performance` `enhancement` |
| P3 session source visibility | [#506](https://github.com/RonenMars/threadbase-streamer/issues/506) | `P3` `enhancement` `provider` |
| P3 push-to-start path | [#507](https://github.com/RonenMars/threadbase-streamer/issues/507) | `P3` `enhancement` |
| P3 real renewal observation | [#508](https://github.com/RonenMars/threadbase-streamer/issues/508) | `P3` `question` |
| P3 delivery metrics + token retention | [#509](https://github.com/RonenMars/threadbase-streamer/issues/509) | `P3` `enhancement` `observability` |
| P3 `THREADBASE_INSTANCE_ID` as serverId | [#510](https://github.com/RonenMars/threadbase-streamer/issues/510) | `P3` `question` |
| P3 `/api/profiles` stub | [#511](https://github.com/RonenMars/threadbase-streamer/issues/511) | `P3` `bug` |
| P3 nightly restart kills PTYs | [#512](https://github.com/RonenMars/threadbase-streamer/issues/512) | `P3` `question` `platform` |
| P3 test-isolation hardening | [#513](https://github.com/RonenMars/threadbase-streamer/issues/513) | `P3` `tech-debt` `e2e` |
| P3 torn-line gap in the watcher | [#514](https://github.com/RonenMars/threadbase-streamer/issues/514) | `P3` `bug` |
| P3 idle-session notifications | [#515](https://github.com/RonenMars/threadbase-streamer/issues/515) | `P3` `enhancement` |
| P3 upstream scanner checkpoint fix | [#516](https://github.com/RonenMars/threadbase-streamer/issues/516) | `P3` `performance` `enhancement` |

P4 doc hygiene is not filed — it was done in the same PR that added this register.

### Why this document survives full parity

The tracker holds open work. It does not hold the ~90 rows in sections 2 and 3 recording what was *already* fixed and where the evidence is, because closed work is not an issue. That record is what stops the next audit re-deriving the same conclusions, and it is the reason this file was written.
