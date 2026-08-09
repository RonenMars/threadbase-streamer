# tb-streamer — Codex active-writer fork, and the ADR 0001 streamer set (as of 2026-08-09 13:00)

Extracted from `../mobile/Mobile-LEFTOVERS.md` and `../mobile/Mobile-ADR-0001-LEFTOVERS.md`, then corrected against PR #463.
Treat as stale by default — re-check before acting.

## The server half of mobile #572 exists: it is PR #463, green and unmerged

**The mobile leftovers say the streamer half "does not exist — no `fix/codex-active-writer-resume` branch." That is false.**
PR #463 (`fix(codex): reject resume of a session Codex already has a writer for`) is on exactly that branch and implements all three fixes from the investigation: the authoritative startup handshake, the bounded `lsof` open-file preflight (`services/sessions/codexRolloutOwner.ts`, POSIX only), and `POST /api/sessions/:id/fork`.
All 11 checks are SUCCESS. The blocker is that nobody has merged it, not that it is missing.

Contract doc ships with the PR: `docs/compatibility/codex-collision-and-fork.md`.

### Both mobile assumptions are now answered — one of them the other way

| Mobile assumed | Actual, per #463 |
|---|---|
| The fork response carries the new rollout as `conversationId`, source stays the requested id | Close, but the shape differs: `id` is the fork's **local placeholder** until Codex writes its own rollout, then `boundConversationId` arrives over `session_update`. The source is `forkedFromConversationId`, a new optional field; `resumedFromConversationId` is deliberately left unset on a fork. |
| There is no idempotency key, which is why the failure path offers no Retry | **There is one.** `idempotencyKey` in the body replays the first outcome for 10 minutes, same as `POST /api/sessions/:id/input`. Unkeyed calls are not idempotent — each starts another Codex process and rollout. So the Retry affordance mobile withheld can come back, gated on sending a key. |

Also note the refusal keeps `code: "CONVERSATION_BUSY"` with an additive `reasonCode: "CODEX_SESSION_ACTIVE"` — chosen so released clients keep working — and `force` does **not** bypass it.

### Still genuinely unverified

The three live scenarios from the investigation report: a Codex session owned by a standalone terminal, by VS Code, and by the desktop app. Nothing has exercised those against #463.

## Streamer follow-up set from the ADR 0001 programme

`docs/followups/streamer/KICKOFF.md`, committed on the tb-mobile branch `docs/adr-0001-followups`, is a paste-ready kick-off for 3 tasks at the tb-streamer root.

**Its whole scope is reviewing and landing PRs #461 and #462, which already exist** — #461 resolves project paths from the recorded cwd instead of the lossy dir-name decode, #462 drops the dead `projects.message_count` column.
Do not let anyone reimplement them.
