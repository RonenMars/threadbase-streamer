# Split-window read — the two ways to build it

> Companion to [2026-09-07-inherited-conversation-history.md](./2026-09-07-inherited-conversation-history.md).
> That document records the feature as dropped. This one explains the two ways it
> could be built and what each actually buys, measured on 2026-09-12.

## 30-second background

When you run `codex fork`, Codex does **not** copy the conversation you forked
from. It writes a new file containing one line — a pointer saying *"my history is
the first 297 lines of that other file."*

So a fork's transcript looks empty, even though the conversation isn't. The
streamer's job is to serve them as one conversation:

```
message_index   0 .. N-1     <- lives in the PARENT's file
message_index   N ..         <- lives in the FORK's own file
                ^ N = where the fork happened
```

The client pages this as a single list, so `message_index` has to be one
continuous run across that seam. `N` is the number that makes it work.

## What happens today

When you open a fork, the server reads the parent's file, parses every message
before the cut, and holds that list in memory (`prefixCache`, capped at 32
conversations). Then it glues that list in front of the fork's own messages.

It works. The question is whether to replace it with a **split-window read** —
serving each half straight out of the SQLite offset index by byte range, so the
parent's messages are never parsed into memory at all.

There are two ways to do that, and they are **not** variations on a theme. They
trade off in opposite directions.

## The two options at a glance

| | **Today** (baseline) | **Option A — in-memory `N`** | **Option B — persisted `N`** |
|---|---|---|---|
| Where `N` is stored | not stored; the whole message list is | in a process cache, same as today | in SQLite (`cache_metadata`) |
| Survives a server restart? | no | no | **yes** |
| What's held in memory per fork | the full message list | one integer | one integer |
| Parent file opened on first request | yes, full parse | yes, ordinal scan | **no** |
| Parent file opened on later requests | no (cached) | no (cached) | no |
| Needs a DB write path | no | no | **yes** |
| Needs an invalidation key | no | no | **yes** |
| Needs seam arithmetic across 2 files | no | **yes** | **yes** |
| New code, roughly | — | seam arithmetic + a 2-line staleness gate | seam arithmetic + staleness gate + persistence + invalidation |
| Measured speed gain per request | — | **0.006 ms** | 0.006 ms |
| Measured memory saved | — | 2.9 MB typical / 23.7 MB worst | same |

---

## Option A — compute `N` and keep it in memory

**The idea.** Instead of caching the parent's *messages*, cache just the *number*
`N`. Serve each half as a byte-range window out of the offset index.

**How `N` is found.** Walk the parent file until you reach the cut line, note its
byte offset, then ask SQLite:

```sql
SELECT COUNT(*) FROM conversation_message_index
WHERE conversation_id = ? AND byte_offset < <cut byte offset>
```

Cache that integer under the same key the message list uses today
(`<parent path>::<cut ordinal>`). The prefix never changes, so the cache never
needs invalidating — that's already how `prefixCache` works.

### Pros

- **No database migration, no write path, no repository.** It reuses the caching
  rule the code already trusts.
- **Memory drops** from a pinned message list to one integer: 2.9 MB → ~0 in the
  typical case.
- **No eviction cliff.** Today, a 33rd fork evicts one of the 32 cached lists, and
  the next request re-parses from scratch (up to 177 ms). Integers are small
  enough that the cap stops mattering.
- **The correctness question is settled.** Measured 0 mismatches across 330 cut
  cases on 110 real conversations (it was 13 before today's leading-injected-run
  fix; that fix closed it).

### Cons

- **It saves essentially nothing.** The work it removes is 0.006 ms per request —
  six microseconds. That is the measured cost of the array-building it replaces.
- **Finding `N` costs what parsing costs.** You still have to walk the parent file
  to locate the cut, because the cut is a *line* number and you must read each
  line to know where you are. Measured at 0.75×–1.17× of today's full parse — so
  the first request per fork is not faster.
- **You still open the parent on the first request.** The headline promise of the
  design — *"when `from >= N` the parent is never opened"* — is not delivered,
  because after a restart you have no `N` and must go find it again.
- **It adds the riskiest part anyway.** Seam arithmetic across two files with
  `message_index` rewriting is the part that can serve a subtly wrong
  conversation, and Option A pays that cost in full for a 6 µs return.

---

## Option B — compute `N` once and persist it

**The idea.** Same as Option A, but write `N` into SQLite so it survives a restart.
Then a fork that already has some turns of its own (the common case) never opens
the parent file at all — not on the first request, not ever.

### Pros

- **This is the only version with a real structural gain.** `from >= N` genuinely
  never touches the parent, including cold after a deploy or a crash.
- **The first request after a restart gets fast**, instead of paying a 2–177 ms
  parse. On the biggest conversation here the parent file is 65 MB.
- **Everything Option A gives you**, plus the above.

### Cons

- **You need a durable write path.** Something has to write `N`, at the right
  moment, exactly once, and handle two requests racing to compute it.
- **You need an invalidation key.** A stored number is a claim about a file. If
  the file is replaced, truncated, or was only partly indexed when you measured,
  the stored `N` is silently wrong — and a wrong `N` shows a believable
  conversation with the wrong turns in it, with no error anywhere.
- **Being wrong is invisible.** There is no exception, no 500, no log line. That
  is the failure mode this whole area has shipped twice already.
- **Two more silent-failure states already measured.** If the index was built
  before the fork existed, the count returns 1 where the truth is 4. If the parent
  was never indexed, it returns 0 — and a fork then renders with no history and no
  error. Both need an explicit gate that does not exist today.
- **The payoff is still only 6 µs per request** once warm. All of the above buys
  a faster *cold* first request, on a feature used by a handful of conversations.

---

## The numbers these conclusions rest on

Measured 2026-09-12 on 685 real Codex rollouts (1.66 GB) on this machine.

| what | measurement |
|---|---|
| Codex conversation size | p50 **11** messages, p90 145, p99 799, max 2406 |
| memory held by the message cache, 32 median-size parents | **2.9 MB** |
| memory held by the message cache, 32 largest parents | 23.7 MB |
| per-request work the split-window would delete (largest prefix, N=353) | **0.006 ms** |
| finding the cut with a newline-only scan | 0.4 / 2.2 / 3.7 ms — **but incorrect** |
| finding the cut correctly (must read each line's `ordinal`) | 2.0 / 13.7 / 19.5 ms |
| today's full parse, same files | 2.6 / 11.7 / 22.3 ms |
| correct scan ÷ today's parse | **0.75× – 1.17×** (i.e. no saving) |
| the `COUNT` query itself | 0.06 – 0.15 ms |
| `backfillIndex`, the prerequisite for any index read | 2.7 / 17.9 / 26.4 / **1551** ms |
| rollouts carrying no `ordinal` field at all | **359 of 685 (52%)** |
| `COUNT` vs. what the API serves, after today's bound fix | **0 mismatches / 330 cases** |
| `byte_offset` order vs `message_index` order | **0 violations / 110 files** |

### Why the "newline-only scan" row matters

The reason this was reopened was a guess that `N` could be found by counting
newlines — no parsing, so very cheap. It can't:

- 1 file in 685 repeats an ordinal (`312` appears twice), so every line after it
  is off by one;
- a parent that is itself a fork starts its ordinals at *its* cut (189, 297 seen
  here), not at 0, so the count is off by the whole offset;
- 52% of files have no `ordinal` field at all.

Reading the `ordinal` field fixes all three — and reading it means parsing the
line, which is the cost the shortcut existed to avoid.

---

## Recommendation

**Neither. Keep today's behaviour.**

Option A is cheap to build and buys 6 microseconds. Option B buys something real
but needs exactly the durable-write-plus-invalidation machinery that makes wrong
answers invisible, and it is the only version worth building — which is the trap:
*the version that is cheap has no payoff, and the version with a payoff is not
cheap.*

Reopen this only if a profile shows fork prefix parsing actually hurting someone.
If the problem turns out to be **memory** rather than speed, the lever is a byte
budget on `prefixCache` — about five lines, no seam arithmetic, no new way to be
silently wrong.

## What changed since the feature was dropped

Two of the three original blockers are genuinely resolved:

| blocker | then | now |
|---|---|---|
| 1. index counts in a different space than the API serves | blocking | **fixed** — #862, completed by the leading-injected-run fix of 2026-09-12 |
| 2. `N` cannot be derived from the index | "impossible" | **resolved** — 0 mismatches / 330 cases |
| 3. payoff doesn't justify the machinery | a judgement call | **still true, and now measured** — 0.006 ms/request, 2.9 MB |

Blocker 3 was the weakest-sounding of the three and is the one that survived.
