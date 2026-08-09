# Claude Code Prompt: extend the exact-transcript open-file probe to Claude Code

Follow-up to the Codex active-writer work (`fix/codex-active-writer-resume`).
Read these first:

```text
docs/compatibility/codex-collision-and-fork.md
src/services/sessions/codexRolloutOwner.ts
src/services/sessions/conversationBusy.ts
```

## Kickoff message

```text
Can you extend the exact-file open-handle collision probe to Claude Code resumes?

Work in a new tb-streamer worktree created from the verified tip of the branch that carries the Codex active-writer fixes (fix/codex-active-writer-resume, or main once it has landed). Do not edit the primary checkout.

Start with the measurement step — do not implement anything until you have evidence about whether a live `claude` process holds its conversation JSONL open continuously. If it does not, stop and report that; the feature is not viable and the right outcome is a documented negative result, not a probe that never fires.

If it does: add `file_handle` as a Claude collision signal inside conversationBusy's caller, keep it force-overridable (unlike Codex, there is no provider-side lock behind it), and keep every existing Claude collision, force and adopt behaviour intact. Preserve compatibility with released mobile clients.

Do not commit or push. Show the staged diff, the measurement evidence, verification results, and a proposed conventional commit message, then wait for approval.
```

## Why this is a separate change

The Codex fix rests on Codex *refusing*: an internal single-writer lock, reported after `codex resume` starts.
That refusal is authoritative, so the streamer can wait for it, return `409` with `reasonCode: "CODEX_SESSION_ACTIVE"`, and reject `force`.

**Claude Code has no such lock.** Two `claude --resume` processes on one conversation both append to the same JSONL and neither complains.
So for Claude there is nothing authoritative to wait for, and:

- The post-spawn handshake (fix 1) must NOT be extended to Claude. It would add latency and learn nothing.
- The open-file probe (fix 2) *may* be worth extending, but only as a **heuristic** — a stronger sibling of `jsonl_mtime`, not a replacement for it, and always overridable with `force: true`.
- `codex fork` (fix 3) has no Claude equivalent. Do not invent one.

## Step 1 — measure before implementing (blocking)

The probe is worthless if Claude does not keep the transcript open. Establish that first, on this machine, and record the numbers in the PR body.

1. Start an interactive `claude` session in a scratch project and note its pid.
2. `lsof -F pc -w -- ~/.claude/projects/<dir>/<uuid>.jsonl` — does the pid appear?
3. Repeat **while idle at the prompt**, **mid-turn**, and **~60 s after the last turn**. Append-only writers commonly open, write and close per line, in which case the handle is visible only during a flush and the probe would miss a genuinely live session almost every time.
4. Repeat for a session started with `--resume` and for a fresh `--session-id` session.

Decision rule:

- Handle present in **all** idle samples → implement.
- Handle present only during writes → **stop**. Report the finding, and record it in `docs/compatibility/codex-collision-and-fork.md` (or a sibling doc) so nobody re-derives it. A signal that fires only while the file is being written adds nothing over `jsonl_mtime`, which already covers exactly that window.

## Step 2 — implementation, if the measurement supports it

Scope is deliberately small; the machinery already exists.

- Reuse `findRolloutOwner()` from `src/services/sessions/codexRolloutOwner.ts`. Rename the module to something provider-neutral (`transcriptOwner.ts`) **only if** you also update the Codex call site and the doc references in the same commit — no dangling names.
- Call it from `resumeSession()` for `CLAUDE_CODE_PROVIDER` using `historyPath`, which `resolveConversationTarget()` already returns. For Claude that is `findJsonlPath()`'s result, so the exact path is already known — do not scan a directory.
- Feed the result into the existing `conversationBusy` outcome as another `detectedBy` entry (`"file_handle"` is already in the `BusySignal` union), rather than a second parallel refusal path. The Claude response shape must stay `code: "CONVERSATION_BUSY"` with `canForce: true`.
- `likelyOwner` becomes `"external"` when a foreign pid holds the file — that is concrete ownership evidence, same as `process_argv`.
- Keep the 800 ms cap and the `SIGKILL`-on-timeout teardown. The current implementation kills the child and destroys its pipes on timeout because a stray `lsof` outlived a polite SIGTERM and held the event loop open past server shutdown — a test hung for 14 s on exactly this. Do not relax it.
- Exclude our own pid, and exclude pids of PTYs this streamer owns (`ptyManager.getPid`) — resuming a conversation we already hold returns 200 from the `hasSession` early-return, but a held-then-resumed session must not read as foreign.

## What must not change

- No post-spawn handshake for Claude.
- `force: true` must continue to bypass every Claude collision signal, including this one.
- No new top-level error `code`; no renamed or removed fields, endpoints, statuses or WS events.
- The Codex path keeps its authoritative semantics: `canForce: false`, `reasonCode: "CODEX_SESSION_ACTIVE"`, probe result not overridable.
- No kill/takeover path derived from a returned pid.

## Tests

- The probe reports a foreign holder of the exact Claude JSONL, and `detectedBy` contains `"file_handle"`.
- A pid belonging to a PTY this streamer owns is not reported as a collision.
- `force: true` still resumes past a `file_handle` hit for Claude (and still does **not** for Codex).
- Probe timeout / missing `lsof` / win32 falls through to the existing mtime + process signals, and the resume still succeeds.
- Every existing Claude collision, force and adopt test stays green.

Run the focused tests first, then `npm run lint && npm test` under the Node version in `.nvmrc`.
Note that this box fails a set of unrelated suites under full-suite load (`pair-endpoints`, `security-hardening`, `watch-for-jsonl`, `webhook-update`, `cors-middleware`, `discovery-cache`) — compare against the untouched base commit before attributing any of them to your change.
