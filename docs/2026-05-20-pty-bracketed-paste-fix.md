# Postmortem: PTY `@<path>` prompts hung Claude indefinitely

**Date:** 2026-05-20
**Severity:** High — mobile users could not start any session whose first prompt contained an `@<path>` reference (the standard pattern for image attachments). The workaround was to send a second message, which submitted both as one combined turn.
**Status:** Resolved.
**Components:** `src/pty-manager.ts` (streamer), Claude Code TUI v2.1.138 (third-party, via PTY).

## Symptom

User starts a session, uploads an image, sends a prompt like:

```
@/Users/ronenmars/Desktop/dev/<project>/.threadbase-uploads/<id>/IMG_5192.heic What is in this image?
```

Mobile shows status `Running` and the prompt rendered in the terminal pane. No response from Claude ever arrives. The session sits this way indefinitely. Sending any second message (even a single dot) unsticks it: Claude then processes the **combined text of both messages** as a single user turn.

Streamer-side: the session is `running`, `lastActivityAt` was set when `pty.ready` fired (right after spawn), and a JSONL file for the conversation was never created on disk. Claude (`ps` PID) is alive but idle on CPU.

## Investigation timeline

1. Initial hypothesis: HEIC parsing in Claude. Disproved — sessions with HEIC succeeded sometimes, and Claude's "image too large to read" path normally falls back to text-only without hanging.
2. Second hypothesis: input never reaching the PTY. Disproved by running `sample` on the stuck Claude PID — Claude's main thread was idle in `kevent64`, HTTP-client thread idle in `kevent64`, all worker threads idle. Process was simply waiting for input.
3. Third hypothesis: Claude's `@`-mention autocomplete picker eats `\r`. ESC prologue was added to dismiss any open picker. Tests passed. **Deployed, then a fresh repro proved this didn't fix it** — and the iOS screenshot showed the prompt was sitting visibly typed in Claude's input box, unsubmitted.
4. Added byte-level instrumentation: `[pty.input.write]` (every byte sequence we write) and `[pty.chunk]` (every chunk Claude echoes back, with a control-char-escaped digest). Redeployed and reproduced.

The instrumented logs were decisive. The bytes written looked correct:

```
[pty.input.write] da49f1e0 promptCount=1 bytes=148 digest=@/Users/.../IMG_5192.heic Hi\r
```

But Claude's response chunks after the write showed:
- The prompt being **typed** into the input box (cursor positioning + literal text)
- **No** submit-related output (no input-box clear, no `Pasting…` indicator, no spinner, no title-set sequence)
- After 30s, only unrelated MCP/plugin status banners ("1 plugin failed to install", "7 MCP servers need auth", etc.)

Crucially, chunk #2 from session boot showed:

```
\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h
```

`\x1b[?2004h` is the **enable-bracketed-paste-mode** sequence. Claude's TUI enables bracketed paste at startup.

## Root cause

Claude Code's TUI is built on Ink. Its `<TextInput>` has special handling for `@`: typing `@` opens a file-mention autocomplete picker. While the picker is active, the Enter key is captured as "accept the highlighted completion" instead of "submit the prompt".

When the streamer wrote `@/path Hi\r` as raw text:
1. Claude saw `@` → opened the mention picker, populated with filesystem matches
2. The path characters were typed in
3. The trailing `\r` was consumed by the picker as "accept current completion" — except the user-typed text didn't match a completion entry, so the picker just stayed open (or dismissed silently) with the text intact in the input buffer
4. The text never became a "submit" event

When the user sent a second message later, those bytes appended to the existing input buffer, the second `\r` happened to land outside the picker's keymap context, and the whole combined buffer submitted as a single turn. This matched the observed JSONL content: e.g. one stuck session showed `...How are you doing?\rtest` as a single user message after the second submit, with the embedded `\r` proving the first Enter was literal text, not submit.

## The fix

Wrap every input in bracketed-paste markers before submitting:

```ts
function buildSubmitBytes(input: string): string {
  return `\x1b[200~${input}\x1b[201~\r`;
}
```

`\x1b[200~` opens a paste; `\x1b[201~` closes it. Content between the markers is committed to the input field as a single insertion **without** triggering autocomplete, mention pickers, or key bindings. The trailing `\r` lands outside the paste block and is processed by the normal keymap as Enter → submit.

This was empirically verified live on a stuck session before shipping. Sending `\x1b[200~test\x1b[201~\r` to the still-stuck PTY caused Claude to immediately render a `Pasting…` indicator, clear the input box, and start a turn — submitting the previously-buffered prompt plus the test text together.

## Verification

A fresh session after the fix:

| Time | Event |
|---|---|
| 18:09:50.487 | Spawn |
| 18:09:51.454 | `pty.ready marker:╭` (108ms) |
| 18:10:18.401 | `POST /input` — bytes: `\x1b[200~@/Users/.../IMG_5192.heic Test123\x1b[201~\r` |
| 18:10:18.443 | `pty.ready marker:❯` — **42ms** later, turn complete |
| 18:10:22 | Assistant response in JSONL |

JSONL recorded exactly one clean user message (no embedded `\r`, no merged text from any second submit).

## Lessons

1. **Don't trust a fix that's "consistent with the theory" without empirical proof.** The ESC hypothesis was plausible and tests passed, but the live system disagreed. Byte-level instrumentation was the only thing that resolved the ambiguity.
2. **Sometimes the right tool is `sample`/`dtruss` on the misbehaving process**, not more code. Confirming Claude was idle on `kevent64` ruled out three plausible theories in 30 seconds.
3. **When a third-party TUI is in the loop, "raw text + \r" is wrong by default.** Terminal apps that support bracketed paste use it to disambiguate "machine wrote this" from "human typed this". The streamer is acting as a machine; it should always paste, never type.
4. **A "sometimes works" bug is still a bug.** The fact that some `@<path>` prompts went through and others didn't pointed at a state-dependent TUI behavior rather than a deterministic byte-level mistake — but the correct response was still to eliminate the state dependence, not to wait for more data points.

## Related mobile bug (separate, found in the same session)

While the streamer was being redeployed to test fixes, an active mobile session was abruptly killed mid-turn. After the streamer came back up, mobile continued to show the now-defunct session as `Running` with `ptyAttached: true` — its locally cached state, unrefreshed. The session detail screen had no `AppState` listener, so backgrounding and foregrounding the app did not trigger any refetch.

Fix in tb-mobile: `WSClient.forceReconnect()` + `AppState 'active'` listener on `app/session/[id].tsx` that invalidates the session + terminal queries and forces a WS reconnect. See [tb-mobile/docs/2026-05-20-pty-bracketed-paste-fix.md](../../tb-mobile/docs/2026-05-20-pty-bracketed-paste-fix.md).

Additionally, `scripts/deploy.sh` now refuses to redeploy while live PTY sessions exist (unless `--force`). Counts `"ptyAttached":true` entries in `GET /api/sessions`. Treats an unreachable server as proceed-OK.

## References

- Test: `__tests__/pty-ready-detection.test.ts` — three tests lock in the byte sequence sent to Claude's PTY.
- Code: `src/pty-manager.ts` `buildSubmitBytes()`.
- Instrumentation kept in place: `[pty.input.write]` and `[pty.chunk]` log lines (info level, surface under `--verbose`). Invaluable diagnostic for any future PTY-shaped bug; do not remove without a good reason.
