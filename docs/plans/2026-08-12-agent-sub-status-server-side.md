# PlanIndicator — derive agent sub-status server-side (streamer + mobile)

Cross-repo.

**Worktrees — outside each repo root, branched from the current `origin/main`:**

| Repo | Path | Branch | Base |
|---|---|---|---|
| streamer | `/Users/ronenmars/dev/ai-tools/tb-streamer-worktrees/feat-agent-sub-status` | `feat/agent-sub-status` | `origin/main` @ `0eb2c53` — **created, `npm ci` done** |
| mobile | `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/feat-agent-sub-status-render` | `feat/agent-sub-status-render` | `origin/main` @ `86eeb2a1` — create when Part B starts |

Work in the worktree, never in the main checkout, and never nested inside the repo root — a nested worktree is a full second copy that Jest, ESLint, TypeScript and Metro all walk into.
Rebase onto `origin/main` before opening either PR.
On the mobile side `npm ci` must run in the worktree: a symlinked `node_modules` makes Metro bundle the main repo and hides the worktree's own lockfile drift.

Do **not** reuse the stale `tb-mobile-worktrees/feat-agent-sub-status` worktree at `0a58200c` — that is the abandoned PR #647 branch, behind `main` and carrying the client-side implementation this plan replaces. It was **closed, not merged**, so none of that code is on `main`; see Part B.

Independent of [PlanCup](./2026-08-12-viewport-relative-cursor-positioning.md) — neither blocks the other.

## Goal

Show whether a live agent is *thinking*, *streaming*, *running hooks*, *acting*, or *waiting for input* — a phase axis inside `running`, which `SessionStatus` does not model today (`src/types.ts:9`: `"running" | "waiting_input" | "idle"`).

Derive it **here**, in the streamer, off the rendered PTY screen, and emit it as an additive field.
Mobile renders it and nothing more.

## Why this layer

An earlier attempt (tb-mobile PR #647, now closed) derived it on the client by scraping mobile's own terminal emulator.
It never worked: mobile's `VirtualTerminal` mis-handles absolute cursor positioning, so the status line it searched for was never where it looked.
Beyond that specific bug, the client is the wrong layer, because this server already has everything the derive needs:

- A real `@xterm/headless` screen per session at the exact geometry the TUI paints against — `src/pty-manager.ts:42-43`, 120x40.
- A throttled screen-scrape already running on every chunk — `detectLivePrompts` at `src/pty-manager.ts:857`/`:881`, `SCRAPE_THROTTLE_MS = 300` at `:80`.
- An established precedent for scraping this exact footer and shipping the result — `src/services/questions/parseStatusLine.ts`, which extracts `model` / `effort` / `permissionMode`.

## What ALREADY exists — do NOT rebuild

- **`parseStatusLine.ts`** — the module to copy, not to extend. Pure, no I/O, scans rendered lines bottom-up (*"the footer is the last thing painted, and older scrollback can contain text that looks like a footer row"*), returns all-optional fields, and degrades to an empty object rather than throwing or inventing a value.
- **`detectLivePrompts`'s single screen read** — `src/pty-manager.ts:942`, `getOutputLines(sessionId, 60)`. Every downstream detector shares it. A new derive hooks in here and needs **no second read**.
- **The additive-callback pattern** — `onPermissionChange` (`src/types.ts:566-577`), *"Additive; absent in tests that omit it."*
- **The additive-field pattern on the wire** — `effort` / `permissionMode` at `src/types.ts:385-394`, and `statusSource` / `statusConfidence` / `statusUpdatedAt` at `:359-367`. **Streamer-side only** — verified absent from mobile's `types/api.ts` and from all mobile source, so they are not a liveness gate the client already has. Do not plan against them as an existing mobile input.
- **Codex already classifies its own phase.** `src/codex-pty-runner.ts:40-50` exports `CODEX_PROMPT_READY_TEXT = "Ready"` and `CODEX_BUSY_STATUS_RE = /\b(?:Starting|Working)\b/`; `:185` isolates the status bar; `:362` maintains a `turnBusy` set. Its scrape pass is `detectScreenState` at `:1024`.
- **Mobile delivery needs no new subscription — but it does need design.** A field inside `Session` reaches the client through the merge at `tb-mobile/app/_layout.tsx:164-166` and `useSessionDetail` (`hooks/useSession.ts:291-303`) with no new wiring. What it does *not* get for free is a coherent lifetime: three call sites write that cache key with incompatible semantics, and absence cannot express "cleared". See Part B1/B2 — that is the real client-side cost.

## The must-fix: the phase is cleared server-side, or this ships #647's bug again

`src/pty-manager.ts:1103-1108` warns:

> Claude's TUI does differential repaints and doesn't always retransmit the box border once it's already drawn — so a mid-conversation return to idle can go undetected forever if the last chunk didn't happen to carry it.

An earlier draft cited that as evidence for *rejecting* the elapsed counter, and never ran it against the accepted design. Running it, as the standing rule requires: **it applies with full force.** A phase field stamped by the scrape pass and never cleared latches on any session that stops emitting — the last chunk said `streaming`, no further chunk arrives, the field says `streaming` forever. That is exactly the bug PR #647 shipped, relocated from the render layer to the server.

The only mitigation in the earlier draft was on the *client* (gate on `statusUpdatedAt`), which pushes the liveness obligation onto every consumer — precisely how #647 failed.

**The rule, which belongs in Part A:**

> The phase is a **refinement of `status === "running"`** and is cleared server-side at the turn-end transition. It is never a free-standing state with its own lifecycle.

The machinery already exists. `markReady` (`src/pty-manager.ts:1168`) is the single idempotent `running → waiting_input` transition; it already sets `statusSource` and `statusUpdatedAt` and already fires `onStatusChange`. Clear the phase there. It is driven by `hasWaitingForInputOsc` (`src/services/questions/detectPermissionGate.ts:101`, used at `pty-manager.ts:900`), which the codebase describes as *authoritative — it arrives even when no further chunk will (the turn is over)*: the one signal that survives the differential-repaint problem.

With that in place, the client-side freshness gate becomes defence in depth rather than the only defence.

## The signal question — settled, but not the way the earlier draft framed it

### The test-lock argument was wrong; drop it

An earlier draft claimed `__tests__/parse-status-line.test.ts:61-64` locks this feature out. It does not. The test asserts that **`parseStatusLine` extracts none of *its own three fields*** from that line — not that the line carries no usable signal. And this plan proposes a *separate module*, so the test does not constrain the design at all.

### The rejected sub-field is not the one the derive reads

`parseStatusLine.ts:9-12` rejects the elapsed counter, and its fixture is `(56s · ↑ 3.4k tokens)` — **`↑`, input tokens**. The derive keys on **`↓`, output tokens**, plus the presence of a duration-bearing parenthetical, `hooks…`, and a `<verb> for <N>s` end marker. Different sub-fields of the same parenthetical. What was rejected is *the numeric value of a monotonically-advancing counter*; what this reads is *the presence of markers*.

### The argument that survives the person who wrote that comment

Not "a phase lags less than a timer" — that is a matter of degree and he can simply disagree. The argument is about signal class:

- The elapsed counter is a **continuous function of wall-clock time**, sampled at output events. Between samples it is wrong and the error grows without bound. No sampling strategy repairs that, which is why the comment prescribes local animation instead. **He was right.**
- The phase is a **step function whose transitions are themselves output events.** `thinking → streaming` happens *because* tokens began painting; `→ hooks` because hook output painted. The repaint condition and the transition condition are the same condition, so discrete sampling at output events is **exact** for this signal, not approximate.
- The single exception is the exit edge, which is not an output event — and that is exactly `:1103-1108`. Which is why the clearing rule above is mandatory rather than nice-to-have.

**Caveat to discharge first:** the `↑`/`↓` split comes from a module derived against two captured turns. Re-verify on a fresh capture before building on it. `GET /api/sessions/:id/output` returns the raw ring buffer verbatim, so one curl against a live session settles this, `hooks…`, and the end marker at once.

## The plumbing cost is real, and the cheap path is a trap

`parseStatusLine` is **REST-only** — called once, from `handleGetSession` at `src/server.ts:4522-4537`, and never from the WS broadcast path, `session_list`, or `managedToResponse`.
So `effort` and `permissionMode` are absent from every `session_update` frame today.
That is structural, not an oversight: `managedToResponse` (`src/session-store.ts:222-311`) is synchronous and has no PTY handle.
A *static* field can be scraped lazily on GET. A *live phase* cannot.

### Rejected: riding `onStatusChange`

There is a cheaper path and it must not be taken. `onStatusChange` is already in `PTYManagerOptions` (`src/types.ts:564`) and **already relayed across the pty-host boundary** (`src/pty-host/remote-session-runner.ts:279`), so riding it would need no new callback, no new event, and no version bump.

Its handler (`src/server.ts:959-1060`) does, *per invocation*: `sessionStore.updateManaged`, `managedSessionsRepo.recordStatus`, a scanner index refresh, file-watcher teardown, a **global** `wsHub.broadcast`, an APNs Live Activity update, and a push notification check. `recordStatus` (`src/db/repositories/managed-sessions.repository.ts:229-247`) runs its update statement **unconditionally, with no same-status guard** — so at `SCRAPE_THROTTLE_MS = 300` that is roughly three durable SQLite writes per second per active session to carry a cosmetic field, and the throttle is a floor, not a ceiling. The notifiers do guard on `previousStatus`, so it probably would not spam pushes; "probably would not spam push notifications" is not a property to ship.

### The actual work

1. **Optional field on `ManagedSession` and `SessionResponse`** — needed for the GET path and the reconnect baseline. Stamped by the scrape pass, not read on demand.
2. **A new dedicated callback in `PTYManagerOptions`**, mirroring `onPermissionChange` — deliberately *not* wired into the status funnel.
3. **A scoped, bespoke frame — not the global broadcast, and not a `SessionResponse` copy.** `src/server.ts:1050` is `wsHub.broadcast` — every client, every session. Use `broadcastToClients` (`src/ws-hub.ts:74`), which exists precisely for *"high-frequency per-session messages (terminal_output, user_message)"* because global broadcast *"made broadcast() cost scale with connections × active sessions."*

   **Send a minimal frame, following that path's existing tenants** — `terminal_output` and `user_message` are bespoke minimal messages, not session copies:

   ```ts
   { type: "session_phase", sessionId: string, phase: Phase | null, updatedAt: string }
   ```

   **Why not a session copy:** `managedToResponse` computes `elapsedMs: (s.completedAt ?? new Date()).getTime() - s.startedAt.getTime()` (`src/session-store.ts:277`). For a live session `completedAt` is null, so **`elapsedMs` changes on every call** — every phase frame would deliver a session object differing from the last whether or not the phase changed. Mobile's `{...prev, ...msg.session}` then produces a new object identity ~3×/second, re-rendering every React consumer of that session for the whole turn, and re-running the `lifecycle`/`lifecycleSource` derivation each tick. It appears in no test and on device reads as "the app got sluggish during turns." Same class as the `recordStatus` write amplification above: a high-frequency signal routed through machinery built for low-frequency whole-object updates.

   The bespoke frame also puts no mapper in the live path, so the null-erasure hazard below applies only to the GET path. And its `updatedAt` gives mobile a freshness signal without mirroring `statusUpdatedAt` — which keeps the app's "server decides liveness and says so" idiom intact and avoids introducing its first time-decay gate.
4. **A pty-host protocol event, and a `PTY_HOST_PROTOCOL_VERSION` bump** (currently `2` at `src/pty-host/protocol.ts:48`). Unavoidable: `:32-36` is explicit that *"the detectors that fire them run in the host, so every one of those callbacks needs an event here or the feature silently stops working when the flag is on."*
5. **Clear the phase at `markReady`** — see the must-fix above.
6. **On the GET path, use an unconditional key — the mapper will otherwise erase the null silently.** `managedToResponse` builds every optional field as `...(s.x != null && { x: s.x })`, and `!= null` is the loose comparison that catches **null and undefined alike**. There are **19** instances of that idiom in the file, so an implementer matching the surrounding style will almost certainly write it — converting explicit-null into absence, at which point mobile's merge keeps the previous value and the label latches. That is #647's bug arriving through the mapper instead of through the missing clear, defeating the very contract added to prevent it.

   The correct in-file precedent is three lines away at `src/session-store.ts:280`:

   ```ts
   completedAt: s.completedAt?.toISOString() ?? null,
   ```

   An unconditional key carrying an explicit null. Copy that, **and comment it so it is not tidied into the guard block later** — it looks like it belongs there, and moving it would break the clearing contract without touching anything named `subStatus`.

   Type it **`Phase | null`, not `Phase?`** — the optional form is `Phase | undefined` and cannot hold an explicit null. Same on mobile's `Session`.

A `SessionRunner` method (`src/types.ts:640-662`) is **not** needed: as a `PTYManagerOptions` callback, every runner already accepts it.

### One semantic rule: always emit the field

`null` when there is no phase — on the live frame and on `SessionResponse` alike. **Never let absence carry meaning.** The whole problem is that a merge cannot express absence, so do not create a state that depends on it. An "absent means no information, null means cleared" distinction is a third state someone will get wrong, and it is the same shape as the bug just closed.

## PART A — streamer

### A1. Codex first — but define the full enum up front

Codex is the cheap half and validates the whole transport before anyone fights Claude's footer.
Its status bar is a plain word on the last non-blank rendered line, already isolated and already classified.
Ship the field, the callback, the protocol event and the mobile render against Codex, end to end.

**The hazard: Codex's phase axis is binary and Claude's is not.** `CODEX_BUSY_STATUS_RE = /\b(?:Starting|Working)\b/` against `CODEX_PROMPT_READY_TEXT = "Ready"`, and the captured note is explicit that a Codex turn walks Ready → Working → Ready with no other state, so *"claiming otherwise would be invention."* If Codex lands first unguarded, the field's type gets fixed by a two-valued provider — and the failure mode is shipping a boolean or a two-member enum that Claude's four-or-five phases then cannot fit without a breaking change to a field mobile has already been told to render.

Mitigation, cheap: **define the full enum in A1** even though Codex only ever emits two of its members, and add a contract test that an unrecognised phase value is ignored rather than coerced. That gets the transport proof without baking the shape. The enum lives in **exactly one place** — this is the two-copies-of-the-grammar problem from #647 in a new costume.

### A2. Claude derive

New pure module beside `parseStatusLine.ts`, same contract: no I/O, rendered lines in, all-optional out, empty result on no match, bottom-up scan.

Never parse raw bytes — the footer is assembled by absolute cursor moves and has no contiguous byte form, which is the documented reason `parseStatusLine` reads rendered lines.

Reuse `lib/terminalChrome.ts`-equivalent grammar rather than re-deriving glyph classes.
Two independently-maintained copies of the same TUI grammar already drifted once: PR #647's end-of-turn glyph class was a subset of the one that already existed, and the missing glyphs stranded the label.

### A3. Wire it up

Call from `detectLivePrompts`'s existing screen read. Note the throttle is a **floor, not a ceiling** — OSC and footer triggers bypass it, and a session with an open gate passes unconditionally.
A throw inside `detectLivePrompts` is swallowed into a `warn` at both call sites (`:857`, `:1118`), so a silent regression is easy: test the failure path explicitly.

### A4. Never add a value to `SessionStatus`

`src/types.ts:409-419` documents the rule: `VALID_STATUSES` rejects unknown values and the store drops sessions outside the requested set, so a new status string makes those sessions **vanish** from already-shipped apps.
The phase rides as a separate additive field, carrying `statusSource` / `statusConfidence` / `statusUpdatedAt`.

**The general rule, worth writing down because the next feature will hit it: additive *fields* are safe; additive *values* in an existing union are not.** Anything a shipped client filters or switches on inherits the vanishing hazard. `VALID_STATUSES` is the documented case; `SessionLifecycle` (`src/types.ts:16-21`), `SessionOwnership`, `ProcessLiveness` and `StatusSource` are all in the same family.

### A5. Unknown providers make no claim

`getTerminalChromeFilter` already routes an unrecognised provider to passthrough — *"prefer passthrough over wrong Claude filters."*
Follow that, not PR #647's "Claude's rules are the safe default," which would give a third provider Claude's grammar.

## PART B — mobile

**Part B is not "add a field and render it."** An earlier draft of this plan claimed the client side was nearly free because the field arrives through existing wiring. It does arrive — but with **three different lifetimes depending on which screen is mounted**, and the clearing semantics do not exist at all. That is the part of Part B that needs design, and the streamer work should not be scheduled against the cheaper estimate.

### B1. The cache problem — solve this before anything else

Three call sites write the same `['session', serverId, sessionId]` key with **incompatible semantics**:

| site | operation | effect on a field the frame omits |
|---|---|---|
| `app/_layout.tsx:164-166` | `{ ...prev, ...msg.session }` — merge | **sticky**: keeps the old value forever |
| `components/conversation/LiveConversationView.tsx:143` | `qc.setQueryData(key, msg.session)` — **whole-object replace** | **destroyed** |
| `lib/eagerCacheSync.ts:25-31` | `{ ...s, ...session }` — merge | sticky (home-screen row) |

**This is a live bug today, not a new one.** `effort` and `permissionMode` are REST-only and absent from every `session_update` frame, so they are wiped whenever `LiveConversationView` is mounted and restored on the next refetch. Both handlers are subscribed simultaneously on the session detail screen, so whichever fires last wins. **File it as its own bug** — it is not caused by this feature and should not be fixed inside it.

**But `subStatus` does not inherit it, and the replace is actually the *safer* semantic.** Work the four cases:

| | replace (`LiveConversationView`) | merge (`_layout`, eager cache) |
|---|---|---|
| **with explicit null** | → null ✓ | → null ✓ |
| **field absent** | → cleared ✓ | → **latched** ✗ |

An absent field is *cleared* under replace and *sticky* under merge. So the always-emit-null contract exists to serve the **merge** paths, not the replace one — and with it in place all three converge on the same value. Item 2 is therefore a genuine pre-existing bug but **not a blocker for this feature**.

**Its severity is higher than "two fields go blank", though.** In `types/api.ts`, `status` is required (`:23`) but every field driving presentation classification is optional — `lifecycle?` (`:68`), `ownership?` (`:94`), `processLiveness?` (`:99`), `activity?` (`:104`). `services/ws-client.ts:15` types the frame as a complete `Session`, but the WS path demonstrably does not populate everything REST does, and because those fields are optional TypeScript never catches the gap. If `session_update` omits `ownership`/`processLiveness`, the whole-object replace does not blank metadata — it **flips the session out of the `external_live` or `stale` branch**, changing what the badge *says* for as long as the conversation screen is mounted. A visibly wrong label, not a missing detail.

**Resolved — it stays a low-severity cleanup.** All six `session_update` emit sites broadcast `sessionStore.get()`, which returns `managedToResponse` for anything managed. That frame carries `lifecycle` and `ownership` **unconditionally** (`src/session-store.ts:250`, `:272`) — and those are precisely the two fields the mislabelling argument depended on. It omits `processLiveness`, `activity`, and `effort`/`permissionMode`.

The scenario is unreachable for a second reason: **`processLiveness` has exactly one assignment site in the whole streamer** — `src/session-store.ts:325`, hard-coded to `"alive"` on the external path. `"gone"` and `"unknown"` are never produced. A `stale` branch that the server cannot cause the client to enter cannot be wrongly exited.

Fixing `LiveConversationView.tsx:143` to merge is still worth doing — a whole-object replace against a frame that is a strict subset of the REST shape is fragile regardless — but it is **robustness, not a live defect**, and it does not outrank this feature.

**A separate finding, pointing the other way — file it on its own.** Mobile handles `processLiveness: 'gone'` and `'unknown'` (`__tests__/unit/lib/externalSession.test.ts` asserts both, calling `'unknown'` *"a new-server signal"*) and `SessionCard.tsx:83` synthesises `'alive'` locally — while the streamer emits only `'alive'` from a single line. Mobile is defensively branching on states the server cannot express, which likely means a presentation branch is dead and the app's real staleness detection comes from the pid fallback. Different bug shape from "field gets blanked"; give it its own investigation.

**Methodology note for whoever writes that up:** `activity` is assigned in `server.ts:3683`, not in `session-store.ts` where the rest of the response is built, and it only surfaces if you grep the enum value (`active_writing`) rather than the field name. One response shape assembled across two files is exactly what produces a confident wrong answer — **grep the values a field can take, not just its name.**

### B2. The clearing contract — the plan must specify it, not the implementer

`{ ...prev, ...msg.session }` does not remove a key that is missing from the frame, and `JSON.stringify` drops `undefined`. So **a server that simply stops emitting `subStatus` cannot clear it.** The client keeps the last phase until a full refetch.

That is PR #647's latching failure reappearing one layer down — the pill latched at the render layer, this latches at the cache layer. Pick one and write it into the wire contract:

- the server emits an explicit `subStatus: null` on phase exit, or
- the client treats "fresh `statusUpdatedAt` + absent `subStatus`" as cleared.

This surfaced by applying the rule earned on PlanCup: *any input used to reject an alternative must be run against the accepted design.* This plan rejects the client-side layer partly because #647's pill latched onto idle sessions — and the accepted design latches too, for the same root cause. Second time that rule has paid.

### B3. The rest

1. Add `subStatus` to `types/api.ts` `Session`, in the additive block with `model` (`:43`), `effort` (`:47`) and `permissionMode` (`:53`). Type it `Phase | null`, never optional — see the always-emit rule.
2. **Also add it to `SessionPresentationInput` (`lib/sessionPresentation.ts:58-72`) — adding it to `Session` alone is not enough.** That type is **standalone and structural**, enumerating eleven fields explicitly rather than deriving from `Session`, so `deriveSessionPresentation` cannot see a field that is not on its own input type. This reads like a data-flow step and is actually a type declaration in a second file plus the derive logic. Small, but it is exactly what turns "add a field" into an afternoon.
3. **Gate on `presentation.live`, not on raw `status`.** `deriveSessionPresentation` does not classify off `status` alone: the `external_live` branch keys off `ownership` + `processLiveness`, `stale` keys off `processLiveness === 'gone'`, and `SessionPresentationInput.status` is a loose `string` because *"Runtime may still emit legacy / on_hold values not in SessionStatus."* So a session can present as **stale** or **external** while `status` is still `'running'` — and a raw-`status` gate would render a phase indicator beside a badge reading "Idle" or "External", the indicator contradicting the label it decorates.

   `deriveSessionPresentation` already returns `live: boolean`, and `SessionStatusBadge.tsx:47` already uses it to drive the `LiveDot` the indicator sits beside. Gating on it makes the contradiction **structurally impossible**, and it follows a rule the codebase states outright at `components/sessions/SessionCard.tsx:79-82` — *"name it here so the badge and the accessibility label agree on one answer rather than each deriving its own."* A raw-`status` gate would be a third derivation of liveness.

   It also agrees with the data by construction: external sessions have no streamer-owned PTY, so no scrape, so no phase.

   **Tree mode is deliberately out of scope.** `components/sessions/tree/TreeRow.tsx:63` renders its own `LiveDot` from an `isLive` prop; it is not a badge, so skipping it breaks nothing, but putting the indicator there would mean reconciling a third liveness derivation.
4. **Do NOT build client-side time decay.** The app has no time-decay precedent, and its established idiom is the opposite: the one thing mobile calls "stale" (`lib/sessionPresentation.ts:211-221`) keys off `session.processLiveness === 'gone'`, an explicit server enum. **The server decides liveness and says so; the client never infers it from a timestamp.** A freshness gate would also have nowhere to live — `sessionPresentation.ts` is a pure `session → presentation` function, and a pure function cannot decay: nothing re-invokes it when the clock crosses a threshold, so the label would clear only on the next unrelated re-render. Making it tick means a timer and a formerly-deterministic function becoming time-dependent.

   Follow the `processLiveness` idiom instead: the server clears `subStatus` explicitly at turn end (the must-fix above), and mobile renders it only while `status === 'running'`. No clock, no timer, no extra field. If a freshness gate is kept anyway, the plan must name where the tick comes from and accept that `sessionPresentation.ts` stops being pure.
4. **Theming cost is bimodal — pick a branch explicitly.** `colorForToken` is **module-private** to `components/sessions/SessionStatusBadge.tsx:18`, not a shared helper, and it is a closed switch over two closed five-value unions (`SessionColorToken` at `lib/sessionPresentation.ts:18`, `Theme.status` at `constants/theme.ts:24-30`).
   - **Reuse an existing token** (everything running-ish renders `running`): ~zero extra work.
   - **Give the phase its own colour**: extend the union, extend the `Theme` interface, add a switch branch, and add the colour to **every theme object — 17 of them**, including the three `appleGlassThemes` variants. Missing one is a type error, so it fails loudly rather than shipping invisible — which is exactly the failure mode `#3fb950` did not have.

   Either way: **never a hardcoded hex.** The app ships four light themes on which #647's pill was invisible.
5. Hide it whenever a question card is showing — including the PTY-scraped gate, not just the structured one. `components/conversation/ThinkingBubble.tsx:107-134` builds `card` from `activeQuestion ? … : questionBlock ? … : null` and returns card-only when set, so it genuinely covers both paths. Copy it; do not re-invent it.

### There is nothing to delete — PR #647 was closed, not merged

An earlier draft of this plan specified removing `lib/agentSubStatus.ts`, its test, `getTailLines` from `services/virtual-terminal.ts`, the `useTerminalStream` derive, and four locale keys including a byte-identical Russian `status.working`.

**None of that exists on `origin/main`.** Verified: `git cat-file -e origin/main:lib/agentSubStatus.ts` fails, `getTailLines` appears zero times in `git show origin/main:services/virtual-terminal.ts`, and `"working"` appears zero times in all four `locales/*/sessions.json`. PR #647 is `CLOSED` with `mergedAt=null`. The draft described the abandoned branch's tree as if it were `main`.

Two consequences:

- **The deletion task is zero, not small.**
- **There is no ordering conflict with PlanCup.** The two plans do not touch a common line, so they land in either order, independently.

The i18n rule still applies in the **forward** direction: if the server-side labels are new strings, `en` + `ar` + `he` + `ru` must be added in the same commit or `__tests__/i18n-completeness.test.ts` fails, and a key with no `t()` reference fails `i18n-unused-keys`.

### Part B, ordered by risk

The earlier "add a field and render it" estimate was true of exactly one item on this list.

| # | work | notes |
|---|---|---|
| 1 | **Wire contract for clearing `subStatus`** | Blocking. Cross-repo, so it belongs in **Part A's field definition**, not here — otherwise the streamer ships a field mobile cannot turn off. |
| 2 | **Reconcile the cache handlers** | **Pre-existing bug, not a blocker for this field** — see below. Its own PR, and possibly a higher priority than this feature. |
| 3 | Add `subStatus` to `types/api.ts` | The only genuinely trivial item. |
| 4 | Render | Cheap if it reuses a colour token; ~20 files if it needs its own. |
| 5 | Question-card suppression | Cheap — the pattern exists and is correct. |
| ~~6~~ | ~~Deletion~~ | **Zero. The section was void.** |

**Not part of this feature, file separately:** the stale-`provider` closure in `hooks/useTerminalStream.ts` — `provider` is read at `:104` and `:146` but omitted from the effect deps at `:291`. Verified. The same effect feeds the chrome filter.

## Verification

- Streamer unit tests for the pure derive over captured real screens, mirroring `__tests__/parse-status-line.test.ts`.
- Integration through a fake PTY, mirroring `__tests__/session-status-line.test.ts:54`.
- Explicitly test that a derive failure leaves the field absent and does not break the PTY path.
- **Exercise it with the pty-host flag on**, or the feature silently no-ops in that mode.
- Contract test: `subStatus` absent means mobile renders exactly as it does today.
- Mobile badge render tests, including that a stale `statusUpdatedAt` clears the indicator.
- `npm run test:i18n` in mobile — a dedicated CI job at `.github/workflows/test.yml:185`.
- **Update `docs/compatibility/tb-mobile.md`.** Its header requires it before any change to a response shape, status value, or WebSocket event.

## Review log

Each validation round is appended here so the reasoning survives the merge.

### Round 1 — both reviewers, 2026-08-12

The draft survived on architecture and failed on almost every specific. Four corrections were load-bearing.

- **The must-fix, found by applying the standing rule from PlanCup.** The draft cited `pty-manager.ts:1103-1108` as evidence for rejecting the elapsed counter, then never ran that input against the accepted design. It applies in full: a phase stamped and never cleared latches exactly as #647's pill did, one layer down. The clearing rule at `markReady` is now mandatory, and the client freshness gate is demoted to defence in depth. **This is the second time that rule has caught a defect the reviewers had already approved.**
- **The test-lock argument was simply wrong.** `parse-status-line.test.ts:61-64` asserts `parseStatusLine` extracts none of *its own three fields*; it says nothing about the line carrying signal, and this plan proposes a separate module. Worse, the rejected fixture reads `↑` (input tokens) while the derive keys on `↓` (output tokens) — a different sub-field. The blocker was overstated; the signal-class argument replaces it.
- **The plumbing list had a wrong item and a trap.** `server.ts:1050` is the *global* broadcast; the scoped `broadcastToClients` (`ws-hub.ts:74`) exists for exactly this message class. And the tempting shortcut — riding `onStatusChange`, which is already relayed across the pty-host boundary — routes a cosmetic field through `recordStatus`, which runs its update statement with no same-status guard: ~3 durable SQLite writes/second/session, plus APNs and push handlers. Rejected explicitly so nobody rediscovers it as a saving.
- **Part B's "add a field and render it" was false, and the deletion section described code that does not exist.** PR #647 is `CLOSED` with `mergedAt=null`, so `lib/agentSubStatus.ts`, `getTailLines`, the `useTerminalStream` derive and the four locale keys are all absent from `origin/main` — verified individually. The deletion task is zero, and there is consequently **no ordering conflict with PlanCup**. Meanwhile the real client cost is a three-way cache-semantics conflict (`LiveConversationView.tsx:143` replaces the whole object on the same key `app/_layout.tsx:165` merges into — a live bug today for `effort`/`permissionMode`) plus a clearing contract the plan had not specified.

Process note on how the deletion error survived: an exploration pass that reads a feature branch and a plan written against `main` produce identical-looking file paths. The check that distinguishes them is `git show origin/main:<path>`, not `ls`.

Three further mobile corrections, all verified directly:

- **The `statusSource`/`statusConfidence`/`statusUpdatedAt` trio is streamer-side only** — zero hits anywhere in mobile source. The draft cited it as an existing client-side liveness input; it is not one, and a freshness gate would have depended on a field mobile does not have.
- **There is no time-decay precedent, and the natural home cannot host one.** `sessionPresentation.ts` is pure, so it cannot decay without a tick source. The app's actual idiom is `processLiveness === 'gone'` — the server decides liveness and says so. The plan now follows that instead of inventing decay, which also removes the second field.
- **`colorForToken` is module-private**, not a shared helper, and both unions it bridges are closed at five values. A phase-specific colour is a ~20-file change across 17 theme objects. Recorded so nobody discovers it mid-implementation.

**Citation audit.** Line-anchor drift has now occurred twice, so every `path:line` reference in both plans was extracted and machine-checked against the cited file. Three errors found and fixed: `pty-manager.ts:165-176` → `:42-43` for the geometry constants (`:165-176` is `createScreen()`'s body — the same right-quote-wrong-anchor slip corrected in PlanCup), `turnBusy` `:358` → `:362`, and the stale-`provider` effect deps `useTerminalStream.ts:182` → `:291`. Re-run `scratchpad/audit-citations.sh` before merge.

### Round 2 — both reviewers, 2026-08-12

Three further defects, and they share a shape distinct from the one the standing rule catches.

- **The mapper would have erased the clearing signal.** `managedToResponse` guards every optional field with `!= null`, which catches null and undefined alike — 19 instances, so a style-matching implementer writes it by default. Explicit-null becomes absence, the merge keeps the old value, and the label latches. This is #647's bug arriving a third way: not through a missing clear, but through the serialiser silently discarding the clear. Fixed with the unconditional-key precedent at `session-store.ts:280`, plus `Phase | null` rather than `Phase?`.
- **A `SessionResponse` frame would have re-rendered the app ~3×/second for an entire turn.** `elapsedMs` recomputes `new Date()` on every call for a live session (`session-store.ts:277`), so every phase frame differs from the last regardless of the phase, and mobile's spread produces a fresh object identity each time. Replaced with a bespoke `session_phase` frame, matching what the scoped path's existing tenants already do.
- **Absence must never carry meaning.** Always emit the field, `null` when there is no phase. An "absent = unknown, null = cleared" distinction is a third state that reintroduces the same failure.

**The pattern worth keeping.** All three are the accepted design *inheriting a hazard from machinery it reused* — the status funnel's unconditional DB writes, the mapper's null-dropping idiom, the response builder's recomputed `elapsedMs`. The standing rule from PlanCup catches a different kind (an input used against a rejected option but never the accepted one). This kind needs its own question:

> **What does the thing I am reusing already do on every call?**

Both questions belong in the review checklist for anything that rides existing plumbing at high frequency.

### Round 3 — mobile gate correction and the broadcast-path answer, 2026-08-12

- **The gate moved from raw `status` to `presentation.live`.** `deriveSessionPresentation` has branches that never consult `status` — `external_live` keys off `ownership` + `processLiveness`, `stale` off `processLiveness === 'gone'` — and `status` is a loose `string` by design. A raw-`status` gate could therefore render a phase indicator beside a badge reading "Idle" or "External". Gating on `presentation.live`, which the badge already uses for its `LiveDot`, makes that structurally impossible and follows the codebase's stated rule at `SessionCard.tsx:79-82`: one answer for liveness, not a third derivation.
- **`SessionPresentationInput` is standalone**, enumerating eleven fields rather than deriving from `Session`, so the field must be added there too. Adding it to `Session` alone would leave the derive unable to see it.
- **The staleness worry was unfounded** and the reasoning is worth keeping: `status` and `subStatus` travel inside the same object through all three cache paths, so they update atomically and cannot disagree. A timestamp and a status can drift apart; two fields of one object cannot.
- **The broadcast-path question resolved in favour of the existing ordering.** `session_update` carries `lifecycle` and `ownership` unconditionally — the two fields the mislabelling argument needed — and `processLiveness` has a single assignment site hard-coded to `"alive"`, so `"gone"` is never emitted. The cache replace is robustness work, not a live defect.

**Both reviewers have signed off on PlanIndicator.**
