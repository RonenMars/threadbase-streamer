# Fux F1 on streamer PR #748

Source review: `tracks/W/REVIEW-2026-08-31-PR748.md` (finding F1). One defect, one small fix, plus the tests that hold it. Nothing else in the PR is in scope.

## The defect

`src/api/middleware/auth.middleware.ts:90-91`:

```ts
const ticket = path === WS_PATH ? c.req.header(TICKET_HEADER) : undefined;
if (ticket !== undefined) { … }
```

The branch fires on the path alone — it does not require `Upgrade: websocket` and does not require `GET`. So a request to `/ws` that carries a valid `X-TB-Ticket` but is not a WebSocket upgrade spends the ticket and promotes its context, then falls through to a 404 without ever attaching a socket:

1. `consumeTicket()` deletes the ticket and calls `markUsed()`, which flips the context out of provisional and sets `expiresAt = now + WS_CONTEXT_TTL_MS` (24 h).
2. `authenticateContext` succeeds, the capability check passes, `c.set("e2eeContext", …)`, `await next()`.
3. `refuseUnsealedIfPinned` returns `null` (a context is present) → `next()`.
4. `@hono/node-ws`'s helper runs `if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return;` and hono's `defineWebSocketHelper` then calls `await next()` → 404. `onOpen`, and therefore `WSHub.addClient`, never runs.
5. Nothing destroys the context, and the 10 s first-frame deadline is armed inside `addClient`, so no clock covers it.

Result: `curl -H "X-TB-Ticket: <t>" http://streamer/ws` → 404, ticket spent, one non-provisional context with live traffic keys resident for 24 h, no socket, holding a slot against `MAX_WS_CONTEXTS_PER_DEVICE = 4`. Same for `POST /ws`, which 404s at routing (`app.get("/ws", …)`) after the ticket has already been spent.

This is the last sibling of the two orphan paths the PR already closes deliberately (the capability refusal at `auth.middleware.ts:161`, and the falsy-`ws.raw` case at `ws.routes.ts:63`).

## The fix

Spend the ticket only on a request that can actually become a socket. In `auth.middleware.ts`, replace the path-only test with:

```ts
const isWsUpgrade =
  method === "GET" &&
  path === WS_PATH &&
  c.req.header("upgrade")?.toLowerCase() === "websocket";
const ticket = isWsUpgrade ? c.req.header(TICKET_HEADER) : undefined;
```

**The predicate must mirror `@hono/node-ws`'s own check exactly, and this is the whole subtlety — say so in a comment.** Looser than hono's and the ticket is spent on a request that will never upgrade, which is the bug. *Stricter* than hono's and a request hono would upgrade skips the ticket branch and falls through to bearer/`?key=` authentication — a spent-sealed request turning into a legacy plaintext socket, which is far worse than what is being fixed. The `method === "GET"` conjunct is safe because the route is registered `app.get("/ws", …)`, so a non-GET can never reach `upgradeWebSocket` at all.

Read via `c.req.header()`, never a bracket read — that is a fetch-API `Headers`, which answers `null` for an absent name whatever `Object.prototype` holds (§10, and the existing `own()` comments in this file).

Do not add a destroy-on-404 path, do not touch `ws.routes.ts`, and do not change anything else in the PR.

## Tests, and they must be seen red first

Add to `__tests__/e2ee-ws-sealing.test.ts`, in the `(b) the ticket is single-use` describe or a sibling one. Run them against the **unfixed** middleware first and record the failure verbatim (test name + assertion) in your report — a mutation that was never seen red proves nothing, which is this program's standing rule.

1. **`GET /ws` with a valid ticket and no `Upgrade` header leaves the ticket and the context intact.** Use `fetch(`${baseUrl}/ws`, { headers: { [TICKET_HEADER]: ctx.ticket } })`. Assert: `registry.ticketCount === 1`, `registry.get(ctx.ctxId)` is not null, `hub.sealedCount === 0` — and then, as the positive control that the predicate is not too strict, that a real `connect({ [TICKET_HEADER]: ctx.ticket })` still succeeds afterwards and receives its two sealed frames.
2. **`POST /ws` with a valid ticket does the same.** Same assertions.
3. Keep an existing-behaviour control in view: the ordinary ticketed upgrade, the spent-ticket 401, and the inherited-`X-TB-Ticket` case must all still pass untouched.

Expected red before the fix: (1) and (2) fail on `registry.ticketCount` (0, not 1) and the follow-on `connect` is refused 401.

## Spec

`specs/end-to-end-encryption/NONCE-DESIGN.md`, §14 verification table (the "rule | test | mutation" rows the PR already extends), one new row:

| §10 a ticket is spent only by a real upgrade | a `/ws` request with a ticket and no `Upgrade` header leaves the ticket and the context intact | drop the upgrade predicate → a bodiless `GET` spends the ticket and orphans a 24 h context |

If you touch §10's "the residual … for **≤10 s**" paragraph at all, keep it to one sentence; the claim becomes true once this lands, so it needs no rewrite.

## Verify

In the worktree:

```
npm run lint && npx tsc --noEmit
npx vitest run __tests__/e2ee-ws-sealing.test.ts
npx vitest run                      # full suite, no new failures
```

## Hard rules

*   **Never commit without approval.** Show `git diff --staged`, explain it, show the exact commit message verbatim, and wait for an explicit yes. This holds even if you are told "just commit it".
*   Conventional commit title, imperative, lowercase, no trailing period — e.g. `fix(e2ee): spend a ws ticket only on a real upgrade`. One sentence per line in the body.
*   No AI attribution anywhere — not in the commit, not in the PR, not in a comment. No Cursor attribution either.
*   Never push to `main`. This is an amendment to the existing PR branch; do not open a new PR.
*   Minimum viable change. Do not refactor adjacent code, do not "clean up" `wss.options.maxPayload` or anything else the PR reasons about explicitly — those reach-ins are load-bearing and documented as such.

## Report back

The failing test names and verbatim assertions from the red run, the final diff, the three verification command outputs, and anything you found that contradicts this brief.
