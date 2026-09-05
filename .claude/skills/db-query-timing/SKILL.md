---
name: db-query-timing
description: tb-streamer SQLite query instrumentation: what db.slow_query and db.query log, why the 35 ms threshold is what it is, and why host saturation — not the SQL — is the usual cause of a slow-query storm. Use when investigating slow queries, cache.db performance, or db.slow_query log lines.
---

# Db Query Timing

Moved out of the repo root `CLAUDE.md` so it loads on demand rather than in every session.
## Query timing

Every SQLite statement is timed. `instrumentDatabase()` (`src/db/query-timing.ts`) wraps `db.prepare` at both `new Database()` sites — `ConversationCache.open` and `RuntimeStore.open` — so the ~90 statements prepared across the cache, the runtime store and the repositories that share those handles are all covered without touching a call site.
`better-sqlite3` is synchronous, so a call's wall time is its cost; measured overhead is +1% on an 8.9 µs call, which is why it is always on rather than behind a flag.

What gets logged, and why so little: the prod log was measured at 261 MB with no rotation, and a single conversation fetch runs dozens of statements.

- **`db.slow_query`** (warn) — a statement at or above `THREADBASE_DB_SLOW_QUERY_MS`. On by default.
- **`db.query`** (debug) — every statement. Off unless `LOG_LEVEL=debug`.
- Both are emitted with dest `"pino"` explicitly. That was written against the old `"both"` default, which also wrote the message through `console.*` so every line landed in the prod file twice; the default is now TTY-aware and already resolves to `"pino"` under a supervisor. The explicit `"pino"` is still correct — it also suppresses the console line at an interactive terminal, which is what these high-frequency lines want.
- Each line carries the statement's **name** (its key in the `stmts` object, applied by `labelStatements`; anything unnamed falls back to `verb:table`), the duration and the row count. Never the SQL text — too verbose — and never the bound parameters, which carry file paths and conversation ids.

**The 35 ms default is measured, not chosen.** Against the live 22 MB `cache.db` (583 conversations, 38 717 index rows), 3 600 read samples across the twelve statements the hot paths run gave p50 0.03 ms / p99 0.87 ms / max 1.83 ms, and 1 200 write samples gave p99 0.09 ms with rare WAL-checkpoint spikes to 4.37 ms. 35 ms is 8× the slowest healthy operation observed, so checkpoint spikes never page anyone, and it is more than the 34 ms *end-to-end* time of the fastest complete conversation fetch measured on this box — a query crossing it cost more on its own than an entire healthy request.
Re-measure before trusting the default on hardware unlike this one.

**Host saturation is the pathology this list was missing, and it is the one that actually occurred.**
On 2026-08-03 the `list` statement reported 104 slow lines at a 118.7 ms median — 136× the documented
p99 — with an index present and used, and `cache.db` at exactly the 22 MB the benchmark was taken at. The
same statement measured **p50 0.38 ms / p99 0.85 ms** against a copy of that cache on an idle machine.
The box was at load 14.7, saturated by tooling around the investigation rather than by the streamer,
which did not appear in the top twelve consumers. Because `better-sqlite3` is synchronous and this timer
measures wall time, a starved process makes every statement look pathological — a true statement about
cost, and not a statement about SQL. **Check the host before the query**: an index that the planner is
already using will not explain a 300× regression.

**At that threshold the warn line may never fire, and that is the intent.** 35 ms is roughly 40× the slowest query ever observed here (p99 0.87 ms, max 1.83 ms), so `db.slow_query` is a tripwire for pathology — a missing index, a lock, a cache grown far past today's 22 MB — not ongoing visibility into query cost. **Silence is not evidence that queries are fast.** It means nothing crossed 40× the observed maximum, which is also what a broken timer, a disabled threshold (`<= 0`) or a statement that throws before recording would look like. To actually see query cost, run with `LOG_LEVEL=debug` and read `db.query`, or lower the threshold for the duration of an investigation.

**Slow-query lines are not attributed to a request.** Doing that needs `AsyncLocalStorage` or a request id threaded through (`AppEnv.requestId` is declared but never set by anything today), and it would only cover the subset of queries that have a request at all — the watcher, the boot scan and the backfill run outside any. At a 35 ms threshold these lines are rare enough to correlate with the adjacent `http.request` line by timestamp; revisit if they ever stop being rare.

