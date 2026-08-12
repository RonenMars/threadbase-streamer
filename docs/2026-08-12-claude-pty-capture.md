<!-- Copied from ~/.threadbase/captures/README.md so the evidence survives the artifact.
     The raw bytes (36 snapshots + a 1.1 MB concatenation) are NOT version-controlled and
     live outside any repo, in a tree the threadbase installer owns. Two PRs cite the
     figures below — threadbase-mobile#654 and this repo's #537 — so the numbers are
     quoted here and inline in those PRs rather than only pointed at. -->

# Claude Code PTY capture — 2026-08-12

Raw PTY bytes from a live Claude Code session, escapes intact. Produced to settle open
questions in PlanCup (tb-mobile #652) and PlanIndicator (tb-streamer #538).

## Files

- `snap-NNN.raw` — 36 distinct snapshots of `session.outputBuffer`, polled ~0.7s apart
  through one full turn via `GET /api/sessions/:id/output`.
- `claude-v2.1.228-turn.raw` — all snapshots concatenated (1,123,773 bytes). **Snapshots
  overlap heavily; see "Counting" before trusting any number taken from this file.**

## Provenance

- Claude Code **v2.1.228**, spawned by tb-streamer at its fixed **120x40** geometry.
- Server flags in effect: `--model claude-opus-4-8 --effort high`.
- Prompt: "Write out the numbers 1 through 60, each on its own line, with a one-sentence
  interesting fact about that number." Pure text generation — **no tool use**.
- Throwaway project dir `~/dev/pty-capture-tmp`; session stopped after capture.

## Findings

Real footer status lines recovered (escapes stripped):

```
·Marinating… (25s · ↓ 1.1k tokens)     mid-turn
✻Baked for 26s                          end-of-turn
```

Markers: `↓` 31, `↑` **0**, `tokens` 31, `hooks…` **0**, `esc to interrupt` **0**.
The absent `↑` matters — `parseStatusLine`'s fixture uses `↑ 3.4k tokens`, so the
"input vs output arrow" distinction is **contradicted by this capture**. Likely the arrow
tracks whichever direction dominates the turn (this one was output-heavy), but that is
untested. A tool-heavy turn should settle it.

**Absolute cursor rows addressed: only 1, 37 and 40. Maximum exactly 40** — the 120x40
geometry is measured here, not assumed.

### CSI final bytes — corrected reading

```
during the turn:   G 51327    B 10075    C 8222    m 8213    H 4395    K 3805
startup only:      r  1       J  1       c  1      ESC7 1    ESC8 1
never emitted:     S  T  L  M  A  D  f
```

The startup row deserves care. A naive count over the concatenated file reports **30** for
each of `r`, `J`, `c`, `ESC7`, `ESC8`. That is an artifact: each snapshot is a *full ring
buffer dump*, so every snapshot that has not yet wrapped replays the session's startup
bytes. Verified per-snapshot — `CSI r` sits at offset 2 in exactly 30 of 36 snapshots and
is absent from the six 65536-byte wrapped ones; `ESC7`/`ESC8` sit at offsets 0 and 5 in the
same 30. **True count for each is 1, at startup.**

The whole startup sequence is these 8 bytes, once:

```
ESC 7   ESC [ r   ESC 8        (save cursor, reset margins to full screen, restore cursor)
```

Every `CSI r` in the capture is **argument-less** (verified: the only parameter string
present is empty). Bare `ESC[r` *resets* margins to the full screen — it does not set a
scroll region. So an emulator that models only the full screen and ignores `r` reaches the
correct end state; `case 'r': break` is right, not a defect. Likewise a startup `2J`
annihilates an empty grid, which is harmless.

**Consequence for the tb-mobile #652 follow-ups: nothing in the deferred family is
reachable mid-turn in this capture.** `S`/`T`/`L`/`M`/`A`/`D`/`f` never appear at all, and
`r`/`J`/DECSC/DECRC appear exactly once each during terminal init. The queue should be
uniformly downgraded pending a capture that shows any of them firing mid-session — there is
no item here that deserves promoting above the others.

## Caveats — read before citing

1. **One turn, one version, no tool use.** A tool-heavy turn may emit sequences this one
   does not. Absence here is not absence in general. `hooks…` and the tokens-absent
   "thinking" state were never observed for exactly this reason.
2. **The ring buffer is a 64KB byte-level tail cut** (`pty-manager.ts:820-825`), so a
   snapshot can begin mid-escape and mid-UTF-8. At most one malformed sequence per
   snapshot head.
3. **Snapshots overlap.** Presence/absence is reliable; magnitude is not. Derive
   per-snapshot before quoting any count — see the startup artifact above.

## Counting

Two independent ways to get a wrong number out of this file:

- **`grep -c` counts matching LINES, not occurrences**, and this capture contains **zero
  newlines** — it is one unterminated line. `grep -acoE $'\033\\[[0-9;]*r'` returns `1`
  where the true occurrence count is `30`. `-c` silently overrides `-o`. Use
  `grep -aoE … | wc -l`. A zero is unaffected (zero lines containing ⇒ zero occurrences),
  but every non-zero count taken with `-c` understates.
- **Snapshot overlap inflates**, as above. The two errors push in opposite directions and
  can cancel, which is worse than either alone.

## Five ways this capture yields a clean-looking zero

Every one of these was hit for real while analysing it or the code around it:

1. **Binary-file silence.** `file(1)` calls a raw dump `data`; grep then skips it and
   prints nothing. `tb-streamer/src/pty-manager.ts` trips this too — it contains a raw
   byte, so plain `grep` returns empty for patterns that are certainly present. Use `-a`.
2. **Malformed pattern that errors like a miss.** `grep` here resolves to **ugrep**, and
   neither it nor `/usr/bin/grep` accepts `$'\x1b\['` — that is ESC plus a *literal* `[`,
   read as an unterminated bracket expression. It errors; add `2>/dev/null` and it becomes
   an innocent-looking zero. Use `$'\033\\['` (double backslash) or `-F`.
3. **Text that is never contiguous in the stream you search.** Regexing the raw bytes for
   `↓ N tokens` returns zero while 31 `↓` characters are present — the footer is assembled
   by absolute cursor moves and exists only after rendering. This is the documented reason
   `parseStatusLine` reads rendered lines rather than raw bytes. Strip CSI first.
4. **`-c` on a file with no newlines**, as above.
5. **Searching a field name instead of its values.** `activity` looked unpopulated in
   tb-streamer because its only assignment builds the value in a different file from the
   rest of the response shape; grepping the enum member (`active_writing`) found it. Grep
   the values a field can take, not just its name.

**The rule that covers all five: a zero is evidence of absence only if the same command
returns non-zero on a file you know contains a match.** Always run the positive control.

```sh
printf '\033[40;1Htest\033[5S\n' > /tmp/poscontrol.raw
/usr/bin/grep -aoE $'\033\\[[0-9;]*S' /tmp/poscontrol.raw | wc -l    # must print 1
/usr/bin/grep -aoE $'\033\\[[0-9;]*S' claude-v2.1.228-turn.raw | wc -l

/usr/bin/grep -aoE $'\033\\[[0-9;]*[A-Za-z]' claude-v2.1.228-turn.raw \
  | sed 's/.*\[//; s/[0-9;]*//' | sort | uniq -c | sort -rn
```

`CSI S` = **0** against that control = 1. That is the citation for #652's deferral.
