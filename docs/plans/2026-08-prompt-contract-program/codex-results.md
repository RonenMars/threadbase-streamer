# Executive Decision

**NO-GO on implementing Track B from `FINAL-PLAN.md` as written.**

**GO on a smaller, coherent project:**

1. Fix the current safety, privacy, and correctness defects.
2. Introduce one scoped, versioned, provider-neutral prompt contract on top of the existing PTY producers.
3. Keep PTY as the default session transport.
4. Treat structured transport as a separately gated, per-provider follow-up.
5. Never combine a PTY and structured control client for the same Codex session.
6. Do not migrate active sessions between transports.
7. Preserve the PTY experience for existing and externally originated sessions until structured resume/return behavior is empirically proven.

The resulting architecture is hybrid at the system level but exclusive per session:

```text
PTY session ───────────────┐
  screen/JSONL producer    ├── provider-neutral prompt contract ── mobile cards
structured session ────────┘
  protocol producer

PTY session        → existing terminal + conversation surfaces
structured session → structured activity view, if and when approved
```

The core project should be defined as:

> Safe, scoped interactive prompts across streamer and mobile, with a transport-neutral contract and no commitment yet to replacing PTY transport.

This delivers meaningful value without turning question handling into an uncontrolled transport and UI rewrite.

Evidence terminology below:

- **PROVEN IN CURRENT CODE** — verified in the current repositories.
- **PROVEN BY EXISTING LIVE CAPTURE** — established by the recorded probes; I did not rerun them.
- **DOCUMENTED / TYPED** — version-matched declarations or documentation, not wire behavior.
- **INFERRED** — follows from current evidence but was not directly executed.
- **UNPROVEN** — requires an experiment.
- **PRODUCT PREFERENCE** — a value decision rather than a technical fact.

# Current-State Verification

## Repository snapshots

| Repository | Branch / HEAD | Status | Research baseline comparison |
|---|---|---|---|
| `tb-streamer` | `main` at `fd995632e5c9c7d56b29a4c5d677501e5610520f` (`v1.69.1`) | Clean; one commit behind `origin/main`, an unrelated Homebrew plan | Baseline `c6fd4406` is an ancestor. No prompt/transport production path has materially changed. |
| `tb-mobile` | `main` at `63fa42c99be0edc9724662c84684fd47c4cea0ff` | Clean and synchronized with `origin/main` | Baseline `c8a02978` is an ancestor. Subsequent production changes are predominantly i18n/RTL; prompt architecture is unchanged. |

Both repositories remained clean and unchanged. I ran no tests, builds, applications, captures, or experiments because this review was strictly read-only and those operations could write.

The research used Claude Code `2.1.239`/`2.1.241` and Codex `0.149.0` ([research record:3–5](</Users/ronenmars/dev/ai-tools/docs/ai-questions-planning-and-research/2-researchers-feature-research-record.md:3>)). Current streamer TUI fixtures claim only Claude `2.1.214` and Codex `0.140.0-alpha.19` as captured versions ([providerHealth.ts:18–23](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/services/providers/providerHealth.ts:18>)). The repositories do not pin users’ installed CLIs. Structured adoption therefore needs its own exact-version eligibility matrix.

## Streamer architecture

**PROVEN IN CURRENT CODE:**

- `SessionRunner` is provider-neutral in name but PTY-shaped in behavior. It requires raw input, raw keys, terminal output, output lines, and input history ([types.ts:751–778](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/types.ts:751>)).
- `LiveSessionManager` selects `PTYManager` for Claude and `CodexPtyRunner` for Codex. There is no structured-protocol runner.
- Claude prompt detection combines:
  - screen scraping for permission gates;
  - screen and JSONL detection for `AskUserQuestion`;
  - OSC-777 fallback;
  - shell-prompt detection.
- Codex gates are synthesized from TUI screen patterns. All Codex prompt-like interactions currently travel as `permission`, not `question`.
- `/input` accepts either semantic text or arbitrary key bytes and has no open-prompt arbitration before calling the runner ([sessions.handlers.ts:933–1020](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/api/handlers/sessions.handlers.ts:933>)).
- Question answers and permission answers ultimately become PTY keystrokes.
- `answersToKeystrokes` remains explicitly single-select v1, assumes cursor index zero, ignores additional multi-select answers, and throws on any missing question ([answersToKeystrokes.ts:16–33](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/services/questions/answersToKeystrokes.ts:16>)).
- The bare missing-answer error is not converted into a typed response by `resolveAnswer`, so it reaches the handler as HTTP 500 ([resolveAnswer.ts:8–22](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/services/questions/resolveAnswer.ts:8>)).
- Permission answer freshness always calls the Claude screen scraper. That is invalid for synthesized Codex gates and explains the deterministic Codex 409 ([sessions.handlers.ts:1177–1216](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/api/handlers/sessions.handlers.ts:1177>)).
- Permission identity is content-derived and explicitly cannot distinguish two consecutive identical gates ([detectPermissionGate.ts:69–85](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/services/questions/detectPermissionGate.ts:69>)). Question screen identity is similarly content-derived.
- Terminal output, user messages, and phase events are subscriber-scoped, but `question`, `permission`, and cancellation events use the global WebSocket broadcast. Every authenticated connected client receives them, whether subscribed to that session or not ([server-wiring.ts:314–375](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/server-wiring.ts:314>), [ws-hub.ts:49–68](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/ws-hub.ts:49>)).
- Subscribe replay exists for pending prompts, but there is no unified snapshot version or prompt sequence ([server-wiring.ts:689–755](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/server-wiring.ts:689>)).
- Transcript watchers are independent of PTY output. They follow Claude JSONL and Codex rollout files and supply conversation history.
- Externally originated Claude sessions are observe-only until “adopt.” Adoption sends `SIGTERM`, waits for the user’s original process to exit, and starts a new `claude --resume` PTY ([sessions.handlers.ts:1478–1590](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/api/handlers/sessions.handlers.ts:1478>)). The original terminal process cannot continue afterward.
- Codex resume detects an open rollout writer and refuses with `CONVERSATION_BUSY` / `CODEX_SESSION_ACTIVE`; `force` cannot bypass the provider lock, and fork is the recovery path ([sessions.handlers.ts:137–166](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/api/handlers/sessions.handlers.ts:137>), [sessions.handlers.ts:776–806](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/api/handlers/sessions.handlers.ts:776>)).
- There is no current `can_use_tool`, `request_user_dialog`, `requestUserInput`, `supportedDialogKinds`, or app-server integration.
- Mobile calls `/queue`, `/queue/:id`, and `/plan-response`; streamer registers none of them. This remains a real cross-repository contract mismatch, but it is not a prerequisite for prompt safety.

### Newly material logging finding

The proposed `renderedTail` removal is insufficient.

**PROVEN IN CURRENT CODE:** `digestBytes` does not digest or hash anything. It returns up to 200 characters of reversible plaintext ([pty-shared.ts:30–40](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/pty-shared.ts:30>)). Claude and Codex log:

- submitted text;
- raw keys;
- Claude PTY output chunks;
- Codex inputs.

These appear in content-bearing info logs as well as structured log metadata ([pty-manager.ts:436–555](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/pty-manager.ts:436>), [pty-manager.ts:769–797](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/pty-manager.ts:769>), [codex-pty-runner.ts:365–487](</Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/codex-pty-runner.ts:365>)). Removing only `renderedTail` would leave secrets exposed.

## Mobile architecture

**PROVEN IN CURRENT CODE:**

- The WebSocket union knows `question` and `permission`, but has no provider-neutral `prompt` and no `session_phase` frame ([ws-client.ts:17–76](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/services/ws-client.ts:17>)).
- `useTerminalStream` is the main live-session data path. It consumes PTY chunks, reconstructs a virtual terminal, replays terminal history, and falls back to `/output` after two seconds ([useTerminalStream.ts:27–329](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/hooks/useTerminalStream.ts:27>)).
- “Raw” fallback is not raw PTY bytes or ANSI. `getRawLines()` still runs the home-grown VT parser and drops empty and border rows ([virtual-terminal.ts:115–145](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/services/virtual-terminal.ts:115>)).
- `renderConfidence` measures escape-parser stress, not transcript completeness, backend status confidence, or source authority ([renderConfidence.ts:1–67](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/lib/renderConfidence.ts:1>)).
- `LiveConversationView` is not PTY-free. It uses transcript history for bubbles but also uses `useTerminalStream` for fallback, thinking output, prompt fallback, and live activity.
- `ThinkingBubble` and `TerminalOutput` both scrape recent terminal lines as a second question detector.
- `QuestionCard` renders only `block.questions[0]`, uses radio buttons, and ignores the modeled `multiSelect` field ([QuestionCard.tsx:24–52](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/components/terminal/QuestionCard.tsx:24>)).
- There is no free-text answer input for “Type something.”
- `useActiveQuestion` stores one active card, uses content-derived permission identity, and keeps answered cards as 30-second ghosts.
- `/input` retries any `NetworkError` up to twice. There is no `prompt_pending` classification, so a future 409 would be retried unless mobile changes with it ([useSessionActions.ts:18–50](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/hooks/useSessionActions.ts:18>)).
- The composer already preserves its draft on mutation failure, which is useful for the proposed arbitration behavior.
- `RawKeyBar.tsx` remains in the repository but has no consumer. The research’s dead-code conclusion is current.
- Card-independent raw-key behavior still exists: the session-level “Stop Response” action sends Escape directly ([app/session/[id].tsx:523–573](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/app/session/[id].tsx:523>)).
- Mobile consumes `session.subStatus` from session snapshots but does not consume the streamer’s live `session_phase` frame. Live phase changes can therefore lag until another session update or refetch.
- A live managed session with `ptyAttached: false` is routed to `DiscoveredSessionScreen`, whose “Overtake” button calls `/adopt` ([app/session/[id].tsx:286–345](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/app/session/[id].tsx:286>), [app/session/[id].tsx:717–725](</Users/ronenmars/Desktop/dev/ai-tools/tb-mobile/app/session/[id].tsx:717>)). Reusing `ptyAttached: false` for a structured managed session would expose a destructive, semantically wrong action to released clients.

## Actual dependency surface

| Data or action | Current authority | Mobile dependency |
|---|---|---|
| Live terminal and startup prompts | PTY bytes | `useTerminalStream`, `TerminalView`, fallback logic |
| Conversation bubbles/history | JSONL/rollout watcher | `LiveConversationView`, conversation hooks |
| Claude question card | PTY screen first, JSONL later | `question` WS event plus local PTY fallback |
| Claude permission card | PTY screen/OSC | `permission` WS event |
| Codex cards | Synthesized TUI screen state | `permission` WS event |
| Answers | Pending maps plus screen freshness | `/answer`, `/permission/answer`, then keystrokes |
| Ordinary text | `/input` directly to PTY | Composer |
| Stop response | Raw Escape | `/input {keys}` |
| Status | REST/session updates; separate phase frame | Mobile ignores separate live phase frame |
| External sessions | JSONL observation; Claude-only destructive adoption | Conversation view or overtake flow |

The current load-bearing assumption is not simply “mobile needs a terminal.” It is:

> PTY presence currently encodes transport, ownership, liveness, raw rendering, readiness, prompt detection, fallback confidence, interruption, and eligibility for mobile control.

That coupling must be separated before a no-PTY managed session can exist safely.

# Research Consistency / Contradictions

The research is strongest where it distinguishes live capture from types:

- **PROVEN BY EXISTING LIVE CAPTURE:** text submitted while a card is open can commit the highlighted option and cause a real side effect.
- **PROVEN BY EXISTING LIVE CAPTURE:** Codex `app-server` `requestUserInput`, multi-question shape, rollout writing, and the single-writer failure at version `0.149.0`.
- **DOCUMENTED / TYPED:** Claude Code `2.1.241` control frames, `can_use_tool`, opaque `request_user_dialog`, `supportedDialogKinds`, and dialog expiry. The follow-up correctly says none was wire-captured ([FOLLOWUP-PLAN:11–22](</Users/ronenmars/dev/ai-tools/docs/ai-questions-planning-and-research/FOLLOWUP-PLAN-claude-code-control-protocol.md:11>)).
- **PROVEN IN CURRENT CODE:** prompt scoping, Codex freshness, multi-question 500, dead `RawKeyBar`, PTY dependencies, and missing endpoints remain as researched.

The most important corrections are:

| Earlier proposal | Later position | Current code/evidence | My decision |
|---|---|---|---|
| Harden the PTY keystroke builder, tab strip, and form scraper | `FINAL-PLAN` cancels it | `answersToKeystrokes` is still unsafe single-select v1 | Do not build v2. Add fail-safe unsupported handling; use structured forms only after transport proof. |
| Treat multi-select/free text as “dissolved” by structured protocols | Structured paths model them natively | Current Threadbase still cannot answer them; Claude structured shape is unproven | Feasibility was proven only for Codex protocol, not fixed in the product. |
| Fix trust-card title | Later dropped as cosmetic | Wrong title remains | Drop it from this project. |
| `RawKeyBar` is a live escape hatch | Later disproven | File is dead; session-level Escape still exists elsewhere | Delete only opportunistically; do not count deletion as delivered value. |
| Remove only `renderedTail` | Retained as Track A | Other default logs contain plaintext input/output | Broaden to a content-free logging policy. |
| Codex freshness is a three-line provider bypass | Retained as Track A | Bypass restores answers, but content-derived identity cannot distinguish identical consecutive gates | Add a server-owned per-instance gate/prompt ID; do not rely only on `contentKey`. |
| Mobile must drop legacy `question`/`permission` in the prompt-model change | Later plan emphasizes released-client compatibility | Released mobile cannot be forced to upgrade | Reject. Dual-stack until a measured client floor is reached. |
| Structured protocol can preserve raw spawned-command control and is “strictly better” | Research record later weakened this | `command/exec/write` addresses a client-created process ID; current mobile also has card-independent Escape | Treat agent-spawned interactive stdin, resize, and interrupt as unproven and gate them. |
| Structured transport costs only terminal view and confidence fallback | `FINAL-PLAN` retains this | Readiness, startup visibility, shell prompts, copy-all, Stop Response, thinking, prompt fallback, and managed-session routing are PTY-dependent | Understated. Use a complete capability inventory before adoption. |
| Codex first because captured | Claude first because primary provider | Codex questions require an under-development, default-off flag; Claude is wire-unproven | Decide after provider gates. Internal proof order and production order need not match. |
| Gate 0a/0b cover transport feasibility | Research record calls out the missing terminal-origin question | Neither tests terminal → control protocol → same terminal | Expand Gate 0 before adoption. |
| “The wall is identical for both providers” | One display decision | Claude’s actual event corpus is uncaptured | The product direction can be shared, but implementation equivalence is unproven. |
| Structured implementation permits detector deletion | Delete per provider when producer is proven | PTY/external sessions would still depend on detectors | Retire only per transport and provider after explicit usage and compatibility criteria. |
| `isBlocking` is directly useful as product behavior | Codex field observed; Claude has related configurable timeout | Captured value contradicted prompt prose; Claude type models a different axis | Normalize it narrowly as provider waiting semantics, never as automatic composer policy. |

I accept the reasoning record’s clean scope cut over the broader implication of `FINAL-PLAN`: question work can ship on PTY, while transport adoption forces question work but not vice versa ([research record:177–190](</Users/ronenmars/dev/ai-tools/docs/ai-questions-planning-and-research/2-researchers-feature-research-record.md:177>)).

I retain the execution constraints from `RUN-PLAN`: manual commit approval, serial merges, streamer before mobile, non-concurrent streamer test execution, and independent verification ([RUN-PLAN:8–34](</Users/ronenmars/dev/ai-tools/docs/ai-questions-planning-and-research/RUN-PLAN-distributed-execution.md:8>)). Its older feature waves are superseded.

# Open Dilemmas

| ID / classification | Question and why it matters | Evidence and unknown | Recommendation / confidence | Smallest experiment and exact rule |
|---|---|---|---|---|
| D1 — **DECIDE NOW** | What is this project? Without a boundary, prompt fixes expand into transport/UI replacement. | **CURRENT:** question work is separable from transport. | Core = safety plus prompt contract on PTY. Structured transport is follow-up. **High.** | No experiment. Reject any core task that requires replacing session transport. |
| D2 — **DECIDE NOW** | PTY, structured, or hybrid? | **CAPTURE:** Codex allows one writer. **UNPROVEN:** Claude writer model. | Hybrid across sessions; exactly one transport per session. PTY remains default. **High.** | Claude concurrency gate may refine provider behavior, but never build “structured prompts beside a Codex PTY.” |
| D3 — **DECIDE AFTER A SPIKE** | Is Claude’s control protocol viable for complete Threadbase sessions? | **TYPED:** protocol exists. **UNPROVEN:** payloads, history, full event corpus, writer behavior. | Do not select a Claude runner yet. **High.** | Expanded Claude capture. Pass only if identity/history, prompts, lifecycle, reconnect, and required controls all pass. |
| D4 — **DECIDE AFTER A SPIKE** | Is Codex `requestUserInput` production-safe? | **CAPTURE:** works on `0.149.0`, but behind `underDevelopment`, default-off flag. | Treat as internal-experiment capability, not a production contract. **High.** | Recapture the intended supported version and verify stable negotiation without hidden configuration. Default-off/unsupported in target builds means no production rollout. |
| D5 — **DECIDE AFTER A SPIKE** | Can Claude go terminal → control protocol → same terminal/history? | Current `/adopt` kills the original terminal; Gate 0a only tests control-client concurrency and history. | This is mandatory before applying structured transport to external sessions. **High.** | Start in a real terminal with exact UUID/sentinels; attach control client; answer; detach; resume/use the same terminal/session. Concurrent success = pass. Clean exclusive handoff = conditional product decision. Fork, corruption, or inability to return = fail. |
| D6 — **DECIDE AFTER A SPIKE** | Can Codex do the same terminal/control/terminal sequence? | App-server-to-app-server lock is captured; terminal-to-app-server behavior is not. | Test separately; do not extrapolate from Claude. **High.** | Same sequence against the exact rollout ID. A refusal that leaves the terminal intact proves safety, not remote control. Only same-rollout reversible continuity passes. |
| D7 — **PRODUCT DECISION** | What replaces the terminal for structured sessions? | **CURRENT:** terminal carries real capabilities. **UNPROVEN:** complete structured event corpus. | Choose a structured activity view, not no-terminal production UX or synthesized terminal. **Medium.** | Capture corpus, then fixture-backed prototype. Approve only if users can inspect messages, reasoning state, tools, output, errors, prompts, stop state, and history without false fidelity. |
| D8 — **DECIDE AFTER A SPIKE** | Which provider adopts first? | Codex has stronger capture but unstable/default-off question capability; Claude has stronger product value but no capture. | Do not bind both to one milestone. Prefer Claude for production if it passes; Codex may be the earlier internal adapter. **Medium.** | Use provider scorecard. First production provider must pass stability, identity, continuity, event completeness, rollback, and client-compatibility gates. |
| D9 — **DECIDE NOW** | How are prompt instances and answers identified? | Current permission identity is content-derived; Codex structured questions use question IDs. | Server-owned instance ID, revision, per-question IDs, option IDs, atomic answer, idempotency key. **High.** | Contract tests must show an answer to prompt A cannot settle identical prompt B and duplicate retries settle once. |
| D10 — **DECIDE NOW** | What happens to PTY multi-question, multi-select, and free text? | Current product cannot answer them safely. Existing TUI probes only prove CLI mechanics. | Do not add a new scraper/replayer. Return typed `unsupported_prompt_shape`/`incomplete_answer`, write zero bytes, and offer safe dismissal/local-terminal guidance. **High.** | Regression tests with partial/multi answers. Any PTY bytes written on rejection fails. |
| D11 — **DECIDE AFTER A SPIKE** | What do non-blocking prompts and deadlines mean? | Codex exposed `isBlocking:false`; Claude types expose dialog and question timeouts, not necessarily the same semantic axis. | Contract carries tri-state answer requirement and nullable expiry; composer policy remains independent. **Medium.** | Capture agent progress before and after unanswered prompts and expiry. Disable composer only when provider/session policy expressly requires it. |
| D12 — **DECIDE NOW** | How are secrets and prompt privacy handled? | Current logs and global broadcasts expose content. Scraped prompts cannot honestly infer secrecy. | Content-free default logs, per-input secret tri-state, subscriber scoping, no answer rebroadcast. **High.** | Log-capture and two-client tests. Any prompt/answer text or cross-session card delivery fails. |
| D13 — **DECIDE NOW** | How do reconnect and multiple clients settle a prompt? | Current singleton card state, global maps, and replay lack revisions/sequence. | Authoritative server registry; multiple open prompts allowed; first valid answer wins; stable terminal error for later answers; snapshot plus sequence on subscribe. **High.** | Two-client answer race and reconnect-at-every-transition tests. Exactly one provider response must occur. |
| D14 — **DECIDE NOW** | How do released clients coexist with structured sessions? | Current mobile treats managed no-PTY sessions as “Overtake.” | Immutable `transport` field plus per-client capability negotiation; structured starts only for explicitly capable clients. **High.** | Old-mobile/new-streamer matrix. If an old client can start, adopt, or mislabel a structured session, rollout fails. |
| D15 — **DECIDE AFTER A SPIKE** | Are interrupt and agent-spawned interactive commands preserved? | Final plan’s Codex claim uses client-created command IDs; mobile currently sends session-level Escape. | Do not claim parity yet. **High.** | Trigger an agent-spawned interactive process, send stdin/resize, interrupt the turn, reconnect, and verify external effects. Missing required control means structured sessions remain internal-only or product-limited. |
| D16 — **DECIDE NOW** | When may detectors be retired? | Existing PTY and external paths still require them. | Only after provider/transport-specific adoption and a stable-release evidence window. **High.** | Apply the retirement checklist under Important Decisions. Failing any item means retain the detector for that path. |

# Important Decisions

## A. PTY versus structured protocols

My decision is:

- **Remain PTY-first for existing behavior and external sessions.**
- **Adopt a provider-neutral prompt contract immediately, but initially feed it from current PTY/JSONL producers.**
- **Treat structured protocols as alternative complete session transports, never as prompt-only sidecars to a PTY session.**
- **Permit PTY and structured sessions to coexist in Threadbase.**
- **Make transport immutable for the lifetime of a session.**

This rejects three tempting but unsafe interpretations:

1. “Structured prompts only” cannot mean opening a Codex app-server client alongside the existing Codex TUI. The captured single-writer constraint forbids it.
2. “Hybrid” cannot mean two control writers for one conversation.
3. A feature-flag rollback cannot silently convert an active structured session into PTY. It can only stop creating new structured sessions unless reversible handoff has been proven.

## B. Provider-neutral prompt contract

The abstraction boundary is correct. Streamer should own provider adaptation; mobile should never understand Claude control frames, Codex JSON-RPC IDs, TUI cursor coordinates, or provider answer codes.

The proposed contract needs refinement.

### Public contract fields

| Field | Decision |
|---|---|
| `schemaVersion` | Required. Enables additive evolution and explicit compatibility. |
| `sessionId` | Required. Delivery must additionally be session-subscriber scoped. |
| `promptId` | Required, opaque, server-owned, unique per occurrence. Never content-derived. |
| `revision` | Required. Increment on meaningful update; answers echo it. |
| `state` | `open`, `updated`, `resolved`, `cancelled`, `expired`, `unavailable`. Include terminal reason. |
| `intent` | Normalized `approval` or `question`; do not expose provider frame names. |
| `title`, `message`, `detail` | Sanitized presentation fields; all optional except one meaningful primary string. |
| `questions[]` | Each gets a stable `questionId`, text/header, explicit input mode, and options. |
| `inputMode` | `single`, `multi`, or `text`. Avoid a provider-derived `form` kind; a form is multiple questions. |
| `options[]` | Each gets an opaque `optionId`, label, optional description/preview. Never answer by position alone. |
| `allowOther` | Normalized capability, not a fake tappable option. |
| secret state | Per question/input: `true`, `false`, or `unknown`. PTY-scraped producers report `unknown`. |
| answer requirement | Prefer `answerRequirement: blocking \| non_blocking \| unknown` over ambiguous `isBlocking`. It describes provider waiting behavior only. |
| `expiresAt` | Nullable absolute timestamp from authoritative provider behavior. Do not invent one for PTY prompts. |
| provenance | `provider`, `screen`, `transcript`, or `synthetic`, plus `authoritative`/`inferred`. This is needed for fallback and diagnostics. |

The server should model multiple open prompts even if mobile initially presents one at a time. A captured non-blocking prompt makes a singleton protocol an unjustified constraint.

### Answer shape

Answers should target IDs, not positions or question text:

```json
{
  "promptId": "opaque-instance-id",
  "revision": 2,
  "responses": [
    {
      "questionId": "language",
      "optionIds": ["typescript"]
    }
  ],
  "idempotencyKey": "client-generated-retry-key"
}
```

Text answers use `text`; multi-select uses multiple option IDs. The answer is atomic across the prompt.

### Provider-specific data kept behind the producer

- Claude request IDs and opaque dialog payload.
- Codex JSON-RPC IDs and rollout item IDs.
- `refusalId`, `decision_reason_type`, raw decision text, `updatedPermissions`, and persistent-approval codes.
- TUI cursor, numeric rows, literal `answerKeys`, and screen content keys.
- Provider error frames and raw payloads.

If mobile needs approve-once versus approve-for-session, expose those as normalized options with opaque option IDs. It should not echo provider protocol codes.

`refusalId` does not belong in the cross-provider contract merely because a provider requires it on the wire. Streamer can map `promptId` and selected option back to the provider request.

Scoping is not an optional payload field. It is a transport and authorization invariant:

- prompt visibility: subscribed clients with `history:read`;
- answer authority: `session:control`;
- answers and secret values are never broadcast;
- unknown dialog kinds fail closed and are never auto-cancelled as though the user chose cancel.

## C. Track A, item by item

| Item | Still valid / urgent? | Independent of structured transport? | Decision |
|---|---|---|---|
| Composer arbitration | Yes; **critical** | Yes | Ship first. Reject semantic `{input}` while an actionable prompt is open. Do not reject `{keys}` or dedicated answer/cancel routes. Mobile recognizes the exact stable code, does not retry, preserves the draft, and focuses the card. |
| Codex freshness skip | Valid; **high** | Yes | Modify. Provider-aware freshness is required, but a three-line bypass leaves identical-gate staleness. Add a server-owned instance token and require capable mobile to echo it. Retain legacy behavior only as an explicitly temporary compatibility path. |
| Remove `renderedTail` | Valid but incomplete; **critical** | Yes | Replace all content-bearing default PTY/input logs with metadata-only logging. Remove `renderedTail` and the reversible `digestBytes` behavior. Do not hash low-entropy secrets. |
| Delete `RawKeyBar` | Valid cleanup; not urgent | Yes | Fold into a later mobile prompt PR if it still remains dead. No standalone phase or review cycle. |
| Trust-dialog title | Cosmetic | Yes | Drop. |
| Multi-question bare 500 | Omitted from final Track A; **high** | Yes | Add a typed `incomplete_answer` or `unsupported_prompt_shape` response and guarantee zero bytes written. |
| Prompt events broadcast globally | Found in research but omitted from Track A; **high privacy priority** | Yes | Scope all open/update/cancel prompt lifecycle events to session subscribers, with subscribe replay tests. |

These safety changes should ship before structured architecture work. They are not scraper investment.

## D. Gate 0

Gate 0a and Gate 0b are not sufficient for transport adoption.

### Already proven; do not repeat without a version change

For Codex `0.149.0`, existing captures already establish:

- app-server exists and can perform approvals;
- rollout JSONLs continue to be written;
- two app-server writers collide;
- `requestUserInput` works with the exact hidden flag;
- one request can contain multiple questions;
- question IDs, `isSecret`, and `isBlocking` appear on the wire.

Repeating those exact probes against the same version adds little. They must be recertified against the version selected for implementation.

### Expanded Claude gate

The Claude gate must capture:

1. Exact JSONL path, UUID, and append identity—not merely file count.
2. `can_use_tool` allow and deny frames with external side-effect controls.
3. Actual `request_user_dialog` kind and opaque payload.
4. Single, multi, free-text, partial-answer, and unknown-kind behavior.
5. Real expiry and environment override.
6. Complete display corpus:
   - user and assistant deltas;
   - reasoning/thinking;
   - tool start/output/completion;
   - edits;
   - prompts;
   - interrupts;
   - errors;
   - turn/session completion;
   - ordering and sequence behavior.
7. Disconnect, control-client crash, provider-process exit, and reconnect with a pending prompt.
8. Multiple control clients.
9. Agent-spawned interactive command stdin/resize and turn interruption.
10. Terminal-origin continuity.

### Supplemental Codex gate

Gate 0b needs additional proof for:

- terminal-origin continuity;
- complete event corpus and ordering;
- pending-prompt reconnect/crash behavior;
- unknown event/request handling;
- interactive agent-spawned command control;
- stable feature negotiation in the intended production version;
- behavior without the under-development flag;
- rollback/recovery of an active structured session.

### Positive controls

Every probe must record the exact binary version, configuration, session/rollout ID, process IDs, and transcript path.

Controls must include:

- allow and deny external effects;
- known-good and deliberately unsupported dialog kinds;
- before/after transcript sentinel;
- response before expiry versus actual expiry;
- second writer against the exact same identity;
- wrong identity as a negative control;
- terminal usability after a refused structured attachment;
- a deliberately mutated assertion or counterexample proving the harness can fail.

## E. Display architecture

| Option | Decision | Reason |
|---|---|---|
| Structured mobile session view | **Recommend, refined** | The only production option that does not pretend structured events are terminal bytes. |
| No terminal/output surface | **Reject for production** | Removes inspection, diagnostics, raw tool context, and familiar recovery paths. Acceptable only for an internal protocol probe. |
| Synthesized terminal text | **Reject as primary UI** | Creates false fidelity and recreates rendering heuristics over structured data. |
| Transport-specific surfaces sharing common conversation/prompt components | **Recommended architecture** | PTY sessions retain their terminal. Structured sessions get a native activity timeline. |

The structured activity view should provide:

- transcript-backed user and assistant messages;
- explicit reasoning/thinking state where available;
- tool and command cards with start, output, exit, and error states;
- expandable monospace command output;
- typed prompt cards;
- explicit interruption and completion states;
- paginated event-backed scrollback;
- a visible degraded/read-only state when essential events are missing.

Implications:

- **Raw output:** show exactly what the protocol supplies and label it; do not call it raw PTY.
- **ANSI:** sanitize by default. Render supported styling deliberately rather than replaying terminal escapes.
- **Scrollback:** event persistence and pagination replace VT scrollback.
- **Thinking/tool activity:** derive from structured lifecycle frames, not PTY silence or scraped text.
- **Confidence:** base it on schema compatibility, sequence gaps, unknown essential events, and transcript/event parity—not escape-parser counters.
- **Debugging:** content-free diagnostics by default. Raw protocol capture must be explicit, local/time-bounded, and redacted.
- **Existing users:** PTY remains default and unchanged.
- **Migration:** new sessions only. No active-session transport conversion.
- **Unknown event:** preserve the session, show a degraded indicator, and fail closed for unknown actionable prompts.

## F. Provider adoption order

Do not choose the production provider yet.

My decision rule is:

1. An internal Codex adapter may be the earlier engineering pilot because its protocol has already been captured.
2. Claude should be the preferred first production provider if it passes the expanded gate because it is the primary provider and its remote-dialog model appears closer to Threadbase’s product.
3. Codex may ship first only if:
   - the intended CLI version exposes a supported, negotiable capability;
   - the under-development/default-off status is resolved or deliberately accepted for a limited pilot;
   - external continuity, display corpus, and recovery pass.
4. Do not couple the second provider to the first provider’s milestone.

“Proven Codex” currently means one captured version and request family, not a production-ready complete transport.

## G. Detector retirement

A detector may stop running on a provider’s structured path only after all of these are true:

1. The structured adapter is default for eligible new sessions of that provider.
2. The provider version/capability matrix is explicit and enforced.
3. Every actionable prompt currently handled by that detector has a captured structured equivalent or an explicit fail-closed policy.
4. Reconnect, expiry, multiple clients, interruption, and process-failure tests pass.
5. Existing and released mobile compatibility is satisfied.
6. The rollback path has been exercised.
7. At least one stable release window shows no unexplained essential-event or fallback rate.
8. Existing PTY sessions have completed or remain routed through the PTY detector.
9. The external-session strategy no longer requires the detector.

As long as a provider still supports PTY or external sessions, the detector remains for those paths. Full deletion is a later provider-specific milestone, not part of initial structured implementation.

# Missing Decisions

The research did not sufficiently resolve these architecture obligations:

| Missing decision | Recommendation |
|---|---|
| Transport identity | Add immutable `transport: "pty" \| "structured"`; do not overload `ptyAttached`. |
| Capability negotiation | Per connected client/device, not only a process-global server flag. Old clients default to PTY. |
| Feature-flag lifecycle | Per provider, new sessions only, explicit target-version allowlist, kill switch, graduation criteria, and deletion date. |
| Active-session rollback | Never automatic. Disable new starts; recover active sessions only through a provider-specific proven procedure. |
| Prompt cardinality | State must permit multiple outstanding prompts even if UI initially surfaces one. |
| Prompt persistence | Define authoritative behavior across WebSocket disconnect and streamer/provider process death. A persisted stale provider request must not remain answerable. |
| First-answer-wins semantics | Atomic server transition, idempotency, stable `already_resolved` response, and close broadcast. |
| Error taxonomy | Stable machine codes such as `prompt_pending`, `prompt_expired`, `prompt_revision_mismatch`, `already_resolved`, `unsupported_prompt_kind`, and `transport_unsupported`. |
| Unknown prompt kind | Fail closed, never infer an answer, and display a degraded/manual-intervention state. |
| Protocol type ownership | Generate and vendor Codex types for the exact binary; use version-matched Claude SDK declarations; never hand-mirror. |
| Phase/status propagation | Keep the three existing statuses. Add always-serialized prompt state and either consume `session_phase` or propagate phase through the normal session update path. |
| Security boundary | Prompt lifecycle must be subscriber-scoped; answer payloads require control authority; secret inputs must never enter default logs or analytics. |
| Structured session observability | Metadata and sequence health, not raw content logging. |
| External ownership UX | Seamless continuity is ideal; exclusive handoff requires explicit product approval and clear “Take control / Release control” semantics. |
| Released-mobile staged rollout | Dual legacy events and explicit client capability floor until adoption telemetry proves old clients are safely below the support threshold. |

The missing `/queue` and `/plan-response` streamer endpoints are real contract debt, but should be tracked separately unless prompt work directly depends on them.

# Recommended Scope

## Core scope

The smallest coherent deliverable is:

1. Correct the revised safety set:
   - semantic input arbitration;
   - content-free logging;
   - working, instance-safe Codex permission answers;
   - typed rejection of unsupported/incomplete answers;
   - subscriber-scoped prompt lifecycle.
2. Introduce the versioned provider-neutral prompt contract and server-owned prompt state machine.
3. Feed it from existing PTY/screen/JSONL producers without adding new scraper capabilities.
4. Update mobile to consume the new contract while retaining legacy `question` and `permission` support.
5. Add transport and client capability fields, but keep all production starts on PTY.
6. Verify old/new streamer-mobile combinations, reconnect, two-client answers, prompt expiry representation, and zero-byte refusal paths.

Stopping here produces a coherent improvement: safer current sessions, one mobile model, one answer route, proper scoping, and a future transport seam.

## Optional / follow-up scope

- Expanded Claude and Codex structured gates.
- Fixture-backed structured activity-view design.
- One provider’s internal structured pilot.
- Limited production rollout.
- Second provider.
- Rich option previews.
- Structured command console when agent-spawned stdin is proven.
- Protocol-event observability and compatibility dashboards.

## Explicit non-goals

- Rewriting Threadbase around structured protocols.
- `answersToKeystrokes` v2.
- Tab-strip or form scraping.
- New trust-dialog scraping cosmetics.
- Synthesized terminal as the main structured UI.
- In-place migration of active sessions.
- Deleting PTY detectors.
- Using Codex’s under-development question flag as an assumed production contract.
- A standalone `RawKeyBar` cleanup release.
- Fixing unrelated queue/plan endpoint debt.
- Provider parity in the first structured milestone.

## Deferred architectural bets

- First production structured provider.
- Whether exclusive terminal/control handoff is acceptable.
- Full non-blocking-prompt UX.
- Structured interactive command terminal.
- Long-term PTY support horizon.
- Exact detector deletion date.
- Rich HTML/Markdown option rendering.
- Whether externally originated sessions ever default to structured control.

# Phase & Milestone Plan

## Safety Stabilization

- **Goal:** Remove current data-loss, privacy, secret-exposure, and deterministic-answer defects.
- **Milestone:** Existing PTY sessions are materially safer without changing their architecture.
- **Repos:** Streamer first, then mobile.
- **Main work:** revised Track A, instance-safe Codex gate identity, scoped events, typed unsupported answers.
- **Dependencies:** None.
- **Entry criteria:** Acceptance scenarios and stable error codes approved.
- **Exit criteria:** Ordinary text cannot settle a prompt; Codex answers work once; rejected answers write zero bytes; logs contain no content; unsubscribed clients receive no prompts.
- **Verification:** focused regressions, full streamer suite, full mobile suites, before/after live prompt probe, log inspection, two-client scoping test, independent verifier.
- **Rollback:** ordinary code revert. Log redaction may retain metadata counters for diagnosis.
- **Excluded:** prompt envelope migration, new detectors, structured transport.
- **Effort:** 5–9 focused engineering days.
- **Estimate confidence:** Medium-high.

## Prompt Contract Foundation

- **Goal:** Give streamer and mobile one safe, provider-neutral prompt model.
- **Milestone:** Current PTY producers drive the new prompt contract; mobile supports it with legacy fallback.
- **Repos:** Streamer, then mobile.
- **Main work:** schema, prompt registry/state machine, IDs/revisions, atomic answer route, subscriber snapshot/sequence, capability negotiation, mobile cards for supported modes.
- **Dependencies:** Safety error and identity semantics.
- **Entry criteria:** Contract field definitions and compatibility policy approved.
- **Exit criteria:** New mobile/new streamer works; new mobile/old streamer degrades; old mobile/new streamer stays on PTY and remains safe.
- **Verification:** schema fixtures, duplicate/stale answer races, reconnect at every state, multiple prompts, unknown fields/kinds, cross-version matrix, full suites, independent verification.
- **Rollback:** server feature disabled for new-capable clients; legacy events continue. No source transport changes.
- **Excluded:** structured provider runner, display replacement, detector deletion, full PTY multi/free keystroke support.
- **Effort:** 12–20 focused engineering days.
- **Estimate confidence:** Medium.

## Structured Feasibility Gate

This can run in parallel with later Prompt Contract work, but it gates all structured implementation.

- **Goal:** Prove each provider can support Threadbase’s real session requirements.
- **Milestone:** Signed provider scorecards with raw evidence and go/no-go rules.
- **Repos:** No production source changes; disposable harnesses only.
- **Main work:** expanded Claude gate and supplemental Codex gate, including terminal-origin continuity.
- **Dependencies:** Exact target provider versions and evidence protocol.
- **Entry criteria:** Positive/negative controls and required observable list agreed.
- **Exit criteria:** Every question is captured as pass/fail/unknown; no ambiguous “mostly works.”
- **Verification:** independent review of identity, causality, external effects, and raw frames.
- **Rollback:** None; experimental sessions/directories only.
- **Excluded:** production runner code or mobile UI.
- **Effort:** 5–10 focused research days.
- **Estimate confidence:** Medium.

## Conditional Structured Pilot

- **Goal:** Prove one provider end-to-end on new Threadbase-started sessions.
- **Milestone:** Internal users can run a structured session through a native activity view.
- **Repos:** Streamer and mobile.
- **Main work:** new transport-specific runner abstraction, event normalization, activity view, prompt producer, lifecycle/reconnect, capability-gated starts.
- **Dependencies:** Provider gate pass, display product approval, Prompt Contract Foundation complete.
- **Entry criteria:** Provider scorecard passes; exact version allowlisted; UI acceptance criteria approved.
- **Exit criteria:** Complete task corpus, prompt forms, interruption, failures, reconnect, transcript parity, and safe active-session recovery demonstrated.
- **Verification:** full suites, end-to-end fixtures and real sessions, fault injection, old-client matrix, independent verifier.
- **Rollback:** disable new structured starts. Active sessions follow the proven provider recovery path; never auto-convert to PTY.
- **Excluded:** external-session structured adoption, second provider, detector deletion, general release.
- **Effort:** Not responsibly committable before the gate. Conditional planning range: 20–40+ engineering days.
- **Estimate confidence:** Low.

## Limited Provider Rollout

- **Goal:** Establish production evidence without removing fallback.
- **Milestone:** One provider’s eligible new sessions use structured transport for a small cohort.
- **Repos:** Both.
- **Main work:** staged eligibility, metrics, degraded-state UX, operational recovery, version drift handling.
- **Dependencies:** Successful internal pilot and stable provider capability.
- **Entry criteria:** Rollback drill passes; no critical pilot defects; support/runbook ready.
- **Exit criteria:** Stable release window with acceptable start, prompt, disconnect, unknown-event, and recovery rates.
- **Verification:** production telemetry without content, sampled support review, cross-version checks.
- **Rollback:** kill switch for new sessions; PTY remains default for everyone else.
- **Excluded:** second provider and detector removal.
- **Effort:** 5–15 focused engineering days plus observation time.
- **Estimate confidence:** Low.

## Expansion and Retirement

- **Goal:** Add a second provider or retire proven-obsolete paths.
- **Milestone:** Separate provider decision, not automatic parity.
- **Dependencies:** First rollout evidence and provider-specific gate.
- **Entry criteria:** A new approved scope and evidence matrix.
- **Exit criteria:** Provider-specific rollout or detector-retirement checklist passes.
- **Rollback:** Continue PTY/provider-one behavior.
- **Excluded:** Any “while we are here” rewrite.
- **Effort:** Unestimable until the first provider rollout.
- **Estimate confidence:** Low.

# Timeline

## Engineering effort versus elapsed delivery

| Work | Focused engineering/research effort | Reasonable elapsed delivery | Confidence |
|---|---:|---:|---|
| Safety Stabilization | 1–2 engineer-weeks | 2–3 calendar weeks | Medium-high |
| Prompt Contract Foundation | 3–5 engineer-weeks | 4–7 calendar weeks | Medium |
| Structured Feasibility Gate | 1–2 researcher-weeks | 1–3 calendar weeks; can overlap contract work | Medium |
| Core project total | 4–7 engineer-weeks | Approximately 6–10 calendar weeks | Medium |
| Structured Pilot | Unknown until gate; provisional 4–8+ engineer-weeks | Additional 6–12+ calendar weeks | Low |
| Limited rollout | 1–3 engineer-weeks | Additional 3–6 calendar weeks including observation | Low |
| Second provider / retirement | Not estimable | Not schedulable yet | Low |

The ranges account for:

- streamer-first landing;
- manual staged-diff and commit approval;
- one PR landing at a time;
- CI and full suites;
- streamer test-suite serialization;
- mobile follow-up after streamer APIs;
- independent verification;
- rebasing and serial merge order;
- provider-spike uncertainty.

## Critical path

```text
Safety streamer
  → safety mobile
  → prompt contract streamer
  → old/new compatibility verification
  → prompt contract mobile
  → independent cross-repo verification
  → provider gate complete
  → display go/no-go
  → one structured runner
  → structured mobile view
  → cross-repo end-to-end verification
  → limited rollout
```

Safe parallelism:

- Claude and Codex evidence probes can run independently.
- Mobile `prompt_pending` UX can be authored while streamer safety work is reviewed, though streamer must land first.
- Content-free logging work can be authored independently of prompt identity work.
- After event captures exist, fixture-based activity-view design can proceed alongside runner work.
- Documentation and observability specifications can proceed without running streamer tests.

Parallel work does not shorten serial merges, streamer-before-mobile dependencies, product approval, or the observation window. Streamer suites must not run concurrently.

# Scope Guardrails

A new task enters the current phase only if all of the following are true:

1. It is required by that phase’s written acceptance criteria; or
2. It prevents data loss, security exposure, or correctness failure directly caused or exposed by the phase; or
3. It is a direct prerequisite of the architecture actually being shipped;
4. The smallest evidence-backed solution has been identified; and
5. It does not silently change the product contract or transport strategy.

Otherwise it becomes:

- a later milestone;
- a separately filed follow-up;
- or explicitly rejected scope.

Pre-existing unrelated defects do not enter automatically. A critical unrelated defect may justify a separate hotfix, not expansion of the active feature phase.

## Discoveries that stop a phase

Stop immediately if evidence shows:

- session identity forks unexpectedly;
- two writers can corrupt one transcript;
- terminal-origin history cannot be preserved;
- an old mobile client can trigger a destructive action on a structured session;
- prompt or answer content enters logs, analytics, or unrelated clients;
- pending prompt state cannot be reconciled after reconnect;
- an unknown actionable provider request cannot fail closed;
- the selected provider capability disappears or remains hidden/unsupported in the intended version;
- a structured session lacks a recovery path after streamer failure;
- the canonical history/search data source changes unexpectedly.

## Discoveries that should be recorded but not block

- cosmetic prompt-card differences;
- richer previews;
- nonessential provider events;
- unrelated queue/plan endpoint debt;
- dead-code cleanup;
- broader status-model cleanup;
- improved terminal emulation;
- second-provider parity;
- detector deletion opportunities;
- command-terminal features not required by the current phase.

## Go/no-go ownership

- The technical owner approves architecture and evidence matrices.
- An independent verifier signs runtime identity, causality, and failure behavior.
- A product owner is required for:
  - accepting loss of terminal capabilities;
  - accepting exclusive handoff instead of seamless continuity;
  - choosing structured-session presentation;
  - reducing support for externally originated sessions.

A new question returns to a spike instead of expanding implementation when it affects:

- canonical session identity;
- writer exclusivity;
- transcript ownership;
- prompt settlement;
- expiry/reconnect;
- security/privacy;
- client compatibility;
- availability of user-visible session data.

Empirical protocol uncertainty must be resolved by an experiment, not by adding defensive architecture around an assumption.

# Methodology Review

The research methodology is professionally sound and should become an explicit project rule at protocol, concurrency, identity, and screen-detection boundaries.

A sharper formulation is:

> Exercise the production path; prove object identity and causality with positive and negative controls; verify the external effect that carries the requirement.

This improves on “Execute, then prove the thing you executed against is the thing in question” by explicitly requiring:

- the real object;
- a causal relationship;
- a falsifiable opposite;
- the observable that matters to the product.

## What it prevents

It directly prevents:

- testing a helper while production calls a dispatcher;
- measuring a hand-built Claude gate and extrapolating to Codex;
- treating a file’s existence as evidence that code is reachable;
- mistaking TUI behavior for control-protocol behavior;
- treating type declarations as runtime capability;
- proving only that an HTTP response was 200 while the file/transcript/session remained wrong;
- accepting an empty search result without proving the search invocation works;
- writing a tautological test whose setup creates its own pass condition.

The research record’s corrected disagreements are good examples ([research record:89–105](</Users/ronenmars/dev/ai-tools/docs/ai-questions-planning-and-research/2-researchers-feature-research-record.md:89>)).

## Why neither extreme is sufficient

“Execute, don’t read” fails because runtime experiments can target the wrong layer, configuration, identity, or provider.

Static reading fails because:

- dead code looks supported;
- types conceal flags and defaults;
- concurrency is behavioral;
- session files can fork;
- a response frame does not prove the external action;
- rendered TUI behavior can differ from protocol behavior.

Positive controls prove that the measurement mechanism can observe a known fact. Negative or counterfactual controls prove causality. Both are necessary.

A test that cannot fail proves nothing. For load-bearing tests, temporarily mutate or invert the protected behavior and confirm that the test fails for the intended reason—not merely because the process crashed.

Independent verification helped because the verifier questioned the measured object rather than reproducing the implementer’s assumptions. That role should remain separate on session transport, prompt settlement, and security changes.

## Practical verification principles

1. Record exact repository commit, binary version, feature flags, configuration, and environment.
2. Name the authoritative runtime object before testing.
3. Prove the harness with a positive control.
4. Include a negative or counterfactual control.
5. Verify the external effect: file, transcript, process, prompt settlement, or user-visible state.
6. Test stale, duplicate, reordered, disconnected, and multi-client behavior at protocol boundaries.
7. Mutate load-bearing safeguards and confirm their tests fail.
8. Preserve raw evidence with secrets redacted.
9. Keep evidence categories explicit: typed, captured, current code, inferred.
10. Apply the full method proportionately: protocol/session/security boundaries require it; ordinary pure transformations usually need focused unit/integration tests plus one real seam test.

# Risks

| Rank | Risk | Severity | Likelihood | Evidence / mitigation |
|---:|---|---|---|---|
| 1 | Secrets in current input/output logs | Critical | High | **CURRENT.** Replace all content-bearing default logs, not only `renderedTail`. |
| 2 | Prose submitted during an open card triggers an unintended action | Critical | Medium-high | **CAPTURE + CURRENT PATH.** Add semantic input arbitration immediately. |
| 3 | Structured rollout breaks or destructively misroutes released mobile | Critical | High if ungated | **CURRENT.** Explicit transport and client capability negotiation. |
| 4 | Structured control breaks the external-terminal product promise | Critical | Medium | **UNPROVEN.** Mandatory terminal/control/terminal gates per provider. |
| 5 | Two writers corrupt or fork history | Critical | Medium | **CAPTURE for Codex; unknown Claude.** Exclusive transport and identity tests. |
| 6 | Prompt content leaks to unrelated connected clients | High | High | **CURRENT.** Subscriber-scoped lifecycle and authorization tests. |
| 7 | Stale answer settles an identical later gate | High | Medium | **CURRENT DESIGN.** Instance ID and revision, not content identity. |
| 8 | Every Codex permission answer is rejected | High | Certain on current route | **CURRENT + CAPTURE.** Provider-correct freshness plus instance identity. |
| 9 | Protocol capability drifts with CLI versions or hidden flags | High | High | Exact-version generated/types matrix and PTY fallback. |
| 10 | Structured event corpus omits activity or controls users depend on | High | Medium | Complete corpus gate and structured activity acceptance criteria. |
| 11 | Prompt expires or provider disconnects while mobile still shows it as answerable | High | Medium | Authoritative expiry/state machine, snapshot/sequence, failure tests. |
| 12 | Multi/free/partial questions remain misleading or throw 500 | High | Medium | Typed unsupported/incomplete response; zero bytes; no fake support. |
| 13 | No automatic fallback exists for an active structured session | High | Medium | Explicit recovery procedure; kill switch affects new sessions only. |
| 14 | Live thinking/tool phase does not update in mobile | Medium | High | Mobile currently ignores `session_phase`; resolve in contract/display foundation. |
| 15 | “Raw terminal fallback” overstates actual fidelity | Medium | High | Current fallback remains VT-normalized. Label accurately; do not reuse it for structured confidence. |
| 16 | Serial review/CI expands elapsed time | Medium | High | Fewer coherent PRs, no artificial fan-out, conservative schedule. |

# Final Go / No-Go Matrix

| Phase | Go now? | Blocked by | Decision/evidence required |
|---|---|---|---|
| Safety Stabilization | **YES** | Acceptance scenarios and stable error names | No architecture spike required. |
| Prompt Contract Foundation on PTY | **YES, after safety contract is fixed** | Final schema and compatibility policy | IDs/revisions, scoping, multi-client and legacy behavior approved. |
| Expanded Structured Feasibility Gate | **YES** | Exact target versions and evidence protocol | Positive/negative controls and terminal-origin sequences. |
| Structured activity-view product design | **AFTER initial event corpus** | Product decision and captured provider events | Fixture-backed acceptance against real event types. |
| One-provider Structured Pilot | **NO** | Provider gate, prompt foundation, display decision | Identity, continuity, stability, control, reconnect, and rollback must pass. |
| Limited production rollout | **NO** | Successful internal pilot | Cross-version compatibility and rollback drill. |
| Second provider | **NO** | Separate provider gate and first-provider evidence | Must justify independent user value and cost. |
| Detector retirement | **NO** | Stable structured usage plus PTY/external exit criteria | Provider/transport-specific retirement checklist. |
| Broad structured rewrite | **NO** | Nothing in current evidence requires it | Would require a separate product and architecture decision. |

# Recommended Next Action

Freeze Track B and authorize the **Safety Stabilization** milestone, beginning with a streamer-first change that prevents ordinary text from settling an open prompt while simultaneously removing plaintext prompt/input/output content from default logs.q
