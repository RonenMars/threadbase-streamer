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

## Milestone 3 — defect 4 staged (2026-09-04)

Shape built, on the assumption stated to the owner (no "stop" received): the Terminal view gains a raw-key path, never a re-route of composer text.

- `components/conversation/ChatComposer.tsx`: optional `sendErrorAction?: { label; onPress }` rendered as one tappable line under `sendError` (`testID="send-error-action"`).
- `components/terminal/TerminalView.tsx`: when `sendInput` last failed with `prompt_pending` and the answer ghost is not in flight, the action is "Send Escape to dismiss it" → `sendKeys.mutate('\x1b')`, i.e. `POST …/input { keys }`, which the server deliberately does not arbitrate (`sessions.handlers.ts:1059-1064`). Composer text still goes through `{ input }` and is still refused.
- `locales/{en,he,ar,ru}/terminal.json`: `answer.sendEscape`.
- `__tests__/integration/components/TerminalView.test.tsx`, new describe "send refused with no card to answer": (1) refusal with no card → the server message stays (positive control), pressing the action calls `sendKeys` once with `'\x1b'` and `sendInput` not at all; (2) no refusal → no action; (3) a non-`prompt_pending` refusal → message shown, no action.

Gates: TerminalView suite 33/33 (30 pre-existing + 3); `tsc --noEmit` exit 0; `eslint --max-warnings=0` exit 0 on the three TS files; `npm run test:i18n` 4 suites / 460 passed.

Mutations (file-backup restore, verified by grep before and after):

| Mutation | Result |
|---|---|
| M3 delete `sendErrorAction={sendEscapeAction}` | exactly 1 red: `TerminalView.test.tsx::"offers Escape through the raw-key route, and never re-sends the text as keys"` at `:642`, `screen.getByText(SEND_ESCAPE)` finds no element |
| M4 send `'\r'` (Enter, which would accept the highlighted option) instead of `'\x1b'` | see below |

Note: the first M4 attempt was cut by a 10-minute tool timeout with the file still mutated; the file was restored from the backup and verified (`grep -c "mutate('\\x1b')"` = 1) before anything else ran, and M4 was re-run on its own.

Not done: `ChatComposer` has no story and is not in `story-exempt.txt`; the pre-commit hook warns on a modified component, it does not block. A story needs the voice and attachment props wired up, which is not a small addition, so it is left out and disclosed.

## Milestone 4 — streamer issues filed, suites green, defect 5 resolved by analysis (2026-09-04)

Owner rulings received: defect-4 shape approved; C2 files both streamer issues; defect 5 is option 2 only, or a written analysis if the Maestro setup is disproportionate; commit and PR approval delegated to the owner after seeing the staged diff and verbatim messages.

Streamer issues (owner check on `RonenMars/threadbase-streamer` → `RonenMars`):

| Issue | Title | Labels |
|---|---|---|
| [#756](https://github.com/RonenMars/threadbase-streamer/issues/756) | P1: the app-level ping frame the silence watchdog depends on is documented but never sent — written as tracking agent P's in-flight fix; quotes `ws-hub.ts:257` verbatim; pins `{ type: "ping", ts }` and the 30 s cadence as contract | P1, bug, performance |
| [#757](https://github.com/RonenMars/threadbase-streamer/issues/757) | P2: prompt_pending refuses input on a pending map that can outlive the prompt record — cites #724 as adjacent | P2, bug, provider |

M4 result: exactly 1 red, `TerminalView.test.tsx::"offers Escape through the raw-key route, and never re-sends the text as keys"` at `:644`, `expect(mockSendKeysMutate).toHaveBeenCalledWith('\x1b')`, Received `"\r"`. Restore verified by grep.

Full suites on the restored tree: **unit 1849/1849 (187 suites), integration 475/475 (64 suites)**, both via the repo scripts with `--forceExit`. `tsc --noEmit` exit 0 (run after the last edit). eslint 0 on all six staged TS files. `test:i18n` green.

### Defect 5 — deferred to a written analysis, with the reasoning chain and the residual risk

**Why not the Maestro route tonight.** Start-of-session record, 07:48:45 IDT: `xcrun simctl list devices booted` empty; `simctl list devices available` shows the iOS 26.5 runtime with **zero devices** created; no Release build exists for the runner to reuse except two in unrelated worktrees (`promo-04-e2e-verify`, `setup-yaml-mock-verify`) whose JS bundles are from other branches; Metro on :8081 belongs to another session (pid 10586) and is not mine to touch; Maestro 2.8.0 is installed. Getting to a run means creating a device, either rebuilding Release (a full Xcode build) or reusing a build I cannot prove fresh, modifying the mock server, writing a flow, and running it — the stale-bundle case is exactly the "empty-looking pass" trap G recorded, so the reuse shortcut is not safe. That is disproportionate under the authorised stop rule.

**The reasoning chain**, stated so a reader can check it rather than trust it:

1. React Native's `WebSocket` hands JavaScript whole messages. On iOS, `React/CoreModules/RCTWebSocketModule.mm` (RN 0.86.3) delegates to SocketRocket's `SRWebSocket`; on Android, `ReactAndroid/.../websocket/WebSocketModule.kt` calls `OkHttpClient.newWebSocket` (OkHttp 4.9.2 per RN's `libs.versions.toml:37`) and forwards `onMessage(text | ByteString)`. Both are RFC 6455 implementations that reassemble continuation frames below the message callback. JS never sees a frame; it sees a message.
2. Therefore the mobile record layer (`services/ws-client.ts` `onmessage` → `context.recv.unseal`) **cannot ever see a fragment**. A jest test at the mocked `global.WebSocket` seam would hand it a whole message by construction and could not fail for a fragmentation reason. Option 1 was correctly rejected on those grounds.
3. Sealing changes the payload, never the framing. G observed the same frame shapes on the plaintext and sealed legs at ~114× MSS. So a fragmented sealed message and a fragmented plaintext message exercise the identical native path: fragments → native reassembly → one whole message → the record layer, which is already tested with whole messages (including the `ArrayBuffer` shape from #940).
4. The only open question is therefore "does the native layer under our pinned RN reassemble correctly", and the only instrument that can answer it is the real app receiving deliberately fragmented frames — the Maestro option, or a rig capture behind a re-fragmenting intermediary.

**Two instruments, blind to the same thing for two different reasons** (carried forward at the owner's request): a capture against this streamer can only ever show fragmentation's *absence*, because `ws` 8.21.3 never emits `fin: false` from `ws-hub.ts:299`; a jest test cannot show anything either, because the seam it mocks sits *above* native reassembly. Neither is a weak version of the other; each is structurally the wrong place to look.

**Residual risk.** Not observed on this build: that SocketRocket or OkHttp mis-reassembles a fragmented binary message on the pinned versions. Both libraries have carried continuation handling for years and it is exercised by every browser-grade server that fragments large messages, so the prior is low, but this program's rule is that a prior is not an observation. The gate this item guards is the stage-2 flip; the honest statement is "reasoned, not observed".

**Recipe for the observation when hardware is up** (not built, so nothing untested ships): `e2e/mock-server.js` gains a `MOCK_FRAGMENT_BYTES=<n>` mode that sends each `terminal_output` echo as `ws.send(chunk, { fin: false })` followed by `ws.send(rest, { fin: true })` (ws's Sender emits opcode 0 for the continuation automatically); the existing chat flow's echo assertion is the positive path; the **negative control** is a second mode that sends the same chunks each with `fin: true` — three complete but individually unparseable messages — which must turn the echo assertion red, proving the harness distinguishes reassembled from not. Run on a freshly built Release app whose bundle contains this branch.

## Milestone 5 — committed and PR opened (2026-09-04)

Owner approved both commits verbatim (approval delegated to the owner by the user for this run).

- `2fa24074` `test(e2ee): pin the server ping as the silence watchdog's liveness signal` (4 files, +34/−3). Pre-commit hooks printed nothing.
- `20a864d8` `fix(terminal): offer Escape when a pending prompt refuses composer text` (7 files, +76/−4). Pre-commit hook output verbatim: `Storybook: modified component(s) with no story — add one if it's small:` naming `components/conversation/ChatComposer.tsx` and `components/terminal/TerminalView.tsx`. The lint stage printed nothing. TerminalView had not been disclosed before the hook named it; the PR body now names both. Neither commit received `[skip-ci]`.
- Branch pushed; **PR #948** opened against `main`: `fix(terminal): send Escape past a pending prompt and pin the ping liveness contract`. The owner merges, not C2.

Expected on merge: #947 closes; #946 and streamer #756 stay open until a streamer carrying P's ping ships; #757 is untouched.

Track deliverables: issues #946, #947, #756, #757 filed · defect 3 mobile half merged-pending · defect 4 fix merged-pending · defect 5 deferred with the reasoning chain, residual risk and recipe recorded above.
