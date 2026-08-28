# Approved-pending plan — mobile #871 (from `mobile-card-identity-engineer`, 2026-08-28)

Sub-agent died on the usage limit after delivering this. A respawned agent implements **this plan**. All lines are `origin/main@3b2cca63` (355-line file), **not** the working tree, which sits on `fix/rtl-directional-layout` and predates #872.

Corrected citations (orchestrator re-verified all of these): `gateKey` **:41–44** (comment :37–40), `dismissedKey` **:103**, `ponytail:` ceiling **:101–102**, `markPending` **:165–170**, `expireIfStale` **:182–187**, `resetAndUnsuppress` **:208–211**, `applyPrompt` **:220–228**, legacy-frame drop **:245**, permission branch **:252–255**, `clear()` **:262–265**, the sentence that goes false **:152**. Five `useActiveQuestion*.test.tsx` files exist, not four (`useActiveQuestion.prompt.test.tsx` is the fifth, added by #872).

## Code — `gateKey`, with the `::` disjointness guard

```ts
function gateKey(msg: PermissionWsMessage): string {
  const options = msg.options.map(o => `${o.index}.${o.label}`).join(',')
  const content = `${msg.prompt ?? ''}::${msg.detail ?? ''}::${options}`
  return msg.gateId && !msg.gateId.includes('::') ? msg.gateId : content
}
```

Module-private, one call site (:253), signature unchanged; no consumer parses the key. The guard is what makes the two namespaces **disjoint by construction** — every content key contains the two literal `::`, so a `gateId` admitted as a key can never equal one. Holds for any server string, including hostile. A `gateId` containing `::` degrades to the content key (today's behaviour) rather than throwing. Load-bearing against a future streamer: the wire schema is `z.string().trim().min(1).max(200)`, which permits `::`.

Second, independent line (not relied on): a reconnect nulls `dismissedKey` via `resetAndUnsuppress` on `disconnected` (`ws-client.ts:263–268` → `useActiveQuestion.ts:316–318`), so a key armed against one streamer generation cannot meet the other's frames. Honest limit: `socket.onerror` (`ws-client.ts:256–261`) schedules a reconnect **without** emitting `disconnected` — filed as a finding, not fixed here.

`promptId` is a third namespace on the same ref (:222, :226) and after this change it *can* meet a `gateId` — deliberately: the streamer mints `gateId = prompt?.promptId ?? occurrenceId ?? prior?.gateId ?? randomUUID()` (tb-streamer `sessions.handlers.ts:1273`; the plan said :1280 — corrected). Ordering makes it benign: `promptContractSeen` is never reset and :245 drops legacy frames after the first contract frame, so `gateKey` only runs *before* a `promptId` key is armed. Equal ⇒ same gate, suppression correctly carries across the channel switch; different ⇒ opens normally.

Contract path untouched, three proofs: `prompt_snapshot`/`prompt_event` return at :243 before the legacy chain at :246; `applyPrompt` keys on `promptId` alone (:222–223); :245 stops `gateKey` running at all once a contract frame has been seen.

## Comments (all three rewrites approved as drafted in the plan)

- **:101–102** `ponytail:` ceiling — currently states the defect; rewritten to say a reopen is a different gate wherever a `gateId` exists, and still hidden on a streamer that sends none.
- **:152** — "…depends on no field an older streamer might not send" is the sentence that actually goes **false**; rewritten to say `gateKey` prefers the server's `gateId` and falls back to content, so it is defined on every streamer.
- **:154–160** the "do not simplify" paragraph — stays true, re-scoped from "the whole key" to "the fallback", plus one sentence on why `gateId` sits above it rather than replacing it.
- **`hooks/useSessionActions.ts:110–111`** — ruled **yes**: strike the trailing clause "the same way they already are to the client's own gateKey suppression", which this change falsifies. Comment-only, no #870 overlap. Nothing else in that file.

## Tests — `__tests__/unit/hooks/useActiveQuestion.phase.test.tsx`, new `describe('useActiveQuestionReducer – gate instance identity')`

`makeGate(over)` already spreads overrides; `GATE_BASE` sets no `gateId`, so every existing test stays on the fallback and the change is a provable no-op for them.

1. `'shows a fresh card when an identical gate reopens under a new gateId'` — positive; fails today with `Expected "active" / Received "pending"`.
2. `'keeps suppressing a repaint of the same gateId after the answer'` — negative control (a random key would pass test 1 without this).
3. `'keys a gate carrying no gateId exactly as before'` — old-streamer control: the key asserted as a **literal** string, plus behaviour, plus the `'g1'` twin.
4. `'hands the card back when an answered gateId gate returns without one'` / the reverse / `'ignores a gateId that could collide with a content key'` (`gateId: 'a::b::c'` ⇒ content key).
5. Untouched contract path: `useActiveQuestion.prompt.test.tsx:48` still asserts `questionKey === 'prompt-1'`. No existing test needs editing.

Mutation: `return msg.gateId && !msg.gateId.includes('::') ? msg.gateId : content` → `return content`. Report the actual failing test names and verbatim assertion text, then restore.

## Mechanics

Sibling worktree `../tb-mobile-worktrees/gate-id-card-key`, branch `fix/gate-id-card-key` off `origin/main`; own `npm ci`; never `npm rebuild --bin-links`; revert `test:ci`'s `app.json` bump and `.git-status-before.txt` before staging; `npx eslint` staged files via `xargs`; suite + tsc green. Title: `fix(prompts): key permission-card dedupe on gateId`. PR opened and taken green, **merge held until #870 is MERGED** — the orchestrator merges.

## Findings, not fixed

`ws-client.ts:256–261` error-only reconnect skips the `disconnected` status, so the suppression-drop backstop can be missed. Wants its own issue.
