# Live Activities — remaining work

Status of the APNs Live Activity delivery path in tb-streamer after PRs [#292](https://github.com/RonenMars/threadbase-streamer/pull/292), [#293](https://github.com/RonenMars/threadbase-streamer/pull/293), [#294](https://github.com/RonenMars/threadbase-streamer/pull/294).

All three are open, stacked, and unmerged.
Everything below is what those PRs do **not** cover.

## Blocking — nothing works end to end until these are done

### CI is red on the stack
- [ ] Fix two pre-existing Biome errors on `integration/missing-prs-2026-07-23`, in a **separate PR** against that branch.
  - `__tests__/server.test.ts:572,714,1006` — `lint/style/useTemplate`
  - `__tests__/codex-scan.test.ts:44` — `lint/correctness/noUnusedVariables`
  - Neither file is touched by #292–#294; both fail on the untouched base. CI runs `biome check .` repo-wide, so the whole stack inherits the failure.
- [ ] Rebase the stack onto the fixed base and confirm Lint goes green.

### Downstream PRs were never actually verified by CI
- [ ] Get the full suite (Lint / Build / Test) to run on #293 and #294. Both currently show **only** `security/snyk` — the workflow did not trigger for a PR whose base is another feature branch. A green Snyk is not a passing test suite.
  - Verified locally instead: `tsc --noEmit` clean, Biome clean on all touched files, 1482 tests passing.

### Mobile side does not exist yet
- [ ] `~/dev/ai-tools/tb-mobile/types/live-activity.ts` — **still absent**. The streamer sends the contract inlined from the prompt; nothing on the mobile side consumes it.
- [ ] Swift `ActivityAttributes` / `ContentState` struct matching the shape below, field for field.
- [ ] Mobile must POST its ActivityKit tokens to `/api/push/register` with the new `kind` field. Until it does, zero rows of kind `liveactivity_*` exist and every send path is a no-op.

## Missing server functionality

### Push-to-start is stored but never used to start an activity
- [ ] There is **no initial** push-to-start send path. `liveactivity_start` tokens are read in exactly one place — `liveActivityRenewal.ts:236`, for starting a *replacement* during renewal.
- [ ] Decide and implement: should the server start a Live Activity for a session the app never foregrounded? Today the first activity can only be created in-app over WebSocket; the push path only updates and renews an activity that already exists.

### Never exercised against a real device
- [ ] Send one real push to a physical device with `APNS_KEY` set. Every APNs interaction so far is against a fake client — the ES256 JWT encoding, the `.push-type.liveactivity` topic, and the HTTP/2 transport have **never** been validated by Apple.
- [ ] Confirm sandbox vs production. `APNS_HOST` defaults to sandbox because `aps-environment` is `development`; a TestFlight/App Store build needs `api.push.apple.com` or pushes silently never arrive.
- [ ] Verify the signing key is genuinely **Team Scoped (All Topics)**. A bundle-scoped key cannot sign the liveactivity topic, and the failure is a bare `403 InvalidProviderToken`.

### Renewal is untested in wall-clock time
- [ ] Observe one real renewal fire across an actual ~7.5 hour window. All 14 renewal tests inject a fake clock; the boot re-arm, the chained one-hour timer hops, and drift across a laptop suspend have never run against the real timer.
- [ ] Verify the elapsed timer visually does **not** reset on a real device after renewal. This is the headline failure mode and it is invisible server-side — asserted in tests, never seen on a Lock Screen.

## Operational gaps

- [ ] `APNS_KEY` is not wired into any deploy path. Not in the launchd plist, the systemd unit, the Task Scheduler action, `scripts/deploy.sh`, or Fly secrets. Prod will boot with Live Activities silently off.
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
