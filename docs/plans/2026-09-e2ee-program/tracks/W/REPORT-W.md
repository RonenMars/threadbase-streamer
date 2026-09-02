# Group W — report on W0 and W1a

**Track:** the streamer WebSocket record layer.
**Session:** `e2ee-W-opus5-high [e16afe]`, Opus 5 / high.
**Span:** 2026-08-28 21:22 → 2026-08-29 21:52 IDT.
**Written for** whoever runs X-server and X-client: the "two lessons" and "my own errors" sections are the parts most likely to save you a day.

---

## State

**W0 and W1a are shipped. `v1.71.0` is on the remote. W1b is running.**

| | |
|---|---|
| W0 | [#740](https://github.com/RonenMars/threadbase-streamer/pull/740) `MERGED` → `91ce3f18` · **no tag** (`refactor` is non-releasing, confirmed from `.releaserc.json`) |
| W1a | [#741](https://github.com/RonenMars/threadbase-streamer/pull/741) `MERGED` → `9b5f367d` · 10/10 CI green |
| Release fix | [#742](https://github.com/RonenMars/threadbase-streamer/pull/742) `MERGED` → `dd74849f` |
| **Tag** | **`v1.71.0` → `f95150cc`**, verified with `git merge-base --is-ancestor 9b5f367d v1.71.0` |
| W1a size | 28 files, 6 915 insertions · suite 2 590 passed / 5 skipped · 78 mutations, 76 red |
| Fixture at the tag | `__tests__/fixtures/e2ee-record-vectors.json` |
| Codes frozen at the tag | `E2EE_CTX_UNKNOWN`, `E2EE_DEVICE_REVOKED`, `E2EE_SEQUENCE_VIOLATION`, `E2EE_SEAL_FAILED` |

---

## W0 — route every send through `WSHub`

Six inline `ws.send(JSON.stringify(...))` in `server-wiring.ts`, all already `WSMessage` union members, so **no new hub method was needed**.

Wire identity was proven rather than asserted: the frames were captured pre-refactor and re-captured after with the same harness — **empty diff**.

The finding worth carrying: **the bypass mutation left the wire-identity test passing**, because a raw send emits byte-identical output. Wire identity cannot detect a bypass and the scanner cannot detect a changed frame; that is what shows the two tests are not redundant.

Four existing tests needed repair, one of which had an assertion **broader than its own name** (`expect(unicast).not.toHaveBeenCalled()` where the test claimed only "no `host_pressure` frame").

---

## W1a — the record layer, context registry, `POST /api/e2ee/open`

Built by an implementer sub-agent, reviewed by this session, and accepted only on an **isolated adversary's** table — never on our own green suite.

### What six adversary rounds found

Each round: a fresh anonymous agent, its own worktree at the exact commit, given the specification and the built tree and nothing else — no plan, no diff history, no conversation.

| Round | Result |
|---|---|
| 1 | **6 of 20 succeeded** — nonce reuse through the response sealer; keys under `showHidden`; eviction destroying the context being opened; a rate limiter backwards under load; a protocol selector falling through to the weaker pattern |
| 2 | all six fixes held; **4 new** — a captured msg1 buying unlimited Diffie-Hellman; a targeted per-device lockout; the handshake states outside the redaction |
| 3 | **2 new** — key rendering through a third inspect mode; unauthenticated traffic ageing the replay cache |
| 4 | **3 new** — the response sealer never validating its target; a PSK checked for presence rather than length; a timing oracle |
| 5 | **6 new** — the downgrade guard failing open; `#private` defeated by the allocation pool; nonce state enforced by TypeScript alone; prototype pollution reaching six defaults |
| 6 | **acceptance** — 102 probes, one finding (a prototype-chain read with no production caller), fixed |

**Nineteen real defects. None of them was findable by our own passing tests.** The three that mattered most:

1. **Nonce reuse** in `RestResponseSealer` — keystream reuse proven by `xor(c1,c2) === xor(p1,p2)`. The invariant was held one layer up by the strict receive counter — *the exact code the REST sliding window is scheduled to replace*. It would have shipped green and become catastrophic one refactor later.
2. **The downgrade guard failing open** in six input shapes (`refuseUnsealedIfPinned`) — the helper W1b and X-server both consume.
3. **Traffic keys readable from the registry in one call** — not through any key-bearing class, but through the **allocation pool**: a public `ctxId` Buffer exposes the shared pool the private key was allocated in. Hiding was tried three times and defeated three times; the fix was to stop hiding, and make keys `KeyObject`s that never exist as JS bytes.

Also found and fixed: eviction destroying the context it was opening; a rate limiter where the flood that cost CPU never tripped it while five malformed requests locked out paired devices; a targeted per-device lockout purchasable with one captured handshake; a PSK checked for presence and later for `.length` rather than `byteLength`, so a `Float64Array(32)` bound **256 zero bytes**; prototype-chain defaults reaching six options, one of which collapsed the pairing/`/open` domain separation.

---

## The tag needed a second PR

W1a's merge ran `Release` and **failed** at `generateNotes`: dependabot's `conventional-changelog-conventionalcommits@10.4.0` requires `conventional-changelog-writer@9`, and the resolved writer was 8.4.0.

**The pipeline had been broken since that bump and had reported success twice.** `generateNotes` only runs when there is a release to make, and every intervening commit was `chore(deps-dev)`. W1a's `feat` was simply the first commit to execute the code.

Fixed by pinning to exact `10.3.0` — the caret `^10.2.1` was the hole — and since `fix` releases, #742 is what cut the tag carrying W1a.

Proven with a control: the same script, the same ten commits, only the installed preset differing — **10.4.0 throws the CI error verbatim, 10.3.0 completes**.

---

## Two lessons, both now in `ADVERSARY-BRIEF.md`

### "A guard hardened against *missing*, silent on *empty*"

Four instances, in four files: `if (!psk)`; a target concatenated *beside* its length check rather than passed into it, making the check unreachable; `if (target)` in `assertTarget`; and `.length` where `byteLength` was meant.

One of them was found by the implementer **in its own new code, while fixing the second**. All now route through one `assertBytes` helper — **the defect was not in any single guard, it was in writing the guard four times.**

### "Absence of a failure is not evidence; only an observed red is"

Five instances:

1. A bad edit **deleted four route tests** and the suite stayed green — a deleted test does not fail, it stops existing. Only the mutation campaign found it.
2. A **mutated module that failed to parse** produced no failure line, which the driver read as "the property held" — and it had already produced a false green on the safeguard that round existed to add.
3. **Twelve mutations whose patch targets moved** in a refactor would have reported "62 red" while six safeguards were no longer tested at all.
4. The **`Release` workflow reported success twice** while unable to release, by exiting before the broken step.
5. During the fix for that very class, **my own `--dry-run` verification exited 0 without ever reaching the step under test.**

The class does not spare the person naming it.

**Consequent rules, now program-wide:** the mutation driver applies inside `try`, reverts in `finally`, asserts `git diff --quiet` after every mutation, and prints `BROKEN — this is not evidence` rather than counting a parse failure. The campaign is **re-run on every refreeze**, never carried forward.

---

## My own errors, for the record

- I corrected `NONCE-DESIGN.md` to rev7 and **never delivered the file**. An adversary round audited an 18-line-stale design, and two of its findings were already fixed. **Fix: deliver explicitly and `diff`-verify both copies before every freeze** — done for rev8 through rev11.
- **§8 and §15 contradicted each other on eviction.** The implementer implemented §8 literally and produced a context that evicted itself. **That defect was mine**, not its.
- I announced rev11 and did not write it. The implementer reported the absence rather than inventing a file to satisfy the instruction.
- My first verification of the round-5 fixes gave **false negatives**, because I grepped for names the refactor had renamed. Caught only by reading the code instead of trusting the empty result.

---

## For X-server and X-client

- **Consume the shared surface from the tag; do not edit it.** The 426 helper, the four frozen codes and `unsealUnchecked` (REST request channel only, advances no counter) exist so neither track reimplements nonce or AAD assembly. **If you find you need to change `record.ts` or `context.ts`, stop and coordinate** — a rebase silently reconciling two edits to a crypto module is the worst possible place to rely on a campaign re-run.
- **The fixture is the contract, not our test files.** `records`, `negative` (twelve cases your implementation must *reject*, not merely reproduce), `open`, `restResponse`, `restTargetCanonicalization`, `encodings`, `restAadLayout`.
- **`NONCE-DESIGN.md` §13 is the REST contract**, including what W1a could not implement for you: the principal comes from the context, no `Authorization` on a sealed request, and at most one sealed response per accepted request counter.
- **Every `/open` attempt re-runs `writeMessage1`.** A retry that re-sends identical bytes is indistinguishable from a replay and is refused for the life of the cache entry, with a deliberately uninformative code.
- **Hash the origin-form request target**, never the absolute URL. The fixture is authoritative; prose that disagrees with it is wrong.
