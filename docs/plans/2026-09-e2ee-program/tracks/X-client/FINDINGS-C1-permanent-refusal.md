# C1 findings — the permanent-refusal verdict (item 1)

Branch `fix/e2ee-permanent-refusal`, off mobile `origin/main` `26815a16` (`ios-v215`). Reasoned against streamer `v1.74.0` (`67f2d05e`). Worktree `../tb-mobile-worktrees/e2ee-permanent-refusal`, own `npm ci`.

## The diff

```
 __tests__/unit/e2ee-open-refusal-verdict.test.ts | 405 +++++++++++++++++++++++
 __tests__/unit/hooks/useSession.test.tsx         |  96 ++++++
 __tests__/unit/stores/servers.test.ts            |  51 +++
 hooks/useSession.ts                              |   4 +
 services/e2ee/context.ts                         |  81 ++++-
 stores/servers.ts                                |   5 +
 6 files changed, 641 insertions(+), 1 deletion(-)
```

Production code is 90 lines across three files; the rest is tests. `mapOpenFailure` is untouched.

## Three things that changed the picture

### 1. The storm was OBSERVED, not reasoned about — executed against unmodified `origin/main`

This is the most important property of this work, so it is recorded in full rather than summarised.

The plan was to work around the "guard absent" requirement by giving each attempt a fresh `serverId`, since once the fix exists no in-suite test can see the storm. That workaround proved unnecessary. With no fix present, twelve attempts against **one** `serverId` storm today, because nothing remembers the verdict. So the requirement was met literally: an executable observation of the storm, run first, against unmodified source at `26815a16`, with no fix in the tree and no test-only seam.

Verbatim output:

```
PASS __tests__/unit/zz-storm-negcontrol.test.ts
  NEGATIVE CONTROL on unmodified origin/main
    ✓ the same serverId storms: every attempt reaches the server, and the message degrades (3 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
```

Its three assertions, verbatim, with what each observed:

```ts
expect(server.calls()).toBe(ATTEMPTS)                            // 12 requests reached the server,
                                                                 // where the fixed client makes 1
expect(seen.slice(0, 10)).toEqual(Array(10).fill(REVOKED_TEXT))  // "This device is not paired for encryption"
expect(seen.slice(10)).toEqual(Array(2).fill(BUSY_TEXT))         // "The server is busy; retrying shortly"
                                                                 // — the laundering, at the 429 boundary
```

The fake streamer answered row 8's measured sequence: `403 E2EE_DEVICE_REVOKED` ten times, then `429`. Real `mapOpenFailure`, real `OpenError`, real `openContext` control flow; only the network was a fixture.

**The file was temporary and has been deleted, deliberately.** It asserts twelve requests where one `serverId` is used, which is precisely the behaviour the fix makes impossible — it could not survive its own remedy, and a permanently red file in the suite would be worse than no file. **Mutation M1 is its permanent successor**: it removes the guard and drives the committed storm test, reproducing the same observation on demand (`expect(server.calls()).toBe(1)` → `Received: 12`). The committed suite additionally keeps a fresh-`serverId` variant as a standing storm-shape control, so the harness's ability to count every request stays proven green.

A reader in three months should take from this that the storm was **observed executing**, not inferred from reading the code.

### 2. `E2EE_CTX_UNKNOWN` is not reachable from `/open`, and the positive control is what caught it

The plan listed `E2EE_CTX_UNKNOWN` as a retryable refusal whose retrying must survive the fix. It cannot be: **`mapOpenFailure` has no branch for it**, so a `409` at `/open` falls through to `E2EE_HANDSHAKE_FAILED`, which is non-retryable. Verified by grep — the code is produced in exactly one place, `services/authed-fetch.ts:383`, for a *sealed request* whose `ctxId` the server has forgotten, and it is recovered there by `invalidateRestContext` plus one retry. That path never reaches the refusal map unless a verdict already stands, in which case blocking it is correct.

The positive control failed and exposed this. The test was wrong, not the fix — corrected to use a 5xx (a genuine `/open` transient), and a second test now pins the `409` reading explicitly so a later edit that quietly makes `/open` retryable on a `409` has to come past a test.

This is pre-existing `origin/main` behaviour, not something the change introduced. Recorded because the brief asserted otherwise.

### 3. A mutation caught a test that could not fail

The first version of the 429-after-verdict race asserted on the error **code** coming back. With M2 applied (a retryable outcome clears the verdict) it still passed: the third attempt re-reached a server still answering 403, re-earned the same verdict, and returned the same code. The assertion could not tell a surviving verdict from one cleared and instantly re-earned.

Corrected to assert on **requests reaching the server**. That is the correct fix rather than merely a convenient one: requests reaching the server is what a storm physically *is*, and the error code was only ever a proxy for it. A proxy that cannot distinguish "verdict survived" from "verdict cleared and instantly re-earned" is not measuring the invariant. M2 then went red on `expect(requestsMade()).toBe(2)` → `Received: 3`.

A mutation coming back green is the campaign working, not the campaign failing — it is the only mechanism that finds a test which cannot fail.

## Mutation campaign — 5/5 seen red, each turning exactly one test red

| | Mutation | Test turned red | Verbatim assertion | Result |
|---|---|---|---|---|
| M1 | The standing verdict is not enforced | `e2ee-open-refusal-verdict.test.ts::stops the storm at one request, however many times the layer above asks` | `expect(server.calls()).toBe(1)` | `Expected: 1` / `Received: 12` |
| M2 | A retryable outcome clears the verdict | `e2ee-open-refusal-verdict.test.ts::a 429 arriving after the verdict cannot reset it` | `expect(requestsMade()).toBe(2)` | `Expected: 2` / `Received: 3` |
| M3 | `addServer` no longer clears (re-pair) | `stores/servers.test.ts::a fresh pairing forgets the verdict for that server` | `expect(_openRefusalCount()).toBe(0)` | `Expected: 0` / `Received: 1` |
| M4 | The verdict ignores the pin | `e2ee-open-refusal-verdict.test.ts::clears on a pin change — a different server identity is new information` | `expect(server.calls()).toBe(2)` | `Expected: 2` / `Received: 1` |
| M5 | `retryFailed` no longer clears (user retry) | `hooks/useSession.test.tsx::after an explicit retry a handshake-refused server is reachable again` | `expect(opens).toBe(2)` | `Expected: 2` / `Received: 1` |

M1 additionally turned six other tests red; the row above is the storm test specifically. Every mutation was reverted from a file backup and the suite re-confirmed green after each.

## Gates

`tsc --noEmit` 0 · `eslint --max-warnings=0` 0 repo-wide · unit **1848/1848** across 187 suites · integration **472/472** · jest e2e **59/59**. The change adds 19 tests and 1 suite.

## Seam disclosure

The new suite mocks `createOpenInitiator` — the SecureStore/Noise boundary — following the existing precedent at `__tests__/unit/e2ee-rest-context-channels.test.ts:16`. That is not the transition under test: every refusal is produced by the real `mapOpenFailure`, carried by the real `OpenError`, through the real `openContext` control flow, and on a refusal the handshake is never read at all. The two clear-point tests mock no e2ee module at all. `stores/servers.test.ts` seeds a verdict through the real classifier — an unpaired device's open throws the non-retryable `E2EE_NOT_PAIRED` — then drives the real `addServer`. `hooks/useSession.test.tsx` goes further: it seeds a real 32-byte device key and a real X25519 server key into the SecureStore mock the whole suite already uses, so `createOpenInitiator` succeeds, a real Noise `writeMessage1` runs, and the refusal is a genuine `E2EE_HANDSHAKE_FAILED`. That the test asserts this code at all is its own control on the seeding: had the key not been read, the open would have failed earlier as `E2EE_NOT_PAIRED` and the test would be red.

## A case this also closes, unplanned

D2 row 9 recorded that an interactive Cloudflare Access gate makes `/open` answer a redirect to HTML where an envelope belongs, and noted it "compounds with the retry defect: the client would get HTML where an envelope belongs, fail, and retry forever". A `302` falls through `mapOpenFailure` to `E2EE_HANDSHAKE_FAILED`, so it is now remembered and the storm behind an Access gate stops at one request.

## What I deliberately did not do

- Did not name the retrying layer. That is item 2 and it waits on group G's client log. Ruled-out candidates are recorded in `PROMPT-stop-polling-hard-refusal.md`.
- Did not touch `mapOpenFailure`, the 45 s silence timer, or the pending-prompt guard (the latter two are C2's).
- Did not add a test-only seam to disable the guard.
- Did not clear on `removeServer` — reasoned through below rather than left as a remark.

## A property, stated rather than left as an accident: the verdict does not survive a restart

The map is per-process and nothing in this module is persisted, so an app restart forgets every verdict. That is correct, and it is a design property rather than an oversight — worth stating because a reviewer will ask whether a "permanent" verdict ought to be written down.

It should not be. After a restart exactly one `/open` goes out, earns its `403`, and the verdict is back — one request per launch is not a storm, and it is the same single request a healthy client makes. Persisting it would buy nothing (the one request it saves is the one that re-establishes the truth) and would cost the thing that makes the verdict safe: a stored verdict outlives the condition that justified it, so a server fixed while the app was closed would stay refused until the user found the Retry button. The in-memory map is self-correcting on the only event that costs a single request.

This is also why `removeServer` leaving a stale entry is bounded rather than accumulating: the map's worst case is the lifetime of one app session.

## Deferred with reasoning: the stale map entry on `removeServer`

`removeServer` does not clear the verdict, so a removed server can leave one entry behind in a module-level `Map`. This is deliberate, and the reasoning matters more than the observation.

**Why it is not a correctness gap.** The only way a stale entry can be consulted is if a *new* open runs for that same `serverId`. `serverIdFromUrl` derives the id from the normalised URL, so the only route back to the same id is re-adding the same server — and that route goes through `addServer`, which clears (R6, pinned by M3). A removed server issues no opens at all. So the entry is unreachable for as long as it is stale, and cleared at the exact moment it would stop being stale.

**What would have to be true for it to matter.** Three things, none of which hold today:

1. A code path that opens a context for a `serverId` with no server record — today every caller reads `serverPublicKey` off the server record first, so no record means no open.
2. Or a second way to (re)create a server record that bypasses `addServer`. `editServer` changes an existing record and cannot resurrect a removed one; nothing else writes a new id.
3. Or enough removed-then-never-re-added servers in one app session for `Map` growth to be measurable. The entry is two short strings and an `Error`; the store holds a handful of servers.

**What would change the answer.** If the verdict is ever persisted across launches (it is not, and should not be — nothing in this module is persisted), or if `serverId` stops being derived deterministically from the URL, then a stale entry could outlive its server and this becomes a real leak. Either change should revisit this line.

The one-line fix is `clearOpenRefusal(serverId)` in `removeServer`. Not taken, because it would add a call with no reachable behaviour to defend and no test that could fail without it — the mutation for it would be unkillable.

## The stickiness ruling, and why

Every non-retryable code is sticky, uniformly. This was raised with the owner before the commit rather than settled in a commit body, and the owner ruled to keep it uniform.

The decisive fact is which storm each option fixes. Narrowing the verdict to `E2EE_DEVICE_REVOKED` would fix the case reproduced deliberately in a lab (D2 row 8) and miss the case that happened on its own: the unprompted field storm was `E2EE_HANDSHAKE_FAILED` — 168 × 400 and 43 × 429 over six minutes from a device nobody was touching. A fix that leaves the field-observed storm running is not the fix this item exists for. Fewest branches is a real but secondary reason, and would not have carried the decision alone.

**The accepted cost:** a mispinned device stops self-healing when its hostname points back, and needs one Retry tap. What carries it is that self-healing is not a device-local kindness — through a Cloudflare tunnel every device collapses to `127.0.0.1` and shares one failure budget, so a storming device spends the whole fleet's budget. One tap on the storming device is cheaper than every other device on that server being refused.

**The cost is now a tested fact, not a claim.** `hooks/useSession.test.tsx::after an explicit retry a handshake-refused server is reachable again` drives the real Retry press with an `E2EE_HANDSHAKE_FAILED` verdict standing and asserts that the next attempt *reaches the server* — not merely that a map shrank. Mutation M5 turns it red on `expect(opens).toBe(2)` → `Received: 1`, which is exactly the user-visible failure "I tapped Retry and it is still unreachable". Without that assertion the trade could silently degrade into "stuck until reinstall" and nothing would notice.
