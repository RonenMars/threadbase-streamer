# Cache Integrity Alert — Streamer Implementation Plan

**Spec:** [`docs/superpowers/specs/2026-07-18-cache-integrity-alert-design.md`](../specs/2026-07-18-cache-integrity-alert-design.md) — read it first, it has the full contract and rationale. This document is execution-focused.

**Recommended model/effort:** Opus 4.8, effort **high**. This touches server startup sequencing, live file-watcher handlers, SQLite transactions, WAL-aware backup, a new REST surface, and CLI plumbing — six-plus files with real coupling between them and a meaningful test surface. Not a mechanical change.

**Branch:** `feat/cache-integrity-alert` (PR1, server-complete) then `feat/cache-integrity-cli` (PR2, stacked on PR1).

## Prerequisites

- Read `src/conversation-cache.ts` in full before touching it — it's large and has several subtle invariants documented inline (the "CRITICAL #2 race" comment on `reconcileDeletions` at line ~1551 in particular).
- Read `src/services/questions/codexGateAnswers.ts` — this PR's `alertStore.ts` copies its load/save-merge pattern exactly.
- Run `npm test` and `npm run lint` once before starting to confirm a clean baseline (per repo CLAUDE.md, tests should be run under the `.nvmrc` Node version, especially anything touching `better-sqlite3`).

## PR1 — Detection, freeze, persistence, wire contract (server-complete)

### Step 1 — `ConversationCache` additions

File: `src/conversation-cache.ts`. Add three methods near the existing `pruneGhostFiles`/`reconcileDeletions` (~line 1500-1600):

```ts
listMissingFiles(exists: (p: string) => boolean = existsSync):
  { id: string; filePath: string; title: string | null; tailed: boolean }[]
```
Read-only. Reuse `this.stmts.allFilePaths.all()` (same statement `pruneGhostFiles` uses) and `this.stmts.hasTail`. Do not mutate anything.

```ts
dropRowsById(ids: string[]): number
```
One `db.transaction`. For each id: delete tail (`deleteTailById`), delete from `conversation_message_index` (there's an existing prepared statement for this at ~line 452 that neither `pruneGhostFiles` nor `reconcileDeletions` currently calls — that's a pre-existing gap in those two methods; **do not fix it there**, only use it in this new method), delete the row (`deleteById`), and clean the in-memory `fileIndex` the same way `pruneGhostFiles` does (~lines 1522-1531). Returns count actually dropped.

```ts
clearAll(): void
```
Uses the existing `deleteAll`/`deleteTailAll` statements (~lines 376-377), plus a `DELETE FROM conversation_message_index`, plus resetting `fileIndex` to empty. This is only called from `reset_rescan`.

**Test:** extend `__tests__/conversation-cache.test.ts` with cases for all three — `listMissingFiles` against a mix of present/missing/tailed rows; `dropRowsById` verifying tail, message-index, and fileIndex are all cleaned (not just the main row); `clearAll` verifying all three tables end empty and a subsequent `upsertFromScannerMeta` works cleanly afterward.

### Step 2 — Backup helper

New file: `src/services/cache-integrity/backup.ts`.

```ts
export async function backupCacheDb(db: Database, cacheDir: string): Promise<string>
```

Use better-sqlite3's native `db.backup(destPath)` (async, WAL-safe — confirm the installed better-sqlite3 version supports it; it's been available since v7). Destination: `join(cacheDir, "backups", `cache-${timestamp}.db`)` — timestamp format matches what a human backup would look like (`YYYYMMDD-HHMMSS`), directory created with `mkdir -p` semantics if absent. After a successful backup, list existing backups in that directory, sort by mtime, and delete all but the newest `THREADBASE_CACHE_BACKUP_RETAIN` (default `3`, parse as int with fallback). Return the path of the backup just created.

**Test:** new `__tests__/cache-backup.test.ts`. Write some rows including uncheckpointed WAL data (don't force a checkpoint before backing up), back up, open the backup file as a fresh `Database` instance, and assert the WAL'd rows are present. Also test retention: create 5 backups, assert only 3 remain and they're the newest 3.

### Step 3 — Alert store + monitor

New file: `src/services/cache-integrity/alertStore.ts`. Mirror `codexGateAnswers.ts` exactly: `~/.threadbase/cache-alert.json` path (respecting `THREADBASE_CONFIG_DIR`), `loadAlertState()` (try/parse, `{}` on any failure — never throw), `saveAlertState(state)` (mkdir -p, write pretty JSON). Shape is the `{ pending?, ignoredIds? }` object from the spec.

New file: `src/services/cache-integrity/cacheIntegrityMonitor.ts`.

```ts
export class CacheIntegrityMonitor {
  constructor(cache: ConversationCache, wsHub: WsHub, log: Logger, cacheDir: string)

  get pending(): PendingAlert | null

  async runDetection(): Promise<void>
  // 1. missing = cache.listMissingFiles()
  // 2. filter out ids in this.ignoredIds
  // 3. if empty: clear any stale pending, return (caller decides whether to run pruneGhostFiles)
  // 4. classify severity from MIN_MISSING / MIN_RATIO env-or-default constants
  // 5. build PendingAlert with a fresh fingerprint (sha256 of sorted ids), persist via alertStore
  // 6. if severity === "high": await backupCacheDb(...), store backupPath on the pending record
  // 7. broadcast {type:"cache_alert", ...} via wsHub

  deferUnlink(filePath: string): void        // queue while pending
  recordUnlink(filePath: string): void       // storm counter while NOT pending; crossing threshold -> runDetection()

  async resolve(fingerprint: string, action: ResolveAction, ids?: string[]):
    Promise<{ ok: true; action: ResolveAction; pruned?: number; backupPath?: string } | { alreadyResolved: true } | { conflict: true; currentFingerprint: string }>

  wsMessage(): CacheAlertWsMessage | null    // for unicast-on-connect
  healthzField(): { severity; missingCount; fingerprint; detectedAt } | undefined
}
```

Implement `resolve` exactly per the spec's four-action semantics (re-verify-on-`prune_all`, intersect-on-`prune_selected` then re-run detection on the remainder, ids-not-fingerprint on `ignore` plus discarding the deferred queue, backup-then-`clearAll`-then-`rescanForRefresh`+`upsertFromScannerMeta` on `reset_rescan`). Fingerprint mismatch and no-pending cases return the tagged results above rather than throwing — the route layer maps them to the right HTTP status.

Storm window: keep a simple ring/array of unlink timestamps, drop entries older than 30s on each call, compare length to 10.

**Test:** new `__tests__/cache-integrity-monitor.test.ts`. Cover: severity classification at and around both thresholds; ignored ids excluded from detection; fingerprint is stable for the same missing-set and changes when the set changes; storm window triggers detection at exactly the threshold and not one below it; defer/drain/discard queue behavior for each of the three outcomes (prune_all drains, ignore discards, prune_selected drains only for the pruned subset — confirm against the spec which is authoritative if this plan and the spec ever disagree); persistence round-trips through `alertStore` (use `THREADBASE_CONFIG_DIR` pointed at a temp dir, same technique as the existing `codex-gate-answers` test).

### Step 4 — Wire into `server.ts`

- Construct one `CacheIntegrityMonitor` instance alongside the `ConversationCache` construction, store it on `ApiDeps` (or wherever `wsHub`/`cache` already live on the deps object) so routes can reach it.
- **Warm-up chain** (~lines 945-1059): after the tail-population batches and before the existing `pruneGhostFiles()` call at line 1043, call `await monitor.runDetection()`. If `monitor.pending` is set after that, **skip** the `pruneGhostFiles()` call; otherwise call it exactly as today. Do not change anything about `cache_ready` broadcast timing.
- **`onFileDeleted`** (~lines 441-448): if `monitor.pending`, call `monitor.deferUnlink(filePath)` and return — do not call `invalidateByFilePath`. Otherwise, keep the existing `invalidateByFilePath` call and additionally call `monitor.recordUnlink(filePath)` right after.
- **`?refresh=1` handling** (~lines 1373-1387): wrap only the `reconcileDeletions(...)` call in `if (!monitor.pending) { ... }`. The `upsertFromScannerMeta` call in the same handler runs unconditionally as today.
- **`handleWsOpen`** (near line 617, wherever the initial per-connection setup happens — same place `pendingPermission` replay would go for a session, but this is server-level so it doesn't need a `sessionId`): if `monitor.pending`, immediately send `monitor.wsMessage()` to the newly-connected socket.
- Leave `onConversationChanged`'s `invalidateByFilePath(..., { skipIfTailed: true })` call (~line 429) completely untouched — it's an append-race guard, unrelated to deletion.

**Test:** extend whatever integration harness already boots a real server for tests (check `__tests__/` for an existing pattern — likely something using a random port, per repo conventions) with cases: warm-up skips `pruneGhostFiles` when detection finds a pending alert; `?refresh=1` skips `reconcileDeletions` while pending but still applies upserts; a client connecting while an alert is pending immediately receives the WS message.

### Step 5 — WS types, REST routes, healthz field

`src/types.ts`: add the two new variants to the `WSMessage` union per the spec's exact shapes.

New file: `src/schemas/cacheAlert.schema.ts` — the zod schema from the spec (`fingerprint`/`action`/`ids` with the `.refine` for `prune_selected`).

New file: `src/api/routes/cacheAlert.routes.ts` — follow the existing one-file-per-route-group, factory-takes-`ApiDeps` pattern used throughout `src/api/routes/`. Two handlers:

- `GET /` → `c.json({ pending: monitor.pending })`
- `POST /resolve` → validate body against the schema (400 on failure, matching how other routes in this directory report zod errors), call `monitor.resolve(...)`, map its tagged result to the right response/status per the spec (200 success, 200 `alreadyResolved`, 409 `fingerprint_mismatch`). Plain `c.json(...)` — no `ALREADY_HANDLED`.

Mount the new sub-app in `src/api/app.ts` (or wherever route groups are composed) at `/api/cache/alert`, following the existing mounting pattern exactly.

`src/api/routes/health.routes.ts`: add the optional `cacheAlert` field to the `/healthz` response, sourced from `monitor.healthzField()`. This route currently doesn't take `deps` — check whether it needs to be converted to a factory like the others, or whether there's already a lighter-weight way health data reaches it; follow whatever the smallest change is that gets `monitor` in scope.

**Test:** new `__tests__/cache-alert-routes.test.ts` covering both endpoints' full contract (200/409/400/alreadyResolved cases) using a real `ConversationCache` + `CacheIntegrityMonitor` wired the same way `server.ts` wires them. Extend the existing healthz test coverage for the field being present when pending and absent when not.

### PR1 completion checklist

- `npm run lint` clean, `npm test` green (run under `.nvmrc` Node — flag anything that looks like a pre-existing flake vs a real regression per repo conventions).
- Manual verification against a local `serve` instance: delete a handful of test JSONLs from a scratch `~/.claude/projects`-like directory pointed at by a throwaway `THREADBASE_CONFIG_DIR`/browse root, confirm an alert is raised, confirm `GET /api/cache/alert` and `/healthz` reflect it, confirm each of the four resolve actions behaves as specified, confirm a restart mid-freeze keeps the alert.
- Update `docs/compatibility/tb-mobile.md` with the new WS types / endpoint / healthz field per the file's existing format (it's the canonical list mobile depends on — this PR must add to it, not just implicitly rely on additive-safety).

## PR2 — CLI surface (stacked on PR1)

### Step 1 — Interactive serve-time prompt

`src/lifecycle/prompt.ts`: add a new prompt function alongside `interactivePermissionModePrompt`, following its exact readline pattern. It should describe the pending alert (severity, missing count) and offer the same four actions (or "skip for now" leaving it pending, which is also a valid response — don't force a decision here, this is a convenience surface, not the only way to resolve).

`cli/index.ts`: in the `serve` command, gate the new prompt with the identical conditions used for the permission-mode prompt (~lines 126-136: real TTY via `stdin.isTTY`, not `opts.prod`, not `process.ppid === 1`, and add an equivalent `THREADBASE_SKIP_*` env escape hatch mirroring `THREADBASE_SKIP_PERMISSION_MODE_PROMPT`). Fire it only when `monitor.pending` is truthy after warm-up completes — this needs to hook in after the warm-up chain resolves, not before.

### Step 2 — `cache` subcommands

`cli/index.ts` already has a `cache` command (~line 254) — extend it, don't create a new top-level command. Add `status` (prints the pending alert if any, or "no drift detected") and `resolve <action> [--ids id1,id2,...]` (calls the REST endpoint). Both should talk to the locally running server over HTTP using the same pattern the existing `pair` command uses for auth (`loadOrCreateApiKey()`, ~line 280) — this is the headless/prod-facing path when no TTY prompt is available.

**Test:** extend whatever CLI test coverage exists for the `cache` command today with cases for `status` and `resolve` (mock the HTTP call or spin up a throwaway server instance, matching whatever the existing `cache` command tests already do).

### PR2 completion checklist

- `npm run lint && npm test` green.
- Manual: `tb-streamer cache status` / `cache resolve ignore` against a local server with an induced alert.

## Follow-up (separate, small PR — not part of this plan's scope)

`vendor/menubar`: read the new `cacheAlert` field off the `/healthz` response the renderer already polls every 5s (`src/renderer/renderer.js:23,28`), switch to the existing-but-currently-unused `error` tray icon state (`src/icons.ts:5`) and `.dot-red` styling (`styles.css:89`) when present, add one line of menu text. No new window, no new polling interval, no Electron `Notification`. This is small enough to fold into either PR1 or do as its own tiny PR after — call it separately since it's a different repo/submodule with its own bump-and-deploy flow (see root `CLAUDE.md`'s menubar submodule section).
