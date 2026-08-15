# Session history on open: whole conversation, byte-bounded

**Status:** proposed
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

Measured over 712 JSONL files on one developer box (2026-08-15):

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| messages | 29 | 452 | 1 663 | 2 490 |
| JSONL bytes | 315 KB | 2.6 MB | 10.2 MB | 22.8 MB |

**At 0.5 MB, 63% of conversations load whole and 37% truncate.**
Truncation is therefore a routine path, not an edge case — which is a deliberate trade of completeness for a bounded phone heap, and it makes two things load-bearing rather than nice-to-have:

1. The truncation boundary must be **visible** in the UI, not silent.
2. The "load older" affordance behind it must actually work, on the screen that already implements paging.

Message count is not a constraint at any budget: 100 000 is 40× the largest conversation observed.

## Server half (tb-streamer)

### `GET /api/conversations/:id` — add `max_bytes`

Additive query parameter. Absent → today's behaviour, unchanged.

```
GET /api/conversations/:id?max_bytes=524288
```

- Serve the **newest** messages, walking backward from the tail, accumulating serialized size until the next message would cross `max_bytes`.
- Never serve zero messages: a single message larger than the budget is returned whole, with `truncated: true`. A blank screen is worse than an over-budget one.
- Clamp `max_bytes` server-side (suggested ceiling 8 MB) so a client typo cannot ask for a 200 MB response.

Response gains two additive fields:

```jsonc
{
  "messages": [ /* ... */ ],
  "fromIndex": 1204,        // already present — index of the first served message
  "truncated": true,        // NEW: the budget stopped the walk, older messages exist
  "servedBytes": 521337     // NEW: what the budget actually spent
}
```

`truncated` is what the client renders a boundary from, and it is distinct from `fromIndex > 0`, which is also true for an ordinary `before_index` page.

**Budget is measured against the serialized response**, not the raw JSONL. The two differ — the API transforms messages — so calibrate the mapping once against real conversations and record the ratio here; do not assume 1:1 from the table above.

Paging older stays exactly as it is: `before_index=<fromIndex>&msg_limit=<n>`, already implemented (`conversations.handlers.ts:563`).

### Not changing

- No new table, no new endpoint, no retained-line store.
- `subscribe_session` replay is untouched — PR #607 settled it at `REPLAY_MAX_LINES`.

## Client half (tb-mobile)

1. **On opening a session**, fetch `GET /api/conversations/:conversationId?max_bytes=524288` and seed the view from it, then attach the live terminal stream on top. The conversation is the history; the PTY is the present.
2. **Page older messages on backward scroll**, reusing the conversation screen's existing mechanism rather than a second implementation: `onStartReached` (`app/conversation/[id].tsx:879`) driving the `before_index` cursor in `hooks/conversationCursor.ts`, anchored with `maintainVisibleContentPosition`. Note the duplicate-key hazard already documented at `useConversations.ts:365` — the anchor requires unique keys, and the seeded page plus a fetched page must not collide on message identity at the seam.
3. **Render the boundary** when `truncated` is true — a top-of-scroll affordance that reads as "older messages load as you scroll", becoming a spinner while a page is in flight. At 37% truncation this is a routine state, not an error state. It disappears once `fromIndex === 0`.
4. **A server without `max_bytes`** ignores the parameter and returns its normal page. The client must not assume `truncated`/`servedBytes` exist — absent means "unknown", rendered as no boundary, which is today's behaviour.
5. **The live terminal tail stays a separate region**, pinned below the message history. Older pages prepend above it; nothing pages *into* the terminal rows themselves.
6. Fix, separately: `terminalMaxLines` (5000) is read at `useTerminalStream.ts:32` as a `useEffect` dependency and applied nowhere, so nothing trims what `VirtualTerminal` retains (`MAX_ROWS = 10_000`). It is inert today and the seeding above makes the view longer, so it should either bind or be removed.

## Verification

Server:

- A conversation whose serialized tail exceeds the budget returns `truncated: true`, `fromIndex > 0`, and `servedBytes <= max_bytes`.
- A conversation under the budget returns every message, `truncated: false`, and `fromIndex === 0` — the positive control, without which a guard that truncates *everything* passes the test above.
- A single message larger than the budget is returned whole rather than an empty array.
- `before_index=<fromIndex>` returns the messages immediately older, with no gap and no overlap at the seam.
- Absent `max_bytes` produces a byte-identical response to today's.

Client:

- Truncated response renders the boundary; untruncated renders none.
- A response missing `truncated` (older server) renders none and does not throw.
- Scrolling to the top of a truncated seed fetches the next older page and prepends it, with the previously-visible message still at the same screen offset — the anchoring assertion, since a page that loads but jumps the viewport is the failure this reuses an existing mechanism to avoid.
- Paging to `fromIndex === 0` removes the boundary and stops firing further fetches.

## Open question

The 0.5 MB budget is a decision, not a measurement — it was chosen to bound the phone heap, and 63%/37% is what it buys on today's corpus.
If the boundary turns out to be hit often enough to annoy, the lever is the budget, not the design: raising it to 2.5 MB would cover ~90% at roughly 5× the payload.
Re-measure the distribution before moving it.
