# Prompt — close the SessionStore copy-vs-reference trap

> ## ⚠️ COMPLETE — historical record, do not execute
>
> Shipped as **[PR #336](https://github.com/RonenMars/threadbase-streamer/pull/336)** (2026-08-01), option (1) as written: `get()`/`list()` now return `Readonly`, `enrichResumedSessionAsync` writes through `updateManaged()`, and `handleGetSession` builds a new object.
>
> Two things it predicted and one it did not:
>
> - The "stop and report if `Readonly` breaks more call sites" instruction did its job — `tsc` flagged exactly the two named functions, confirming the bug was a one-off rather than a pattern.
> - The `Date`-versus-ISO-string trap was real, and **worse than described**: `new Date(<unparseable>)` yields an `Invalid Date` that `managedToResponse` throws on, so a naïve port would have turned a silent no-op into a 500. The fix reuses `parseIsoDateOrNull`.
> - The open design question was answered rather than deferred: `resumeSession()` now reads its response *after* enrichment, so the `201` carries the enriched shape.
>
> Kept because the framing — the class table, the "assert against the store" instruction, the blast-radius check — is what made the resulting PR come out right, and is worth reusing.

Paste everything below the line into a fresh session.

---

Fix a silent state-loss bug in `tb-streamer` **and** the API shape that produced it, in one PR. Repo: `/Users/ronenmars/dev/ai-tools/tb-streamer`. Read `AGENTS.md` and `CLAUDE.md` first — their conventions are binding.

This is a streamer-only task. Nothing here touches tb-mobile.

## The bug

`enrichResumedSessionAsync` (`src/server.ts:4410`) resolves a dozen fields after a resume — `sessionName`, `messageCount`, `account`, `filePath`, `model`, `preview`, `firstMessageText`/`firstMessageAt`, `lastMessageText`/`lastMessageAt`, `projectId`, `resumedFromConversationId` — and writes every one of them to a value that is thrown away:

```ts
const session = this.sessionStore.get(sessionId, this.ptyAttachedIds());
if (!session) return;
session.sessionName = conv.sessionName ?? undefined;   // ← lost
```

`SessionStore.get()` (`src/session-store.ts:82`) returns `managedToResponse(managed, …)` — a **freshly constructed object literal**, not a reference into the store. The repository writes in the same function (`upsertProjectByPath`, `updateConversationProjectId`) *do* persist, and the fields usually reappear later from the scanner or cache, which is why this has never been reported.

## The class — this is the part that matters

Fixing that one function leaves the trap intact. `SessionStore` exposes two pairs of getters with **opposite mutation semantics and no type-level distinction**:

| Method | Returns | Mutating the result |
|---|---|---|
| `getManaged(id)` (`src/session-store.ts:45`) | `this.managed.get(id)` — the **live object** | changes the store |
| `get(id, ptyAttachedIds)` (`:82`) | `managedToResponse(…)` — a **fresh copy** | changes nothing |
| `listManaged()` (`:56`) | live references | changes the store |
| `list(ptyAttachedIds)` (`:63`) | fresh copies | changes nothing |

And mutating a copy is **correct** in one context. `handleGetSession` (`src/server.ts:4132`) decorates the response before serving it:

```ts
const session = this.sessionStore.get(sessionId, this.ptyAttachedIds());
if (session) {
  if (!existsSync(session.projectPath)) session.failureReason = `Project directory not found: …`;
  const reconciled = this.withReconciledLifecycle([session])[0];
  session.lifecycle = reconciled.lifecycle;
  session.lifecycleSource = reconciled.lifecycleSource;
```

That is the right use of a copy. Which is exactly why the idiom "get a session, mutate it, done" is now normalised in this codebase — right when building a response, silently wrong when persisting state, and indistinguishable at the call site. The next person to copy that shape into a persistence context reintroduces the bug.

## What to do

**One PR containing all three parts.** Ship the guard together with the instance it catches, so the fix is provably not a one-off.

### 1. Make the copy semantics compile-enforced

- `get()` returns `Readonly<SessionResponse> | null`.
- `list()` returns `readonly Readonly<SessionResponse>[]` (and `paginate()` if the same shape applies — check).
- Leave `getManaged` / `listManaged` alone: they hand out live references on purpose, and `updateManaged` is the supported way to write.

Add a short doc comment on each pair stating which is which. The types carry the guarantee; the comment carries the *why*.

### 2. Fix the two legitimate mutators in `handleGetSession`

They now fail to compile. Build a new object rather than mutating:

```ts
const base = this.sessionStore.get(sessionId, this.ptyAttachedIds());
if (base) {
  const reconciled = this.withReconciledLifecycle([base])[0];
  const session: SessionResponse = {
    ...base,
    ...(existsSync(base.projectPath) ? {} : { failureReason: `Project directory not found: ${base.projectPath}` }),
    lifecycle: reconciled.lifecycle,
    lifecycleSource: reconciled.lifecycleSource,
  };
```

Check the rest of that handler — there is further mutation below (the model/effort status-line scrape) that needs the same treatment. **Preserve the existing response shape exactly**; this is a refactor, not a behaviour change.

### 3. Fix `enrichResumedSessionAsync` for real

Write through `sessionStore.updateManaged(sessionId, {...})` (`src/session-store.ts:34`), which `Object.assign`s into the stored object.

**This is not a copy-paste of the current assignments.** The store holds a `ManagedSession`; the function was written against a `SessionResponse`, and they disagree on the date fields:

| Field | `ManagedSession` (`src/types.ts:78,80`) | `SessionResponse` (`src/types.ts:380`) |
|---|---|---|
| `firstMessageAt` | `Date` | `string` (ISO) |
| `lastMessageAt` | `Date` | `string` (ISO) |

The current code assigns `new Date(...).toISOString()`. Porting that verbatim puts strings where `managedToResponse` later calls `.toISOString()` on them, turning a silent no-op into a throw. **Convert to `Date` when writing to the store** and let `managedToResponse` serialize, exactly as it already does for `startedAt`.

## One design question to decide, not inherit

`resumeSession()` (`src/server.ts`, the extraction from #324) builds its response **before** calling `enrichResumedSessionAsync`, so even a correct fix leaves the `201` body unenriched. Choose one and say which in the PR:

- re-read after enrichment and return the enriched response, or
- document that the `201` is deliberately the pre-enrichment shape and the client re-fetches.

Do not leave it ambiguous, which is the current state.

## Tests

- **Assert against the store, never against the returned object.** A test written the obvious way passes against the same throwaway the bug is about. Use `sessionStore.getManaged(sessionId)` and check `sessionName` and `projectId` specifically.
- Assert the date fields are `Date` instances, then that `GET /api/sessions/:id` serializes without throwing — that pair is what catches the type mismatch above.
- Keep a test that `GET /api/sessions/:id` still returns `failureReason` for a missing project directory and the reconciled `lifecycle`, so the `handleGetSession` refactor is proven shape-preserving.
- The compile error *is* the regression test for the class. Note in the PR that reintroducing a mutation on `get()`'s result no longer type-checks.

## Scope

**Do not** widen this into unrelated `server.ts` cleanup. Three parts, one PR.

If `Readonly` turns out to break more call sites than the two named here, stop and report what they are before adjusting them — that list is itself the finding, and it may mean more instances of this bug exist.

## Working agreement

- Base on `integration/missing-prs-2026-07-23` and target it with `gh pr create --base integration/missing-prs-2026-07-23`. Fetch first; the tip moves.
- Work in your own git worktree under `~/dev/ai-tools/tb-streamer-worktrees/`, never the repo root.
- Show the staged diff and the proposed commit message, and wait for approval before committing.
- Conventional-commit title. No AI attribution anywhere. One sentence per line in all GitHub-bound prose.
- Do not comment on or review any GitHub PR or issue — report findings in your reply.
- Verify with `npm run lint && npm test` under the Node in `.nvmrc` (v24.15.0): `source ~/.nvm/nvm.sh && nvm use`.
- Use `/usr/bin/grep` and `/opt/homebrew/bin/git` — the plain ones are unreliable in this environment's subshells.
- **The local suite degrades under sustained load.** Known flakes, all 15 s timeouts, all passing in isolation: `cors-middleware` ×2, `codex-resume` ×1–2; under load `pair-endpoints`, `watch-for-jsonl`, `webhook-update` and `discovery-cache` join them. Re-run a failing file in isolation before concluding anything, and treat CI on clean runners as the verdict.

## Context

Background and the full write-up are in `docs/BACKLOG.md` under *"`enrichResumedSessionAsync` writes its enrichment to a throwaway copy"*. The bug was found while extracting `resumeSession()` in #324 and deliberately left out of that refactor so it would get a deliberate fix rather than being smuggled into an unrelated change.
