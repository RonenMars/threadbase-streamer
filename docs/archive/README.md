# Archive

Historical material kept for context — not the place to start if you want to use or modify the streamer today. For current docs, go up one level to [`docs/`](../).

## What lives here

### [`design-docs/`](design-docs/)

Reference and design documents that are no longer current. Two reasons a doc lands here:

1. **The design shipped but the path is no longer primary.** For example, the optional-PostgreSQL persistence path was implemented and still works, but SQLite became the primary cache layer afterwards — the Postgres-leaning reference docs (`database-config`, `neon-migration-guide`) describe a workflow that the streamer no longer leads with.
2. **The doc was an implementation prompt that overlaps with a polished design doc kept under [`architecture/`](../architecture/).** The architecture doc is the canonical version; the prompt is preserved here as the brief that drove it.

### [`implementation-plans/`](implementation-plans/)

The detailed step-by-step plans that drove substantial pieces of the streamer. Each plan corresponds to code that has since shipped:

- `2026-04-24-conversation-metadata.md` + `2026-05-01-sqlite-cache-layer.md` → the SQLite `ConversationCache` (`src/conversation-cache.ts`)
- `2026-04-24-postgres-persistence-plan.md` → the optional Postgres path (`src/db/`)
- `2026-05-02-quick-access-endpoints.md` → recents + popular endpoints
- `2026-05-02-router-path-splitting.md` → the Hono `api/routes/` split
- `2026-05-06-projects-cache-migration-prompt.md` → the projects-as-identity refactor
- `2026-05-13-jsonl-fields-propagation.md` → forwarding new scanner fields through to the mobile client (see also [`threadbase-scanner`](https://github.com/RonenMars/threadbase-scanner), [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile))
- `2026-05-30-lifecycle-*.md` → the macOS/Linux/Windows prod-dev coordination feature (`src/lifecycle/`)

These are kept because they show the design + planning discipline that preceded each feature. The corresponding design docs (where they exist) live under [`architecture/`](../architecture/).

### [`pre-release-snapshots/`](pre-release-snapshots/)

Frozen status reports from the July 2026 pre-release triage, kept for their prioritization reasoning rather than their status. Every row in them has been re-verified since and most are now fixed; the current picture lives in [`docs/2026-08-10-open-items-register.md`](../2026-08-10-open-items-register.md). They are archived rather than deleted because the "which of these actually blocks a public invite" argument in `pre-release-issues-cursor.md` is still the useful lens, and re-deriving it would cost more than keeping it.

### [`research/`](research/)

Pre-decision research dossiers. The one currently here surveyed the npm-install-vs-tarball question; the streamer stayed with tarballs + Homebrew rather than npm-first.

## Why keep these instead of deleting?

The shape of a real engineering project includes the path that was considered, the path that was tried, and the path that shipped. Deleting the first two leaves only the third, which is not the whole story. These artifacts are also useful when revisiting old decisions — you do not have to reconstruct the constraints from scratch.
