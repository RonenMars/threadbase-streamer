# Cache Integrity Alert — Design

## Problem

The SQLite conversation cache (`~/.threadbase/cache/cache.db`, `src/conversation-cache.ts`) can drift from disk truth (`~/.claude/projects/*.jsonl`, `~/.codex/sessions/*.jsonl`). Real incident on 2026-07-18: `~/.claude/projects` was accidentally deleted; the cache still held 2125 conversation rows against 181 real files (7 Claude + 174 Codex). `/api/conversations` served ghosts; resume 404'd (a distinct `history_file_missing` error code was already shipped for that specific path — see PR #228).

Existing drift-detection code only partially covers this:

- `pruneGhostFiles()` (`src/conversation-cache.ts:1506`) runs once at startup, but **keeps rows that have a cached tail** — exactly the rows a real deletion leaves behind, so ghosts accumulate forever.
- `reconcileDeletions()` (`src/conversation-cache.ts:1561`) drops ghosts including tailed ones, but only runs on `GET /api/conversations?refresh=1` (`src/server.ts:1373-1387`) — it's opportunistic, not proactive.
- `onFileDeleted` (`src/server.ts:441-448`) silently prunes one row per live chokidar `unlink` event — fine for one file, but an `rm -rf` while the server is running drains the cache with zero user-visible signal.
- Nothing detects "most of my history just disappeared" as a distinct, dangerous event, and nothing stops destructive action from happening automatically before a human has looked at it.

## Goal

Never silently display or act on stale cache data. When cache/disk drift is detected:

1. **Freeze** — no automatic pruning/reconciliation happens once drift is detected, until a human decides.
2. **Protect** — back up the cache DB before any destructive resolution (immediately, for a mass-deletion event).
3. **Ask** — surface the decision on every surface the user might be looking at: mobile app, menubar tray app, CLI.
4. **Act** — apply exactly the action the human chose, once, idempotently.

## Scope (v1)

In scope: detect missing-file drift (startup sweep + live unlink storm), severity classification (mass deletion vs a few stray files), freeze semantics, auto-backup, a persisted pending-alert record that survives restarts and re-surfaces on every client connect, and four resolution actions.

Deferred to v2 (explicitly out of scope): detecting a *moved* project directory and re-linking cache rows to new paths by conversation UUID; detecting a temporarily unmounted volume/network share vs a genuine deletion; per-project or per-client differentiated severity; automatic recovery from Time Machine.

## Severity & thresholds

- **High severity ("mass deletion")**: `missingCount >= 20` **and** `missingCount / totalRows >= 0.20`. Triggers immediate backup, a blocking modal on mobile, and a Time Machine hint in the copy.
- **Low severity**: any nonzero missing count below the high threshold. Triggers a dismissible-but-persistent banner; no modal, no forced backup until the user picks a destructive action.
- Both severities **freeze** — the only difference is how loud the ask is.
- Thresholds are env-overridable: `THREADBASE_CACHE_ALERT_MIN_MISSING` (default 20), `THREADBASE_CACHE_ALERT_MIN_RATIO` (default 0.20).
- Live-unlink storm: `>= 10` unlinks within a `30s` window while the server is running re-triggers detection (same thresholds then classify severity from the resulting missing set).

## Detection flow

1. **Startup warm-up** (`src/server.ts` warm-up chain, `~945-1059`): after tail population, run `CacheIntegrityMonitor.runDetection()` instead of unconditionally calling `pruneGhostFiles()`. Agent-conversation rows are excluded automatically — `pruneAgentConversations()` (`server.ts:900`) already removes them earlier in startup, so agent JSONL deletions never raise an alert. Ids the user has previously chosen to `ignore` are excluded from the missing-set. If the remainder is empty, behave exactly as today (`pruneGhostFiles()` runs). If non-empty, classify severity, persist the pending alert, broadcast it, and — if high severity — back up the DB immediately.
2. **Live deletions** (`onFileDeleted`, `server.ts:441-448`): while an alert is pending, defer — queue the path, do not invalidate the row. While no alert is pending, invalidate as today and record the unlink for storm detection; crossing the storm threshold runs detection.
3. **`?refresh=1`** (`server.ts:1373-1387`): while an alert is pending, skip `reconcileDeletions()` (the removal half) but keep running the upsert half (additions/updates from a fresh scan are still safe and useful).

## Resolution actions

All four are invoked via `POST /api/cache/alert/resolve`, are idempotent per fingerprint (see below), and — except `ignore` — back up the DB first if not already backed up for this pending alert.

- **`prune_all`** — re-verify each missing id against disk (a file may have reappeared, e.g. a remount) and drop only rows still missing; then apply the deferred unlink queue normally.
- **`prune_selected`** (`ids: string[]`) — drop only the given ids (must be a subset of the pending missing-set); re-run detection on the remainder — if anything is still missing, a new pending alert (new fingerprint) is raised.
- **`ignore`** — persist the missing ids into a durable ignore-list (not just the fingerprint — see below), clear the pending alert, and **discard** the deferred unlink queue (the user explicitly chose to keep these rows, so queued deletions for other paths must not be silently applied as a side effect).
- **`reset_rescan`** — back up, clear all conversation/tail/message-index state, then re-run the existing refresh scan machinery (`rescanForRefresh()` + `upsertFromScannerMeta`, `server.ts:1374-1381` — NOT a re-run of the one-shot startup warm-up chain, which cannot be invoked twice) to rebuild the cache from disk truth. Tails are not eagerly re-warmed; they repopulate lazily on next read/tail, matching existing behavior for freshly discovered conversations.

**Why ignore persists ids, not just a fingerprint of the set:** if the fingerprint of `{A,B,C}` were the ignore key, one more deletion (`D`) produces a new set `{A,B,C,D}` with a different fingerprint that doesn't match anything ignored — so `A,B,C` would resurface in a new alert even though the user already said "leave them." Persisting the individual ids avoids this.

## Idempotency & concurrency

- Every pending alert has a `fingerprint` = sha256 of its sorted missing-id list.
- A resolve request must include the fingerprint it's resolving. If it matches the current pending alert, it proceeds. If there's no pending alert at all, respond `{ ok: true, alreadyResolved: true }` (first successful resolver wins; a second concurrent request harmlessly no-ops). If a pending alert exists but with a **different** fingerprint (e.g. `prune_selected` left a remainder, or a restart recomputed a changed set), respond `409 { error: "fingerprint_mismatch", currentFingerprint }` so the caller can refetch and re-render before retrying.
- Node's single-threaded event loop plus synchronous better-sqlite3 calls mean two resolve requests never interleave mid-mutation.

## Persistence

`~/.threadbase/cache-alert.json` (directory overridable via `THREADBASE_CONFIG_DIR`, same as `~/.threadbase/gate-answers.json` — see `src/services/questions/codexGateAnswers.ts` for the load/save-merge pattern this copies):

```json
{
  "pending": {
    "fingerprint": "sha256:...",
    "severity": "high",
    "detectedAt": "2026-07-18T01:00:00.000Z",
    "missingCount": 1944,
    "totalRows": 2125,
    "backupPath": "/Users/.../cache/backups/cache-20260718-010000.db",
    "missing": [{ "id": "...", "filePath": "...", "title": "...", "tailed": true }]
  },
  "ignoredIds": ["..."]
}
```

`missing` is capped at 1000 entries in the persisted file and WS/REST payloads only ever expose a 20-item `sample` — the full list is available via `GET /api/cache/alert` for clients that need it (e.g. to build a `prune_selected` picker).

## Backup

Uses better-sqlite3's native async `db.backup(destPath)`, not a raw file copy — the cache DB runs in WAL mode (`conversation-cache.ts:904`), so a plain `cp` of `cache.db` would miss uncheckpointed data sitting in `cache.db-wal`. Backups land in `~/.threadbase/cache/backups/cache-<timestamp>.db`; the last `THREADBASE_CACHE_BACKUP_RETAIN` (default 3) are retained, older ones pruned.

## Wire contract

### WebSocket (additive to `WSMessage`, `src/types.ts`)

Server-level (no `sessionId`), following the existing `cache_ready` / `scan_progress` precedent (`types.ts:180-181`):

```ts
{ type: "cache_alert", fingerprint: string, severity: "high" | "low",
  missingCount: number, totalRows: number, detectedAt: string,
  sample: { id: string, title?: string }[] } // first 20

{ type: "cache_alert_resolved", fingerprint: string, action: ResolveAction }
```

Broadcast on raise/severity-change. Additionally **unicast** to a client the moment it opens its WS connection (`handleWsOpen`, next to `server.ts:617`) whenever an alert is pending — this covers both the pre-`cacheReady` startup window and every reconnect, so a client never misses an alert raised while it wasn't listening. Old mobile clients ignore unknown WS message types (verified: `services/ws-client.ts:178` guards on registered handlers only) — fully backward compatible.

### REST

`GET /api/cache/alert` → `{ pending: PendingAlert | null }` (full record, including the missing list, for building a `prune_selected` picker).

`POST /api/cache/alert/resolve`, body validated with zod:

```ts
z.object({
  fingerprint: z.string(),
  action: z.enum(["prune_all", "prune_selected", "ignore", "reset_rescan"]),
  ids: z.array(z.string()).optional(),
}).refine(v => v.action !== "prune_selected" || (v.ids && v.ids.length > 0))
```

Responses: `200 { ok: true, action, pruned?: number, backupPath?: string }`; no pending alert → `200 { ok: true, alreadyResolved: true }`; fingerprint mismatch → `409 { error: "fingerprint_mismatch", currentFingerprint }`; invalid body → `400` (standard zod validation response). Plain Hono JSON responses — this route does **not** use the `ALREADY_HANDLED` sentinel (that convention is only for handlers that write directly to the raw Node `res`).

### `/healthz` (additive field)

```ts
{ ok: boolean, version: string, cacheAlert?: { severity, missingCount, fingerprint, detectedAt } }
```

Field absent entirely when there's no pending alert. The menubar app currently reads only `ok` and `version` (`vendor/menubar/src/renderer/renderer.js:28`), so this is a fully additive, non-breaking change.

## Client surfaces

- **Mobile**: WS `cache_alert` → banner (low) or modal (high) with the four actions; REST for fetch-on-reconnect and resolve. See `tb-mobile/docs/plans/2026-07-18-cache-integrity-alert-mobile-plan.md`.
- **Menubar**: reads `cacheAlert` off `/healthz` (already polled every 5s), switches the tray icon to its existing-but-unused `error` state (`vendor/menubar/src/icons.ts:5`, `.dot-red` in `styles.css:89`) and adds a menu line prompting the user to open the mobile/CLI to resolve. No new polling, no new window — smallest possible menubar change.
- **CLI**: an interactive prompt at `serve` startup when a pending alert exists (gated identically to the existing permission-mode prompt — real TTY only, never under `--prod`/launchd: `cli/index.ts:126-136`), plus `tb-streamer cache status` / `cache resolve <action> [--ids ...]` subcommands for headless/prod use, hitting the local REST API the same way the existing `pair` command does (`loadOrCreateApiKey()`, `cli/index.ts:280`).

## Backward compatibility

Everything here is additive: new WS message types (ignored by old clients), a new optional `/healthz` field (ignored by old menubar), new REST endpoints (404 on old servers — new mobile must catch `NotFoundError` and hide the feature). No existing endpoint, field, status value, or WS message changes shape or meaning.
