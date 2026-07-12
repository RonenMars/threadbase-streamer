# Session prompt — tb-scanner: incremental refresh (byte-offset checkpointing)

> **Run in:** the `tb-scanner` repo (publishes `@threadbase-sh/scanner`)
> **Depends on:** nothing — fully independent, start any time
> **Unblocks:** tb-streamer PR 2 (offset index) imports the new `parseJsonlLine` export
> Extracted from `tb-streamer/docs/superpowers/specs/2026-07-12-live-conversation-reparse-stall-design.md`.

---

Fix an event-loop-blocking full-file re-parse in the persistent index engine, using log-shipper-style byte-offset checkpointing.
This bug freezes tb-streamer (a downstream consumer) for 2-3 minutes at a time in production.

## The incident (downstream context)

tb-streamer serves Claude Code conversations to a mobile app.
When a conversation has a LIVE session appending ~1 JSONL line/second, every detail request notices "file changed" and calls scanner.refreshFile().
Result: the entire file is re-parsed from byte 0 on every request; concurrent client retries pile up on the Node event loop; the server stalls for minutes.
Verified in production logs (requests released in same-second batches with ms=120000-190000).

## Root cause

Verified in the 0.9.4 bundle; line numbers from dist/index.js, source files named by the bundler's `// src/` markers.

1. `src/persistent/index-engine.ts` — indexFile() calls checkpoints.remove(filePath) (dist:2228) on EVERY file change. For an append-only file this throws away paging checkpoints whose prefix is still perfectly valid.
2. `src/persistent/index-engine.ts` — getPage() (dist:2361): when checkpoint count is 0 and total > CHECKPOINT_INTERVAL, it calls buildCheckpoints(), which re-streams the WHOLE file.
3. `src/persistent/paged-reader.ts` — buildCheckpoints() (dist:1643) does a synchronous JSON.parse fold over every line plus structuredClone(state) every 500 messages (dist:1654). No yielding — the event loop is blocked for the duration.
4. `src/scanner.ts` — refreshFile() (dist:2838) evicts the in-memory LRU entry (dist:2872-2905), so the next getConversation() re-parses the full file too.

Net effect: an append of ONE line costs O(entire file), twice (persistent + in-memory), on the main thread.
Claude Code session files reach multi-GB upstream (anthropics/claude-code#22365, #18905) — design for GB-scale.

## Required design (the Filebeat/Fluent Bit/Kafka pattern)

A. Per-file resume state, persisted in the scanner's SQLite index DB (new migration):
   `file_state(path PK, identity, size, mtime_ms, byte_offset, last_message_index, reducer_state_json)`.
   `identity` = inode (fall back to a fingerprint of the first N bytes when inode is unavailable/reused — Vector's approach).

B. refreshFile(filePath) becomes incremental:
   - stat the file.
   - identity mismatch OR size < byte_offset → truncated/replaced: drop file_state + checkpoints for that path, full re-parse (this fallback keeps correctness).
   - size == byte_offset and mtime unchanged → no-op.
   - size > byte_offset → `fs.createReadStream({ start: byte_offset })`, carry a partial-line remainder across reads (advance byte_offset only past complete, successfully parsed lines — a torn write must not corrupt state), resume the metadata/conversation reducers from persisted reducer_state, parse ONLY the new lines, and UPDATE the in-memory LRU entry in place instead of evicting it.

C. Checkpoints become append-only (Kafka sparse-index style):
   - On append, EXTEND the checkpoint chain past the previous EOF; never remove entries covering the immutable prefix. Remove only in the truncation branch.
   - Prefer storing `{messageIndex, byteOffset}` checkpoints and reconstructing page state by seeking to the nearest checkpoint and parsing forward — this eliminates the structuredClone-per-500-messages entirely.
     If reducer snapshots must stay, clone once at checkpoint creation only.

D. Event-loop hygiene for the remaining full parses (cold index, truncation fallback):
   await setImmediate() (or setTimeout 0) every ~500-1000 lines.
   Add a single-flight guard: one in-flight parse promise per filePath; concurrent refreshFile/getPage callers await the same promise instead of starting duplicate parses.

E. New export for consumers: a stateless per-line parse/classify function (the exact line→Message mapping used internally), so downstream indexers (tb-streamer's watcher) can process appended lines with identical semantics instead of duplicating parser logic.
   Name suggestion: `parseJsonlLine()` / `classifyJsonlLine()`.

## Compatibility constraints

- Public API signatures unchanged (refreshFile, getPage, getConversation, parseSingleFilePage, parseConversation) — behavior just gets faster. Semver: minor.
- The persistent DB gets a new migration (see `src/persistent/migrations.ts` pattern).
  Existing installs must upgrade cleanly: absent file_state rows mean "cold", and the first refresh backfills them.
- Watch out for streaming duplicate entries: appended lines can share a requestId with earlier lines (token counts growing).
  If any keep-last-per-requestId dedupe exists in the reducers, verify it still works when the duplicate arrives in a LATER incremental batch than the original (state must persist enough to dedupe across the boundary).

## Acceptance criteria / tests (TDD — write these first)

1. Append N lines to an indexed file → refreshFile reads ONLY the appended bytes (spy on createReadStream options.start) and existing checkpoints are untouched.
2. getPage() after an append does NOT rebuild checkpoints from zero.
3. Truncate a file (size < offset) → full re-parse fallback, correct results.
4. Replace a file at the same path (new identity) → treated as new file.
5. Partial line at EOF (torn write) → not parsed, not counted; completed on next append.
6. refreshFile leaves the in-memory LRU usable without a full re-parse (getConversation after refresh does not re-stream the file — spy on read calls).
7. Concurrent refreshFile×10 on one path → exactly one underlying parse (single-flight).
8. Event-loop check: indexing a synthetic 100k-line file keeps max event-loop delay under ~50ms (use perf_hooks.monitorEventLoopDelay).
9. Existing test suite stays green.

Work on a feature branch, conventional commits, open a PR.
Run the full lint + test suite before committing.
