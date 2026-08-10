> **Superseded — archived 2026-08-10.** A frozen 2026-07-19 snapshot. Most rows here are now fixed. For current status see [`docs/2026-08-10-open-items-register.md`](../../2026-08-10-open-items-register.md).

# Open Pre-release Issues by Severity — status update

> **Date:** 2026-07-19 (update of 2026-07-18 snapshot)  
> **Repository:** `@threadbase-sh/streamer`  
> **Source report:** [Pre-release Backlog and Roadmap Analysis](pre-release-backlog-roadmap-analysis-2026-07-18.md)

---

## Release verdict (updated)

> **Improved.** The former P0 (stale conversation history) and several P1 install/setup issues are in open PRs. Remaining open work is mostly ops polish, Windows scope, and enhancements — not first-session product blockers for a macOS-first OSS invite.

## Resolved / in flight (since 2026-07-18)

| Issue | Status | PR |
|---|---|---|
| Stale conversation history vs. fresh resume | In flight — auto-reconcile without `?refresh=1` | [#237](https://github.com/RonenMars/threadbase-streamer/pull/237) |
| Homebrew vs deploy.sh plist conflict check | In flight — warn on serve + doctor | [#238](https://github.com/RonenMars/threadbase-streamer/pull/238) |
| `bootstrapAgent` exit-5 false-positive | In flight — requires `afterBootout` | [#240](https://github.com/RonenMars/threadbase-streamer/pull/240) |
| Upload filenames with spaces break `@path` refs | In flight — sanitizeFilename | [#241](https://github.com/RonenMars/threadbase-streamer/pull/241) |
| Quick Access historical conversation routing | Superseded on modern mobile (Favorites + conversation type); legacy `/api/sessions/recents` retained for older clients | — |

## Still open

### S2 — Medium

| Task / issue | Priority | Effort | Notes |
|---|---:|---:|---|
| Log truncation creates sparse/NUL-filled logs | P1 | S | Ops/debug; not end-user mobile path |
| Windows `prod logs` | P1 if Windows ships | M | Waive for macOS-first invite |
| Codex structured prompt cards | P2 | M | Partial: trust/hooks only |
| Store API key in OS keychain | P2 | L | `0600` YAML acceptable for early OSS |

### S3 — Low

| Task / issue | Priority | Effort | Notes |
|---|---:|---:|---|
| Busy-wait CPU spin in `bootoutAgent` | P2 | XS | |
| Partial `prod logs --clear` failure | P2 | XS | |
| Fully incremental warm-up | P2 | L | Partial |
| Split `src/server.ts` | P2 | L | |
| Normalize Commander booleans | P3 | XS | |

### S4 — Enhancements

| Task / issue | Priority | Effort | Notes |
|---|---:|---:|---|
| Forward `sourceToolAssistantUUID` | P3 | XS | |
| Forward full `SystemEntry` types | P3 | S | |
| Migrate `/api/search` to QUERY | P3 | M | Keep GET for compat |
| Forward per-image metadata | P3 | M | |

## Release focus (updated)

- [x] Stale history auto-reconcile — PR #237
- [x] Homebrew conflict detection — PR #238
- [x] `bootstrapAgent` exit-5 tightening — PR #240
- [x] Upload filename sanitize (Bug 5 pair) — PR #241
- [ ] Merge the in-flight PRs above; re-verify list freshness without `?refresh=1`
- [ ] Waive or fix Windows `prod logs` only if Windows is in invite scope
- [ ] Preserve `GET /api/search` compatibility
