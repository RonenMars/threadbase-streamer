# Inherited Conversation History

> Status: proposed. Not implemented.
> Origin: a Codex fork opens as an empty conversation in tb-mobile
> (threadbase-mobile#1009, threadbase-streamer#801 fixed the 404 it raised; this
> plan fixes the emptiness behind it).

## Goal

A conversation whose history physically begins in **another file** should be
served, and read, as one complete conversation.

The case that forced this is `codex fork`, but the mechanism is deliberately not
named after it: the streamer gains a general "this conversation inherits a prefix
from that one" link, and forks are its first consumer.

Minimum successful outcome:

- Opening a forked session in tb-mobile shows the conversation it was forked
  from, followed by the fork's own turns, in one scroll.
- A divider marks where the fork happened.
- Paging, search anchors, delta-on-open and ETags keep working unchanged,
  because the stitched conversation presents one continuous `message_index`
  space.
- No transcript content is copied into SQLite.

## Analysis

### What `codex fork` actually writes

Verified on this machine, 2026-09-06. The fork's rollout is two lines:

```json
{"timestamp":"2026-09-06T17:31:07.637Z","ordinal":297,"type":"session_meta",
 "payload":{"session_id":"01a077c6-1d5a-7a03-a6b8-40c7817fe8c6",
            "forked_from_id":"01a075cd-f290-7d63-9bd8-b37f70c2ef5f",
            "forked_from_ordinal_exclusive":297, ...}}
```

The 297 preceding turns stay in the parent file. Codex needs no copy — it reads
the parent up to the cut and continues — so the **agent** has full context while
the **transcript we serve** has none. That asymmetry is the whole bug: the fork
is not empty, it is elsewhere.

Three properties of the format matter to the design:

- **`ordinal` is a line index, not a message index.** The parent
  `01a075cd-…` has 331 lines with ordinals 0–330 matching line numbers exactly,
  of which the scanner renders **27 messages**. Line 297 is a
  `thread_settings_applied` event — not a message at all. So
  `forked_from_ordinal_exclusive: 297` cannot be used as a message cursor
  without translation.

  Worked on the real pair, because the trap is not hypothetical: the parent
  holds 30 message-shaped lines, of which 3 carry `role: "developer"` and are
  not rendered — 27, matching `conversation_meta.message_count` exactly. Before
  the cut there are 24, of which those same 3 developer lines are dropped. The
  cut is therefore **21**, not 27 and not 297. Reaching for the file's own
  message count gets a plausible, wrong answer that renders 6 turns the fork
  never inherited, with no error anywhere.
- **Ordinals continue across the fork.** The fork's own first line is
  `ordinal: 297`, not 0. Numbering is continuous along a fork chain, which makes
  fork-of-a-fork tractable rather than a special case.
- **The link lives in the file, not in our records.** A fork made by the user in
  their own terminal carries the same `session_meta`. Keying the mechanism off
  `ManagedSession` would cover only forks Threadbase itself started.

### What the cache already gives us

`~/.threadbase/cache/cache.db` (71 MB on this machine):

| table | rows here | contents |
|---|---|---|
| `conversation_meta` | 1601 | one row per conversation |
| `conversation_tail` | 1599 | JSON of the **last N messages only** |
| `conversation_message_index` | 192,220 | per-message `byte_offset` + `byte_length` |
| `conversation_file_state` | 896 | how far each file is indexed |

The DB stores **pointers, not transcripts**, and `readMessageWindow()` already
preads exact byte ranges for a `[from, to)` window rather than parsing a file.
That is the machinery this plan builds on, and the reason no content copy is
needed. (Copying instead would mean mirroring 1.6 GB of Codex plus 1.5 GB of
Claude transcripts, and mirroring every append — rejected.)

Two limits of that index, both load-bearing here:

- `isIndexableFile()` restricts it to `claude-code`. A Codex file "indexes" as
  zero messages under the Claude line reducer, which is the silent-wrong-data
  bug hotfixed after 1.28.0, so Codex is excluded on purpose. Today every Codex
  detail request full-parses — that is the `offset-index miss … → scanner
  fallback` line in the log.
- Rows are keyed by `conversationIdForFile()`, the **filename stem**. For Codex
  that stem is `rollout-<ts>-<uuid>`, not the conversation id.

Both are why index extension is staged last here, not first: the stitching works
without it, and lands sooner if it does not wait for it.

### Why this is not a client-side fix

tb-mobile could fetch two conversations and concatenate them, but then every
cursor, the delta-drain, the ETag, the search anchor and the "load older" pager
would each need to know about the seam. The server already owns one
`message_index` space per conversation; keeping the seam behind that boundary is
what leaves the client's paging machinery untouched.

## Assumptions

- The parent file is normally still on disk. It usually is — a fork exists
  precisely because the parent is *in use* somewhere.
- A fork's inherited prefix is **immutable**. The parent may keep growing past
  the cut, but everything before the cut is frozen, so the prefix can be cached
  and validated cheaply.
- Chains are short in practice. A depth cap is a safety rail, not a design
  constraint.
- Additive wire only. An older tb-mobile that ignores the new field still gets a
  complete conversation, just without the divider.

## Design

### The link

One record per conversation that inherits:

```ts
interface InheritedPrefix {
  sourceId: string;            // parent conversation id
  sourceFilePath: string;      // resolved at link time, re-resolvable
  sourceOrdinalExclusive: number; // as written by the provider (line ordinal)
  throughMessageIndex: number;    // RESOLVED message count — the cut
  resolvedAt: number;
}
```

`throughMessageIndex` is the translation of `sourceOrdinalExclusive` into "how
many rendered messages precede the cut", computed once and stored. Everything
downstream uses only this number; no read path ever re-derives it from ordinals.

**Discovery** reads the conversation's own first JSONL line — the streamer
already has `readFirstJsonlEntry()` in `conversations.handlers.ts` for exactly
this kind of identity check. A `session_meta` carrying `forked_from_id` +
`forked_from_ordinal_exclusive` produces a link; anything else produces none.

**Storage**: none in phases 1–2, deliberately. The plan originally called for a
`conversation_links` table so the translation would not be redone per request —
but the read path needs the prefix's *messages*, not just its length, so storing
`throughMessageIndex` saves nothing that is actually expensive. What it would
save is a re-parse of the source file, and an in-process cache keyed by
`sourcePath + cut` does that in a dozen lines with no migration, no repository
and no write path to keep in sync. The prefix is immutable, so the cache needs
no invalidation.

The table becomes worth adding at phase 4, when a window can be served from the
offset index without parsing anything and the cut is the only thing left to
look up.

### Numbering: one continuous space

A stitched conversation renumbers so the client sees no seam:

```
message_index   0 .. N-1     inherited, from the parent file
message_index   N ..         the fork's own messages
                ^ N = throughMessageIndex
```

`total` becomes `N + own_total`. Because this is a plain contiguous space,
`before_index`, `after_index`, `anchor_index`, the `{ resume }` delta cursor and
`deriveCursor()` on the client all keep working with no change.

### Read path

Serving `[from, to)` splits at `N`:

| segment | source | window |
|---|---|---|
| inherited | parent file | `[from, min(to, N))` |
| own | own file | `[max(from, N) - N, to - N)` |

Concatenate, rewrite `message_index` on the inherited half by `+0` and on the
own half by `+N`. When `from >= N` the parent is not touched at all — which is
the common case once a fork has some turns of its own, so the steady-state cost
of this feature is zero.

Each half is fetched by the best reader available for its file: the offset-index
window when warm (Claude today, Codex after Phase 4), otherwise the existing
single-file parse. No new parsing code.

**Phases 1–2 implement the degenerate form of this, and that is where this
stops.** Codex detail requests already materialise every message (there is no
index to window with), so the prefix is simply prepended to that list and the
existing slicing does the rest — one `filtered` array feeds `total`, every cursor
and the byte budget, unchanged.

> **The split-window read above will not be built.** Decided 2026-09-08. See
> "Why the split-window read was dropped" below.

### ETag

`computeConversationEtag()` currently hashes `filePath:messageCount:timestamp` of
one file. A stitched conversation must fold in the prefix, or a client caches a
half-conversation under a validator that cannot change when the other half does:

```ts
ConversationEtagInput & { prefix?: { sourceFilePath: string; through: number } }
```

The prefix is immutable, so adding its path and cut is sufficient — no parent
mtime needed.

### The divider

Additive, on `meta`:

```jsonc
"inherited_history": {
  "source_id": "01a075cd-f290-7d63-9bd8-b37f70c2ef5f",
  "source_provider": "codex-cli",
  "through_message_index": 27,
  "forked_at": "2026-09-06T17:31:07.482Z",
  "unavailable_reason": null        // or "source_missing"
}
```

tb-mobile renders a divider immediately before `message_index ===
through_message_index`:

```
  …parent turn 26
  ─── Forked into Threadbase · 20:31 ───
  you: continue with the merge
```

This is the honest presentation: it explains why the original session is still
running elsewhere, and why the turns above it may keep changing there.

### When the parent is gone

Serve the fork's own messages, `through_message_index: 0`, and
`unavailable_reason: "source_missing"`. The app shows one plain line where the
history would be instead of a silent truncation. This is the degrade path the
mobile server-contract rule asks for, and it is why index-only storage is
acceptable: the failure is visible and bounded, not data loss.

### Chains

Resolve transitively (fork of a fork of a conversation), newest last, with a
depth cap of 8 and a visited-set to refuse cycles. A refused chain degrades to
`source_missing` rather than erroring.

## Phases

1. **Link discovery and translation.** Read `session_meta` lazily, on the read
   path, for files that can carry a link (Codex only, so Claude's hot path pays
   nothing); translate `sourceOrdinalExclusive` → `throughMessageIndex` using
   the scanner's own line parser; cache resolved prefixes in process.
   Verifiable on its own: the link row for `01a077c6-…` must say
   `throughMessageIndex: 21` — not 297 (the raw ordinal) and not 27 (the
   parent's whole-file message count).
2. **Stitched reads.** Split-window read in `handleGetConversation`, `total` and
   `message_count` corrected, ETag extended. Server-only — a fork already looks
   complete in the app, seamlessly, with no mobile release.
3. **The seam.** `meta.inherited_history` on the wire; tb-mobile divider; locale
   copy in the four languages.
4. **Codex offset index (performance).** Extend `isIndexableFile` to Codex with
   a Codex line reducer, and key rows by conversation id rather than filename
   stem. Turns every fork read into a byte-range window and removes the
   full-parse fallback Codex pays today. Independently valuable — this is the
   `offset-index miss` line in the log for **every** Codex conversation, not
   just forks.

Phases 1–2 are the fix. 3 is the polish the design decision asked for. 4 is a
standing performance debt this work makes worth paying.

**Status as of 2026-09-08.** Phases 1–3 shipped.
Phase 4 shipped as #818 and was then gated off for Codex by #824, because the offset index numbers a Codex rollout in a different space than the detail handler serves it in — the index is built with the scanner's `parseCodexJsonlLine`, which renders the AGENTS.md and permissions dumps as `role: user`, while `isServable` drops them before indices are assigned.
That gate lifts when the two spaces agree; #824's comment names the condition.

## Why the split-window read was dropped

Decided 2026-09-08, after investigating what it would take to build.

**It cannot be built correctly on today's index, and the blocker is not `N`.**
While the index space is pre-filter and the served space is post-filter, any windowed read against the index numbers in a different space than `through_message_index` and every client cursor live in — and the gap varies with the conversation's *text*, so it is not a constant that can be corrected for.
Handed a perfect `N`, the own half would still be served unfiltered: a correct divider over a wrong list.

**Resolving `N` from the index is separately impossible.**
`forked_from_ordinal_exclusive` is a LINE ordinal and `conversation_message_index` has no ordinal column, so the cut cannot be located in the index at all.
Even given a mapping, the index counts in the pre-filter space, and `isCodexInjectedContext` is a predicate on message TEXT which the index does not store — so the correction cannot be computed from rows either, only by preading and parsing them, which is the scan the design existed to remove.

**The payoff does not justify the machinery.**
The parent prefix is already memoised by `prefixCache` — one parse per fork per process, not per request.
So the real gain over today is an integer instead of a pinned message array, plus removal of the cache's eviction cliff.
Against that: a reindex, a durably persisted cut, an invalidation key on file identity plus a monotonic size floor, and seam arithmetic across two files with `message_index` rewriting — every one of which is a new way to serve a subtly wrong conversation.
#824 is what that class of mistake looks like in production, and it shipped from a much simpler change.

**What was done instead.** `PREFIX_CACHE_MAX` was raised from 8, which addresses the only concrete cost anyone identified without adding a failure mode.

If a profile later shows fork prefix parsing actually hurting users, reopen this — but reopen it *after* the two index spaces are reconciled, not before.

**Not needed, for the record:** a `conversation_links` table.
`cache_metadata` is a generic key/value store with a working repository, so persisting a resolved cut would be a type widening rather than a migration.
Recorded here so the question does not get re-litigated from scratch.

## Risks

- **The ordinal→index translation is the one silent failure.** A wrong `N` shows
  a plausible conversation with the wrong number of inherited turns. Mitigation:
  it is computed once, stored, and pinned by a fixture test against the real
  pair on this machine (parent 331 lines / 27 rendered messages / cut at
  ordinal 297 → 21). Drafting this plan produced the wrong number (27) on the
  first pass, from exactly the shortcut the test now forbids.
- **A live parent.** The prefix is frozen, but the parent's *file* keeps
  growing, so any check comparing file size to an indexed offset must be scoped
  to the prefix, not the file. This is exactly the `readMessageWindow` decline
  condition (`stat.size !== fileState.byte_offset`) and it will reject a live
  parent unless the prefix path is exempted.
- **List/preview drift.** `conversation_meta.message_count` and
  `conversation_tail` for a fresh fork describe only its own (empty) file, so
  the hub row reads "no messages" while the detail view shows 27. Phase 2 must
  correct the count at the same time as the detail, or the two surfaces
  disagree.
- **Scanner ownership.** Message parsing lives in `@threadbase-sh/scanner` (a
  separate repo), and the cross-repo dependency turned out to bind at phase 1,
  not phase 4 as first written: translating the cut requires knowing which lines
  render, and that rule lives there. The streamer must not carry a second copy
  of it — a copy that drifts shows a fork the wrong number of inherited turns,
  silently. So `parseCodexJsonlLine` is exported from the scanner and
  `parseCodexConversation` is refactored to use it, leaving exactly one
  definition of "this line is a message".

## Verification

Fixtures already exist on this machine and should be copied into the repo as
test data (trimmed):

- parent `01a075cd-f290-7d63-9bd8-b37f70c2ef5f` — 331 lines, ordinals 0–330,
  27 rendered messages
- fork `01a077c6-1d5a-7a03-a6b8-40c7817fe8c6` — 2 lines, `forked_from_ordinal_exclusive: 297`

Cases:

1. Cut translation: 297 → 21, with the 3 unrendered `developer` lines as the
   discriminator — an implementation that counts message-shaped lines returns
   24 and passes any looser assertion.
2. Tail request on a fresh fork returns the parent's first 21 messages,
   `total: 21`.
3. `before_index` paging across the seam returns one contiguous run with no gap
   or duplicate at `N`.
4. After the fork takes 3 turns: indices 21–23 are its own, the parent is not
   re-read.
5. Parent file deleted → own messages only, `unavailable_reason:
   "source_missing"`, no 404 and no throw.
6. Fork of a fork: both prefixes resolve, in order.
7. Parent still being appended to by another Codex client → the prefix is stable
   and the response does not decline.

## Non-goals

- Copying transcript content into SQLite.
- Claude Code: it has no fork primitive, so it gains a link mechanism with no
  producer. (It may gain one later — that is why this is not named
  `codex_fork_*`.)
- Any UI for *choosing* a fork point, or forking from an arbitrary message.
- Writing to the parent conversation in any way. The fork is a reader of it,
  always.
