# Streamer: emit the app-level `{ type: "ping", ts }` the record layer already documents

Agent note. Mobile issue #946's streamer half.
Branch `fix/e2ee-ws-app-ping`, worktree `tb-streamer/.worktrees/fix/e2ee-ws-app-ping`, off `origin/main` `d9148f25`.
Owner mirrors this file; this agent does not commit it.

## 1. Diagnosis re-verified from `origin/main`, and one broken grep caught

Re-verified rather than trusted. The first form used was `git grep -E 'type:\s*"ping"'`, which returned nothing — **and so did its positive control** for `session_list`. `git grep -E` is POSIX ERE and does not support `\s`, so the emptiness was the grep, not the code. Re-run with `[[:space:]]`:

| Grep | Result |
|---|---|
| `type:[[:space:]]*"session_list"` in `src/`+`cli/` | **6 hits** (positive control passes, including the bare `type: "session_list",` line form a multi-line literal would use) |
| `type:[[:space:]]*"ping"` in `src/`+`cli/` | 2 hits: `src/types.ts:339` (the declaration) and `src/ws-hub.ts:257` (the comment) |
| `-F '"ping"'` in `src/` (no regex at all) | the same 2 |

**Confirmed: nothing in `src/` constructs or sends an app-level ping.** The type is declared, the send path documents sealing it, and no code emits it. Nine `{ type: "ping" }` constructions exist in `__tests__/`, where the frame is used as a generic broadcast vehicle.

Also confirmed: `src/ws-hub.ts:488` `client.ping()` inside a 30 s `setInterval` is the only idle liveness signal, and it is a WebSocket **protocol** ping, invisible to `onmessage`.

## 2. Counter consumption — the concern is structurally void, not merely small

The brief asked what the change does to counter consumption and to any rekey threshold the counter feeds.

**There is no rekey threshold on `origin/main` to reach.** NONCE-DESIGN §6 (user's ruling, 2026-08-29) removed in-place rekey entirely, and the code matches: `git grep -E 'rekey|bytesSealed|rekeyDue' -- src` returns **three comment lines asserting their absence** and no implementation. `record.ts:23` states it directly. So the brief's hypothesis — *"a rekey path previously reached only under load may now be reached by an idle session"* — cannot occur: the WS channel has no rekey, no byte-count trigger, and no key generation.

The only counter threshold that exists is exhaustion, §7 `MAX_COUNTER = 2n ** 64n - 1n`, refuse-don't-wrap:

- cost of the change: **one s2c WS counter per sealed socket per 30 s** = 2/min, 2 880/day.
- time for pings alone to reach `2^64`: ~**1.75 × 10^13 years**.
- and a WS context dies with its socket (§8, no grace window), so no socket accumulates across reconnects. A reconnect is a new context with counters legitimately at 0 — §8 is explicit that this is not a counter reset.

**Nothing keys off "the counter did not advance".** §5 R4 makes the counter owned by `RecordState` and never passed in; grepping every `.counter` / `#n` read outside `record.ts` returns exactly one hit, and it is a comment in `context.ts:290` telling a caller *not* to read `state.counter`. So un-freezing an idle socket's s2c counter is observable to nothing.

Net: counter cost is real, bounded, and reaches no threshold. No record-layer change is required — the change is confined to `ws-hub.ts`'s caller, so §4's isolated-adversarial-verifier gate is not triggered. Flagged for the owner rather than assumed.

## 3. The seal-then-send ordering hazard — proved absent, not argued unlikely

`ws-hub.ts:243` warns that an `await` between `seal` and `ws.send` reorders frames and trips the peer's strict `counter == expected` (§5 R2). A periodic timer is the shape that warning describes, so it needs a proof.

1. `sendTo` is synchronous end to end: `context.sendState(CHANNEL_WS).seal(memo.plaintext)` then `ws.send(frame)`, with no `await` and no promise between them.
2. `RecordState.seal` is synchronous. `src/e2ee/record.ts` and `src/e2ee/context.ts` contain **no** `async`, `await` or `Promise` at all (grepped).
3. The emission site is the existing `setInterval` callback in `startPing`, itself synchronous.
4. Node runs a synchronous block to completion on one thread, so two `sendTo` calls cannot interleave. Counter order therefore equals `ws.send` order, and `ws` preserves FIFO per socket.

That is a proof from the absence of suspension points. The corollary worth a comment at the emission site: the hazard would be **created** by making that callback `async`.

### The ordering hazard that is real, and where it bites

Not the seal/send pair — the **placement relative to the two guards already in `startPing`**:

- guard 1, stale context: `registry.get(context.ctxId) !== context` → `closeForE2ee(client, E2EE_CTX_UNKNOWN, "maintenance")`
- guard 2: `readyState !== OPEN` → `continue`

Emitting the ping **before** guard 1 seals on a registry-invalidated context, which **throws** — `contextCanSeal(stale) === false` is asserted at `__tests__/e2ee-ws-sealing.test.ts:1683`.

**Correction to what this agent first reported.** The gate-1 message said that mutation would close the socket `E2EE_SEAL_FAILED` instead of `E2EE_CTX_UNKNOWN`, a §9 semantic change. **That was wrong, and the mutation run disproved it.** `invalidateContext` (`context.ts:246-250`) clears the send-state map, and `sendState` then throws `RecordError(E2EE_CTX_UNKNOWN, …)` (`context.ts:264`) — so the close code is `E2EE_CTX_UNKNOWN` either way and §9's semantics are not touched.

What emitting above the guard actually costs, and it is still worth refusing: a socket the maintenance pass has already decided to close gets a send attempt first, the refusal is logged with `phase: "send"` rather than `phase: "maintenance"`, and the sweep does work proportional to sockets it is about to discard. The pre-existing assertion catches it either way.

Two **existing** assertions pin the correct placement, so this mutation already has its red test:

- `expect(sockets[0].send).not.toHaveBeenCalled()` — `e2ee-ws-sealing.test.ts:1631`
- `expect(sockets[0].close).toHaveBeenCalledWith(1008, E2EE_CTX_UNKNOWN)` — `:1627`

**Decision: the ping is emitted after both guards, beside `client.ping()`.**

## 4. Plaintext clients, and clients with no context yet

**Plaintext (legacy `?key=`) sockets** take the `sendTo` branch with no context and receive `{"type":"ping","ts":…}` as a text frame. Read-only check of tb-mobile `origin/main` `services/ws-client.ts:311-322`: `handlers.get(msg.type)` misses, no default case, no throw, then wildcard handlers fire. And `git grep -F "'ping'"` over mobile `services/ hooks/ components/` returns **nothing** (positive control on `'session_update'` returns hits in three files), so no handler exists to misbehave. The frame is inert except for resetting the silence timer.

Sending it to plaintext sockets too is deliberate: the client's 45 s timer is unconditional, so an unpinned client redials just as often — only more cheaply. Emitting to every socket fixes the churn for both paths and is what "the same send path as every other frame" already means, `sendTo` handling both.

**Mid-handshake:** the hub has no such state — `addClient(ws, context)` receives a context already built from the ticket. The analogue is the *unproven* socket (context attached, no inbound frame yet). A ping seals fine there (send state is independent of receive state) and must **not** clear the unproven timer, or the ticket-thief reaper at §10 stops firing. `clearUnproven` is called only from `receive()`, so it does not — pinned by a test, because that is the ticket-thief defence.

With production constants the question is moot anyway: the unproven deadline is 10 s and the first ping is at 30 s.

## 5. Cadence: reuse the 30 s timer

Client window is 45 s (`WS_SILENCE_TIMEOUT_MS`, tb-mobile `hooks/useTerminalStream.ts:25`). Existing protocol-ping interval is 30 s.

**Reuse it rather than add a timer.** One schedule cannot drift against itself, there is one place to change cadence, and the interleaving argument in §3 above is made once instead of twice. 30 s leaves a 15 s margin; one lost ping does exceed the window, which is correct — a socket dropping frames should be redialled.

## 6. Verification plan

`vi.useFakeTimers()` + `advanceTimersByTimeAsync(30_000)` against the real `startPing` is already the established convention in this file (`:1624`, `:1678`), so **no constructor seam is needed** — the real 30 s constant is exercised.

- **Real objects, real wire:** real `http.Server`, real Hono app, real `/api/e2ee/open` handshake, real `WSHub`, real `ws` sockets, real `RecordState` both ends. Faking **only `setInterval`** leaves socket I/O and the harness's `poll()` on real timers, so the frame is captured off the wire before the client's record layer touches it.
- **Negative control proving causality:** capture the `ws` client's `'ping'` event separately from `'message'`. Over one interval the protocol ping is observed on the `'ping'` channel while the JS-layer message channel carries exactly the app ping — so "the JS layer sees nothing from a protocol ping" is a fact about the protocol, not a harness that sees nothing.
- **Positive control:** the same harness reads the sealed ping's plaintext header at the expected counter and unseals it under the client's own key.

Mutations that must go red:

| Mutation | Test |
|---|---|
| remove the ping emission | the idle-session-gets-a-ping-inside-45 s test |
| send it unsealed to a sealed client | the wire-is-ciphertext assertion (no plaintext `type`, unseals at the expected counter) |
| cadence above the client's window | the constant-relationship test |
| emit before the maintenance guard | **existing** `:1627` / `:1631` |
| let a ping clear the unproven timer | the ticket-thief reaper test |

## 7. Results — gates, and all mutations seen red

**Gates on the final tree** (branch `fix/e2ee-ws-app-ping`, 2 files, +249/-8):

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean, exit 0 — **and positive-controlled**, see §8 |
| biome (working invocation, see §8) | `src/ws-hub.ts` and `__tests__/e2ee-ws-sealing.test.ts` clean |
| full suite | **Test Files 1 failed / 261 passed / 1 skipped (263)**, **Tests 1 failed / 2762 passed / 5 skipped (2768)** |

The single failure is `release-notes.test.ts`, a pre-existing dependency-version problem proven to fail identically on pristine `origin/main` (§8). Every other test in the repository passes.

### All mutations seen red

Run in the worktree, each applied to the pristine file and reverted after. `<file>::<test>` with the verbatim assertion:

| Mutation | Red test | Verbatim assertion |
|---|---|---|
| remove the ping emission | `e2ee-ws-sealing.test.ts::reaches an idle sealed session inside the client's silence window, sealed` (+4 more) | `timed out waiting for 3 frames` |
| send it unsealed to a sealed client | `e2ee-ws-sealing.test.ts::reaches an idle sealed session inside the client's silence window, sealed` | `AssertionError: expected '{"type":"ping","ts":…}' not to contain 'ping'` |
| cadence above the client's window (30 s → 60 s) | `e2ee-ws-sealing.test.ts::keeps the cadence under the window the client actually times out on` | `AssertionError: expected 60000 to be less than 45000` |
| cadence creep inside the window (30 s → 36 s) | same test | `AssertionError: expected 9000 to be greater than or equal to 10000` |
| emit above the maintenance guard | **pre-existing** `e2ee-ws-sealing.test.ts::the maintenance pass closes a cap-collected context without application traffic` | `AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| let a ping clear the unproven timer | `e2ee-ws-sealing.test.ts::does not let a ping prove that a sealed socket holds the keys` | `AssertionError: expected "vi.fn()" to be called with arguments: [ 1008, 'E2EE_CTX_UNKNOWN' ]` |

The cadence mutation also reddens the two pre-existing maintenance tests, which hardcode `advanceTimersByTimeAsync(30_000)` against the constant. That is existing coupling to `PING_INTERVAL_MS`, not something this change introduced.

## 8. Two tooling findings that affect the whole program

**`npm run lint` is a silent no-op inside `tb-streamer/.worktrees/<…>`.** `biome.json` sets `vcs.useIgnoreFile: true` and `.gitignore:7` is `.worktrees/`, so biome ignores every file in the worktree the program *mandates* for streamer work. It does not error — it prints `Checked 0 files` and exits 0. **Every streamer track in this program that ran lint from its sanctioned worktree got a false green.** The form that works is explicit paths with the vcs ignore off:

```
npx biome check --vcs-enabled=false src cli __tests__
```

That reports `Checked 481 files`. Proven with a positive control: an injected `const    __fmtControl   =    {a:1,   b:2};` produced `Found 1 error`, and the clean run after reverting it produced none.

With that form, this change's two files are clean. Four **pre-existing** format errors exist in the tree and are untouched here — `__tests__/apns-live-activity.test.ts`, `detect-question-from-screen.test.ts`, `input-prompt-arbitration.test.ts`, `status-confidence.test.ts`. The same four appear in the root checkout at its own stale commit, so they predate this branch.

### Method entry, program-wide: `\s` in `git grep -E` matches nothing and fails silently

`git grep -E` is POSIX ERE, which has no `\s` escape. A pattern containing it does not error — it matches nothing, and returns a clean, plausible zero. Use `[[:space:]]`, or `-F` for a fixed string.

This cost this agent one false "confirmed" and was caught only because the **positive control returned zero too**. That is the whole value of the control: without it, `type:\s*"ping"` returning nothing reads exactly like the finding it was meant to test.

**The owner independently hit the same wall earlier the same night** — `git grep -nE 'type:\s*"ping"'` returning nothing for both target and control — and correctly re-ran with a different form, but diagnosed it as "my grep form is blind" rather than as this specific mechanism. Right conclusion, wrong reason; and a right conclusion for the wrong reason is how a method note comes to teach the wrong lesson.

**Consequence for earlier work in this program:** any search in this program that used `\s` under `git grep -E` and reported a zero should be re-run before its zero is trusted. That cannot be audited retroactively from here, so it is written down for whoever finds one.

**One pre-existing suite failure, proven not mine.** `__tests__/release-notes.test.ts::renders a release-worthy commit in the generated notes` fails with `Missing helper: "conventional-changelog-conventionalcommits requires conventional-changelog-writer@9 or newer …"`. Verified by checking out a throwaway worktree at pristine `origin/main` `d9148f25` with no changes at all and running that one file — identical failure — then removing the worktree. The cause is the shared `node_modules` symlink the worktree convention uses being stale against `origin/main`'s lockfile, so it will be red for every streamer track on this machine.

### The one-PR-at-a-time rule protects against something narrower than it says

Observed while #760 (docs) and #761 (this change) were briefly open together. The repo was **never** at one-PR quiescence at any point that night: `#753` (Dependabot) and `#754` (Snyk) were open throughout.

So the invariant the program actually maintains is "one *human* PR open at a time", not "one PR open at a time" — bot PRs are exempt and never held the slot. That is a weaker claim than the rule's wording, and the gap matters: **as written, the rule was in continuous violation all night while the thing it protects against — two humans merging interacting changes into one repo — never occurred once.**

Worth stating so nobody later reads a night of bot PRs as evidence the rule was being ignored, or tries to enforce the literal wording against a Dependabot branch.

### Method entry: check the tool's blast radius, not your intent

Contributed by the owner from the same night's work on the docs record, and recorded here because it is the same family as the two findings above.

`git-filter-repo` was run to excise a leaked identifier. It did that — and, because it rewrites every commit back to the initial one, it also turned the branch into a **parallel history with no common ancestor with `main` at all**. `git merge-base` returned nothing, and a PR from that branch would have shown 932 divergent commits and been unmergeable. The check that ran afterwards verified the leaked value was gone: the thing the operator was worried about. The thing the tool had actually changed — the ancestry — went unchecked.

**A tool that does what you asked can still do something you did not ask. The verification has to cover the tool's blast radius, not the operator's intent.**

This is the third member of a family that turned up three times in one night, and the shared shape is worth naming: in each case **the instrument reported success on the question that was asked, while the question that mattered was never asked.**

| | Question asked, answered "fine" | Question that mattered, never asked |
|---|---|---|
| lint no-op | "does biome pass?" — yes, exit 0 | "did biome look at any file?" — no, zero |
| `\s` grep | "does this pattern match?" — no hits | "can this pattern match anything?" — no, `\s` is not ERE |
| `filter-repo` | "is the leaked value gone?" — yes | "what else did the rewrite change?" — the entire ancestry |

None of the three announced itself. All three agreed with whoever read them first.

**A naive attribution scan produces four false positives on ordinary English, and the next person will see them too.** Checking this commit body with a case-insensitive `grep -icE 'claude|cursor|co-authored|generated with|ai'` returns **4** — all from the bare `ai` alternation matching inside `against`, `await`, `plaintext` and `raising`. The check that actually answers the question is word-boundaried: `grep -inE '\b(claude|cursor|anthropic|copilot)\b|co-authored-by|generated with|🤖'`, which returns nothing here, plus a check that no trailer-style `^[A-Za-z-]+: ` lines exist. Use the second form; a `4` from the first is noise, not a finding.

**The `tsc` gate was itself positive-controlled**: an injected `const __tscControl: number = "not a number";` produced `src/ws-hub.ts(559,7): error TS2322`, and the restored file exits 0. So the green is a green, not a gate that never ran.

## 9. The frozen wire contract is compiler-enforced, not merely obeyed

The frame is built as `const appPing: WSMessage = { type: "ping", ts: Date.now() }`.

**The `: WSMessage` annotation is load-bearing and must not be tidied away.** It reads as redundant — the value is used once, on the next line, and a cleanup pass will want to inline it into `JSON.stringify`. That is exactly the edit to refuse. `JSON.stringify` accepts *anything*: inlined or unannotated, the literal is checked against nothing, and the wire shape can then drift field by field with the build staying green. The annotation is the only thing making the frozen contract mechanical rather than a matter of everyone remembering. With it, TypeScript's excess-property check turns a shape change into a build failure. Both forbidden edits were run:

| Forbidden edit | `tsc` verdict |
|---|---|
| add a field — `{ type: "ping", ts: Date.now(), seq: 1 }` | `src/ws-hub.ts(528,66): error TS2353: Object literal may only specify known properties, and 'seq' does not exist in type '{ type: "ping"; ts: number; }'.` |
| rename `ts` — `{ type: "ping", sentAt: Date.now() }` | `src/ws-hub.ts(528,50): error TS2353: … 'sentAt' does not exist in type '{ type: "ping"; ts: number; }'.` |

So the server cannot emit a superset of what `src/types.ts:339` declares and what the mobile union pins, without the build failing first.

## 10. Traffic analysis: what a regular ciphertext emission newly reveals

The question a crypto reviewer asks first: this gives an idle sealed socket a fixed-shape ciphertext every 30 s, forever — known plaintext at known intervals. Considered, and here is why it is not a problem.

**Against the cipher: nothing.** ChaCha20-Poly1305 is IND-CCA2 secure, and known plaintext is not an attack on it. The stream-cipher hazard that known plaintext *would* expose is keystream reuse, and that is exactly what the counter discipline makes structurally impossible: the nonce is `direction(4) || counter(8)`, never random, never repeated within a context (§2, §5 R1), and §7 refuses to send rather than wrap. A ping is sealed under a counter value used once, like every other frame. The frame also carries no secret — `type` is a constant string and `ts` is a wall-clock millisecond an observer can read off its own clock.

**Against an on-path observer: nothing new, and this is the part worth stating precisely.** The instinct is that a new 30 s periodic emission creates a liveness oracle. It does not, because **the 30 s periodic wire signal already existed**: `client.ping()` has sent a WebSocket ping control frame (opcode `0x9`) on this exact timer for as long as the hub has existed, and a control frame is as visible on the wire as a data frame. An observer watching an idle sealed session already saw a small encrypted record every 30 s, and already saw the pong come back. This change makes that periodic event two records instead of one and slightly larger. It does not create the period, the predictability, or the liveness signal — all three were already observable.

So the honest statement of what is newly learned is: **nothing about liveness that the protocol ping did not already reveal at the same 30 s resolution.** The idle-versus-active distinction an observer can draw — quiet periodic keepalive versus irregular bursts of terminal output — is likewise unchanged, and is a property of the session having traffic at all.

**Where it points, if anything, is mildly favourable.** A constant-size frame on a fixed schedule is the shape of cover traffic, not of a leak; it is irregular, content-correlated frame sizes that carry information, and this adds none.

**Not claimed:** that this design resists traffic analysis generally. It does not, and never has — sealed terminal output still varies in size and timing with what the agent prints, which is a pre-existing property of the channel and out of scope here (D-7 already keeps REST paths and query in the clear for related reasons). The claim is narrower and is the one that matters for this change: the ping adds no new exposure.

## 11. Framing for a reviewer: this confirms a prior judgement rather than making a new one

Two things about the provenance, because they change how novel this looks.

**The counter cost was already considered and accepted.** `ws-hub.ts:257-262` — written before this change and quoted in streamer #756 — says the app-level ping "is sealed here like every other frame **and consumes a counter. That is correct and costs nothing**". The arithmetic in §2 above therefore *confirms* a judgement someone already made, rather than reaching a new one. §18 records the same conclusion in the spec.

**Someone wrote the guard rail and not the road.** That comment, and §18, exist to stop a future reader "optimising away" a frame — a frame that was never implemented. The design intent was recorded in two places and the code was written in neither. Nothing detected the gap for months, and the reason is structural: the missing signal was **invisible by construction**. A protocol ping the JS layer cannot see is indistinguishable, from inside the client, from a server that has gone quiet — so the defect could only ever surface as a device-level measurement, which is exactly how it surfaced.

## 12. Why the 15 s margin is not a tolerance problem

The obvious reviewer objection to a 30 s cadence under a 45 s window is that it leaves only one sweep of slack — why not 20 s for margin against a lost ping?

Because **margin against frame loss is meaningless on this channel**. A WebSocket runs over one TCP connection: a frame is not dropped in the way a datagram is dropped, it is retransmitted, and a socket that genuinely cannot deliver a frame within 15 s is a broken socket. §5 R2 makes the same assumption load-bearing in the other direction — the receiver requires `counter == expected` with no window precisely because a gap on one TCP connection is a protocol violation rather than a network event.

So "one missed ping exceeds the window and the client redials" is the correct behaviour, not a tolerance failure: redialling a socket that cannot deliver is what the client should do. The margin protects against scheduling jitter — a loaded event loop, a backgrounded app's timer coalescing — and 15 s is ample for that.

## 13. §4's adversarial verifier is not triggered — the reasoning, on the record

Recorded so a later reader can disagree with it rather than find it assumed. §4 requires an isolated adversarial verifier for changes to the **record layer** or the **envelope**. This diff touches neither: it is confined to `ws-hub.ts`, and `record.ts` and `context.ts` are byte-identical to `origin/main`. The change adds traffic *through* the record layer rather than changing it.

The rekey analysis strengthens rather than weakens that: there is no rekey path to perturb, because §6 abolished in-place rekey on the user's 2026-08-29 ruling and the code matches it — three comments asserting absence, zero implementation. The only threshold is §7 exhaustion at `2^64 - 1`, against which 2 880 counters a day is not a number that needs arguing about.

Only two tests in the suite advance timers past 30 s, both in `e2ee-ws-sealing.test.ts`, and both assert `send` was **not** called on the stale sockets they are about — which my placement preserves. No other test reaches the ping interval, so no existing assertion is perturbed by the extra frame.

`tsc` is its own gate (babel strips types), run separately from lint and the suite.
