# Live Activities — remaining work

Status of the APNs Live Activity delivery path in tb-streamer after PRs [#292](https://github.com/RonenMars/threadbase-streamer/pull/292), [#293](https://github.com/RonenMars/threadbase-streamer/pull/293), [#294](https://github.com/RonenMars/threadbase-streamer/pull/294).

**Revised 2026-08-10 against `main` @ `f390d67`.** All three PRs are **merged**, and the whole "Blocking" section below is resolved — the feature works end to end. The live prod instance reports it enabled against the **production** APNs host, and a shipping TestFlight build exercises ES256 JWT signing, the `.push-type.liveactivity` topic and HTTP/2 transport:

```
{"event":"live_activity.enabled","host":"api.push.apple.com","topic":"com.ronenmars.threadbase.push-type.liveactivity"}
```

**What is actually left is provisioning, not code** — tracked as [#480](https://github.com/RonenMars/threadbase-streamer/issues/480) and [#481](https://github.com/RonenMars/threadbase-streamer/issues/481). The feature works on the maintainer's machine because two files were placed there by hand that no install path creates: `~/.threadbase/AuthKey_<keyId>.p8` (auto-discovered by `loadApnsKeyIntoEnv`, `cli/launchd-entry.ts:175`) and `~/.threadbase/.env` supplying `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_HOST`, none of which have a default or any discovery (`src/services/push/apnsClient.ts:107-111`). Both mechanisms live only in the launchd entry point, so Windows and Linux can never enable push at all.

## Resolved since this doc was written

- [x] Two pre-existing Biome errors on the base branch — `biome check .` now exits 0 repo-wide.
- [x] Rebase the stack and confirm Lint green — #292–#294 merged with CI green.
- [x] Get the full suite to run on #293 and #294 — merged through normal CI.
- [x] `tb-mobile/types/live-activity.ts` and the Swift `ActivityAttributes` / `ContentState` structs — the mobile side exists and ships in TestFlight.
- [x] Mobile POSTs ActivityKit tokens to `/api/push/register` with the `kind` field — the endpoint validates `kind` (`src/api/routes/misc.routes.ts:131`) and is no longer the `{ok:true}` stub some older docs describe.
- [x] Send one real push to a physical device — the TestFlight build exercises the full chain.
- [x] Verify the signing key is Team Scoped (All Topics) — production sends succeed.

## Missing server functionality

### Push-to-start is stored but never used to start an activity
- [ ] There is **no initial** push-to-start send path. `liveactivity_start` tokens are read in exactly one place — `liveActivityRenewal.ts:236`, for starting a *replacement* during renewal.
- [ ] Decide and implement: should the server start a Live Activity for a session the app never foregrounded? Today the first activity can only be created in-app over WebSocket; the push path only updates and renews an activity that already exists.

### Host default is wrong for the shipping case
- [ ] `APNS_HOST` defaults to **sandbox** (`src/services/push/apnsClient.ts:111`) because `aps-environment` was `development`. Every TestFlight/App Store build needs `api.push.apple.com`, and today each operator has to discover that and override it by hand — a wrong host does not error, the pushes simply never arrive. Tracked in [#480](https://github.com/RonenMars/threadbase-streamer/issues/480).

### Renewal is untested in wall-clock time
- [ ] Observe one real renewal fire across an actual ~7.5 hour window. All 14 renewal tests inject a fake clock; the boot re-arm, the chained one-hour timer hops, and drift across a laptop suspend have never run against the real timer.
- [ ] Verify the elapsed timer visually does **not** reset on a real device after renewal. This is the headline failure mode and it is invisible server-side — asserted in tests, never seen on a Lock Screen.

## Operational gaps

- [ ] `APNS_KEY` reaches the server on **macOS only**, and not via the plist: `cli/launchd-entry.ts:175` discovers `AuthKey_<keyId>.p8` in the install dir and derives `APNS_KEY_ID` from the filename. Linux and Windows invoke `cli.js` directly and never run that loader, so prod boots with Live Activities silently off there. No install path on any platform creates the `.env` that supplies team and bundle id. Tracked in [#480](https://github.com/RonenMars/threadbase-streamer/issues/480) and [#481](https://github.com/RonenMars/threadbase-streamer/issues/481).
- [ ] No metric or health surface for Live Activity delivery. `/api/push/health` reports per-token state, but there is no count of activities renewed, ended, or retired.
- [ ] No cleanup for `push_tokens` rows. Expired and revoked rows are retained deliberately (so health can explain why delivery stopped) and nothing ever prunes them.
- [ ] Decide whether `THREADBASE_INSTANCE_ID` is stable enough to be `serverId`. It defaults to `os.hostname()`, so a hostname change makes mobile treat it as a different server.

## Deliberately not done — confirm these are the wanted calls

- [ ] **Temporal not used.** `@temporalio/client` is reachable only under `MULTI_AGENT_FLOW`, where the PTY path this feature observes does not run. Renewal uses DB-persisted deadlines plus boot re-arm instead. Confirm that is acceptable long-term.
- [ ] **Postgres `push_tokens` is dormant.** `pg-migrations/007` creates the end-state table to keep both backends in sync, but Postgres persistence is unused; only SQLite is exercised.
- [ ] **Pre-existing lint left alone.** Six Biome findings on the base branch were not touched, per the surgical-changes rule.
- [ ] **`apns-priority` is always 10.** The sender accepts `5` but no caller passes it. If iOS throttles, batching low-priority updates at 5 is the lever.

## Contract that must not drift

Any change here needs a coordinated tb-mobile change — an ActivityKit decode failure is **silent**, and the surface simply stops updating with no server-side error.

```ts
{ sessionId, serverId, projectName, status, startedAt, lastOutput, serverLabel? }
```

- `status` — `'running' | 'waiting_input'` only. `idle` has no representation and sends an `end` instead.
- `startedAt` — epoch **milliseconds**, the session's real start. iOS renders its own ticking timer from it, so never a computed elapsed value and never per-second pushes. A renewal must carry the original through unchanged.
- `lastOutput` — collapsed to one line, truncated to 90 characters, which is what keeps the payload under APNs' 4 KB limit.
- `aps` envelope — `timestamp` and `stale-date` are in **seconds** while `startedAt` inside content-state is in **milliseconds**.

## Env vars

| Variable | Required | Default |
|----------|----------|---------|
| `APNS_KEY` | Yes | — (p8 PEM **contents**, never a path; feature off when unset) |
| `APNS_KEY_ID` | With `APNS_KEY` | derived from `AuthKey_<keyId>.p8` under launchd |
| `APNS_TEAM_ID` | With `APNS_KEY` | — |
| `APNS_BUNDLE_ID` | With `APNS_KEY` | — |
| `APNS_HOST` | No | `api.sandbox.push.apple.com` |
