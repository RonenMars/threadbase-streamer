# PlanCup — make absolute cursor positioning viewport-relative (mobile)

Single-repo change in **tb-mobile**: `services/virtual-terminal.ts` plus its unit tests.

**Worktree — already created, branched from the current `origin/main`:**

```
/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/fix-viewport-relative-cup
branch: fix/viewport-relative-cup   base: origin/main @ 86eeb2a1
```

Work there, not in the main checkout. Worktrees live **outside** the repo root: a nested one is a full second copy of the tree that Jest, ESLint, TypeScript and Metro all walk into, which on 2026-08-01 produced two phantom test failures from a stale branch.
Rebase onto `origin/main` before opening the PR; do not branch from anything older.
`npm ci` has been run in the worktree — it needs a **real** `node_modules`, never a symlink to the main checkout's, or Metro silently bundles the main repo and the worktree's own lockfile drift stays invisible.

This plan ships **alone**. It is justified entirely by a shipped transcript-corruption bug and makes no reference to the agent-status indicator.
The indicator plan ([2026-08-12-agent-sub-status-server-side.md](./2026-08-12-agent-sub-status-server-side.md)) does not depend on it either — the two are independent.

## Goal

`tb-mobile/services/virtual-terminal.ts` resolves absolute cursor positioning (`CSI H` / `CSI f`) against its whole append-only scrollback grid instead of against the 40-row viewport the TUI actually paints against.
Every footer repaint therefore lands in the middle of the transcript and overwrites conversation content.
Make absolute row addressing viewport-relative, and add the regression test the current suite structurally cannot express.

## The bug

`services/virtual-terminal.ts:243-248`:

```ts
case 'H':
case 'f':
  this.row = Math.max(0, (args[0] || 1) - 1)
  this.col = Math.max(0, (args[1] || 1) - 1)
  this.ensureRow(this.row)
  break
```

`this.row` is an index into `this.grid`, which is append-only up to `MAX_ROWS = 10_000`.
A TUI paints absolute cursor moves against a fixed-height screen, and this streamer spawns every PTY at 120x40 — `src/pty-manager.ts:42-43` (Claude) and `src/codex-pty-runner.ts:36-37` (Codex).
Claude paints its footer at rows ~31-40 (`\x1b[40;1H`, `\x1b[35;3H`, `\x1b[38;3H` all appear in captures).
So once the grid is taller than 40 rows, `CSI 40;1H` addresses grid row 39 — deep inside scrollback — rather than the bottom of the screen.

Measured against `origin/main`'s emulator, feeding N plain transcript lines and then one real footer repaint:

| seeded lines | footer's distance from end | transcript rows destroyed |
|---|---|---|
| 0, 20, 35 | 0 | 0 |
| 41 | 2 | 2 lost + 1 mangled |
| 45 / 60 / 100 / 200 / 500 | 6 / 21 / 61 / 161 / 461 | 2 lost + 1 mangled |

The mangled row is the visible symptom: `"transcript line 37"` becomes `"tr✻ Brewing… (12s · ↑ 3.4k tokens)"`.
A spinner ticks continuously through a turn, so this repeats for the whole turn.

### It fires on every resume, not only on long sessions

`terminal_replay` carries `PTYManager.getOutputLines(sessionId, 200)` — up to 200 rows of already-rendered, escape-free text (`src/server.ts:1184` → `src/pty-manager.ts:701-719`).
Mobile feeds that whole payload into the emulator through `feedHistory` (`hooks/useTerminalStream.ts:99-108`, called at `:187-203`), so after replay the grid is ~200 rows and `this.row ≈ 199`.
The *first live* `terminal_output` frame then carries raw CUP that lands at absolute rows 0-39: the very top of the replayed transcript.
The corruption is not "after 41 lines of output" — it is immediate, on every session resume.

### This streamer already fixed the same bug class

`src/pty-manager.ts:695-697`, above `getOutputLines`:

> Claude's absolute-cursor repaints resolve to where they actually paint — unlike the old raw-byte slice, which scrambled order after a TUI repaint and made replayed conversations appear out of order on resume.

And `src/pty-manager.ts:39-41`, on the geometry constants themselves:

> PTY geometry. The headless render terminal (`session.screen`) MUST match these so Claude's absolute cursor moves (`ESC[<row>;<col>H`) resolve to the same screen coordinates the real TUI is painting against.

The server solved it by rendering into a real 120x40 headless xterm.js.
Mobile's hand-rolled emulator is the remaining un-fixed half of the same problem.

## What ALREADY exists — do NOT rebuild

- **One emulator, one construction site.** `VirtualTerminal` is constructed only at `hooks/useTerminalStream.ts:51-54`, one per hook call. No other file in tb-mobile imports it. There is no second copy anywhere in the ecosystem — `tb-scanner` has no terminal code at all.
- **`ensureRow`'s trim needs no changes, and that is evidence *for* deriving the origin.** `services/virtual-terminal.ts:300-309` shrinks `grid.length` and `this.row` by the same `excess` when the grid passes `MAX_ROWS`. Both terms move together, so a derived origin rides along free. Do **not** read this as a task: an implementer who adds viewport state to maintain here has built the `viewTop` field that step 3 forbids.
- **The output filters are a three-layer stack, and it changes how the tests must be written.** `getRawLines()` (`:106-110`) drops empty rows **and** whole box-border rows (`BOX_BORDER_RE`, `:30`); `getLines()` (`:116-118`) drops provider chrome on top. So grid-row index is not output-line index — assert on content, never index. Critically, `lib/terminalChrome.ts:34` matches a *correctly placed* footer exactly, so it is filtered out of `getLines()`, while the mangled `tr✻ Brewing…` fails the `^` anchor and survives. **That asymmetry is why this bug is user-visible**, and it is what a naive "footer lands near the bottom" assertion gets wrong.
- **The two feed paths carry different data.** WS replay is escape-free rendered text. The HTTP fallback — query at `hooks/useTerminalStream.ts:81-97`, fed by the effect at `:111-129` — is the raw PTY byte ring buffer, cut with a byte-level `subarray` (`tb-streamer/src/pty-manager.ts:820-825`), so it can begin mid-escape-sequence *and* mid-UTF-8 codepoint. Both go through the same `feed()`.
- **Test house style exists** — module-level `const ESC` / `const CSI`, a `feedAndGet` helper, `describe('VirtualTerminal – <topic>')` with an en dash, `expect(vt.getLines()).toEqual([...])`. The scrollback-cap suite re-declares `MAX_ROWS` locally rather than importing it.

## The change

### 1. Add the viewport origin

```ts
// The TUI paints against a fixed-geometry screen — the streamer spawns every PTY
// at 120x40 (tb-streamer src/pty-manager.ts:42-43, src/codex-pty-runner.ts:36-37).
// Absolute cursor moves address that VIEWPORT, not the whole scrollback grid.
const VIEWPORT_ROWS = 40

private viewportTop(): number {
  return Math.max(0, this.grid.length - VIEWPORT_ROWS)
}
```

### 2. Apply it to `CSI H` / `CSI f` — **clamped**

```ts
this.row = this.viewportTop() + Math.min(Math.max(0, (args[0] || 1) - 1), VIEWPORT_ROWS - 1)
```

Measured effect: the footer's distance from the end of the grid becomes **3 at every seed** from 0 to 500, and at seed 500 the only row touched is the bottom-of-viewport row where a footer legitimately paints.

**The clamp is not optional — without it this fix is a regression.** Real terminals clamp CUP to the screen. Unclamped, each out-of-range absolute move appends a screenful of blanks (`viewportTop() + 199` → `ensureRow` grows the grid → next origin is higher → repeat), and enough of them push the grid past `MAX_ROWS = 10_000`, at which point the trim starts evicting **real transcript from the top**. Measured — 200 seeded rows, N stray `CSI 200;1H`, counting surviving transcript rows:

| strays | `main` today | fix, unclamped | fix + clamp |
|---|---|---|---|
| 0 / 1 / 5 / 20 / 60 / 61 | 200 | 200 | 200 |
| **62** | 200 | **79** | 200 |
| **70 / 100** | 200 | **0** | 200 |

Today's code sets `row = 199` and grows nothing, losing nothing — so the unclamped fix is *strictly worse than the status quo* for this input. The HTTP fallback's byte-level `subarray` can begin mid-escape, which is exactly how a garbage row number gets in.

#### The invariant

State this in the file as an invariant, not as a consequence — it is the load-bearing property of the whole design:

> `viewportTop() ≡ grid.length - VIEWPORT_ROWS`, so `viewportTop() + (VIEWPORT_ROWS - 1) ≡ grid.length - 1` whenever the grid is at least a screen tall. With the clamp, CUP's maximum target **is** the last row, so **CUP provably never grows the grid.**

That is what makes it sound to read `viewportTop()` *before* `ensureRow` runs. Swapping those two lines silently breaks it, and nothing in the suite would catch the swap — so the comment is doing real work.

Worked example, `CSI 40;1H` on a 200-row grid: `viewportTop()` = 161 (read first), `row` = 161 + 39 = 200, `ensureRow(200)` finds `201 <= 200` false and does not grow. Lands on the last existing row.

### 3. Apply it to `CSI A` / `CSI B` too

Both are measured corruption in the same class, and both are two lines.

```ts
case 'A': this.row = Math.max(this.viewportTop(), this.row - n); break
case 'B': this.row = Math.min(this.row + n, this.viewportTop() + VIEWPORT_ROWS - 1)
          this.ensureRow(this.row); break
```

- **`CSI A` clamps at grid row 0**, so cursor-up from the footer region walks into scrollback and the next `putChar` overwrites transcript. Measured on a 200-row grid after `CSI 40;1H`: `CSI 45A` destroys `transcript line 155` — five rows *above* `viewportTop()` — and `CSI 100A` lands the cursor 99 rows from the end, deep in scrollback.
- **`CSI B` grows the grid from a cursor move**, shifting the derived origin mid-frame. Measured: painting `CSI 38;1H AAA`, then `CSI 10B`, then `CSI 38;1H BBB` — the *same* absolute row — leaves `AAA` at 2-from-end while `BBB` lands at 0. The frame tears.

**Verified cost: zero test churn.** The `A` tests (`virtual-terminal.test.ts:45`, `:464`, `:500`, `:503`) and the `B` test (`:56`) all run on 1–3-row grids, where `viewportTop()` is 0 and behaviour is byte-identical.

### 4. The viewport origin is DERIVED, never stored

### 3. The viewport origin is DERIVED, never stored

Add this as a comment in the file, and treat it as the invariant the whole design rests on:

> The viewport origin is **derived**, never stored — `grid.length` is the single source of truth. Do not introduce a `viewTop` field. The model holds as long as `grid.length` changes only by appending at the bottom.

This is what makes the narrow scope safe. Because `viewportTop()` is recomputed from `grid.length` at each absolute move, any prior splice is already absorbed by the time the next one resolves, so the out-of-scope handlers cannot desynchronise it. Measured — 100 seeded rows, one mid-op, then a footer repaint:

| mid-op | footer distance from end | scrollback lost |
|---|---|---|
| none (control) | 1 | 0 |
| `CSI 5S` | 1 | 5 — pre-existing, out of scope (see below) |
| `CSI 5T` / `CSI 5M` / `CSI 5L` / `CSI 10B` | 1 | 0 |

A **stored** `viewTop` would have to be maintained correctly in every splice, and each out-of-scope op becomes a way to desynchronise it — which is precisely the two-mental-models trap. Derived state has no such failure mode, and there is nothing to clear in `reset()` (`:141-149`), because it already sets `grid = [[]]`, which *is* the origin.

#### The newline hazard, resolved by measurement

The strongest theoretical objection to a derived origin: `feed()` grows the grid unconditionally on `\n` (`:75-79`), so a `\n` landing between two absolute moves of the same frame would make `viewportTop()` return a larger value for the second move than the first, tearing the frame in half.

Measured against the prototype, 200 seeded rows in every case:

| scenario | result |
|---|---|
| A. three-row frame, no interleaved newline (control) | rows land 2 / 1 / 0 from end |
| B. same frame with a `\n` injected between the absolute moves | 2 / 1 / 0 — **no drift** |
| C. frame split across three separate `feed()` chunks (the real WS case) | 2 / 1 / 0 |
| D. output newlines arriving between chunks | superseded frame's row drifts; the current frame still lands at 0 |
| E. five grow-then-repaint cycles | footer 1 row from end; **one** seeded row lost |

The hazard does not materialise, because a `\n` advances the cursor as well as the grid: the next absolute move recomputes the origin against the new length, so the frame's rows stay consecutive relative to the current bottom. This is the property a stored origin would not have.

Case E's single lost row is `transcript line 199` — the bottom-most seeded row, which a footer legitimately paints over because it is inside the viewport. It is an artifact of a synthetic seed that never scrolls, not a defect. Compare `main`, which loses two rows and mangles a third *on every repaint*.

### Rewrite the `MAX_ROWS` comment

`services/virtual-terminal.ts:15-19` currently reads:

> Kept well above any TUI screen height so absolute cursor positioning (H/f) never hits the trim.

That is the reasoning that produced this bug: it keeps CUP away from the *trim* while leaving CUP addressing the wrong *rows*. Replace it.

## Scope: the cursor-moving handlers — `H`, `f`, `A`, `B`

Two independent principles converge on the same boundary, which is why it is worth stating both.

**Structural — this is the primary rule.** Handlers that only **move the cursor** become viewport-relative; handlers that **mutate grid structure** do not. After `A`/`B` are clamped, no cursor move can change `grid.length`, so the only remaining growth is `\n` at the bottom — a genuine screen scroll. `L`/`M`/`T`/`J` would need a viewport *bottom* and a scroll-region model, not just an origin.

The rule is **complete over the handlers that exist today**: the row-affecting cursor moves are exactly `A`, `B`, `H`, `f`, and all four are in scope. `C`, `D`, `G` are column-only, so the viewport is irrelevant to them. `ESC 7`/`8` and `CSI s`/`u` are unimplemented — whoever adds saved-cursor state joins it to the cursor-moving set.

**Measured impact — the secondary rule, used as a severity gate** for what a follow-up is worth doing. Not "does a test have to change," which separates nothing, since `CSI S` and `CSI 2J` both have tests asserting their broken behaviour.

The two rules do not conflict anywhere here: `A`/`B` are cursor-moving *and* measurably corrupting (in by both), `S` and `2J` are grid-mutating *and* unverified (out by both).

| defect | positioning impact | scrollback impact | verdict |
|---|---|---|---|
| CUP `H`/`f` | measured; continuous; every turn, every resume | measured | **in** |
| `CSI A` | measured — reaches 5+ rows above `viewportTop()` | measured | **in** |
| `CSI B` | measured — tears a frame mid-paint | none | **in** |
| `CSI S` | **none** — measured | real, frequency unverified | out |
| `CSI 2J`/`3J` | none | total, frequency unverified; `2J`-vs-`3J` semantics unsettled | out |

**Result: 152/152 green across all eleven terminal-related suites, `tsc` clean, zero test rewrites.**

### `CSI S` is out, and the reason it was nearly in was a false claim

An earlier draft of this plan asserted that `:285-288` "never adjusts `this.row`, so the cursor silently points at a different logical line afterwards." **That is wrong.** Measured with identical viewport-relative CUP in both variants — 60 rows, `CSI 30;1H`, `CSI nS`, then a write:

| `CSI S` implementation | content rows clobbered, n=1 | n=5 |
|---|---|---|
| current (splice grid top) | `line0`, **`line51`** | `line0`…`line4`, **`line55`** |
| push blanks + `row += n` | **`line51`** | **`line55`** |

Both land the write on the *same* row: the splice's implicit shift compensates exactly, so the current code is internally consistent on the positioning axis. `CSI S`'s only real defect is destroying the `n` oldest scrollback rows — and **nobody has verified that Claude's TUI emits SU at all.** Unverified frequency puts it in the same bucket as `2J`, and the structural boundary excludes it independently: `S` mutates grid structure.

**Severity if it does fire, for whoever picks up the follow-up.** The mobile terminal renders a *scrollback transcript*, not a 40-row screen — `components/terminal/TerminalOutput.tsx:286-297` feeds a FlashList with `maintainVisibleContentPosition` and an explicit scroll-to-top button at `:317`. So `splice(0, n)` deletes history the user can physically scroll to, and it does so **invisibly**: the splice shrinks `grid.length` by `n`, so the derived origin shifts by `n` too, the viewport shows identical content, and the scroll never appears. Silent, unrecoverable, detectable only by absence. Do not let the follow-up treat this as cosmetic.

Leave a one-line comment on the `S` case pointing at its follow-up, so the file does not silently hold two models with nothing marking the boundary. Cheap mitigation for the legibility concern; costs no test.

**The one contingency that would flip this.** If Claude's TUI does emit SU, `CSI S` is live transcript loss of the same class as the headline bug and belongs in this PR. One grep for `ESC [ <n> S` over a real captured PTY chunk log settles it. **Run it before implementing; if SU appears, pull `CSI S` back in.**

**Getting a capture is a one-liner, not a blocker.** Neither repo has raw PTY captures checked in — `e2e/fixtures/terminal-output.json` is a 3-line synthetic with zero escape bytes — but `GET /api/sessions/:id/output` returns `session.outputBuffer` **verbatim**, the unrendered raw ring buffer (`tb-streamer/src/server.ts:5484-5493` → `src/pty-manager.ts:687-691`). One curl against any live session mid-turn produces a genuine capture with no new instrumentation. The same artifact answers the frequency question for `L`, `M`, `T`, `0J` and `2J` as well — one capture for the whole follow-up family.

**The follow-up issue must lead with the frequency check, not the fix — and must not sit indefinitely.** The invisibility finding above changes how this defect can ever be resolved. A deferred issue for a *visible* bug gets closed when a user hits it and files a report; an invisible one has no such route, because neither the user nor plan step 6 can observe it. So: grep first, and if nobody can produce a capture, **that absence is itself the answer** — apply the append-blanks fix on the structural-boundary grounds rather than waiting for evidence that has no way to arrive. That keeps the deferral honest instead of turning it into a permanent shelf.

## Explicitly OUT of scope

Every one of these is a real defect in the same file and the same family. None is fixed here; each gets a follow-up issue so the diff stays reviewable and the regression risk stays bounded.

- `CSI S` (`:285-288`) splices the grid's oldest rows instead of appending blanks at the viewport bottom, destroying scrollback. **Not a cursor bug** — do not carry that claim into the follow-up issue.
- `CSI 2J` and `CSI 3J` are treated identically as total grid annihilation (`:249-260`). A real terminal clears only the viewport on `2J`; `3J` clears scrollback. Two existing tests assert the destructive behaviour (`virtual-terminal.test.ts:490`, `:556`), and the `2J`-vs-`3J` split is itself unsettled.
- `CSI 1J` (erase from start of screen to cursor) falls through the `if/else if` silently, with no counter increment.
- `CSI 0J` truncates the grid to `row + 1`, permanently deleting scrollback below the cursor.
- `CSI r` (DECSTBM) is parsed and discarded (`:295-296`); no scroll region is modelled, so `S`/`T`/`L`/`M`/`\n` all operate on the whole grid.
- `CSI L` / `M` / `T` splice absolute scrollback with no viewport bottom.
- `ESC 7` / `ESC 8` / `ESC M` (DECSC/DECRC/RI) are silently dropped at `:193-194`, and `CSI s` / `u` are in `IGNORED_CSI` — there is no saved-cursor state in the class at all.
- **A CUP split across a `feed()` boundary is dropped and printed as literal text.** Measured: `feed('\x1b[40;')` then `feed('1HFOOTER')` yields the row `"1HFOOTER"` with `truncatedEscapeCount` 1, because `parseCSI` (`:206-209`) discards accumulated params on a short chunk and only a bare trailing ESC survives via `pendingEsc`. Pre-existing and unchanged by this fix; it degrades to visible junk rather than corruption. Worth knowing, because escape-free-vs-raw-bytes is not the only chunking axis.

**The boundary is not hermetic — one consequence to expect.** `CSI 0J` (`:254-259`), `K`, `L` and `M` all read `this.row`, so their behaviour on grids taller than a screen changes as a *consequence* of this fix even though they are out of scope. Most visible: `\x1b[H\x1b[J` today truncates the grid to one row (total transcript loss); afterwards it truncates to `viewportTop() + 1`, keeping scrollback. That is an improvement, but it is an untested behaviour change and belongs here rather than being discovered in review. The existing `0J` test (`:92-98`) is on a 3-row grid and is unaffected.

## Settled questions

**Is the narrow scope right? — Yes: the four cursor-moving handlers, conditional on the derived origin and the clamp.**
A derived origin is self-correcting across every out-of-scope op (measured above), so the two-mental-models risk is real only if the origin is *stored* — which step 4 forbids. The structural boundary and the measured-impact test independently pick the same four handlers; see the scope table.

**Where does 40 come from? — Hard-code it. Do not put geometry on the wire.**

The instinct to eliminate the duplication is wrong here, for a documented reason. `src/pty-host/protocol.ts:38-41`:

> Deliberately absent: `resize`. The plan lists it, but PTY dimensions are the fixed `PTY_COLS`/`PTY_ROWS` constants and `SessionRunner` has no resize method, so the verb would be one nothing could ever send. Add it with the caller that needs it.

Geometry is structurally constant. A wire field would carry a value that cannot vary, guarding a scenario the protocol has explicitly declined to support. The glyph-class drift in the abandoned PR #647 happened because two copies of a fact that *did* vary drifted; 40 cannot drift while resize does not exist.

Two corrections to the premise, worth recording so nobody re-opens this:

- `PTY_HOST_PROTOCOL_VERSION` (`protocol.ts:48`) governs the **streamer↔pty-host IPC** boundary. Mobile never sees it. A `rows`/`cols` field on `terminal_replay` would be a streamer↔mobile WS change — additive-optional, no bump. The indicator plan's version bump does not subsidise this one; they are different boundaries.
- `PTY_COLS`/`PTY_ROWS` are plain non-exported `const`s in two files. Even the wire approach would need an export and a shared constant first.

**Wiring it would not even remove the constant.** Mobile must keep a fallback for streamers that do not send geometry, so the wire option is the hard-coded constant *plus* a negotiation path — and it would block a shipped-corruption fix on a cross-repo release. This is the objection that comes back, so it is recorded here rather than re-argued.

**Failure direction, which decides how bad a wrong constant is.** Too large → origin too low → today's bug at reduced scale. Too small → **with the clamp** → footer rows pile onto the bottom row instead of corrupting transcript. The clamp is what makes a wrong constant *degrade* rather than *corrupt*, and that is half the justification for hard-coding at all.

So: hard-code `VIEWPORT_ROWS = 40` with a comment naming both streamer constants, and make the follow-up **conditional rather than scheduled** — whoever adds resize adds the wire field in the same change, which is the policy `protocol.ts:38-41` already states. That attaches a trigger to the risk instead of leaving an open TODO nobody actions.

**Rejected: deriving the origin from the highest row an absolute move has addressed.** Two measured failure modes.
*Multi-row repaint collapses* — a footer painted top-down in one chunk (rows 31, 35, 38, 40) sees the derived height rise as the repaint proceeds, so every row lands at the current bottom and overwrites the last; three of four footer rows are destroyed.
*One stray escape poisons it permanently* — a single `CSI 200;1H` puts the footer 61 rows from the end forever, because the tracked maximum is monotonic with no recovery path. The HTTP fallback path can begin mid-escape-sequence, which is exactly how a garbage row number gets in.

## Verification

1. **New regression test seeding >40 rows before a footer repaint.** This is the property the current suite cannot express. All five existing CUP tests (`virtual-terminal.test.ts:79`, `:95`, `:143`, `:490`, `:556`) have at most 3 grid rows at the cursor move, so `viewportTop()` is 0 and they are provably byte-identical under this change. No test in the repo combines a large grid with any cursor operation — that is the coverage hole that let this ship.
2. **Three assertions, not one — and shape the fixture like the real trigger.** "The footer lands within the last few rows" *fails after the fix* if written against `getLines()`, for the wrong reason: `lib/terminalChrome.ts:34` matches a correctly-placed footer exactly and filters it out, while the mangled hybrid survives the `^` anchor. Split it:
   - on `getLines()`: every seeded transcript line still present **and** no line matches `/Brewing/`. Fails today (two lost, mangled hybrid present), passes after. **This assertion carries the test.**
   - on `getRawLines()`: footer text among the last few entries.
   - invariant: `CSI 40;1H` on a >40-row grid does not change `getRawLines().length`.

   Build the fixture as the production path does: 200 escape-free rows joined with `\n` — what `feedHistory` receives at `useTerminalStream.ts:202` — then one live frame carrying `\x1b[40;1H`.
3. **A clamp test.** `CSI 200;1H` on a >40-row grid leaves `getRawLines().length` unchanged. Without it the clamp gets dropped in review and nothing fails.
4. **Validate the constant itself, not just the implementation.** Every other step tests the code against the assumption that the viewport is 40 rows. Feed a **real captured PTY log** and assert the footer rows land contiguously at the bottom. A wrong constant shows up immediately as a fixed offset. Since the constant is hard-coded, this is the check that earns it.
5. **The HTTP fallback path, concretely.** Feed a chunk that *begins inside a CSI* — the byte-level `subarray` at `tb-streamer/src/pty-manager.ts:820-825` can start mid-escape and mid-UTF-8 — and assert only that nothing throws and no transcript row is lost. Note `useTerminalStream.ts:77` swaps to `getRawLines()` at low parse confidence, the likely state on that path.
6. **Run the consumer suites, not just `--testPathPattern "virtual-terminal"`.** That pattern is a path regex and matches no consumer test — it excludes `__tests__/unit/hooks/useTerminalStream.{emptyReplay,seq,userMessages,watchdog}.test.tsx`, `__tests__/integration/components/TerminalView.test.tsx`, `__tests__/unit/components/terminal/`, and `__tests__/unit/utils/terminalSession.test.ts`, and `emptyReplay` exercises the very replay path this plan names as the production trigger. Use `--testPathPattern "useTerminalStream|TerminalView|terminal"`. Prototype baseline: **152 passed across 11 suites**, `tsc --noEmit` clean.
7. `npx tsc --noEmit --pretty false` and `npx eslint` on the changed files.
8. On device: resume a long session, let a turn run, and confirm the top of the transcript survives the spinner ticks.

**Standing rule, earned the hard way on this plan: any input used to reject an alternative must be run against the accepted design.**
The unclamped-CUP regression survived two reviewers because the stray `CSI 200;1H` was used adversarially against the *rejected* track-highest-row option and never against the *accepted* one. The asymmetry was in the testing, not in the designs — and the accepted design turned out to be strictly worse than `main` for that exact input. This rule generalises well past this PR.

**Expect a fixture artifact, do not chase it.** With a synthetic plain-line seed, footer rows interleave with surviving transcript rows (32-34, 36-37, 39 keep old content) because the seed never clears them. That is the fixture, not a bug — one more reason the headline test should use a real capture.

## Review log

Each validation round is appended here so the reasoning survives the merge.

### Round 1 — streamer-side review, 2026-08-12

Verdict: approve with changes. Six applied, three load-bearing.

- **Step 4 inverted.** The original text asked for stored viewport state maintained through `ensureRow`'s trim and `reset()`. That is exactly what would create the two-mental-models incoherence the scope question worried about. Replaced with the derived-origin invariant, backed by a measured table showing positioning survives every out-of-scope op.
- **`CSI S` primitive replaced.** The original "splice grid top + adjust `this.row`" fixes the cursor but leaves the scrollback destruction. Re-measured independently: splice loses 6 scrollback rows, push-blanks loses 0.
- **Wire-geometry option rejected on documented grounds** — `protocol.ts:38-41` deliberately omits `resize`, so geometry cannot vary; the follow-up is now conditional on resize landing rather than a scheduled issue. Two premise errors corrected: `PTY_HOST_PROTOCOL_VERSION` is the IPC boundary and invisible to mobile, and `PTY_COLS`/`PTY_ROWS` are non-exported consts.
- **Track-highest-row option rejected** with two measured failure modes: multi-row repaints collapse onto one row, and a single stray `CSI 200;1H` poisons the origin permanently with no recovery path.
- **Citation corrected** — the "old raw-byte slice" comment is at `pty-manager.ts:695-697`, not `:174-176` (which is `createScreen()`'s body). Verified directly. Geometry comment at `:39-41` added as a second reference.
- **Verification widened** — the narrow `--testPathPattern` matched no consumer test; added full-suite runs, a test that validates the constant itself against a real capture, and a `CSI S` test.

The single-construction-site claim was independently re-checked and holds: `app/session/_layout.tsx:10` and `utils/stripBoxDrawing.ts:6` mention `VirtualTerminal` only in comments, so `hooks/useTerminalStream.ts:53` really is the only one.

### Round 2 — prototype + scope ruling, 2026-08-12

Prototyping the round-1 plan in the mobile worktree found a contradiction, and chasing it overturned a claim both reviewers had accepted.

- **The prototype broke a test**, `virtual-terminal.test.ts:116-121`, which asserts `line1` is *destroyed* by `CSI 1S`. That put `CSI S` in exactly the position `2J` was excluded from, so the stated scope principle no longer separated them.
- **Chasing it showed the `CSI S` cursor claim was false.** Measured with identical CUP in both variants: old and new clobber the *same* content row (`line51` at n=1, `line55` at n=5); the splice's implicit shift compensates exactly. The plan had asserted a cursor bug that does not exist, and round 1 endorsed it. `CSI S`'s only defect is scrollback destruction, at unverified frequency.
- **Scope principle replaced.** "Does a test have to change" separates nothing; **measured impact** does, and it drops `CSI S` and `2J` into the same bucket without any restatement. `CSI H`/`f` alone.
- **Result: one behavioural change, zero test rewrites, 82/82 on the emulator suites and 152/152 across all eleven terminal suites, `tsc` clean.**
- **The newline hazard was measured and does not exist** (table under step 3). It was the strongest theoretical argument against a derived origin.
- A replacement assertion for the deferred `CSI S` work is recorded below so the follow-up does not have to re-derive it. Note the trap: asserting the cursor holds its screen row passes under *both* implementations and discriminates nothing.

```ts
it('scroll up (CSI S) pushes rows into scrollback instead of deleting them', () => {
  const vt = new VirtualTerminal()
  vt.feed('line1\nline2\nline3')
  vt.feed(`${CSI}1S`)
  expect(vt.getLines()).toEqual(['line1', 'line2', 'line3'])
})
```

Verified: `['line1','line2','line3']` corrected, `['line2','line3']` today. A 3-row grid pins only scrollback survival; when the follow-up lands, test it where the viewport is real (50 rows, `CSI 40;1H`, `CSI 5S`) and assert survivor count plus that `line 0` is still present.

### Round 3 — mobile-side review, 2026-08-12

The mobile reviewer converged independently on all three round-1/2 changes, then found a defect neither the streamer reviewer nor I had caught.

- **Ship-blocker: the unclamped CUP was a regression.** Each out-of-range absolute move appended a screenful of blanks; past 62 strays the grid crossed `MAX_ROWS` and the trim evicted real transcript. Independently reproduced: 62 strays → 79 of 200 rows survive, 70 → 0, against 200 on `main`. **The plan was using a stray `CSI 200;1H` to reject one alternative while leaving the accepted design open to the same input.** Clamp added; 200/200 at every stray count.
- **`CSI A` and `CSI B` pulled into scope**, both measured. `CSI 45A` from the footer region destroys a row five above `viewportTop()`; `CSI 100A` lands the cursor 99 rows from the end. `CSI 10B` mid-frame makes the same absolute row resolve to two different places, tearing the frame. Zero test churn — every `A`/`B` test runs on a 1–3-row grid.
- **The scope boundary is now principled rather than post-hoc.** Cursor-moving handlers become viewport-relative; grid-mutating handlers do not. This independently excludes `CSI S`, agreeing with the round-2 measured-impact ruling — two different tests, same four handlers.
- **Verification item 2 would not have caught the bug for the right reason** — `terminalChrome.ts:34` filters a *correctly placed* footer out of `getLines()` while the mangled hybrid survives the `^` anchor. Split into three assertions.
- **Stale round-1 bullet deleted** — "any new viewport state must be decremented in `ensureRow`" survived the rewrite and directly instructed the implementer to build the `viewTop` field step 4 forbids.
- Added: the non-hermetic-boundary consequence (`0J`/`K`/`L`/`M` read `this.row`, so `\x1b[H\x1b[J` changes from total transcript loss to keeping scrollback), the feed-boundary CUP truncation, the failure-direction note, and the consumer evidence for `CSI S` severity.
- Citation nit fixed: the HTTP fallback is the query at `useTerminalStream.ts:81-97` but the feed is the effect at `:111-129`.

### Round 4 — streamer-side re-review, 2026-08-12

Approved for commit. All three round-3 findings independently reproduced: the stray-CUP table matched at every count, `CSI 45A` destroyed a transcript row above `viewportTop()`, and the `CSI 10B` frame tear showed the same absolute row resolving two rows apart. Zero test churn re-confirmed against `virtual-terminal.test.ts:41` and `:52`.

Three documentation requirements applied: the invariant stated as an invariant, the adversarial-input rule added to verification, and the follow-up reframed to lead with the frequency check. The structural boundary is adopted as the **primary** scope rule with measured-impact demoted to a severity gate, and the boundary was checked complete over the handlers that exist today.

The `CSI S` deferral holds — impact is severity × frequency, and the consumer evidence raises only severity. But the reviewer's own diagnosis of how the clamp regression slipped through is worth preserving verbatim, because it is the process lesson rather than the code one:

> The failure wasn't that I missed an input — it's that I tested the *rejected* option adversarially and the *accepted* one only on well-formed data. The asymmetry was in my testing, not in the designs.

### Round 5 — mobile-side sign-off, 2026-08-12

Accepted the `CSI S` deferral and withdrew the objection. Its own reasoning, worth keeping because it is the cleanest statement of why the boundary holds:

> I proposed the boundary … and then immediately carved out an exception for the one grid-mutating handler I happened to like. That is special pleading, and the tell is that my justification for the exception ("pure data loss, unambiguous semantics, 3 lines") never once referenced the boundary. It was a severity argument wearing a scope argument's clothes.

It also confirmed the deferral is **safe, not merely defensible**: leaving the old `splice(0, n)` in place cannot destabilise the derived origin, because the splice shrinks `grid.length` and every absolute index by the same `n`, so a subsequent `viewportTop() + k` addresses the same content. That is the same compensation that falsifies the positioning claim — the two findings are one fact seen from opposite sides.

Final state independently re-verified on the worktree: all three handlers as specified, `tsc --noEmit` clean, 11 suites / 152 tests green.

**Both reviewers approved. Ready to commit.**
