# Codex Live Session Support — Execution Task Plan

> Status: historical implementation plan. The Codex live-session work shipped in
> PR #159; this document is retained as implementation provenance.

Source of truth for intent: `docs/plans/2026-07-03-codex-live-session-support.md`
(includes Phase 0 CLI-characterization findings). This file breaks the
remaining phases (2, 3, 4, 6) into bite-sized tasks for subagent-driven
execution. Phase 1 (provider plumbing) and Phase 5 (tb-mobile) are already
done — do not redo them.

## Global Constraints (apply to every task)

- Never modify tb-mobile. This repo (`tb-streamer`) only.
- Claude live-session behavior must stay byte-for-byte equivalent: same spawn
  args, same prompt markers (`╭`, `❯`), same bracketed-paste input path, same
  JSONL watch logic under `~/.claude/projects/<encoded>/`, same statuses
  (`running`, `waiting_input`, `idle`), same callback shapes
  (`onOutput`, `onStatusChange`, `onReady`, `onPermissionChange`,
  `onLiveQuestion`, `onLiveQuestionGone`).
- Do not rename or remove any existing WS event type, REST endpoint path,
  response field, or session status string. New fields are additive/optional
  only (see `docs/compatibility/tb-mobile.md`).
- `provider` on `ManagedSession`/`SessionResponse` defaults to `"claude-code"`
  when absent — this is already implemented (Phase 1); do not change it.
- Codex prompt-ready detection MUST render PTY output through a headless
  xterm screen buffer (same technique `pty-manager.ts` already uses for
  Claude via `session.screen` / `getOutputLines()`) rather than matching raw
  byte chunks — Phase 0 found Codex paints most text via absolute cursor
  moves, so raw substring matching misses it.
- Codex readiness marker: the rendered status-bar line contains the literal
  word `Ready` when usable (`Starting` while MCP servers load, `Working`
  mid-turn). Do not treat the `›` compose-box glyph alone as ready — it
  renders before `Ready`.
- Codex directory-trust gate: on first launch in a never-before-used
  `--cd <dir>`, Codex blocks on a rendered screen containing the text
  "trust the contents" with options `1. Yes, continue` / `2. No, quit`. This
  must be auto-answered with `\r` (accepts the highlighted default) before
  normal readiness detection proceeds. This gate does not appear on
  `codex resume` or on subsequent launches in an already-trusted directory.
- Codex input: no bracketed-paste wrapper. Write the plain input text, then
  after a short delay write `\r` to submit (same delay constant pattern as
  Claude's `SUBMIT_DELAY_MS`, but without the `\x1b[200~...\x1b[201~` wrap).
- Codex process launch: `codex --cd <projectPath> --no-alt-screen` (fresh) /
  `codex resume <codexSessionId> --cd <projectPath> --no-alt-screen` (resume).
  PTY geometry: reuse the same cols/rows as Claude (120x40) for consistency.
- Codex rollout files live under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
  (date-nested, NOT project-path-encoded like Claude). `session_meta.payload.id`
  (== `payload.session_id`) is the persisted Codex session id; `payload.cwd`
  is the working directory. The file exists within ~1s of process spawn
  (after any trust gate is cleared), well before any user input.
- Every new file/module needs tests in `__tests__/`. Every task must leave
  `npm run lint` and the relevant test files green before being marked done.
- Vitest globals are enabled — do not import `describe`/`it`/`expect`.

## Task 1: Extract Claude PTY logic behind a `SessionRunner` interface, no behavior change

Purpose: Phase 2 — split `PTYManager`'s provider-specific mechanics behind a
narrow interface so `LiveSessionManager` can delegate to different runners by
provider, without changing any Claude behavior.

Steps:

1. In `src/types.ts`, add a new exported interface `SessionRunner` capturing
   exactly the subset of `PTYManager`'s public surface that
   `LiveSessionManager` calls today: `start`, `startFresh`, `sendInput`,
   `sendKeys`, `cancel`, `killPid`, `putOnHold`, `getOutput`,
   `getOutputLines`, `getSession`, `hasSession`, `listSessions`, `dispose`.
   Match `PTYManager`'s current method signatures exactly (read
   `src/pty-manager.ts` for the authoritative signatures — do not guess).
2. Add `class PTYManager implements SessionRunner` in `src/pty-manager.ts`
   (just the `implements` clause — no other changes to this file in this
   task). This is a compile-time check that the interface extraction is
   accurate; if it doesn't compile, fix the interface, not `PTYManager`.
3. In `src/live-session-manager.ts`, change the `claudeRunner` field's type
   from `PTYManager` to `SessionRunner`, and rename the field to `runners`
   as a `Map<ProviderName, SessionRunner>` seeded with one entry:
   `[CLAUDE_CODE_PROVIDER, new PTYManager(options)]`. Every method
   (`start`, `sendInput`, etc.) that currently calls `this.claudeRunner.X(...)`
   directly should instead:
   - For methods that take a `sessionId` (sendInput, sendKeys, cancel,
     putOnHold, getOutput, getOutputLines, getSession, hasSession): look up
     which runner owns that session. Since only one runner exists right now,
     resolving "the runner that has this session" via `hasSession()` across
     the map is sufficient — do not add a separate session→provider index
     yet (that's this task's whole job kept minimal; a real index only
     matters once two runners exist, which is Task 2).
   - For `start`/`startFresh`: resolve the runner by
     `options.provider ?? CLAUDE_CODE_PROVIDER` via `this.runners.get(...)`;
     if absent, keep throwing the existing 501
     "not implemented yet" error via `assertSupportedProvider` (adjust it to
     check `this.runners.has(provider)` instead of
     `provider === CLAUDE_CODE_PROVIDER`).
   - `killPid`: this is PID-based, not session-based, and Claude-specific
     process cleanup — call it on every runner in the map (today there's
     only one, so behavior is unchanged; this avoids a design decision this
     task doesn't need to make).
   - `listSessions`: concatenate `listSessions()` across all runners.
   - `dispose`: call `dispose()` on every runner in the map.
4. Do not touch `pty-manager.ts` internals beyond the one-line `implements`
   addition. Do not touch `server.ts`, `session-store.ts`, `types.ts` beyond
   the new interface, or any test file's assertions about Claude behavior.

Tests:

- Run the full existing suite (`npm test`) — it must pass unchanged. This
  task must not need new tests of its own (it's a pure structural
  extraction with identical runtime behavior for the single
  already-registered Claude runner) — confirm this by diffing test output
  before/after, not by asserting it in prose.
- `npm run lint` passes (`tsc --noEmit && npx biome check .`).

## Task 2: Add `resolveCodexExe()` and a `CodexPtyRunner` implementing `SessionRunner`

Purpose: Phase 3 — the Codex process runner, built against the `SessionRunner`
interface from Task 1. Wired into `LiveSessionManager` in Task 3; this task
is the runner in isolation with its own unit tests against a mocked
`node-pty`.

Steps:

1. In `src/platform.ts`, add `resolveCodexExe()` mirroring
   `resolveClaudeExe()`'s structure exactly (same which/where.exe pattern,
   same Homebrew/local candidate paths, but for `codex` instead of `claude`,
   and its own module-level cache variable e.g. `_codexExe`). Do not touch
   `resolveClaudeExe()` itself.
2. Create `src/codex-pty-runner.ts` exporting `class CodexPtyRunner implements SessionRunner`.
   Model its shape on `PTYManager` (same `InternalSession`-style internal
   state: `Map<string, ...>` of sessions, `outputBuffer`, headless `screen`
   via `@xterm/headless`, `pendingReady`/`queuedInputs` maps) but simplified
   to what Codex actually needs per the Phase 0 findings:
   - `start(sessionId, options)`: Codex has no `--session-id`/`--resume-by-id`
     equivalent for a *fresh* session (per the source plan, Section 8) — for
     this task, implement `start()` to mean "resume an existing Codex
     session": spawn `codex resume <sessionId> --cd <projectPath> --no-alt-screen`.
     (`sessionId` here is the Codex-persisted `session_meta.payload.id`.)
   - `startFresh(options)`: generate a local placeholder id via
     `randomUUID()` for the `ManagedSession.id` (the live PTY handle), spawn
     `codex --cd <projectPath> --no-alt-screen` (no `--session-id` flag —
     Codex assigns its own id, discovered later in Task 3's binding logic).
     Do NOT wire rollout-file binding in this task — that's Task 3. This
     task's `startFresh` just spawns the process and returns a
     `ManagedSession` with `provider: CODEX_CLI_PROVIDER` and the
     placeholder id, same shape `toPublicSession` produces for Claude.
   - Readiness: implement a `detectReady(sessionId, strippedChunk)` private
     method that renders the session's headless screen (same
     `getOutputLines`-style flush-then-read pattern as `pty-manager.ts`) and
     checks the last non-blank line for the literal substring `Ready`
     (case-sensitive, matching the real status bar). Do NOT match on `›`
     alone (see Global Constraints).
   - Directory-trust gate: before the `Ready` check, if the rendered screen
     contains `/trust the contents/i` and the gate hasn't already been
     answered for this session, write `\r` once (debounce with a
     per-session `Set<string>` so it's only answered once) and return
     early (still not ready).
   - Input: `sendInput` queues while `pendingReady` (same queuing behavior
     as `PTYManager`, reuse the same "queue while booting, flush on ready"
     shape) and otherwise writes the raw input text followed by `\r` after
     a short delay (reuse a `CODEX_SUBMIT_DELAY_MS` constant — same value as
     Claude's `SUBMIT_DELAY_MS` is fine, no bracketed-paste wrap).
   - `sendKeys`: write raw bytes directly, same as Claude.
   - `cancel`/`putOnHold`: `SIGINT` the process (confirmed clean exit in
     Phase 0), mirror `PTYManager.putOnHold`'s session cleanup (delete from
     map, dispose screen, set status `idle`, `onStatusChange` callback).
   - `getOutput`/`getOutputLines`/`getSession`/`hasSession`/`listSessions`/`dispose`:
     same shape as `PTYManager`'s equivalents.
   - Exit handling: on non-zero exit within <2s with no output, set
     `failureReason` to a Codex-specific message ("Codex binary not found or
     not executable" if the project dir doesn't exist, else a generic
     "Codex process exited immediately" message) — mirror
     `PTYManager.handleExit`'s pattern but do not reuse its Claude-wording
     string verbatim.
   - Constructor takes the same `PTYManagerOptions`-shaped callbacks
     (`onOutput`, `onStatusChange`, `onReady`, `logger`) as `PTYManager`.
     `onPermissionChange`/`onLiveQuestion`/`onLiveQuestionGone` are
     Claude-specific (permission gates, AskUserQuestion) — accept them in
     the options type for shape-compatibility but do not call them from
     Codex (Codex has no equivalent detected yet per Phase 0; out of scope).
3. Export a `CODEX_PROMPT_READY_TEXT = "Ready"` (or similarly named) constant
   and a trust-gate regex constant at module scope, documented with a short
   comment referencing the Phase 0 findings section, so the magic strings
   aren't buried in a conditional.

Tests: create `__tests__/codex-pty-runner.test.ts`:

- Mock `node-pty` (same mocking approach as existing `pty-*.test.ts` files —
  read one first, e.g. `__tests__/pty-ready-detection.test.ts`, for the
  established mock shape).
- `resolveCodexExe()`: unit test executable resolution (mock `execFileSync`
  the same way `platform.test.ts` tests `resolveClaudeExe()`, if such a test
  file exists — check `__tests__/` for a `platform.test.ts` first).
- `startFresh()` spawns `codex` with `--cd <projectPath> --no-alt-screen`
  and no other args.
- `start()` (resume) spawns `codex resume <sessionId> --cd <projectPath> --no-alt-screen`.
- Directory-trust gate: feeding mocked PTY output containing "trust the
  contents" causes exactly one `\r` write and does not mark the session
  ready.
- Readiness: feeding output whose rendered last line contains `Ready`
  fires `onReady` and transitions status to `waiting_input`; output
  containing only `›` without `Ready` does NOT fire `onReady`.
- `sendInput` while pending-ready queues, then flushes in order once ready.
- `cancel`/`putOnHold` sends SIGINT and cleans up session state.
- Exit-code handling sets `failureReason` on instant non-zero exit.

## Task 3: Wire `CodexPtyRunner` into `LiveSessionManager`; bind live sessions to persisted rollout files

Purpose: Phase 3 (wiring) + Phase 4 (JSONL/rollout binding) combined — this
is the task that makes Codex live sessions actually discoverable as real
conversations.

Steps:

1. In `src/live-session-manager.ts`, register a second runner:
   `this.runners.set(CODEX_CLI_PROVIDER, new CodexPtyRunner(options))`.
   Remove the 501 "not implemented" throw for `codex-cli` from
   `assertSupportedProvider` (it now resolves to a real runner via
   `this.runners.get(provider)`).
2. In `src/server.ts`, add a Codex-equivalent of `watchForJsonl()` — name it
   `watchForCodexRollout(sessionId, projectPath)`. Differences from the
   Claude version (`watchForJsonl`, read it first for the full pattern —
   deadline, cleanup, fs.watch, broadcast of existing lines, scanner
   invalidation, `linkSessionToProject`):
   - Directory to watch: `codexRoots[0]` (or all configured `codexRoots`,
     matching how provider scan calls already use the configured list) joined
     with today's `YYYY/MM/DD` path segments
     (`~/.codex/sessions/<Y>/<M>/<D>/`, per Phase 0 findings).
   - Matching a candidate file: there is no filename-encoded session id to
     check first. Poll/watch for recently modified `.jsonl` files, then parse
     `session_meta.payload.cwd` and accept the file only when it matches
     `projectPath`. This guards against picking up an unrelated concurrent
     Codex session in the same date directory.
   - Once matched: set the live session's persisted conversation id from
     `session_meta.payload.id` while keeping the streamer's live PTY id stable.
     Follow the existing `ManagedSession` / `SessionResponse` field naming
     instead of inventing a new response shape.
   - Update `SessionStore` so `GET /api/sessions/:id` and session-list
     broadcasts surface the bound conversation id.
   - Trigger the same scanner/cache/project bookkeeping that `watchForJsonl()`
     performs so the new Codex conversation becomes visible via
     `/api/conversations?provider=codex-cli`.
3. Call `watchForCodexRollout` from the same place `handleStartSession`
   already calls `watchForJsonl`, gated on `provider === CODEX_CLI_PROVIDER`.
   Claude must keep calling `watchForJsonl` exactly as today.
4. Do not implement resume-via-`/api/sessions/resume` in this task. That is
   Task 4. This task covers `POST /api/sessions/start` with
   `provider: "codex-cli"` only.

Tests:

- Starting a session with `provider: "codex-cli"` no longer 501s and reaches
  the Codex runner.
- A rollout `.jsonl` with matching `cwd` appears after process start and binds
  the session to the persisted conversation id while the live session id stays
  stable.
- A rollout file with a different `cwd` is ignored.
- `/api/conversations?provider=codex-cli` includes the new conversation after
  the bind-triggered rescan.
- Existing `__tests__/codex-api.test.ts` and `__tests__/codex-scan.test.ts`
  keep passing.
- `npm run lint` passes.

## Task 4: Codex resume — `POST /api/sessions/resume` and `isProviderResumable()`

Purpose: Phase 6. Only after Tasks 1-3 land does resume become safe to wire,
since it depends on the `CodexPtyRunner` resume path from Task 2 and the
runner registration from Task 3.

Steps:

1. In `src/providers.ts`, update `isProviderResumable()` so `codex-cli`
   returns resumable availability now that resume is implemented and verified.
   Keep the function signature unchanged.
2. In `src/server.ts`'s `handleResume`, thread the conversation's provider
   through to `this.ptyManager.start(...)` so `LiveSessionManager` selects the
   right runner. Reuse existing provider lookup patterns rather than adding a
   parallel source of truth.
3. Confirm `LiveSessionManager.start()` already resolves the runner by
   `options.provider` per Task 1. If `handleResume` passes `provider`, no
   further manager change should be needed for this task.
4. Do not change Claude resume arguments or the behavior of providers other
   than `codex-cli`.

Tests:

- A conversation with `provider: "codex-cli"` and `resumable: true` can be
  resumed via `POST /api/sessions/resume`, and the resulting live session has
  `provider: "codex-cli"`.
- Existing scan-only Codex conversations without a known live binding still
  report non-resumable until the cache contains the required metadata.
- Existing Claude resume tests pass unchanged.
- `npm run lint` passes.

## Task 5: Full-suite regression pass + `docs/compatibility/tb-mobile.md` update

Purpose: close out the plan's compatibility requirement and catch any
cross-task interaction the per-task reviews did not see, especially overlapping
changes in `server.ts`.

Steps:

1. Run `npm run lint && npm test` (full suite, not a filtered subset).
2. Read `docs/compatibility/tb-mobile.md` and add the new additive fields
   introduced by Tasks 3-4, following the file's existing format. Do not remove
   or reword existing entries.
3. Confirm the streamer verification commands from
   `docs/plans/2026-07-03-codex-live-session-support.md` still pass, plus the
   new Codex test files added by Tasks 2-4.

Tests: this task is the test/verification pass. Report full suite output, not a
subset.
