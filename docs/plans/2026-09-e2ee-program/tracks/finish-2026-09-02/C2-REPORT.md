# C2 report — silence timer, pending-prompt guard, fragmented-frame test

Agent: C2 (Fable 5.1, running the Sonnet 5 / medium brief). Task file: `agents/C2-sonnet5-medium.md`.

## Milestone 1 — both issues filed (2026-09-04)

Preconditions re-verified from the remote rather than from the brief:

- Mobile `origin/main` = `c64fab5e`, which is the squash of C1's PR #942 (`fix(e2ee): remember a permanent open refusal so a later 429 cannot revive it`), merged 2026-09-03 23:32 UTC. The brief said #942 was still open; it is not.
- Mobile open PRs: #945 and #879, both dependabot. No slot held.
- Streamer `origin/main` = `d9148f25`, latest tag `v1.74.0`.
- `gh repo view RonenMars/threadbase-mobile --json owner` → `RonenMars`.
- No branch and no worktree created. Waiting for the owner's go.

Issues filed on `RonenMars/threadbase-mobile`:

| Item | Issue | Title | Labels |
|---|---|---|---|
| Defect 3 | [#946](https://github.com/RonenMars/threadbase-mobile/issues/946) | P1: an idle session redials the socket every 45 s because no server frame ever arrives, and each redial is now a Noise handshake | P1, bug, performance |
| Defect 4 | [#947](https://github.com/RonenMars/threadbase-mobile/issues/947) | P2: a pending prompt leaves the Terminal view with no way to send a key, so a stuck prompt cannot be dismissed from the phone | P2, bug, ux |

## Findings that change the brief

### Defect 3 — the client already resets on any inbound frame

`hooks/useTerminalStream.ts:271-272` subscribes to `'*'` and resets the silence timer on every parsed message; `services/ws-client.ts:318-322` fires wildcard handlers for every frame. That landed in #143 on 2026-06-17 and is pinned by `__tests__/unit/hooks/useTerminalStream.watchdog.test.tsx` ("any inbound message resets the silence timer"). The brief's "likely fix" is therefore already the behaviour, and it was the behaviour during the 2026-09-02 measurement.

Why the timer still fires at idle: the streamer sends an idle client nothing the JS layer can see. Its only liveness signal is a WebSocket **protocol** ping every 30 s (`src/ws-hub.ts:15`, `client.ping()` at `:488`), which React Native handles below `onmessage`. `host_pressure` is pushed only on a level change and `session_list` only on membership change.

The streamer's own spec (`NONCE-DESIGN.md` §18) and code comment (`src/ws-hub.ts:257-262`) say the client's silence timer depends on an app-level `{ type: "ping" }` frame. The type is declared at `src/types.ts:339`; **nothing in `src/` constructs or sends one.** Positive control on the same grep: `type: "session_list"` constructions found in three files.

Consequence: the substantive fix is the streamer emitting the ping it already promises, at a cadence under 45 s, sealed like every other frame. That is a two-repo item; the streamer half needs its own issue there and has not been filed by C2 (outside the mobile brief; awaiting the owner's routing). The mobile half is a contract-pin test for the `ping` type, a corrected `docs/e2ee-client.md`, and the timer staying longer than the server cadence. `PAIR_EXCHANGE_LIMIT` is untouched and named as out of scope in the issue.

### Defect 4 — the guard is a server 409 that already exempts raw keys

The refusal is `POST /api/sessions/:id/input` answering 409 `prompt_pending` on `{ input }` while the session is in the server's pending maps (`sessions.handlers.ts:1059-1108`). The same route **deliberately does not arbitrate `{ keys }`** ("Esc and arrow nav are how a card is dismissed", `:1059-1064`). On mobile, `sendKeys` exists (`hooks/useSessionActions.ts:48-55`) but the Terminal view reaches it only from a prompt card's own controls; the composer posts `{ input }`, and there is no key toolbar in `components/terminal/`.

Design choice, pending the owner's approval: **exempt the Terminal view by giving it a raw-key path** (Escape at minimum) through the existing un-arbitrated `{ keys }` route. Not by sending composer text as keys, which is the exact hazard the server guard exists for (prose typed over an open picker approved a tool call in a live capture). The "clear the guard when the prompt is no longer open" option is not a client change: the pending map lives on the server and outlived the prompt record in the capture (Escape written to the PTY on the host did not clear it). That is a streamer defect and needs its own issue there.

### Defect 5 — what a jest test can and cannot drive

The React Native WebSocket API delivers whole messages to `onmessage`; frame reassembly happens in the native layer (SocketRocket on iOS, OkHttp on Android). `__tests__/unit/services/ws-client.test.ts` replaces `global.WebSocket` with a mock and calls `onmessage` directly, so a jest test at that seam can only hand the record layer an already-reassembled message. It cannot exercise native reassembly.

Two honest options, decision requested from the owner:

1. **Jest, `ws` server → `ws` client, real fragmentation on the wire.** `ws` 8.x `send(data, { fin: false })` emits an opcode-2 frame followed by opcode-0 continuations. This proves the record layer unseals a message that arrived fragmented, and the negative control (a receive path that unseals each fragment independently) goes red. But the client under test is Node's `ws`, not React Native's native layer, and the PR body must say so.
2. **Maestro flow against a fragmenting `e2e/mock-server.js`.** The mock server already uses `ws` (`e2e/mock-server.js:7`), so it can emit fragmented frames to the real app on the simulator. This drives the actual iOS native reassembly. But the mock server is plaintext (no E2EE), so the assertion is "the terminal renders the fragmented output", not "the record layer unseals", and the sealed path is exercised only in option 1.

Recommendation: both, with option 1 in the unit suite and option 2 as one Maestro flow, because neither alone covers what the brief asks for. Scope check needed before building either.

## Next gate

Owner confirms: (a) C2 may branch now that #942 is merged; (b) the defect-4 design choice; (c) who files the two streamer issues; (d) the defect-5 test shape.

## Milestone 2 — defect 3 mobile half staged (2026-09-04)

Owner's go received; #942 merge re-verified from the remote (`gh pr view 942` → MERGED, merge commit `c64fab5e` = `origin/main`, head branch gone). Worktree `../tb-mobile-worktrees/e2ee-silence-prompt`, branch `fix/terminal-escape-and-ping-liveness` off `c64fab5e`, own `npm ci`. Nothing committed or pushed.

Staged (+34/−3, four files): `WSMessage` gains `{ type: 'ping'; ts: number }`; `WS_SILENCE_TIMEOUT_MS` comment explains why the wildcard reset is load-bearing and why 45 s must exceed the 30 s server cadence (constant unchanged, `forceReconnect` untouched); new test `useTerminalStream.watchdog.test.tsx::"a server ping frame with no session payload resets the silence timer"`; `docs/e2ee-client.md` corrected.

Gates: watchdog suite 7/7, `tsc --noEmit` exit 0, `eslint --max-warnings=0` exit 0 on the changed TS files. Full unit suite deferred to the end of the PR.

Mutations (restored from file backup, 7/7 re-confirmed after each):

| Mutation | Result |
|---|---|
| M1 `client.on('*')` → `client.on('terminal_output')` | 2 red: new test at `:122` `expect(__wsTest.forceReconnect).not.toHaveBeenCalled()` (Received 2); pre-existing "any inbound message resets the silence timer" at `:103` (Received 1) |
| M2 keep `'*'` but `if (msg.type !== 'ping') resetSilenceTimer()` | exactly 1 red: the new test, same assertion at `:122` (Received 2); pre-existing test stays green, which is what makes the new one non-redundant |

The streamer half (emitting the ping) is not built; #946 stays open on the mobile side until it ships, and the PR body says so.
