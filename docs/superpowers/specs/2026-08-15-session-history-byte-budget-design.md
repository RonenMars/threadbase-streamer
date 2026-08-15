# Session history on open: whole conversation, byte-bounded

**Status:** server half implemented (PR pending); client half tracked in threadbase-mobile#741
**Date:** 2026-08-15
**Repos:** tb-streamer (server half), tb-mobile (client half)
**Related:** PR #607 (replay the whole render terminal on subscribe)

## Problem

Opening a session shows the terminal, and the terminal shows only what the live PTY still holds — 1040 rendered rows (`SCREEN_SCROLLBACK` + `PTY_ROWS`), and on a *resumed* session, near enough nothing, because resume spawns a fresh screen (`pty-manager.ts:325` calls `createScreen()`).
Everything older lives in the JSONL, which the conversation screen already reads with pagination, but the session view never inherits it.

The durable history is keyed by **conversationId**, not by the live session: Claude `--resume` appends to the same `<conversationId>.jsonl` and keeps the same `sessionId`, so the conversation timeline spans every resume with no boundary.
That is the timeline the user means when they say "scroll up".

## Decision

The session view is seeded from the **conversation**, loaded as a single request at open, bounded by a **byte budget of 0.5 MB** rather than a message count.

Older messages beyond the budget load on **backward scroll, in place**, exactly as the conversation screen already does — not by routing the user to another screen.

Rejected: paging older **terminal rows** into the terminal view.
That would splice pages into the same list a live PTY tail is appending to and repainting — two producers, one list, seams that move mid-gesture.
Paging older **messages** above the seed has none of those properties: growth is at the top, away from the tail pinned at the bottom; older messages are immutable, so nothing below the insertion point re-renders; and the historical and live regions are separate objects with a fixed boundary between them.

Rejected: a new store for retired terminal lines.
The conversation is already stored, already indexed by byte span, and already paginated. A second durable copy at terminal-line granularity buys TUI fidelity of old scrollback and nothing else.

### What the budget costs, measured

Measured on one developer box, 2026-08-15.

Source files, over 712 JSONL transcripts:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| messages | 29 | 452 | 1 663 | 2 490 |
| JSONL bytes | 315 KB | 2.6 MB | 10.2 MB | 22.8 MB |

**The budget applies to the serialized response, and the response is not a fixed fraction of the JSONL.** Sampling eight real conversations gave payload/JSONL ratios from **0.03 to 0.61** — a 20× spread, driven by how much of a transcript is tool output the API reshapes. So the source-file distribution above cannot be translated into payload bytes by any single ratio, and the budget has to be calibrated against the response directly.

Response payloads, 40 conversations sampled at `msg_limit=500` (the largest page the endpoint will serve):

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| payload bytes | 62 KB | 0.5 MB | 2.6 MB | 3.1 MB |

**At 0.5 MB, 90% of conversations load whole and 10% truncate.**
That is the number to design against; an earlier draft of this spec said 63/37, derived from JSONL bytes, and was wrong for the reason above.

Truncation being the 10% case does not make the boundary optional — it makes it *quiet*, which is worse if it is silent. Both still hold:

1. The boundary must be **visible** in the UI, not silent.
2. The "load older" affordance behind it must actually work, on the screen that already implements paging.

**A message count cannot do this job, and already does not.** `msg_limit` is clamped to 500 (`conversations.handlers.ts:691`), so "load the whole conversation with a 100 000 limit" silently returns 500 messages; a 2 490-message conversation needs five pages whatever the budget. The seed is one bounded page either way, which is why backward paging is the mechanism rather than a fallback.

## Server half (tb-streamer)

### `GET /api/conversations/:id` — add `max_bytes`

Additive query parameter. Absent → today's behaviour, unchanged.

```
GET /api/conversations/:id?max_bytes=524288
```

- Serve the **newest** messages, walking backward from the tail, accumulating serialized size until the next message would cross `max_bytes`.
- Never serve zero messages: a single message larger than the budget is returned whole. A blank screen is worse than an over-budget one.
- Measure in **bytes** (`Buffer.byteLength`), not UTF-16 string length. Hebrew is 2 bytes per character in UTF-8 and emoji up to 4, so length-based accounting silently stops binding for exactly the users a budget protects.
- Clamp `max_bytes` server-side so a typo'd extra zero cannot ask for a multi-hundred-MB response.
- `max_bytes` counts as a paging parameter: sent alone it must still produce a `message_pagination` block, or a trimmed page would have no cursor to page older from.

Response gains **one** additive field, inside the existing `message_pagination` object:

```jsonc
"message_pagination": {
  "total": 2490,
  "before_index": 2490,
  "from_index": 2301,        // already present — moves to the trimmed page's start
  "has_more_older": true,    // already present — this IS the truncation signal
  "next_before_index": 2301, // already present — the cursor for the older page
  "served_bytes": 498231     // NEW: what the budget actually spent
}
```

**No `truncated` flag.** An earlier draft specified one; it is redundant. A budget-trimmed page is exactly a page with older messages behind it, which is what `has_more_older` and `next_before_index` already say, and the client behaviour is identical in both cases: show the affordance, page backward, stop at `from_index === 0`. `served_bytes` is kept because what the budget spent is genuinely new information and is what future calibration reads.

Paging older stays exactly as it is: `before_index=<from_index>&msg_limit=<n>`, already implemented (`conversations.handlers.ts:563`).

### Not changing

- No new table, no new endpoint, no retained-line store.
- `subscribe_session` replay is untouched — PR #607 settled it at `REPLAY_MAX_LINES`.

## Client half (tb-mobile)

1. **On opening a session**, fetch `GET /api/conversations/:conversationId?max_bytes=524288` and seed the view from it, then attach the live terminal stream on top. The conversation is the history; the PTY is the present.
2. **Page older messages on backward scroll**, reusing the conversation screen's existing mechanism rather than a second implementation: `onStartReached` (`app/conversation/[id].tsx:879`) driving the `before_index` cursor in `hooks/conversationCursor.ts`, anchored with `maintainVisibleContentPosition`. Note the duplicate-key hazard already documented at `useConversations.ts:365` — the anchor requires unique keys, and the seeded page plus a fetched page must not collide on message identity at the seam.
3. **Render the boundary** off `message_pagination.has_more_older` — a top-of-scroll affordance that reads as "older messages load as you scroll", becoming a spinner while a page is in flight. It disappears once `from_index === 0`. This is the same signal the conversation screen already pages on; there is no truncation-specific flag to branch on.
4. **A server without `max_bytes`** ignores the parameter and returns its normal page, which still carries `has_more_older`. Only `served_bytes` is absent, and nothing should depend on it.
5. **The live terminal tail stays a separate region**, pinned below the message history. Older pages prepend above it; nothing pages *into* the terminal rows themselves.
6. Fix, separately: `terminalMaxLines` (5000) is read at `useTerminalStream.ts:32` as a `useEffect` dependency and applied nowhere, so nothing trims what `VirtualTerminal` retains (`MAX_ROWS = 10_000`). It is inert today and the seeding above makes the view longer, so it should either bind or be removed.

## Verification

Server — implemented in `__tests__/conversation-max-bytes.test.ts`:

- A page whose serialized size exceeds the budget keeps the **newest** messages and drops the oldest, with `served_bytes <= max_bytes`. Asserting on which end survives, not on a count: a count-only check passes whichever end was dropped.
- No budget → the full page, `from_index: 0`, no `served_bytes`. The positive control, without which an implementation that trims every page to one message passes every assertion above.
- `from_index` / `has_more_older` / `next_before_index` move to the trimmed page's start, and `before_index=<from_index>` returns the messages immediately older with no gap or overlap at the seam.
- A Hebrew conversation stays within a byte budget — the measured size of the returned messages, independently of what the server reported. UTF-16 accounting admits ~2× the messages and overshoots.
- A single message larger than the budget is served whole rather than as an empty page.

Each was confirmed to fail against a deliberately broken implementation (length instead of bytes; cursor left unmoved; newest message not exempt), each producing exactly one failure.

Client:

- Scrolling to the top of a trimmed seed fetches the next older page and prepends it, with the previously-visible message still at the same screen offset — the anchoring assertion, since a page that loads but jumps the viewport is the failure this reuses an existing mechanism to avoid.
- Paging to `from_index === 0` removes the boundary and stops firing further fetches.

## Open question

The 0.5 MB budget is a decision, not a measurement — it was chosen to bound the phone heap, and 90/10 is what it buys on today's corpus (p50 payload 62 KB, p90 0.5 MB, max 3.1 MB).
If the boundary turns out to be hit often enough to annoy, the lever is the budget, not the design: 3 MB would cover essentially everything measured here, at up to 6× the worst-case payload.
Re-measure the **payload** distribution before moving it — the source-file distribution does not predict it.
