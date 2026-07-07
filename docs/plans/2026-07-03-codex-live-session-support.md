# Codex Live Session Support Plan

> Status: historical implementation plan. The Codex live-session work shipped in
> PR #159; this document is retained as implementation provenance.

## Goal

Add live Codex CLI session support to `tb-streamer` so `tb-mobile` can start,
watch, send input to, stop, and view terminal output for Codex sessions using the
same REST and WebSocket contract it already uses for Claude Code sessions.

The minimum successful outcome is:

- `POST /api/sessions/start` can start either a Claude Code or Codex CLI live
  session without changing existing Claude behavior.
- WebSocket clients receive `session_ready`, `session_update`,
  `terminal_output`, and `terminal_replay` for Codex sessions.
- `POST /api/sessions/:id/input`, `/stop`, `/cancel`, and WS `hold_session`
  work for Codex sessions through the same mobile paths.
- Codex live conversations appear with `provider: "codex-cli"` and remain
  additive to the existing mobile contract.
- Existing read-only Codex history support keeps working.

## Analysis Summary

`tb-streamer` currently has two separate levels of Codex support:

- Historical Codex conversations are already scanned from `codexRoots`, defaulting
  to `~/.codex/sessions`. The server passes `providers:
  ["claude-code", "codex-cli"]` into scanner calls, surfaces `provider` on
  conversation list/detail responses, and forces Codex detail responses to
  `resumable: false`.
- Live sessions are still Claude-specific. `PTYManager` resolves `claude`,
  starts `claude --session-id <uuid>` or `claude --resume <uuid>`, uses Claude
  prompt markers (`╭`, `❯`) for readiness, watches `~/.claude/projects/<encoded
  cwd>/<uuid>.jsonl`, and refreshes Claude JSONL files through the scanner.

`tb-mobile` is already close to provider-aware. It stores `provider` on
conversation models, shows provider badges, filters by provider, and consumes the
generic session and WebSocket shapes. The mobile app should not need a separate
Codex transport if the streamer keeps the existing session API shape stable.

Local CLI verification on this machine shows the installed `codex` command
supports the relevant interactive paths:

- `codex [PROMPT]` starts the interactive CLI.
- `codex resume` resumes a previous interactive session.
- `--cd <DIR>` sets the workspace root.
- `--no-alt-screen` disables alternate-screen mode and may simplify replay.
- `--sandbox`, `--ask-for-approval`, `--model`, `--profile`, and `-c key=value`
  are available for runtime policy/configuration.

The hard part is not merely spawning `codex`. The hard part is separating the
provider-specific session runtime from the existing Claude assumptions while
keeping the mobile wire contract unchanged.

## Assumptions

- Codex live support should be opt-in first, not a breaking replacement for
  Claude Code.
- The first implementation can support starting new Codex sessions before it
  supports robust Codex resume. Codex resume semantics and stable id mapping need
  a dedicated verification step.
- `tb-mobile` should only need small UI/API additions, likely a provider selector
  when starting a session. Existing session detail, terminal, input, stop, and
  WebSocket handling should remain shared.
- Unknown WebSocket event types and optional REST fields are safe, but existing
  endpoint paths, field names, status values, and event names must not be removed
  or renamed.

## Proposed Architecture

### 1. Introduce a provider-aware live session runner

Do not thread `if provider === "codex-cli"` through all of `PTYManager`.
Instead, split the provider-specific process details behind a small runner
boundary.

Recommended shape:

```ts
export type LiveSessionProvider = "claude-code" | "codex-cli";

export interface LiveSessionStartOptions {
  provider: LiveSessionProvider;
  sessionId?: string;
  projectPath: string;
  projectName?: string;
  branch?: string;
  systemPrompt?: string;
  initialPrompt?: string;
}

export interface LiveSessionRuntime {
  start(options: LiveSessionStartOptions): Promise<ManagedSession>;
  sendInput(sessionId: string, input: string): number;
  sendKeys(sessionId: string, keys: string): void;
  cancel(sessionId: string): void;
  putOnHold(sessionId: string): void;
  getOutput(sessionId: string): string;
  getOutputLines(sessionId: string, maxLines: number): Promise<string[]>;
  hasSession(sessionId: string): boolean;
  getSession(sessionId: string): ManagedSession | null;
  listSessions(): ManagedSession[];
  dispose(): void;
}
```

Implementation options:

- Conservative path: keep the current class as `ClaudePtySessionRunner`, then add
  `CodexPtySessionRunner`, and expose a thin `LiveSessionManager` that delegates
  by session id.
- Smaller but messier path: add provider options directly to `PTYManager`. This
  is faster initially, but it makes future provider behavior harder to reason
  about because the current file is full of Claude-specific readiness, JSONL, and
  prompt-detection assumptions.

Recommendation: use the conservative runner split. It is a real abstraction with
two callers immediately, not a speculative wrapper.

### 2. Add provider to live session identity

`ManagedSession` and `SessionResponse` should carry optional
`provider?: "claude-code" | "codex-cli"`.

Compatibility rules:

- Default missing provider to `"claude-code"` for older data.
- Include `provider` in new session responses and session WebSocket events.
- Keep all existing fields and status strings unchanged.
- Do not create a new Codex-only endpoint for live sessions.

`SessionStore` should preserve provider on managed sessions and list responses.
`conversationToResumableSession` already has provider logic for historical
conversations; the same provider field should exist on live sessions.

### 3. Provider-select session start

Extend `POST /api/sessions/start` request parsing with an optional `provider`
field:

```json
{
  "path": "relative/project/path",
  "provider": "codex-cli",
  "input": "optional initial prompt"
}
```

Rules:

- Missing `provider` means `"claude-code"`.
- Invalid provider returns `400`.
- Existing Claude request bodies continue to work.
- `systemPrompt` remains Claude-only unless Codex support for equivalent config is
  verified and explicitly mapped.

For mobile, this enables a minimal provider selector on the start-session flow
without changing the session detail flow.

### 4. Codex process launch

Add a Codex resolver alongside `resolveClaudeExe()`:

- Prefer `which codex`/`where.exe codex`.
- Probe Homebrew and common local install paths on macOS/Linux.
- Fall back to bare `"codex"` for PATH resolution.
- Diagnose instant exit as "Codex binary not found or not executable" rather
  than reusing Claude wording.

Initial Codex launch command:

```sh
codex --cd <projectPath> --no-alt-screen
```

For an initial prompt:

```sh
codex --cd <projectPath> --no-alt-screen "<prompt>"
```

Open decisions to verify before implementation:

- Whether `--no-alt-screen` preserves enough output for stable `terminal_replay`
  while still rendering well in mobile's `VirtualTerminal`.
- Whether Codex interactive sessions emit a stable session id early enough to map
  the streamer's generated id to the persisted Codex rollout file.
- Whether `codex resume <id>` accepts the same id present in Codex rollout JSONL
  `session_meta.payload.id`, or whether the CLI uses a separate name/index.

### 5. Readiness and status detection

The current readiness logic is Claude-specific:

- Prompt markers are `╭` and `❯`.
- Readiness broadcasts `session_ready`.
- `waiting_input` is inferred when the prompt marker appears.

Codex support needs a provider-specific readiness detector:

- Start in `running`.
- Mark ready on Codex's prompt/input marker once observed.
- Keep the existing fallback timer so queued mobile input is not stranded if the
  prompt marker changes.
- Emit `session_ready` exactly like Claude when the first prompt is reachable.
- Use the same `running`, `waiting_input`, and `idle` statuses.

Codex prompt detection should start simple and observable:

- Detect known prompt markers from actual `codex --no-alt-screen` output.
- Add debug logging for unmatched startup output.
- Avoid adding Codex-specific `question` or `permission` events until there is a
  concrete prompt shape to map.

### 6. Terminal streaming and replay

Reuse the same `node-pty` + xterm headless screen path:

- Raw Codex output broadcasts as `terminal_output`.
- `subscribe_session` returns `terminal_replay` from the provider runtime's
  `getOutputLines()`.
- `putOnHold()` kills the PTY, marks `idle`, clears screen state, and broadcasts
  `session_update`.

This keeps `tb-mobile`'s `useTerminalStream()` unchanged.

### 7. Input handling

Keep the same mobile routes:

- Text input: `POST /api/sessions/:id/input` with `{ input }`.
- Raw keys: `POST /api/sessions/:id/input` with `{ keys }`.
- Stop/hold/cancel: existing session lifecycle routes.

Provider-specific behavior:

- Claude keeps bracketed-paste submit semantics.
- Codex should start with the same paste-then-submit path only if verified
  against the interactive CLI. If Codex does not need bracketed paste, the Codex
  runner can write plain input plus `\r`.
- Queued input while pending-ready should remain provider-independent.

### 8. Codex JSONL wiring

Current Claude fresh sessions rely on `--session-id` so the JSONL filename is
known before the CLI writes it. Codex does not expose an equivalent flag in the
locally verified `codex --help` output.

Plan for Codex:

1. On Codex process start, snapshot the newest known Codex session files under
   configured `codexRoots`.
2. Watch `codexRoots` recursively or poll briefly for a newly created/modified
   rollout file.
3. Parse `session_meta.payload.id` from candidate files.
4. Bind the streamer's live session id to the Codex persisted id once known.
5. Refresh the scanner/cache for the bound file and surface `provider:
   "codex-cli"`.

Open decision:

- Whether the mobile-visible session id should be the streamer's generated id
  for the whole live session, or should rekey to the Codex persisted id once
  discovered.

Recommendation:

- Keep the streamer's generated id stable for the live PTY.
- Use `resumedFromConversationId` only for actual resume flows.
- Avoid rekeying an active mobile route after the user has navigated to it.

**Revised during implementation (Task 3 prep):** `SessionResponse.conversationId`
is a REQUIRED field, already documented in `src/types.ts` as "alias for id —
mobile uses this to build deep-link URLs," and mobile navigates on it the
moment `POST /api/sessions/start` returns. Writing the Codex persisted id
into `conversationId` after the fact would be exactly the in-flight-route
rekey this section warns against, so that field is NOT the storage location
— it must stay `=== id` for a live PTY's whole lifetime, matching existing
Claude semantics. `resumedFromConversationId` doesn't fit either (resume-only,
set in `enrichResumedSessionAsync`). Instead: a new additive optional field,
`boundConversationId?: string`, on both `ManagedSession` and `SessionResponse`,
set once the rollout file is discovered — mobile-safe because it's a new
field older clients simply never read, unlike overloading `conversationId`.

This mirrors the existing distinction between live session identity and
conversation identity without breaking in-flight WebSocket subscriptions.

### 9. Resume behavior

Do not mark all Codex history resumable in the first pass. Current API correctly
reports Codex historical conversations as `resumable: false`.

Add resume in a later phase after verifying:

- `codex resume <session-id>` accepts `session_meta.payload.id`.
- It can run under `--cd <projectPath>` consistently.
- It writes to either the same rollout file or a new forked session file.
- The mobile "resume conversation" flow can normalize the response without
  confusing live id vs conversation id.

Phase 1 should support "start new Codex live session"; Phase 2 can support
"resume Codex conversation".

## Implementation Phases

### Phase 0 - Characterize Codex CLI behavior

Purpose: remove guesswork before touching server code.

Tasks:

- Run a disposable `codex --cd <tmp-project> --no-alt-screen` PTY capture.
- Capture startup output, first prompt marker, input submit behavior, exit/stop
  behavior, and session file creation timing.
- Verify whether bracketed paste is accepted.
- Verify `codex resume <id>` behavior against a real `session_meta.payload.id`.
- Add findings to this plan or a follow-up note before implementation.

Verification:

- A short fixture or test helper captures representative Codex output.
- The implementation plan is updated with actual marker strings and resume
  semantics.

#### Findings (2026-07-03, codex-cli 0.142.5, macOS)

Verified with a real `node-pty` spawn rendered through `@xterm/headless`
(same technique `pty-manager.ts` uses for Claude) — raw substring matching on
the byte stream is **not** reliable because Codex paints most of its TUI with
absolute cursor moves (`\x1b[<row>;<col>H`), splitting words across
non-contiguous writes. Any readiness/prompt detector must render through a
headless screen buffer like Claude's does, not grep raw chunks.

1. **First-run directory-trust gate (plan gap — not previously documented).**
   On the *first* launch ever in a given `--cd <dir>`, Codex blocks on an
   interactive gate before reaching the compose prompt:
   ```
   Do you trust the contents of this directory? Working with untrusted
   contents comes with higher risk of prompt injection. Trusting the
   directory allows project-local config, hooks, and exec policies to load.

   › 1. Yes, continue
     2. No, quit

     Press enter to continue
   ```
   Detect via rendered-line match on `/trust the contents/i` and answer with
   `\r` (accepts the highlighted default, "Yes, continue"). The decision is
   persisted per-absolute-path in `~/.codex/config.toml` under
   `[projects."<path>"]` → `trust_level = "trusted"`, so this gate is a
   **one-time cost per unique project path**, not per-session — subsequent
   `start`/`resume` calls against the same `projectPath` skip it entirely
   (confirmed: `codex resume` against an already-trusted dir went straight to
   the ready prompt, no gate). New Codex runner must handle this as a
   pre-ready state distinct from Claude's boot sequence; there is no CLI flag
   to pre-accept it non-interactively.

2. **No bracketed paste needed.** Plain keystrokes typed directly into the
   PTY (`proc.write("ping")`, no `\x1b[200~...\x1b[201~` wrap) appeared
   correctly in the compose box live, character by character. Submit is a
   bare `\r` once text is present. Unlike Claude, there is no evidence Codex
   needs the paste-then-delay-then-submit dance — a single plain write of the
   text followed by `\r` is sufficient. (Kept the same "write then \r on a
   short delay" shape as Claude for safety/consistency, but the bracketed
   paste wrapper itself is Claude-specific and should not be reused.)

3. **Readiness signal: status-bar word, not just a marker glyph.** The
   compose line is prefixed with `›` (U+203A) as soon as the input box
   renders — but that happens well before Codex is actually usable (while
   `Starting MCP servers (N/12): …` is still in progress). The authoritative
   ready signal is the literal word `Ready` in the status bar's last
   line (format: `<model> · <cwd> · <model> · <effort> · Ready · …`);
   `Starting` and `Working` are the other two observed states. Detector
   should match on the rendered status-bar line, not just presence of `›`.

4. **Rollout file appears immediately, before any user input.** The JSONL
   under `~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl` is created
   (with a `session_meta` first line) essentially as soon as the trust gate
   is cleared and Codex begins booting — birthtime landed within ~1s of the
   trust-gate answer, well before "Starting MCP servers" finished and long
   before any message was sent. `session_meta.payload.id` (and the identical
   `payload.session_id`) equals the UUID segment of the filename, and
   `payload.cwd` equals the `--cd` argument. This means Phase 4's poll-for-new-file
   strategy can run immediately after spawn (post trust-gate) rather than
   waiting for the first exchange — a short bounded poll (e.g. every 250ms for
   a few seconds) against `codexRoots` filtered by `cwd` match is sufficient.

5. **`codex resume <session_meta.payload.id> --cd <projectPath> --no-alt-screen`
   works as hoped.** It replays the prior transcript into the TUI (prior
   user/assistant turns visible as `› <text>` / `• <text>` lines), skips the
   trust gate (dir already trusted), and reaches the same `Ready` status-bar
   state. This validates Phase 6 (Codex resume) as viable without further
   spikes — `isProviderResumable()` can be flipped for Codex once the runner
   exists.

6. **Exit/stop behavior.** `SIGINT` (what `putOnHold()`/`cancel()` already
   send for Claude) cleanly exits Codex with `exitCode=0, signal=2` — no
   special-casing needed versus Claude's kill path.

7. **Response framing.** Assistant output renders as `• <text>` bullet lines
   (vs. Claude's differently-styled turn framing) — not needed for the
   runner itself (raw PTY bytes stream through unchanged either way) but
   useful context if any provider-specific screen-scraping is added later
   (e.g. for permission-gate-equivalent detection, out of scope for this
   plan).

**Revisions to the rest of this plan based on these findings:**

- Section 4 ("Codex process launch") and Section 5 ("Readiness and status
  detection") need a **directory-trust gate handler** as an explicit
  pre-ready state, added below in Phase 3.
- Section 7 ("Input handling"): drop the bracketed-paste assumption for
  Codex; the Codex runner writes plain text + delayed `\r`.
- Section 8 ("Codex JSONL wiring"): the "watch or poll briefly" step can
  start immediately post-spawn (after the trust gate, if any, is cleared)
  rather than waiting for first output — the file exists that early.
- Section 9 / Phase 6 ("Resume behavior"): no longer a research risk. Resume
  is proven to work end-to-end at the CLI level; Phase 6 is now primarily
  wiring, not verification.

### Phase 1 - Provider plumbing without Codex process support

Tasks:

- Add `ProviderName` to live `ManagedSession` / `SessionResponse`.
- Validate optional `provider` on `/api/sessions/start`.
- Default missing provider to `claude-code`.
- Add provider to session list/detail WebSocket payloads.
- Keep Claude path behavior byte-for-byte equivalent where possible.

Tests:

- Existing Claude session tests still pass.
- `/api/sessions/start` without `provider` still starts Claude.
- Invalid `provider` returns `400`.
- Managed session responses include provider when set.

### Phase 2 - Extract Claude runner

Tasks:

- Rename or wrap current `PTYManager` behavior as the Claude runner.
- Introduce provider-neutral manager/delegator by session id.
- Move Claude-only constants and comments out of the provider-neutral layer.
- Preserve current callbacks: `onOutput`, `onStatusChange`, `onReady`,
  `onPermissionChange`, `onLiveQuestion`, `onLiveQuestionGone`.

Tests:

- Existing `pty-*`, server, and prompt-detection tests pass unchanged or with
  mechanical import updates.
- No mobile contract changes.

### Phase 3 - Add Codex runner

Tasks:

- Add `resolveCodexExe()`.
- Spawn `codex --cd <projectPath> --no-alt-screen` in a PTY.
- Implement Codex readiness detection from Phase 0 findings.
- Implement Codex input submit semantics.
- Broadcast output, replay, ready, and status through the shared callbacks.
- Diagnose instant exits with Codex-specific failure reasons.

Tests:

- Unit-test Codex argument construction and executable resolution.
- Mock `node-pty` to verify start, input, keys, stop, hold, and exit behavior.
- Verify `session_ready` and `terminal_replay` are emitted for mocked Codex
  output.

### Phase 4 - Bind live Codex sessions to persisted history

Tasks:

- Watch or poll configured `codexRoots` after starting a Codex live session.
- Detect the newly written rollout file.
- Parse `session_meta.payload.id`, `cwd`, and timestamps.
- Store the persisted id as `conversationId`.
- Refresh scanner/cache for the Codex file.
- Surface `provider: "codex-cli"` on the resulting conversation metadata.

Tests:

- Fixture-backed test where a Codex rollout appears after process start.
- Session response starts with streamer's live id, then gains `conversationId`.
- `/api/conversations?provider=codex-cli` includes the new conversation after
  refresh.
- Existing read-only Codex tests keep passing.

### Phase 5 - Mobile start-session provider selector

Tasks in `tb-mobile`:

- Add provider option to the new-session start flow.
- Send `provider: "codex-cli"` only when Codex is selected.
- Treat missing session provider as Claude for older streamers.
- Keep terminal, input, stop, and WebSocket handling shared.
- Show provider on live session rows if the server includes it.

Tests:

- Starting Claude sends no provider or sends `claude-code` without changing
  behavior.
- Starting Codex sends `provider: "codex-cli"`.
- Session detail works with the same terminal stream and input actions.

### Phase 6 - Codex resume

Tasks:

- Based on Phase 0 verification, decide whether to expose Codex history as
  resumable.
- If viable, update `isProviderResumable()` for Codex only when the server can
  actually resume it.
- Route `/api/sessions/resume` for Codex conversations to the Codex runner.
- Preserve current `resumable: false` until the end-to-end path is proven.

Tests:

- Codex conversation detail remains `resumable: false` before this phase.
- After implementation, only verified-resumable Codex conversations return
  `resumable: true`.
- Resume returns a mobile-normalized session response.

## Compatibility Notes

Do not break any of these mobile contract points:

- Existing endpoint paths stay unchanged.
- Existing field names and status strings stay unchanged.
- `Authorization: Bearer <token>` and `/ws?key=<token>` both continue to work.
- Existing WebSocket event names stay unchanged.
- New provider fields must be optional for older clients.
- Unknown provider-specific fields should be additive only.

Recommended API additions:

- Optional request field: `provider?: "claude-code" | "codex-cli"` on
  `/api/sessions/start`.
- Optional response field: `provider?: "claude-code" | "codex-cli"` on live
  session responses.
- Optional response field behavior: `conversationId` may differ from `id` for a
  live Codex PTY until the persisted Codex rollout id is known.

## Risks

- Codex CLI may not expose stable session ids at process start. Mitigation:
  decouple live `id` from persisted `conversationId`.
- Codex TUI prompt markers may change. Mitigation: keep fallback readiness,
  debug logs, and focused marker tests.
- Bracketed paste may not behave the same as Claude. Mitigation: provider-owned
  input writer.
- Recursive watching of `~/.codex/sessions` may be noisy. Mitigation: watch only
  during live Codex session startup first, then consider long-lived watching.
- `tb-mobile` may assume `SessionStatus` is only `running | waiting_input |
  idle` in some TypeScript paths. Mitigation: keep those statuses for Codex.

## Files Likely To Change

Streamer:

- `src/types.ts`
- `src/providers.ts`
- `src/platform.ts`
- `src/pty-manager.ts` or new `src/live-session/*`
- `src/server.ts`
- `src/session-store.ts`
- `src/conversation-cache.ts` only if live Codex binding needs cache metadata
  changes
- `__tests__/codex-*.test.ts`
- `__tests__/pty-*.test.ts`
- `docs/compatibility/tb-mobile.md`

Mobile:

- `types/api.ts`
- start-session screen/hooks under `app/`, `hooks/`, or `components/servers/`
- session row/card provider display if live sessions should show the badge
- relevant Jest tests

## Suggested Verification Commands

Streamer:

```sh
npm run lint
npm test
npx vitest run __tests__/codex-api.test.ts __tests__/codex-scan.test.ts
```

Mobile:

```sh
npx eslint <touched ts/tsx files>
npm run test:ci
```

Manual end-to-end:

1. Start streamer from source on a non-default port with verbose logs.
2. Pair mobile or use an existing server entry.
3. Start a Claude session and confirm existing behavior is unchanged.
4. Start a Codex session for the same project.
5. Confirm mobile navigates on `session_ready`.
6. Confirm terminal output streams and replay works after leaving/re-entering the
   screen.
7. Send text input from mobile and confirm Codex receives exactly one submit.
8. Stop/hold the session and confirm status becomes `idle`.
9. Confirm the Codex conversation appears in history with `provider:
   "codex-cli"` after the rollout file is bound and scanned.

## Recommended First PR

Keep the first PR narrow:

1. Add provider to live session types/responses.
2. Validate optional `provider` on start.
3. Extract the current Claude PTY behavior behind a provider runner without
   changing behavior.
4. Add tests proving Claude behavior is unchanged.

Only after that lands should the Codex runner be added. That keeps the risky
refactor separate from the provider feature.
