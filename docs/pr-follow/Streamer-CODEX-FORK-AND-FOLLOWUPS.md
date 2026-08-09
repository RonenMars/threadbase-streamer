# tb-streamer — Codex active-writer fork, and the ADR 0001 streamer set (as of 2026-08-09 17:45)

Extracted from the tb-mobile leftovers notes, then corrected against PR #463.
Treat as stale by default — re-check before acting.

## The server half of mobile #572 exists, and is now merged

**The mobile leftovers say the streamer half "does not exist — no `fix/codex-active-writer-resume` branch." That is false.**
PR #463 (`fix(codex): reject resume of a session Codex already has a writer for`) is on exactly that branch and implements all three fixes from the investigation: the authoritative startup handshake, the bounded `lsof` open-file preflight (`services/sessions/codexRolloutOwner.ts`, POSIX only), and `POST /api/sessions/:id/fork`.

**Status: MERGED into `integration/prs-223-441-…-456`, not into `main`.** GitHub closed it as merged automatically when that branch — its base — was advanced to contain its commits. #465 (the claude open-file measurement) rode along the same way.
So `main` still has none of this; the contract only reaches clients when the integration branch lands.

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

Both are still **open against `main`**, though their content is already on the integration branch (by content equivalence — they were rebased, so a SHA-ancestry check reports them absent).
Landing them means merging them to `main`, or letting the integration branch carry them there.
