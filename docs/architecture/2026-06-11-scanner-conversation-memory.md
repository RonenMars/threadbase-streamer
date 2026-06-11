# Scanner conversation-cache memory — analysis & decision

**Date:** 2026-06-11
**Status:** Decided — no action (ship as-is; instrument before optimizing)
**Related:** [cache-layer](2026-04-30-cache-layer.md), scanner `getConversationPage` (threadbase-scanner #6, v0.5.0), conversation-detail staleness refresh (streamer #28)

## Problem

`ConversationScanner.getConversation(id)` parses an entire conversation JSONL into a
`Conversation` object (full `messages[]` + `fullText`) and caches it in an in-memory
LRU (`conversationLRU`, capacity **5**). The bounded paged read
`getConversationPage()` (v0.5.0) sits on top of that same `getConversation()` call —
it slices a window out of the already-fully-parsed array. So paging fixed the
**repeated re-parse** cost (cost #1) but not the **resident-memory** cost (cost #2):
the full message array for a large conversation still lives in the LRU, and up to 5
such conversations can be resident at once.

The question raised: is the resident-memory cost worth fixing (e.g. a true
windowed parse, an on-disk offset index), given the streamer runs on a 1 GB Fly VM?

## What actually uses the scanner

Tracing every scanner call site in the streamer (`src/server.ts`,
`src/services/projectChats/listProjectChats.ts`):

| Scanner API | Weight | Endpoint(s) | Mobile surface |
|---|---|---|---|
| `getMetadataCache()` | light — per-conversation **metadata only**, no message bodies | `/api/conversations` (list), `/api/conversations/count`, `/project-chats`, `handleResume` enrichment | Conversations list, Recents / Quick Access, resume |
| `scanner.search()` | index lookup, no full parse | `/api/search` | search |
| **`getConversation()`** | **heavy — full parse, fills the LRU** | `/api/conversations/{id}` (detail) via `findConversationByUuid`; also `handleResume` | **Conversation detail view** (+ resume) |

**Key finding:** the heavy full-parse + LRU memory path is reached by **one endpoint
family only** — opening (or resuming) a *single* conversation's detail. The list,
count, Recents/project-chats, and search paths use `getMetadataCache()`, which holds
lightweight metadata, **not** full message arrays. The memory cost is therefore
narrow and bounded, not spread across the app.

## Why this is a non-issue in practice

The scanner serves **read-only historical data**. A finished conversation's JSONL
never changes, so:

- Parsing it **once** and serving repeat reads from the LRU is exactly the right
  behavior — that is the "compute once, reuse" cache, not waste. (This is the cost-#1
  fix from scanner #6; keep it.)
- The memory ceiling is `min(5, distinct large conversations a user opens this
  session)` × one parsed conversation. For normal-sized conversations this is
  negligible. It only becomes notable if a single user opens **many distinct
  very-large (10k+ message) conversations** in one session before the LRU evicts.

The **one exception** to "static, never changes" is the **active conversation** the
user is resumed into: Claude appends turns and the JSONL grows. That is the only case
that must be revalidated, and it already is — `findConversationByUuid` compares the
file mtime against the scanned snapshot and re-parses **only the file that actually
grew** (streamer #28). So we already recompute *only on change*, nowhere else.

Net: the design already matches the "static everywhere except the live conversation"
usage model. The resident-memory cost is confined to one endpoint, bounded by an LRU
of 5, and only material under an access pattern (many huge distinct conversations per
session) that is not the observed usage.

## Options considered

| # | Option | Effort | Risk | Verdict |
|---|---|---|---|---|
| 0 | **Do nothing**; keep the LRU; instrument | none | none | **Chosen** |
| 1 | Shrink LRU (5 → 1–2) | ~10 min | low | Rejected — trades memory back for re-parse churn (re-introduces cost #1) |
| 2 | Cache a lighter projection (drop `fullText` from the page-serving path) | ~½ day | low | Deferred — best effort/payoff of the real fixes; revisit only if profiling demands |
| 3 | True bounded parse (two-pass, carry `pendingToolUses`/`teamInfoMap` state into the window; share the per-line reduction between full and windowed parse) | ~1–2 days | high (parser refactor; equivalence traps) | Deferred — only if data proves the multi-huge-conversation case is real |
| 4 | On-disk offset/state index (sidecar maintained by the watcher) | multi-day; new persistence surface | high | Rejected for now — architectural overkill for a one-endpoint, LRU-bounded cost |

Why 3/4 are not warranted today: they solve "hold at most one window in memory,"
which only pays off when many distinct huge conversations are resident — an access
pattern the usage model (static browsing; one active conversation) does not produce.

## Conclusion

**The resident-memory cost is a documented non-issue under current usage.** The LRU is
correct and should stay. `getConversationPage` (v0.5.0) already removes the
per-page re-parse cost, which was the real waste. No memory optimization is justified
without evidence.

## Recommendations / next steps

1. **Proceed with the streamer integration of `getConversationPage`** ("Task E" —
   wire it into `handleGetConversation`). It bounds per-page *work* for the active
   conversation and is independent of the memory question.
2. **Keep the LRU at 5.** Do not shrink it (Option 1) — that would re-introduce the
   re-parse cost we just eliminated.
3. **Instrument before optimizing.** If memory ever looks suspect on the 1 GB VM, add
   a cheap gauge for resident parsed-conversation sizes (e.g. sum of `messageCount`
   across `conversationLRU` entries) rather than guessing. Escalate **only** if it
   shows sustained large resident arrays under real load.
4. **Escalation path, in order, if (3) ever fires:** Option 2 (drop `fullText`) as the
   low-risk first step → Option 3 (true windowed parse) only if true bounded memory is
   genuinely required.
5. **Do not** treat the conversation *detail* path as permanently static — the active,
   growing conversation must keep its mtime-based staleness revalidation (streamer
   #28). "Fetch once, never refresh" applies to list/Recents/search/finished
   conversations, not to the live one.
