# Group W — PLAN

**Session:** `e2ee-W-opus5-high [e16afe]` · Opus 5 / high
**Owner session ref (recorded at first contact, 2026-08-28 21:22 IDT):** `e2ee-owner [ddde5e]`
A later *name* against ref `ddde5e` is a rename and may be accepted alone.
A different ref needs the user's confirmation in this pane.

**Status:** W0 plan + `NONCE-DESIGN.md` outline **APPROVED by `e2ee-owner` (owner's stamp 21:35; received in this pane 21:28 IDT, 2026-08-28)**.
Worktree created: `tb-streamer/.worktrees/feat/e2ee-record-layer` on `feat/e2ee-ws-hub-routing` from `76d6d420`, `node_modules` symlinked. W0 implemented; awaiting owner diff read, then the user's commit approval.

---

## Preconditions — re-verified in this session, 2026-08-28

| Check | Result |
|---|---|
| `git ls-remote --tags origin v1.70.6` | `0069afc103109e90fa08ac051634c894fdc42eea refs/tags/v1.70.6` — present |
| `git show origin/main:src/e2ee/record.ts` | `fatal: path ... does not exist in 'origin/main'` — Phase 3 unstarted |
| `origin/main` pinned commit | **`76d6d420ee1753153b929c63c5942daee23a9124`** — `docs(e2ee): add the parallel execution plan and re-verify remaining work (#737)`, 2026-08-28 20:46 +0300 |

Group P is live in `.worktrees/fix/e2ee-pairing-closeout` (pairing route, `src/e2ee/pair-*.ts`). W0 touches neither. Whoever merges second rebases and re-runs mutations.

---

## W0 — route every send through `WSHub`

Pure refactor. No crypto.

### The six sites (verified by scanning every `src/**/*.ts` blob at `origin/main`)

Exactly six raw sends exist outside `src/ws-hub.ts`, all in `src/server-wiring.ts`, all on the same `deps` closure that already calls `deps.wsHub.unicast` at `:718` and `:720`.

| # | Line | Frame | In `WSMessage` union? | Maps to |
|---|---|---|---|---|
| 1 | `server-wiring.ts:711` | `{ type: "session_list", sessions }` | yes — `types.ts:290` | `deps.wsHub.unicast(ws, …)` |
| 2 | `server-wiring.ts:713` | `{ type: "cache_ready" }` | yes — `types.ts:373` | `deps.wsHub.unicast(ws, …)` |
| 3 | `server-wiring.ts:756` | `deps.promptRegistry.snapshot(id)` → `PromptSnapshot` | yes — `types.ts:338` (`\| PromptSnapshot`) | `deps.wsHub.unicast(ws, …)` |
| 4 | `server-wiring.ts:766` | `{ type: "terminal_replay", … }` | yes — `types.ts:347` | `deps.wsHub.unicast(ws, …)` |
| 5 | `server-wiring.ts:787` | `{ type: "permission", … }` | yes — `types.ts:313` | `deps.wsHub.unicast(ws, …)` |
| 6 | `server-wiring.ts:806` | `{ type: "question", … }` | yes — `types.ts:309` | `deps.wsHub.unicast(ws, …)` |

**No new hub method is needed.** All six shapes are already union members, so `unicast` types them without a cast and without widening `WSMessage`.

### The one behaviour difference, stated rather than discovered

`unicast` (`ws-hub.ts:89-97`) is not a pure rename of `ws.send`:

- it gates on `ws.readyState === ws.OPEN`;
- it swallows a throw and drops the socket from `this.clients`.

On an **OPEN** socket the emitted bytes are identical — `unicast` does `JSON.stringify(message)` on the same object literal, so key order and therefore the byte string are unchanged. The difference is confined to a **non-OPEN** socket: today the raw `ws.send` throws (unhandled) or buffers; after W0 the frame is silently dropped and the socket is reaped. Sites 1–2 run immediately after the upgrade and sites 3–6 run while handling a frame the socket just delivered, so both are OPEN on the real path. This is a strict improvement, but it is a behaviour change and belongs in the PR body, not in a "pure refactor" claim.

### Tests

**T1 — wire identity (the positive control).** Reuse the rig that already exists at `__tests__/ws-replay-depth.test.ts:47-61`: `createApiDeps(...)`, a recording socket, drive `handleWsOpen(ws)` and then `handleWsMessage(ws, {type:"subscribe_session", sessionId}, null)` against a session with a pending permission gate, a pending question and a live PTY, so all six frames fire in one run. Capture the ordered array of emitted strings.

Method: run the capture on the pre-refactor tree (commit `76d6d420`), paste the captured sequence into the test as the expectation, then refactor. The test passing after the refactor *is* the before/after comparison. Both raw captures and an empty `diff` between them go in the PR body.

Two things the rig needs that it does not have today, or the test passes for the wrong reason:

- the existing fake socket is `{ send }` only, so after the refactor `unicast`'s `ws.readyState === ws.OPEN` evaluates `undefined === undefined` → `true` and the frames flow **by accident**. T1's socket sets `readyState: 1, OPEN: 1` explicitly.
- assert the captured array has length 6 and contains each of the six `type` values, so a harness that captured nothing cannot pass a `toEqual([])`.

**T1 negative control.** Perturb one byte of one expected frame → T1 fails. Proves the comparison has causality rather than comparing two empty arrays.

**T2 — no bypass.** `__tests__/ws-no-hub-bypass.test.ts`: read every `.ts` under `src/` except `src/ws-hub.ts`, assert zero matches for `/\b(ws|client|socket|sock)\.send\(/`.

Pattern chosen against a full `\.send\(` scan of `origin/main`: a bare `.send(` has six legitimate hits (`transport.send`, `t.send` in `src/pty-host/*`) and six more (`sender.send`, `this.apns.send` in `src/services/push/*`). The identifier-qualified pattern has **zero** false positives today. Known ceiling, to be named in a comment in the test: a bypass written through a differently-named binding slips through.

T2 positive control: assert the scanner actually read >0 files, and that the same regex *does* match a synthetic `ws.send(x)` string — a scanner whose glob silently matched nothing otherwise reports success.

**T2 mutation (the required one).** Restore `ws.send(JSON.stringify({ type: "cache_ready" }))` at site 2 → T2 fails. Report with the test name and the verbatim assertion.

*Alternative considered and not recommended:* typing the handler's `ws` parameter as `Omit<WebSocket, "send">` so `tsc --noEmit` (already in `npm run lint`) forbids the bypass structurally. Stronger than a regex, but it re-types a parameter threaded through the wiring and needs a cast inside the hub — a bigger diff and adjacent churn for a refactor PR. Raised for the owner; recommendation is the scanner.

### Done means

- `grep -n 'ws\.send(' src/` outside `ws-hub.ts` returns nothing.
- T1 passes with the pre-refactor capture; the two captures diff empty.
- T2 passes; the mutation makes it fail.
- `npm run lint` and `npm test` green with exit codes captured (`npm test` ~10 min, background).

### Branch

`tb-streamer/.worktrees/feat/e2ee-record-layer` on `feat/e2ee-ws-hub-routing`, from `76d6d420`, `node_modules` symlink per CLAUDE.md, Node v24.15.0.

---

## `NONCE-DESIGN.md` — draft outline (owner approval required before any W1a code)

Target path: `specs/end-to-end-encryption/NONCE-DESIGN.md`. Reviewed by the adversary first, before the implementation.

| § | Fixes | Source |
|---|---|---|
| 1 | Scope: the WS record layer's nonce and counter rules. Non-goals: the handshake's nonce, the REST window (X-server), `--no-e2ee`. | — |
| 2 | Primitive: ChaCha20-Poly1305 (RFC 8439) via Node `crypto.createCipheriv`; 32-byte key, 12-byte nonce, 16-byte tag. | design §3.3 |
| 3 | Nonce = `direction(4) ‖ counter(8)`, **big-endian**, never random. `0x00000001` client→server, `0x00000002` server→client. Separate keys *and* separate direction labels, so a record cannot be reflected at its sender. | design §3.3, D-2 |
| 4 | Counter type is a **decision, not an inheritance**: `bigint` on the server. Client obligation stated normatively — a `bigint`, or a two-`number` representation that **throws** above 2^53 and never wraps. | plan.md Phase 3 |
| 5 | AAD = `version(1) ‖ ctxId(16) ‖ direction(4) ‖ counter(8) ‖ channel(1)` = 30 bytes. `channel`: `0x01` ws, `0x02` rest-request, `0x03` rest-response. | design §3.3 |
| 6 | The counter state machine, four rules: (R1) the sender increments by exactly 1 **after** a successful seal; (R2) the WS receiver requires `counter == expected` exactly — no window, a repeat/gap/reorder is a protocol violation, `e2ee.sequence_violation` + policy close; (R3) a rejected frame advances **neither** counter; (R4) the counter is owned by the record state and is never passed in by a caller. | design §3.4, plan.md Phase 3, noise.ts §5.1 precedent |
| 7 | **Rekey — the section the whole file exists for.** See the two conflicts below. | design §4.3 |
| 8 | Exhaustion: a sender at `2^64 - 1` refuses to send and forces a rekey. Asserted, so it can never become a silent wrap. | design §3.3 |
| 9 | Lifecycle table — what survives a socket close, a streamer restart, a revocation, a rekey, and each of the two bounds; for each: does the context survive, the keys, the counters. | design §4.3, §4.4 |
| 10 | **Distinguishable rejection codes.** Unknown-because-restarted/expired → recoverable, the client re-handshakes once transparently. Refused-because-revoked → hard failure, surfaced. Two failures behind one code was a P1 in the prior program; X-client §4.3 depends on the split. | CLAUDE.md §3, W brief |
| 11 | What this file **forbids**, each with its reason: reusing `chachaNonce` from `noise.ts` (little-endian, spec §12.3); building the record state out of `CipherState`; a caller supplying a counter; any window on the WS channel. | plan.md Phase 3, noise.ts:224 |
| 12 | Test obligations, one row per rule in §3–§8, each naming the mutation that must make it fail. This is the table the adversary checks the implementation against. | design §9 |
| 13 | Interop fixture format for X-client: keys, ctxId, direction, counter, AAD, plaintext, expected ciphertext — path named in the W1a PR body. | W brief |

### Two conflicts in the sources that §7 has to resolve — owner decision needed

**C1 — `design.md` contradicts itself on the counter reset.**
§3.3 says the counter "starts at 0, increments by exactly 1 per sealed record, **never reset**". §4.3 says "Counters reset to 0 only as part of a rekey". Both cannot stand. The kickoff and `CLAUDE.md` §3 follow §4.3.

Proposed resolution, to be written as one rule replacing both: **uniqueness is per `(key, nonce)`, not per context.** A rekey replaces `k`, so restarting the counter at 0 keeps every `(k, nonce)` pair unique. §3.3's "never reset" is the correct rule *within one key generation* and was written before §4.3 introduced rekey.

Corollary §7 must state as a claim the adversary is asked to break: **the AAD needs no epoch/generation field.** A frame captured in generation *N* and replayed at generation *N+1*'s identical counter fails authentication because `k` changed. That is the only thing stopping it, so it is written down rather than assumed.

**C2 — the design deviates from Noise's own `Rekey()`, and nothing says so.**
Noise spec §11.3 is explicit that `Rekey()` updates `k` and **does not** reset `n`. The design resets the counter. The deviation is safe (C1), but it means a record layer that delegates to a Noise-shaped `rekey()` helper gets Noise's semantics and a counter that keeps climbing — which passes every test that does not specifically look. `src/e2ee/noise.ts`'s `CipherState` has no `rekey()` today, so the trap is a future one; §7 and §11 forbid it in advance.

### Open questions for the owner

1. **C1** — may `NONCE-DESIGN.md` be the resolving document (with §3.3 quoted and superseded in place), or does `design.md` §3.3 get a correcting edit in the same W1a PR?
2. **The 24 h bound.** `design.md` §4.3 lists 24 h as *both* a `k_c2s`/`k_s2c` rotation trigger *and* the transport context's own lifetime cap. At 24 h: rekey and continue, or destroy the context and force a new `/api/e2ee/open`? The rejection code in §10 differs by answer.
3. **Rejection code strings** for §10. X-client's precondition depends on the exact values, so they should be agreed before W1a's tag rather than after. Proposal: `E2EE_CTX_UNKNOWN` (recoverable) and `E2EE_DEVICE_REVOKED` (hard).
4. **AAD `version` byte** — `0x01`, and is there an existing constant to reuse or does W1a mint it?
5. **W0's no-bypass enforcement** — regex scanner test (recommended) or the `Omit<WebSocket,"send">` type-level variant. See W0 T2.

---

## Owner rulings, 2026-08-28 — binding for W1a

**The counter does NOT reset on rekey.** Rekey replaces `k` only — exactly Noise §11.3 `Rekey()` semantics — and the counter continues monotonically across generations for the life of the context. `2^64-1` refusal is the only ceiling.

This sides with `design.md` §3.3 ("never reset") and with the workspace `CLAUDE.md` §3 read literally ("the counter **surviving** a rekey is the rule tested hardest"). It removes the C2 trap rather than fencing it, needs no "uniqueness per `(key, nonce)`" argument and no epoch field anywhere. Nonce uniqueness stays one invariant: **one counter value, once, per direction, per context.**

`design.md` §4.3's "Counters reset to 0 only as part of a rekey" is the sentence that was wrong.

> Note for the record: the Group W kickoff message also said "the counter resets only inside a rekey and that is the test you see red first". That line is superseded by this ruling, which is the one consistent with the governing `CLAUDE.md` §3.

The adversary still runs the cross-generation replay attempt (captured at generation N, replayed at N+1). It must fail **on the strict counter first and on the key second**, and its report must say which.

| Q | Ruling |
|---|---|
| Q1 | `NONCE-DESIGN.md` is the resolving document **and** `design.md` §4.3 gets the one-line correcting edit in the same W1a PR — quote the old sentence, state the rule, point at `NONCE-DESIGN.md`. A design doc contradicting the shipped record layer is the "docs that carry status" failure. |
| Q2 | At 24 h the context is **destroyed**, not rekeyed; the client re-opens via `/api/e2ee/open` (recoverable). Rekey triggers are **1 GiB sealed** and the client's **foreground rekey**. The wall-clock bound is the context's, per the §4.3 lifetimes table. |
| Q3 | Approved as proposed. **Frozen at W1a's tag**, consumed by X-server and X-client: `E2EE_CTX_UNKNOWN` (unknown, expired, or restart-lost — one transparent re-handshake), `E2EE_DEVICE_REVOKED` (hard failure), plus the WS policy-close reason `E2EE_SEQUENCE_VIOLATION` alongside the `e2ee.sequence_violation` log event, so the client can tell it from a network drop. |
| Q4 | Reuse `E2EE_PROTOCOL_VERSION` (`src/api/routes/misc.routes.ts:119`, value 1). Move it to `src/e2ee/` if importing a route module into `e2ee/record.ts` inverts the dependency direction, and update `pair-request.ts:17`'s comment. Do not mint a second constant. |
| Q5 | The regex scanner, with its ceiling comment and the synthetic-`ws.send` positive control. The `Omit<WebSocket,"send">` variant is a follow-up, not this PR. |

---

## W0 execution record, 2026-08-28

**Implemented and staged.** Owner READ the staged diff in the worktree and accepted it; owner APPROVED the commit message verbatim. **The user's commit approval is still outstanding** — nothing is committed.

| Check | Result |
|---|---|
| Six sites rewritten | `grep -rn -E '\b(ws\|client\|socket\|sock)\.send\(' src/` → only `ws-hub.ts:56`, `:79`, `:92` |
| Wire identity | pre- and post-refactor captures `diff` **empty**; six frames in order `session_list`, `cache_ready`, `prompt_snapshot`, `terminal_replay`, `permission`, `question` |
| `npx tsc --noEmit` | exit **0** |
| `npx biome check src cli __tests__` | exit **0**, 458 files, no warnings |
| `node scripts/check-no-nul-bytes.mjs` | exit **0** |
| Full suite | first run killed (contended with P, exit 144); re-queued under `/tmp/tb-streamer-suite.lock` |

**Mutations, both seen red.**

- **M1** (required — bypass restored at `server-wiring.ts:713`): `__tests__/ws-no-hub-bypass.test.ts > no send bypasses WSHub > finds no raw socket send outside ws-hub.ts` — `AssertionError: expected [ Array(1) ] to deeply equal []`; assertion `expect(offenders).toEqual([]);`. **The wire-identity test passed under M1**, because a bypass emits byte-identical output — the causality evidence that the two tests cover different properties.
- **M2** (negative control — `alpha` → `alphA` in one expected frame): `__tests__/ws-hub-wire-identity.test.ts > WSHub routing leaves the wire unchanged > emits the pre-refactor bytes exactly` — `AssertionError: expected [ …(6) ] to deeply equal [ …(6) ]`; assertion `expect(sent).toEqual(EXPECTED_FRAMES);`.
- **Positive control, observed not argued:** the first capture returned **five** frames — without a `promptRegistry` in the wiring, site `:756` is skipped by its own guard and the harness silently covers five of six sites. This is why the test asserts `toHaveLength(6)` plus the six `type` values.

### Environment findings (not fixed here)

- **`npm run lint` is broken inside any `.worktrees/*` worktree.** `biome.json`'s `files.includes` carries `"!.worktrees"`, so `biome check .` resolves to a path under `/.worktrees/` and reports `Checked 0 files` then errors. Reproduced in Group P's worktree, so it is pre-existing. Owner confirms the prior program hit the same thing and ran `npx biome check <files>` from worktrees. Use explicit paths; a `Checked 0 files` is never a pass.
- **`handleWsMessage`'s body sits inside a bare `try { … } catch { // malformed JSON, ignore }`.** Pre-existing, and it is why the three unwired-`wsHub` tests failed with "replay is undefined" rather than a `TypeError`.

### Full-suite lock protocol (owner rule, in force from 2026-08-28)

Before any `npm test` in a streamer worktree: `until mkdir /tmp/tb-streamer-suite.lock 2>/dev/null; do sleep 20; done`, run, `rmdir` via `trap ... EXIT INT TERM`. Targeted `vitest run <file>` and lint may run concurrently. A green that shared the box with a killed sibling run is not a clean green.

---

## W1b design input (decided with the owner, argued in the W1b plan)

A seal failure must never fall into `handleWsMessage`'s bare `catch {}`; W1b narrows that swallow to JSON parsing only.

The close reason for a seal failure is **distinct** from `E2EE_SEQUENCE_VIOLATION` — proposed `E2EE_SEAL_FAILED`. A seal failure on the send path is a **server-side fault**; a sequence violation is a **claim about the peer**. Collapsing them would repeat the two-failures-behind-one-code P1 in a new place.

**`E2EE_SEAL_FAILED` joins the strings frozen at W1a's tag**, so X-client can tell the two apart: `E2EE_CTX_UNKNOWN`, `E2EE_DEVICE_REVOKED`, `E2EE_SEQUENCE_VIOLATION`, `E2EE_SEAL_FAILED`.

## W0 remaining sequence

User commit approval (in W's pane) → push → PR (body carries both captures + empty diff, M1/M2 names and verbatim assertions, the M1-passes-wire-identity note, the five-frame catch, the non-OPEN delta, the scanner's ceiling) → rebase onto latest `origin/main` → CI green → squash-merge → confirm `MERGED` → report whether semantic-release cut a tag (**a `refactor` commit may not cut one** — say which). Then W1a, `NONCE-DESIGN.md` first.

---

## Sub-agent spawn rule (owner advisory 2026-08-28, after Group M lost two reports)

**`record-layer-adversary` is spawned as a one-shot synchronous `general-purpose` Agent call, so its report returns as the tool result.** A named teammate only for genuine back-and-forth, and only with an agent definition carrying no `tools:` frontmatter — a pinned `tools:` list omits `SendMessage`, so the teammate finishes and its report is silently lost. This matches the user's global `CLAUDE.md` ("one-shot report → anonymous synchronous agent").

**An idle notice is never a deliverable.** The adversary's table — every attempt in its brief listed as `rejected: <evidence>` / `succeeded: <finding>` / `not attempted: <reason>` — must arrive as content, or the run did not happen. An omitted row reads as covered, which is the "filtered sample reported as exhaustive" failure the acceptance exists to prevent.

**W0 note:** no sub-agent was used. W0 is a six-line mechanical refactor plus two test files with no crypto, and the program's isolated-verifier requirement (workspace `CLAUDE.md` §4) applies to crypto changes. Reported to the owner rather than assumed.

**Adversary gets its own worktree, from the moment it is dispatched** (owner advisory 2026-08-28, from a Group M incident). Implementer in `.worktrees/feat/e2ee-record-layer`; adversary in `.worktrees/audit/e2ee-record-adversary`, checked out at the **exact commit under review**, `node_modules` symlinked, never in W's tree. The orchestrator is the likely second writer — it rebases and merges — and two writers in one tree is the workspace `CLAUDE.md` §6 stop-work hazard. **Discard any measurement taken while a tree was moving.**

**A dispatched sub-agent is presumed resident in its worktree until it explicitly acknowledges a move** (owner rule, strengthened 2026-08-28 after a second Group M near-miss where the sub-agent caught the orchestrator's dirty files and stop-worked correctly). Until that acknowledgement, W does not edit, rebase, or run suites in `.worktrees/audit/e2ee-record-adversary`.

---

## Owner ruling on sub-agent use, 2026-08-28 22:24

W0 done first-hand is **accepted as done** (mechanical, no crypto).

**W1a and W1b go through `streamer-record-layer-engineer`, one-shot synchronous per PR.** The reason is the orchestrator one, not the isolated-verifier one: *the session that reviews the diff must not be the session that wrote it*, and that separation matters most exactly where a plausible-looking wrong answer passes review — the record layer.

Division of labour per crypto PR:

1. **W writes `NONCE-DESIGN.md`** — it is the plan, and the owner approves it.
2. **`streamer-record-layer-engineer`** builds `record.ts` / `context.ts` / the route, in its **own** worktree.
3. **W reads every diff as reviewer**, never as author.
4. **`record-layer-adversary`** comes third — isolated, one-shot synchronous, in `.worktrees/audit/e2ee-record-adversary` at the exact commit under review.

**Suite cadence:** targeted `vitest run <file>` while iterating; exactly one lock-protected full run before each commit-approval request. The full suite is ~18 minutes (1079s), so a serialized two-track queue is ~36 minutes per round.

## W0 approval state

Owner: staged diff READ, commit message APPROVED verbatim, green suite ACCEPTED.
**User: approval requested 22:23, NOT yet given. Nothing committed.** The owner's "proceed with the user's approval" is an instruction to obtain it, not a grant of it — a peer session cannot approve a commit.

---

## W0 — COMPLETE, merged 2026-08-28 22:24 UTC

| | |
|---|---|
| PR | [#740](https://github.com/RonenMars/threadbase-streamer/pull/740), `MERGED` |
| Squash commit on `main` | **`91ce3f18`** — `refactor(ws): route every socket send through WSHub (#740)` |
| Branch commit | `3cc15f9b`, rebased onto `3f7f9924` |
| Head branch | deleted |
| CI | all ten checks SUCCESS, `mergeable: CLEAN` |
| Local suite (rebased, under lock) | exit **0** — 251 files passed / 1 skipped, 2466 tests passed / 5 skipped, 1028.78s |
| Mutations re-run post-rebase | M1 and M2 both still red |
| **Release tag** | **NONE.** The `Release` workflow ran on `91ce3f18` and completed `success` without cutting one. Latest tag remains **`v1.70.6`**. |

**Why no tag, confirmed from config rather than inferred:** `.releaserc.json` uses the `conventionalcommits` preset, whose default release rules cover `feat` (minor), `fix` and `perf` (patch) only. `refactor` appears in neither the preset defaults nor the repo's explicit `releaseRules` (`chore`, `docs`, `test`, `build`, `ci` → `release: false`), so it is non-releasing by omission.

**Consequence for the program's "children key off release tags, never merges" rule:** W0 produces no artefact to key off. Nothing downstream was waiting on a W0 tag — X-server keys off `NONCE-DESIGN.md` approval plus **W1a's** tag, and X-client off **W1b's** tag. W1a adds `src/e2ee/record.ts` under a `feat` commit, which *is* releasing, so the tag those tracks wait on arrives there.

## Next: W1a

`NONCE-DESIGN.md` first, written by W, owner-approved before any code.
Branch `feat/e2ee-record-layer` in the same worktree, started from the post-W0 `origin/main` (`91ce3f18` or later).
Implementation by `streamer-record-layer-engineer` in its own worktree; W reviews every diff; `record-layer-adversary` third, isolated, in `.worktrees/audit/e2ee-record-adversary`.

---

## W1a plan approved 01:45, 2026-08-29

`NONCE-DESIGN.md` approved by `e2ee-owner` with one ruling that rewrote §8, plus three smaller items — all applied. Branch `feat/e2ee-record-layer` from `91ce3f18`.

**Ruling: a context is bound to one channel instance, not to the device.** Two contexts per device, one IK handshake each:

- **WebSocket context** — per socket, dies with it, **no grace window**, strict `expected` on channel `0x01`, no rekey (the socket is shorter-lived than any bound). A reconnect is a new `/api/e2ee/open`, which the single-use 30 s ticket already implied.
- **REST context** — per device, long-lived, channel `0x02`/`0x03`, sliding window (X-server populates it), rekey on 1 GiB or client foreground, destroyed at 24 h.

`context.ts` keys receive state by **(context, channel)**.

Two reasons, verified against the sources rather than accepted: `X-TB-Ctx` carries a `ctxId` on every REST request and the 2 s HTTP replay fallback (`mobile-design.md` §4.3) runs *while the socket is down*, so a socket-bound context takes the fallback with it; and a shared context would **sequence-violate itself into a close loop**, because frames in flight at a drop are lost and R2 reads the first frame after a reconnect as a gap.

**A new context is not a counter reset.** §6's invariant scopes uniqueness per context; a reconnect yields a new `ctxId`, new keys, and counters legitimately at 0.

Other rulings: §10 ticket log approved as a W1a widening — option (1), a sensitive-key set in `summarizeQuery` (`ticket`, `key`, …) always reduced, tested with an **all-digit** ticket plus a `limit=50` control proving it is not blanket numeric redaction. §4 — collapse `E2EE_EXCHANGE_VERSION` into the canonical constant under `src/e2ee/`. §7/R4 — the exhaustion test may use a construction-time `createRecordState({ initialCounter })` seed marked internal; a `seal(counter, …)` signature stays forbidden, and §5 R4 says so explicitly so the adversary does not read the seed as a violation.

**Doc corrections in the W1a PR** (new §14): `design.md` §4.3 twice — the counter sentence and the "follows the socket"/"grace window" sentences — and `mobile-design.md` §4.3's reconnect row.

---

## HOLD — 2026-08-29 01:51 (user's instruction, relayed by `e2ee-owner`)

An independent reviewer (`e2ee-mega-brain-reviewer`) is reviewing `NONCE-DESIGN.md` and the program state. Its findings **may change §6 or §8, or the code**.

Until `e2ee-owner` sends the findings **and** an explicit "go":

- **Do not commit.**
- **Do not ask the user for commit approval.**
- **Do not spawn the adversary.**

Permitted meanwhile: the implementer keeps building; W reads its diff as reviewer when it returns.
If the implementer finishes first, it stops at a **clean staged tree** and reports; W holds the report and reviews it, and nothing advances past review.

**Note on why §6/§8 are the exposed sections:** §6 (counter does not reset on rekey) and §8 (two contexts per device) are the two places where the owner's rulings overrode the written `design.md`. They are the correct sections for an independent reviewer to test hardest, and a finding against either would invalidate work already done in the implementer's tree rather than merely adding to it.

---

## Revision 2 + B3 ruling + stop-work resolved, 2026-08-29

**NONCE-DESIGN.md is now 401 lines**, revision 2, incorporating the independent review (`tracks/REVIEW-2026-08-29-mega-brain.md`: 3 blockers, 4 high, 12 medium, 12 low, 9 notes). New sections: **§11 The `/open` handshake**, **§12 Wire encodings**, **§13 The REST envelope contract**, §18 two easy-to-miss items.

**B3 — RULED BY THE USER, 2026-08-29: Alternative B, no in-place rekey.**
> A key is never replaced inside a context. A new key is a new context.

24 h, 1 GiB and foreground all mean "open a new REST context, drain the old, then `E2EE_CTX_UNKNOWN`". `rekey()` and `bytesSealed` are **deleted**, not merely unwired. `CLAUDE.md` §3 / `plan.md`'s *"the counter surviving a rekey is the rule tested hardest"* is **retired with the reason recorded in §6** — no code path rekeys, and a test obligation for a nonexistent path invites someone to re-add the path to satisfy it.

**Stop-work (traffic key in a log) — RAISED and RESOLVED "continue" by the user at 03:11.**
A failing assertion serialised a context including the traffic key `k`. Verified myself rather than trusting "scrubbed": decoy positive control proving the scan fires, then exact-value grep across both worktrees, the scratchpad, the 22 mutation-evidence files, the suite logs and `tracks/`. **Zero hits outside three fixtures**, all of which are meant to contain them. Decisively: the keys are byte-identical to the **already-committed** `noise-ikpsk1-vectors.json` on `origin/main` since `8ed91593` (#631) — nothing was exposed that was not already a published test vector. The *mechanism* was real; fixed by making `k` non-enumerable, with a test and its own red mutation, both kept. `JSON.stringify` is not protection — it throws on the `bigint` counter; the leak path is `util.inspect` / the test differ.

**§15 defect found by the implementer, fixed in the doc.** `direction` and `counter` are each bound in *two* places — the AAD **and** the nonce — so dropping either from the AAD alone leaves the frame rejected anyway and the safeguard test stays green. Those two rows now specify a **full-binding** mutation, with the reasoning written beside the table. `ctxId` and `channel` are AAD-only, so their single-field mutations are genuinely sufficient.

**Session note:** a duplicate session `e2ee-W-opus5-high [a26ff1]` exists. **This session, `[e16afe]`, is the one of record.**

---

## Sub-agent addressing (owner advisory 2026-08-29, after a Group F near-miss)

A message sent to a sub-agent **by bare name** reached a stale earlier instance with the same name — names collide across turns, and the newer agent wins the bare name. That stale instance then inspected the live implementer's worktree and correctly stop-worked.

**Group W is immune to this by construction, verified rather than assumed:** the implementer was spawned **anonymous** and every message to it has gone to its agentId `a1cdd5aac93335f6a`. `ListAgents` shows exactly one subagent, running, with no name to collide on. The adversary will be spawned the same way — anonymous, addressed by id.

If a stale instance ever wakes here: tell it to go idle and stay out of every worktree.

**Also cleared:** the duplicate `e2ee-W-opus5-high [a26ff1]` is no longer listed. This session `[e16afe]` remains the one of record.

## Rev3 gates — status

Doc gates (N-M1 §8 sweep, N-H1 wording + `provisional` field, N-M2 canonicalization table, N-M3 tunnel bound, N-M6 retryable saturation, N-M7 eviction order + drain, N-L1 Access sentence, N-M4/N-M5 fixture requirements) — **applied, `NONCE-DESIGN.md` rev3, 430 lines.**
Code gates 2–5 + N-M6, N-M7, N-M3(optional), N-L2 — **queued to the implementer**, which is mid-run.

---

## W1a — owner diff read, three edge defects, 2026-08-29 05:19

Owner read the full diff. **The record layer itself is confirmed correct** — offsets, big-endian nonce, ctxId-before-AEAD then auth-before-sequence, R1–R4, the sealer's one-response rule with bounded eviction, both-direction `assertTarget`, non-enumerable keys plus the inspect-custom on `HandshakeKeys`. Three defects at the **edges**, all verified by W in the source before dispatch:

1. **`/open`'s IP rate limit bounded nothing.** The boolean was ignored and nothing consulted the bucket before `readMessage1`, so unlimited garbage msg1s each cost two DH — the D-9 CPU case on a public endpoint. The comment asserted *"sustained garbage from one source is exactly what it still bounds"*, which is false: **charging a bucket you never check bounds nothing**, and a comment claiming a protection that does not exist is worse than no comment because it stops the next reader looking. Fix: a failure bucket keyed by IP, **checked before the handshake**, charged only on failure.
2. **The psk-less branch was selected by the absence of `psk`** (`args.psk ? NOISE_PROTOCOL_NAME : NOISE_IK_PROTOCOL_NAME`). A pairing call site that forgets the argument silently downgrades to plain `IK` and loses the pair-token binding — **a missing argument selecting a weaker protocol, at a trust boundary**. Fix: an explicit `pattern` argument that throws in both directions.
3. **Retired and expired contexts were never swept.** Pruning happened only inside `get()`, on that exact `ctxId` — and a replayed msg1 creates contexts **nobody will ever look up**, so the sweep never ran on exactly the contexts an attacker manufactures. Fix: sweep on the `open` path before the cap; **anything that allocates must also be a place that collects**. Also `destroy()` returned early for an unregistered context, making the "drop the ticket" comment on the `writeMessage2` failure path false.

Notes: `openWith` is unexported, so the REST sliding-window receiver needs a sanctioned `unsealUnchecked` seam — the PR body must say which side adds it. 5 `/open`/min per static key is thin for a flaky network and is named a tunable.

**NONCE-DESIGN.md is rev5, 453 lines**, carrying all three rules plus the seam and the tunable, and three new §15 mutation rows.

---

## Adversary round 1 — 2026-08-29 08:02. IT BROKE IT.

Isolated agent, spec + code only, 20 attempts. **16 rejected, 6 succeeded.** Every attack on the record layer's core was rejected — replay, reflection, `ctxId` confusion, cross-socket, channel confusion, target canonicalization, the provisional cliff, and every abuse of `unsealUnchecked`. All six defects were at the **edges**.

| | Finding |
|---|---|
| **A** | **Nonce reuse.** `RestResponseSealer.accept()` re-armed a spent counter, so two responses sealed under `(k_s2c, 2‖7)`. Keystream reuse proven: `xor(c1,c2) === xor(p1,p2)`. The class doc claimed it refused this. The invariant was actually held one layer up by `unsealRequest`'s strict counter — **the exact code §13 schedules the sliding window to replace.** |
| **B** | Traffic keys printed under `util.inspect(x, { showHidden: true })`. `hideKey` set only `enumerable: false`; `noise.ts`'s own comment said that is insufficient, and `record.ts` never got the inspect-custom hook. Inspecting the **registry** dumped every live context's keys in one call. |
| **C** | **Eviction destroyed the context being opened.** It is provisional by definition, so "provisional first" sorted it to the front of its own queue. A device with 4 live sockets could never open a usable 5th. **Caused by W's own design contradiction** — §15 said "evicts the oldest", §8 said "provisional first". |
| **D+E** | The `/open` limiter was backwards: a well-formed msg1 from a fresh keypair never charged the failure bucket (50/50 reached the handshake, `dh=50`), while five malformed ones locked out paired devices. **The flood that costs DH never tripped the limit; the trivial flood that tripped it hit only legitimate devices.** |
| **F** | The pattern selector fell through to **psk-less `IK`** for any unrecognised string, dropping the pair-token binding. TypeScript blocks it in-repo; the client track consumes this module as an artefact. |
| **18** | The sealer's `evicted` table overflowed into the dead-end `E2EE_SEAL_FAILED` §13(a) forbids. |

**This is the isolated-verifier requirement paying for the whole programme.** Every one of these passed our own green suite.

### Fixes (owner-ruled shapes), all mutations red

- **A** — `outstanding` + monotonic `acceptedHighWater` + an RFC-6479 bitmap of answered counters. `accept()` refuses outstanding / below-window (as **recoverable**) / answered; `seal()` carries the matching split. **The `evicted` Set is gone, which closes 18 with it.**
- **B** — one `redactKeyMaterial()` in `protocol.ts` used by all five key-bearing objects. Four private conventions is how the fifth gets missed.
- **C** — candidates computed from the *other* live contexts before inserting. Design contradiction fixed: the context being opened is never a candidate. **A fixture of four *unused* contexts stays green through this bug** — the regression test holds them in use.
- **D+E** — failure budget charged on `E2EE_DEVICE_REVOKED` too, raised to 30/min; per-device allocation stays 5/min. Tunnel residual named as operator-side control for R's rollout guide.
- **F** — runtime membership check plus a `switch` with a `never` default.

**Suite on the refrozen tree: exit 0, 2558 passed. 53 mutations, 51 target-red.**

### Three process notes worth keeping

1. **The implementer found a second bug inside its own fix**: `isAnswered` read a bit modulo the window width for a counter *above* the high-water mark, so a **fresh** counter was refused as already answered. Same class as the defect being repaired.
2. **A mutation went green and was retargeted rather than reported as a pass** (M51: the runtime check and the `never` arm are redundant, so removing one proved nothing). M32 was **explicitly deleted**, not silently dropped, when the ruling removed the code it targeted.
3. **Key-hygiene assertions must reduce to a boolean.** `expect(rendering).not.toContain(secret)` prints the whole rendering on failure — the test proving keys are hidden would publish them the first time it failed.

## Adversary round 2 — running

Fresh anonymous agent, **rebuilt** audit worktree (round 1's attack files removed — an adversary that finds the previous round's tests is not isolated), verified byte-identical to the implementation tree. **26 rows**: the original 20 plus six attacking the fixes directly, plus the boolean-assertion rule and a positive control required for every detector.

If round 2 diverges from round 1 on A/B/C, send **both shapes** to the owner before deciding which is right — the implementer rebuilt those cases from a description rather than from round 1's files.

---

## Decision: the mutation campaign is re-run on every refreeze, never carried forward

**2026-08-29, from a real occurrence in W1a.** While adding the round-2 tests, a bad edit silently deleted **four** route tests — the source-budget ordering, the well-formed-unpaired charge, the paired-device lockout, and per-device keying. **The suite stayed green.** The loss surfaced only because six previously-red mutations went green on the next campaign run.

A passing suite cannot report coverage that has disappeared: a deleted test does not fail, it simply stops existing. **Only re-running the mutations detects it**, and only if they are re-run against the current tree rather than trusted from the previous round.

Recorded in the PR body's verification section for the same reason.

## Round 2 result — all six round-1 fixes held

54 attacks across 26 rows. Nonce reuse survived a **40,000-iteration hostile fuzz** over a counter distribution built from window edges, attempting `seal` twice per iteration regardless of whether `accept` succeeded: >1000 records, **0 duplicate nonces**, with a negative control proving the harness catches the pre-fix bookkeeping. Window edges, eviction with the cap full of *in-use* contexts, and 18 hostile pattern values all rejected.

Four new findings, three availability and one hygiene — **none confidentiality**:

- **E-1** one captured msg1 bought unlimited DH (a replay for a *live* device is neither a handshake throw nor a missing row, so no budget charged it).
- **E-2** *the sharp one*: five replays of one captured msg1 spent the **victim's** minute and pushed it past its socket cap, while bystanders were unaffected. **Caused by §8's own "key the limiter on the authenticated device"** — a replay authenticates as the victim, so keying on the device is what made it targeted.
- **E-3** 30 malformed msg1s from one source deny every paired device behind a shared-IP tunnel. No code; operator-side control, stated in §8.
- **E-4** the Noise handshake states hold `ck`, from which **both** traffic keys derive, and were outside the redaction helper — rendered by *plain* `util.inspect` at default depth. §13's "every object" sentence was false in exactly the way it warns about, one layer below where anyone looked.

Fixed by an **ephemeral-keyed msg1 replay cache** checked before any DH and charged to the **source, never the device**; insertion-ordered rather than LRU, because a hit *is* a replay and refreshing would let an attacker pin a slot. Owner accepted the divergence as strictly safer than the ruling.

---

## Adversary round 3 — 2026-08-29 09:51. Two more breaks.

14 rows, 68 checks. **Every previously-fixed defect held** — nonce reuse under a 40k fuzz plus ten hand-built edge scripts, window edges against an **independent oracle** over 20k operations, eviction with the cap full of *in-use* contexts (the evicted context kept sealing for the whole 10 s drain), 38 hostile pattern values, and the replay cache's collision, TTL, memory and who-pays rows.

**Break 1 — key hygiene defeated by a third inspect mode.** `util.inspect(x, { customInspect: false, showHidden: true })` rendered traffic keys from **all eight** key-bearing classes; on the **registry** that is every live context's key in one call. Mechanism confirmed in source: `enumerable:false` is beaten by `showHidden`, the inspect-custom symbol by `customInspect:false`, and `private readonly k` is TypeScript-only — **a real own property at runtime**.

> **Fixed by migrating to ECMAScript `#private` fields — a smaller fix than the mechanism it replaced.** A `#private` is not a property, so it is invisible to `showHidden`, `customInspect:false`, `getOwnPropertyDescriptors`, spread and `structuredClone`. It needs no hide list and no inspect handler to be correct, **so it cannot be defeated by a mode nobody thought of.** Three rounds of the weaker mechanism; §13 now carries a defeated-by table so nobody reaches for it a fourth time.

**Break 2 — unauthenticated traffic drove the replay cache's eviction clock.** `replays.record()` sat after the handshake but *before* the device-row check, so a msg1 from a keypair the server had never seen still wrote an entry: ~43 200 entries/day from one source, ~66 % of capacity, and the entries evicted first are the oldest — **where a captured victim's msg1 lives**. Fixed free by moving the record below the device check.

**Contract gap** — a client that re-sends an **identical** msg1 after a lost response is refused for the cache's lifetime. The rejection deliberately stays `400 E2EE_HANDSHAKE_FAILED`, indistinguishable from any other handshake failure, because telling an attacker which capture the server recognises is worse than the missing diagnostic. **Every `/open` attempt must re-run `writeMessage1`** — now §11, and in the client track's brief.

**E-3 was under-quantified by me.** A refused request is never charged, so ~0.5 rps holds the bucket full **indefinitely** — fleet-wide `/open` denial for as long as the flood lasts, not "a minute", and a replayed msg1 does it at **zero** server DH.

### The process note that matters most

**The adversary's first key detector reported `RecordState` clean, and was wrong.** `util.inspect` prints a Buffer under `showHidden` as a multi-line **decimal `Uint8Array`**, not `<Buffer de ad …>`, and its needle list knew only the second spelling. **The unredacted-object negative control is what exposed it.** Without that control the report would have said key hygiene was clean — for the third round running.

### My own process failure

**The implementer never pulled rev7.** I wrote "I am fixing §8, §15 and §13 on my side" and never told it to copy the file, so round 3 audited a design 18 lines stale and two of its findings were already fixed but undelivered. **Fix: deliver the file explicitly and `diff`-verify both copies before every freeze.** Confirmed empty for rev8.

## Program-wide rule: the mutation driver reverts in a `finally`

The implementer died mid-campaign and reported *"a mutation revert left the tree damaged — my driver applies patches outside its try/finally."* **A tree that still typechecks with a safeguard silently removed is the worst artefact this process can produce, because nothing reports it.** The driver applies inside `try`, reverts in `finally`, and asserts `git diff --quiet` after **every** mutation so a failed revert halts the campaign rather than poisoning it. Owner has made this program-wide.

**Always check for a stranded mutation before trusting a tree whose agent died mid-campaign.**

---

## Adversary round 4 — 2026-08-29 13:10

**Key hygiene verified closed** — all eight key-bearing classes across **15 renderers**, plus errors thrown from inside `seal`/`unseal`, with a leaky state **planted inside the registry's own private map** as the control proving the walk reaches the leaves. Three rounds to get there.

Three findings, all confirmed in source by W before dispatch:

1. **`RestResponseSealer.seal` never validated its target**, and because `sealWith` concatenated the target *beside* the header rather than passing it *into* the AAD builder, the builder's 32-byte check was **unreachable from every seal path**. A REST response could be sealed with **no** request-target binding. The receive side and `RecordState` both held — *the response sealer was the one unexercised path, and it is the class the REST middleware will call*.
2. **The PSK was never length-checked** — `if (!psk)` is truthiness, so `Buffer.alloc(0)` completed a full `IKpsk1` handshake with the right protocol name, the right token order, and a binding over **zero bytes**. The wire claims the pair token is bound; it is not. **Exactly what §11 rejected when it refused a public-constant PSK**, arriving through a missing length check.
3. **A timing oracle**: a replay returns before the handshake, so it costs 0 DH while every other refusal costs ≥1 — a free poll answering "is my capture still cached?". **Accepted**, because the floor it reveals is already bounded and documented; recorded in §8 so it is a known property rather than an unstated gap.

Plus three one-line fragilities, all fixed: `args.pattern ?? …` was a **prototype-chain read** (prototype pollution could downgrade a protocol selector at a trust boundary); `HandshakeKeys` getters returned **live** buffers; the registry's **ticket table** rendered in full under `customInspect:false` — tickets are credentials.

## The defect class: a guard hardened against *missing*, silent on *empty*

**Three instances of one defect**, in three files:

| Guard | Broke on |
|---|---|
| `if (!psk)` in `noise.ts` | `Buffer.alloc(0)` — a keyed handshake with a zero-byte binding |
| target concatenated beside the header | the length check unreachable — a response with no binding |
| `if (target)` in `assertTarget` | an empty target passing the assert, caught only *after* the sealer had spent an acceptance it can never re-arm |

The third was found by the **implementer, in its own new code, while fixing the second** — it noticed the pattern. All are now length checks at the root, with the reasoning inline naming the sibling guard.

**Row 6 of the final round sweeps the class itself**: every truthiness guard on a Buffer, string, array or numeric field in `src/e2ee/*` and the route, with a verdict per guard reported whether or not it breaks. Three instances is a class, not a coincidence.

## The driver hardening paid for itself one round after it landed

Fix 1 moved the AAD construction, invalidating the patch targets of **six** older mutations; the `#tickets` rename invalidated four more; the PSK guard and the selector one each. **All twelve surfaced as `patch target not found` and halted the campaign** rather than passing quietly.

Without the hardening the run would have reported **62 red while six safeguards were no longer being tested at all** — silent coverage loss, the same class as the four deleted tests and the module that failed to parse. Three distinct instances of "absence of a failure is not evidence" in one track.

**Final state before the last round:** 64 mutations / 62 target-red, suite **2576 passed / 5 skipped, exit 0**, 23 files, 5994 insertions, HEAD `15696278`, rev9 diff-verified empty.

---

# W1a — SHIPPED. `v1.71.0`, 2026-08-29.

| | |
|---|---|
| Tag | **`v1.71.0` → `f95150cc`** — verified with `git merge-base --is-ancestor 9b5f367d v1.71.0` |
| W1a PR | [#741](https://github.com/RonenMars/threadbase-streamer/pull/741) `MERGED` → **`9b5f367d`**, 10/10 CI green |
| Release fix | [#742](https://github.com/RonenMars/threadbase-streamer/pull/742) `MERGED` → **`dd74849f`** |
| Final size | 28 files, 6 915 insertions |
| Suite | 2 590 passed / 5 skipped |
| Campaign | 78 mutations, 76 red (2 documented greens) |
| Fixture at the tag | `__tests__/fixtures/e2ee-record-vectors.json` |
| Frozen codes at the tag | `E2EE_CTX_UNKNOWN`, `E2EE_DEVICE_REVOKED`, `E2EE_SEQUENCE_VIOLATION`, `E2EE_SEAL_FAILED` |

**The tag needed a second PR.** The `Release` run on W1a's merge failed at `generateNotes`: dependabot's `conventional-changelog-conventionalcommits@10.4.0` requires `conventional-changelog-writer@9`, and the resolved writer was 8.4.0. **The pipeline had been broken since that bump and reported success twice**, because `generateNotes` only runs when there is a release to make and every intervening commit was non-releasing. W1a's `feat` was simply the first commit to run the code. Pinned to exact `10.3.0`; `fix` releases, so #742 is what cut the tag carrying W1a.

## What six adversary rounds cost and bought

**Nineteen real defects**, none of which our own green suite could have found. The three that mattered most:

1. **Nonce reuse** through the response sealer — keystream reuse proven — held only by a layer scheduled for deletion.
2. **The downgrade guard failing open** in six input shapes, in the helper two other tracks consume.
3. **Traffic keys readable from the registry** in one call, via the *allocation pool*, through an object holding no key at all.

## Two lessons that outlived the track

**"A guard hardened against *missing*, silent on *empty*."** Four instances, four files — `if (!psk)`, a target concatenated beside its check, `if (target)`, and `.length` where `byteLength` was meant. Now one `assertBytes` helper: *the defect was not in any single guard, it was in writing the guard four times.*

**"Absence of a failure is not evidence; only an observed red is."** Five instances: four tests silently deleted with the suite still green; a mutated module that failed to parse and was read as a pass; twelve mutations whose targets moved in a refactor; a `Release` workflow succeeding because it exited before the broken step; and — during the fix for that very class — **my own `--dry-run` verification exiting 0 without reaching the step under test.**

Both are in `ADVERSARY-BRIEF.md` for the later tracks.

## W1b — started

Worktree `.worktrees/feat/e2ee-ws-sealing` from `v1.71.0`. Plan approved and amended (`PLAN-W1b.md`): header-carried ticket, socket close destroying only its own context, the `E2EE_SUPPORTED` correction. Implementer writes, **W reviews and does not author**. X-server runs in parallel on the same tag; file sets are disjoint and the shared crypto surface is *consumed from the tag, never edited* — if either track needs to change `record.ts` or `context.ts`, stop and coordinate rather than merge-resolve a crypto module.

**Addressing:** the owner is `e2ee-owner [ddde5e]` and is addressed **with the ref**. A duplicate `[2f959c]` appeared and vanished; same name + new ref is not the same session.
