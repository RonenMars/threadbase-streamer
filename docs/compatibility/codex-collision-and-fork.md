# Codex active-writer collisions and fork — client contract

**Status:** implemented in the streamer (2026-08-09). Mobile work not started.

Codex enforces a **single writer per rollout** and only reports the refusal after `codex resume` starts: `already has an active writer (code -32600)`.
The streamer used to answer `201`, then the session went idle with no structured failure, and mobile sat on its pending screen until the 20-second stuck-session fallback.

Two things changed, plus one new endpoint.
Everything below is **additive**: no field, endpoint, status value or event was renamed or removed, and a client that ignores the new fields behaves exactly as it does today.

## 1. The collision response

`POST /api/sessions/resume` answers `409` for a Codex conversation another client owns.

```json
{
  "error": "This Codex session is already open in another client",
  "code": "CONVERSATION_BUSY",
  "reasonCode": "CODEX_SESSION_ACTIVE",
  "provider": "codex-cli",
  "detectedBy": ["file_handle"],
  "lastActivityMs": null,
  "likelyOwner": "external",
  "canForce": false,
  "canTakeOver": false,
  "canFork": true,
  "ownerPid": 9935,
  "ownerSource": "terminal"
}
```

- `code` stays `CONVERSATION_BUSY` deliberately. Released mobile builds switch on that string; a new top-level code would surface as a generic network error with no recovery UI.
- `reasonCode: "CODEX_SESSION_ACTIVE"` is what distinguishes Codex's authoritative lock from the existing heuristic collision.
- `detectedBy` gains one value, `"file_handle"`: another process holds the exact rollout JSONL open. It is `[]` when the collision was reported by Codex itself after spawn (there is no signal to name — Codex is the signal).
- `ownerPid` / `ownerSource` are present only when the pre-flight identified the holder. `ownerSource` is `"terminal"` only when the owning command is exactly `codex`; anything else is `"unknown"`, because a VS Code or desktop `codex app-server` can host unrelated threads.
- `lastActivityMs` is `null`: this response is not derived from file mtime.

The existing Claude `CONVERSATION_BUSY` body is unchanged except that it now also carries `canForce: true`, `canTakeOver: <likelyOwner === "external">`, `canFork: false`.

### What clients must do

- **Honour the capability flags, never `likelyOwner`,** when deciding which actions to offer. Treat a missing flag (older streamer) as today's behaviour.
- **Do not offer "Resume anyway" when `canForce` is false.** `{ "force": true }` only ever bypassed the streamer's own heuristic; it cannot bypass Codex's lock, and the server returns the same `409` for a forced request.
- **Do not offer "Take over".** There is no way today to prove the owner is a standalone TUI rather than a shared app-server, so no process is ever signalled.
- Offer **Cancel** and **Fork into Threadbase** (when `canFork`), and say plainly that a fork is a separate continuation — the original thread stays with its current owner and the histories diverge from the fork point.

### Other Codex resume failures

A Codex resume that fails to start for any other reason now answers `502 { "error": <reason>, "code": "SESSION_START_FAILED", "provider": "codex-cli" }` instead of a `201` followed by a silent idle session.
A resume that is merely slow still answers `201` and finishes booting in the background — unchanged.

## 2. `POST /api/sessions/:id/fork`

Codex only. `:id` is the source conversation (a rollout id, or a placeholder the registry can resolve).

Request body — every field optional:

```json
{ "projectName": "tb-streamer", "branch": "main", "idempotencyKey": "…" }
```

Responses:

| Status | Body | Meaning |
|---|---|---|
| `201` | the new session (same shape as a resume `201`) | Fork is live and ready |
| `202` | `{ id, status: "pending", forkedFromConversationId }` | Spawned, still booting — wait for `session_ready` / `session_update` as with any pending session |
| `409` | the collision body above | Codex refused the fork too |
| `404` | `{ error, code: "history_file_missing" }` | The source history is gone |
| `400` | `{ error }` | The source project path could not be resolved |
| `501` | `{ error, code: "UNSUPPORTED_PROVIDER", provider }` | Not a Codex conversation — the server never silently falls back to resume |
| `502` | `{ error, code: "SESSION_START_FAILED", provider }` | The fork process failed to start |

Identity:

- The response's `id` is the **fork's** id — a local placeholder until Codex writes its own rollout, at which point `boundConversationId` arrives over `session_update` (same flow as a fresh Codex session).
- `forkedFromConversationId` carries the **source** id. It is a new optional field on the session shape, distinct from `resumedFromConversationId`, which is deliberately left unset on a fork.
- The source rollout is never resumed, written to, or signalled.

**Not idempotent.** Every accepted call starts another Codex process and another rollout. A client that retries on timeout must send `idempotencyKey`; the first outcome is replayed for 10 minutes, exactly as for `POST /api/sessions/:id/input`.

## 3. Where this is enforced

- `src/services/sessions/codexRolloutOwner.ts` — the bounded pre-flight (`lsof` on the exact rollout, 800 ms hard cap, POSIX only). A null result is "no evidence", never "free".
- `src/codex-pty-runner.ts` — `CODEX_ACTIVE_WRITER_RE` against the rendered screen, and `failStartup()`, which tears the session down without ever firing `onReady`.
- `src/server.ts` — `resolveConversationTarget()`, the post-spawn handshake in `resumeSession()`/`handleFork()`, and `codexSessionActiveBody()`.

## Still unverified

The live matrix from the report is not covered by tests: a real Codex session owned by a standalone terminal, by VS Code, and by the desktop app, plus a real `codex fork` producing a usable independent rollout.
