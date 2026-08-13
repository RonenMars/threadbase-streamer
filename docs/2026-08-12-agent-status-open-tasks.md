# Open tasks — viewport-relative cursor + server-side agent sub-status

Register for the work started 2026-08-12. Plans: [`plans/2026-08-12-viewport-relative-cursor-positioning.md`](./plans/2026-08-12-viewport-relative-cursor-positioning.md) and [`plans/2026-08-12-agent-sub-status-server-side.md`](./plans/2026-08-12-agent-sub-status-server-side.md), both in [#537](https://github.com/RonenMars/threadbase-streamer/pull/537).
Evidence: [`2026-08-12-claude-pty-capture.md`](./2026-08-12-claude-pty-capture.md).

## Done

| What | Where |
|---|---|
| Both plans, five and three review rounds | [streamer#537](https://github.com/RonenMars/threadbase-streamer/pull/537) |
| PlanCup implemented — viewport-relative `H`/`f`/`A`/`B` with clamps | [mobile#654](https://github.com/RonenMars/threadbase-mobile/pull/654) — green, mergeable |
| PTY capture (output-heavy turn, no tool use) | `~/.threadbase/captures/`, README committed |
| PlanIndicator Part A (streamer) | branch `feat/agent-sub-status`, uncommitted |

## Blocked / awaiting a decision

**Merge [mobile#654](https://github.com/RonenMars/threadbase-mobile/pull/654).** 10/10 CI green, `MERGEABLE`, body records verification item 4 as satisfied. Nothing outstanding.

**Second PTY capture — tool-heavy turn.** In progress with `consultant-for-streamer`. The only artifact that can still change anything. Settles, in priority order:
1. `↑` vs `↓` — whether the arrow tracks direction-of-dominance. Decides whether the struck "different sub-field" argument is permanently dead.
2. `hooks…` — needs a turn that actually triggers a hook (a Stop hook is cheapest).
3. The `thinking` state — `WORKING` matching while `TOKENS` does not; sample early in a turn.
4. Whether any deferred #652 sequence (`S`/`T`/`L`/`M`/`A`/`D`/`f`) fires mid-turn.

Until it lands, **both plans rest on one output-dominated turn with no tool use**, and that qualifier belongs on every citation.

## PlanIndicator — remaining work

### Part A (streamer) — branch `feat/agent-sub-status`, not yet a PR

Complete and verified: `AgentPhase` union, `subStatus` on both types, unconditional-key serialisation, `onPhaseChange` callback, clear at `markReady`, deduping `setPhase`, derive wired into the existing scrape pass, scoped `session_phase` frame, pty-host event + protocol v3, compatibility doc.
`tsc` clean, 21 tests, contract tests verified against deliberately-broken variants.

Committed as `0ea09bc`, pushed, **deliberately not a PR** — four verification gaps remain, tracked in [streamer#541](https://github.com/RonenMars/threadbase-streamer/issues/541):

- [ ] Integration test through a fake PTY, mirroring `__tests__/session-status-line.test.ts:54`.
- [ ] Assert the scrape pass stays non-fatal — a throw inside `detectLivePrompts` is swallowed into a `warn` at both call sites, so a regression there is silent.
- [ ] Direct `setPhase` / `markReady` unit tests — the change-guard and the turn-end clear, currently covered only indirectly.
- [ ] Full-suite run.

### Part A2 (streamer) — the Claude derive. **Blocked on capture 2.**

`parseAgentPhase`'s Claude branch deliberately returns `null`. Reporting no phase is the correct pre-feature behaviour; a guessed phase is worse than none.
Do not write it until the marker grammar is re-verified — and reuse `terminalChrome`'s grammar rather than re-deriving glyph classes, which is how #647 drifted.

### Part B (mobile) — [mobile#653](https://github.com/RonenMars/threadbase-mobile/issues/653). **Blocked on Part A shipping.**

Not "add a field and render it". Ordered by risk:

1. ~~Clearing contract~~ — resolved in Part A (always-emit, explicit `null`).
2. Cache-handler reconciliation — [mobile#655](https://github.com/RonenMars/threadbase-mobile/issues/655), independent, see below.
3. Add `subStatus` to `types/api.ts` **and** to `SessionPresentationInput` (`lib/sessionPresentation.ts:58-72`) — that type is standalone, not derived from `Session`, so adding it in one place leaves the derive blind.
4. Gate on `presentation.live`, **not** raw `status` — `deriveSessionPresentation` has branches that never consult `status`, so a raw gate can render a phase beside a badge reading "Idle" or "External".
5. Render via the existing colour token if possible; a phase-specific colour is ~20 files across 17 theme objects. Never a hardcoded hex.
6. Question-card suppression — copy `ThinkingBubble.tsx:107-134`, which covers both the structured and PTY-scraped gates.
7. No client-side time decay. The app's idiom is `processLiveness === 'gone'`: the server decides liveness and says so.

Tree mode (`TreeRow.tsx:63`) is deliberately out of scope.

## Filed, unstarted

| Issue | Summary |
|---|---|
| [mobile#655](https://github.com/RonenMars/threadbase-mobile/issues/655) | `LiveConversationView.tsx:143` replaces the whole session object where two other writers merge, wiping REST-only fields while mounted. Pre-existing; P2 (badge cannot be mislabelled — `lifecycle`/`ownership` are always on the frame). Worth landing before Part B. |
| [mobile#656](https://github.com/RonenMars/threadbase-mobile/issues/656) | `processLiveness: 'gone'` is never emitted by the streamer, so three mobile production paths are unreachable — including the whole `stale` branch. Open question: whether a vanished external session lingers in the eager cache. Turns on whether React Query's focus manager is wired to `AppState`. |
| [streamer#539](https://github.com/RonenMars/threadbase-streamer/issues/539) | `CODEX_BUSY_STATUS_RE`'s `\b` does not stop a path from false-hitting; a Codex session under a dir named `Working`/`Starting` never reads as ready. |
| [streamer#541](https://github.com/RonenMars/threadbase-streamer/issues/541) | The four verification gaps in Part A, above. Blocks its PR. |
| [mobile#668](https://github.com/RonenMars/threadbase-mobile/issues/668) | The deferred `VirtualTerminal` CSI family, filed as one issue because the capture shows none of it is reachable mid-turn. P3, unblocked only by a tool-heavy capture. |
| [mobile#669](https://github.com/RonenMars/threadbase-mobile/issues/669) | `useTerminalStream`'s WS effect omits `provider` from its deps, so live frames are filtered by a stale provider's chrome rules. Independent of #647, which is why it survived that PR's abandonment. |

**The #652 deferred family is uniformly downgraded, not reordered** — [mobile#668](https://github.com/RonenMars/threadbase-mobile/issues/668). The capture shows `S`/`T`/`L`/`M`/`A`/`D`/`f` never emitted and `r`/`J`/`c`/`ESC7`/`ESC8` firing once at startup. Nothing in it is reachable mid-turn. Only capture 2 can change that.

## Deliberately not filed

- **Putting PTY geometry on the wire.** The follow-up is *conditional*, not scheduled: whoever adds resize adds the wire field in the same change, which is the policy `src/pty-host/protocol.ts:38-41` already states. Filing it would create a TODO nobody actions for a value that cannot currently vary.
- **Housekeeping from the capture session** — `~/dev/pty-capture-tmp/.remember/` and `~/.claude/projects/-Users-ronenmars-dev-pty-capture-tmp/`. Conversation history, safe to delete, not repo work.
- **The stale `tb-mobile-worktrees/feat-agent-sub-status` worktree** at the closed #647 branch (`0a58200c`). Do not reuse it; it carries the client-side implementation this work replaces.

## Method notes earned here

Four defects were caught *after* sign-off. All four came from measurement, not from reading. Both rules below are in the plans and were each violated by the person who had just written them down.

**Run the test that killed the thing you are replacing, before you propose the replacement.**
Stated as a construction practice, not a review one — the failure happens at proposal time. Three successive attempts to promote an item out of the deferred queue (`2J`, `CSI r`, `ESC7`/`ESC8`) were the same artifact relabelled, each proposed by someone who had written the disqualifying caveat into the same message. *Stating a caveat is not applying it.*

**Ask per statistic whether it is sensitive to how the file was assembled.**
The answer differs between statistics on one line of evidence: frequencies were inflated by snapshot duplication, while the maximum and the distinct set were exact. Over-correcting into a blanket "magnitude is unreliable" nearly discarded `max = 40`, the one figure the constant rests on. **Under-trusting is the quieter failure** — it never yields a wrong answer, it just discards a right one and nobody goes back to check.

**Hand disagreements over as evidence, not conclusions.** Offsets and per-snapshot counts can be re-run by the recipient; an unfalsifiable claim can only be accepted or rejected. That is also what makes a claim cheap to test against yourself.

**A zero is evidence of absence only if the same command returns non-zero on a file you know contains a match.** Five distinct ways to produce a clean-looking zero were hit for real here; they are catalogued in the capture README.
