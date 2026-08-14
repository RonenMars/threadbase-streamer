# Current-behaviour defects found during the E2EE design review

**Date:** 2026-08-14
**Found by:** the STRIDE review in [../../docs/security/2026-08-14-streamer-review.md](../../docs/security/2026-08-14-streamer-review.md) and `tb-mobile/docs/security/2026-08-14-mobile-review.md`
**Status:** all six fixed. Streamer on `fix/review-defects`, mobile on `fix/review-defects`.

None of these are E2EE work. They are things the review found wrong in the code **as it exists today**, while establishing what the design would have to change.
They are listed here rather than in the design docs because fixing them does not depend on E2EE shipping — and four of the six are exploitable now.

---

## The six

| # | Defect | Where | What it means | STRIDE | Fix |
|---|---|---|---|---|---|
| **D1** | `hold_session` over the WebSocket has **no capability check** | `src/server-wiring.ts:669-671` (before), vs `src/services/security/capabilities.ts:120` | The socket is authorized once, at the upgrade, against `history:read`. `hold_session` SIGINTs the agent and disposes its screen — that is control, not reading. Any socket that cleared the upgrade could stop **any** session by id with a single JSON frame. A read-only device could kill every running agent. | E — elevation (TB-S-04, DREAD 34) | The principal is now captured at the upgrade and threaded to every frame; `hold_session` requires `session:control`. |
| **D2** | `subscribe_session` accepts any session id with **no per-frame check at all** | `src/server-wiring.ts:616-630` (before) | Same root cause as D1: no principal ever reached the socket, so no frame could be authorized. Under one shared credential this was not an escalation — but it meant there was nowhere for a check to live once credentials stopped being uniform. | I — disclosure (TB-S-05, DREAD 35) | Now requires `history:read` per frame. **This does not add project scoping** — see "What was deliberately not fixed". |
| **D3** | The first-ever `server.yaml` is created **without a file mode** | `src/auth.ts:47` (before), vs `:170-171` and `:354-355` | `writeFileSync` with no `mode` lands at the process umask — typically `0644`. So the file holding the shared **admin** API key was world-readable on a multi-user host until some later write happened to rewrite it at `0600`. A server that never rotates its key never gets that write. | I — disclosure (TB-S-16, DREAD 34) | `mode: 0o600` plus `chmodSync`, matching the two other writers in the same module. |
| **D4** | The fail-closed contract was **documented one way and implemented the other** | `src/services/security/capabilities.ts:78-82` vs `src/api/middleware/auth.middleware.ts:96-104` | The docstring said an unclassified route is denied. The middleware calls `next()`, for a good reason it states inline (a 403 would confirm that a path an authenticated caller cannot name exists). A reader trusting the docstring would believe a route was guarded by omission when it is not. **And the test that was the real guarantee had a hole**: it scanned route files for literals already starting `/api`, which skips every sub-app mounted at a prefix, because those files write paths *relative* to the mount. A whole new mount prefix in `app.ts` passed without ever being classified. | E — elevation (TB-S-06, DREAD 27) | Docstring corrected to describe actual behaviour and to name the test as the guarantee; the test now reconstructs full paths from `app.ts` mounts + each sub-app's own literals, with a positive control so it cannot pass vacuously. |
| **D5** | Mobile sends `{ type: 'auth', token }` on **every** connection to a handler that does not exist | `services/ws-client.ts:179` (before) vs `src/server-wiring.ts:607-671` | The streamer's WS handler only knows `register`, `subscribe_session` and `hold_session`; unknown types fall through a `catch {}` silently. So the long-term credential was re-transmitted over the wire, on every connect and every reconnect, for nothing. On the LAN path (`ws://`) that is a second copy of the admin key in cleartext. | I — disclosure (TB-M-05, DREAD 35) | Frame deleted, not implemented. The now-dead `apiKey` field went with it. |
| **D6** | The scoped device token is minted and stored, and **never read back** | `stores/servers.ts:164` (write), `:201` (delete), no read site — while every request sent `server.apiKey` (`services/api-client.ts:200`, `:324`, `:381`, `:521`) | C5 shipped per-device, individually revocable credentials on both sides. The client stored one and then authenticated with the OWNER's shared key on every request — which carries `admin` (`src/services/security/capabilities.ts:63-69`). A lost phone leaked the ability to rotate the key and revoke other devices, rather than a scope that could be revoked on its own. | E — elevation (TB-M-14, DREAD 37) | See below — it needed a server-side prerequisite first. |

---

## D6 needed a database move first

**The trap:** the `devices` table lived in `cache.db` (`src/db/migrations/011_create_devices.sql`), which `tb-streamer cache clear` deletes outright (`cli/index.ts:437`) and the cache-integrity monitor rebuilds via `reset_rescan`.

A device registry is rebuildable from nothing. Losing it invalidates every device token ever issued. So switching the client to that credential would have turned a **documented troubleshooting step** into "and now re-pair every device" — a worse regression than the defect.

That is almost certainly why the credential was never adopted, and it means the table was simply in the wrong file. `runtime.db` exists for precisely this: *"everything in the cache is rebuildable from `~/.claude`/`~/.codex`, this is not. It must survive 'delete the cache and restart' and the integrity monitor's reset-and-rescan."*

**The move, following the `managed_sessions` precedent already in the codebase:**

| Change | File |
|---|---|
| New table in the authoritative store | `src/db/runtime-migrations/003_create_devices.sql` |
| One-time, non-destructive lift from `cache.db` | `RuntimeStore.importLegacyDevices()` — the existing `importLegacyManagedSessions` body generalized into a shared private helper rather than copied |
| Repository built from the runtime handle | `src/server.ts` — beside `ManagedSessionsRepository`, so device auth no longer depends on the conversation cache opening at all. A cache failure used to null `devicesRepo` and silently drop every device to the shared-key path. |
| Cache-side table kept but emptied | `src/db/migrations/011_create_devices.sql` — still created so the copy has a source, then cleared once the copy is verified (see the retention follow-up below) |

**And a capability flag, because mobile cannot tell which streamers have the move.** `GET /api/info` now reports `devicesDurable: true` (`src/api/routes/misc.routes.ts`), and the client only prefers the device token when a server says so:

```ts
// tb-mobile/types/api.ts
export function authToken(server): string {
  return server.serverInfo?.devicesDurable && server.deviceToken
    ? server.deviceToken
    : server.apiKey
}
```

Absent means "older server, assume not durable", matching the `claudeFlags` / `projectSummary` / `push` pattern already in that response. So a new app against an old streamer behaves exactly as it does today.

**Deliberately not a 401-retry fallback.** Silently re-presenting the shared key after a device token is refused would let a *revoked* device keep working, which is the one thing revocation has to prevent.

---

## What was deliberately not fixed

Stated so it is not later mistaken for an oversight.

| Not fixed | Why |
|---|---|
| **Per-project scoping of `subscribe_session`** | D2's fix enforces `history:read` per frame and creates the seam scoping would hang off. It does not add scoping, because the capability model has none anywhere — the C5 design lists per-project filesystem scoping as an explicit non-goal, and `fs:browse` is all-or-nothing too. Inventing a scoping model inside a defect fix would be a product decision smuggled in as a bugfix. Still open as TB-S-05 / open question 3. |
| **`session_list` on WS open** | `handleWsOpen` still unicasts every session to any socket (`src/server-wiring.ts:597-598`). Same reason as above, and it is the free step in attack tree 6.3 of the streamer review. |
| **The `?key=` query-string credential** | Removing it needs the E2EE ticket flow (design §3.5) and the compatibility contract requires it to keep working (`docs/compatibility/tb-mobile.md:88`). |
| **Live sockets surviving revocation** | TB-S-18. Real, but it is designed for in E2EE §4.4 and is a bigger change than these six. |
| **`--local-no-auth` bypassing the capability check** | TB-S-23. The new WS guard deliberately matches the existing HTTP behaviour (a null principal is allowed) rather than being stricter than it, because a socket quietly refusing what the REST routes permit would be a second undocumented behaviour for that flag. Open question 9. |

---

## Behaviour changes worth knowing

1. **A read-only device can no longer hold sessions.** No shipped client issues read-only devices yet, so no user-visible change today — but this is a real authority reduction, not a no-op.
2. **Device auth now survives `tb-streamer cache clear`.** The first boot after upgrading copies existing rows from `cache.db`, logged as `runtime.legacy_import`.
3. **Device auth now survives a conversation-cache failure.** Previously a cache open error nulled `devicesRepo`.
4. **Mobile authenticates as a device, not as the owner**, against any streamer reporting `devicesDurable`. A revoked device now actually stops working — which is the point, and is a change in what revocation does in practice.
5. **The WS credential converges on the next reconnect.** Right after pairing, `serverInfo` is still null, so the socket is opened with the shared key exactly as before; the device token is used from the next connect onward. No forced reconnect was added for this.
6. **Editing a server's URL or API key by hand now clears its device identity** (`stores/servers.ts`). A hand-entered credential is a different pairing, and carrying the old token forward would authenticate as a device the new key may know nothing about.
7. **A refused WS frame is dropped and logged (`ws.capability_denied`), not answered.** The server→client message union has no error type and adding one is a contract change older clients would ignore; dropping matches how malformed JSON is already handled.

---

## Tests added

| Test | Covers |
|---|---|
| `__tests__/ws-capabilities.test.ts` | D1, D2 — refusal *and* a positive control per case, plus the legacy-key and `--local-no-auth` paths, so a guard that refused everything would fail. |
| `__tests__/capabilities.test.ts` — rewritten mount scan | D4 — reconstructs paths from `app.ts` mounts; a separate positive-control test asserts the reconstruction actually finds `/api/sessions`, `/api/pair/exchange` and `/ws` so the classification assertion cannot pass on an empty set. |
| `__tests__/runtime-store.test.ts` — `importLegacyDevices` | D6 — copy-once, rollback safety, no-op on a bare source and on an empty table, and an explicit "devices survive deleting cache.db" case. |
| `tb-mobile/__tests__/unit/auth-token.test.ts` | D6 — every fallback branch, including "server never reports the field", which is the backward-compatibility contract. |

D3 and D5 have no new test: D3 is a file mode with no behavioural surface a unit test would not simply restate, and D5 is a deletion whose assertion would be "this frame is absent".

---

## Verification

Both worktrees were fresh checkouts off `origin/main` and needed `npm ci` first. Node v24.15.0 (matches `.nvmrc`); `better_sqlite3.node` confirmed present before trusting any run.

| Repo | Command | Result |
|---|---|---|
| tb-streamer | `npm run lint` (`tsc --noEmit` + biome) | **pass** — 398 files, 0 errors |
| tb-streamer | `npm test` | **pass** — 203 files, 1969 tests, 1 file / 11 tests skipped, 297 s |
| tb-mobile | `npx tsc --noEmit` | **pass** |
| tb-mobile | `npx eslint <10 changed files>` | **pass** |
| tb-mobile | `npm run test:unit` | **pass** — 106 suites, 1002 tests |
| tb-mobile | `npm run test:integration` | **pass** — 43 suites, 295 tests |

Integration was run deliberately, not just unit: `authToken` is a new guard on a shared function that every API call routes through, which is exactly the shape that passes unit and fails integration.

Two things worth recording from the run:

- **The migration executed against real data.** The suite logged `Copied 24 managed session row(s)` and `Copied 350 device row(s) from cache.db to runtime.db` — the import path is exercised, not just compiled.
- **One pre-existing test needed updating, and it was the right kind of failure.** `runtime-store.test.ts` pins the exact list of runtime migrations, so `003_create_devices.sql` broke it. That assertion is doing its job; the expected list was extended.

The real `~/.threadbase/runtime.db` was checked afterwards and is untouched (still two migrations, mtime unchanged) — the suite's runtime-db isolation held.

Nothing is committed. Both branches are `fix/review-defects` in their respective worktrees.

---

## Retention follow-up (2026-08-14)

Checking these fixes against the published privacy policy surfaced three consequences of the D6 database move. All three are now fixed; two were caused by the move itself.

| # | Issue | Resolution |
|---|---|---|
| **R1** | **Device records had become unerasable.** `revoke()` is a soft delete that keeps the row for the audit surface, the registry now lives in `runtime.db`, and no CLI command deletes that file — so a row, including the user-supplied `name`, was permanent. Before the move, `cache clear` removed it as a side effect. | `DevicesRepository.delete()` / `deleteRevoked()`, `DELETE /api/devices/:id` and `DELETE /api/devices` (admin-scoped, additive), and a `tb-streamer devices list\|revoke\|delete` command group. The CLI talks to runtime.db directly so it works with the server stopped — an erasure tool that needs the server running is not much of an erasure tool. |
| **R2** | **Device labels were duplicated on disk.** The import left the cache-side rows in place for rollback, so the same user-supplied names sat in two files indefinitely. | `importLegacyDevices` now **moves** rather than copies: it verifies the destination row count matches what was read, then deletes the source. `managed_sessions` is unchanged and still copies. The cost is that rolling back to a pre-move streamer requires re-pairing — a QR scan — which was judged cheaper than retaining duplicate personal data indefinitely. |
| **R3** | **The published policy overstated deletion.** `threadbase.sh/privacy-policy` said, in two places, that uninstalling the app deletes everything stored locally. False on iOS: `expo-secure-store` is called with no options anywhere in tb-mobile, so Keychain entries survive an uninstall — and since D6 the device token is read back from there, so a reinstall restores a working credential set. | The caveat is now published in all four locales (`en`, `he`, `ar`, `ru`) in **tb-landing**, plus the actionable remedy: removing a server inside the app deletes that server's credentials. A regression guard in `tests/content.test.ts` fails the build if either string loses the qualification. |

**Erasure is deliberately not revocation.** Deleting a row frees its `token_hash` without telling the device anything, so it stops being *known* rather than being *refused*. Both the API and the CLI refuse to delete an active device unless forced, and `deleteRevoked()` exists so "revoke, then erase" is the easy path.

**Correcting an earlier claim in this session's review.** The policy divergence was first described as the deployment having dropped a paragraph its source contained. A line-by-line comparison showed the reverse: `tb-mobile/docs/privacy-policy/proposed-privacy-policy.md` is a superseded draft, and the deployed page is *ahead* of it — carrying the Sentry EU processing location (still an unresolved "set this before publishing" note in the draft), the Android speech-recognition caveat, the MailerLite section, and the current support address. Reconciling toward the draft would have deleted accurate disclosures. Exactly one draft sentence was better than the deployed text, and that is the one that was published. The draft is now marked superseded so nobody repeats the mistake.
