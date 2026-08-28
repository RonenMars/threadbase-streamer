# Brief — `streamer-answer-settlement-engineer`

Repo: `tb-streamer`. Issue: **#720 (P1)** — "`/prompt/answer` returns 409 `prompt_cancelled` after the answer was written to a scraped gate". Nothing else.

**Cite from `origin/main` only, never a checkout** (`c=origin/main; /opt/homebrew/bin/git show "${c}:<path>"`). Base is `7cde4b9a` (v1.70.1). All lines below are from there.

## 1. Verified state

`src/services/prompts/promptRegistry.ts`, 482 lines.

- `answer()` **:302–324**: sweep, lookup, idempotent replay of a recorded outcome **:309–311**, in-flight dedupe **:312–313**, then `entry.queue.then(() => this.performAnswer(entry, answer))` **:314–318**. **Answers for one entry are already serialized.**
- `performAnswer()` **:327–373**: pre-adapter checks — state **:331–334**, expiry **:335–337**, revision **:338–344**, response validation **:345–346**, adapter present **:347**. The write is `await entry.adapter(...)` **:349–354**.
- **The defect**: the post-adapter state re-check **:355–357** (`entry.prompt.state !== "open" && !== "updated"` → `terminalError(...)` → `prompt_cancelled`) and the post-adapter revision re-check **:358–364**. Only after those does it look at `adapterResult.ok` **:365–372**, and resolve at **:373**.
- On a scraped gate the write removes the box, the detector calls `handlePermissionChange(sessionId, null)` (`src/api/handlers/sessions.handlers.ts:1215–1223`) which transitions the record to `cancelled`/`provider_closed`, and :355 then reports failure for a write that succeeded. Deterministic on that provider, not a race — 3/3 with zero 200s on the Group C 1.70.0 rig.

**The fact that shapes the fix, and you must confirm it yourself before designing around it:** `transition()` **:244–248** *throws* `Cannot transition terminal prompt ${promptId}` when the record is already terminal. So deleting :355–357 on its own does not produce a 200 — it moves the failure to an unhandled throw at :373, outside the `try` that wraps only the adapter. The cancel has to be prevented, deferred or reconciled; the re-check removal alone is not a fix.

## 2. Plan deliverable — answer these, then stop

1. **Why does the post-adapter re-check exist at all**, given `entry.queue` serializes answers per entry? Say what it can still observe (detector-driven transitions, expiry, session invalidation) and which of those, if any, *should* fail an answer whose bytes already landed. Cite #700's diff if it tells you anything.
2. **The chosen fix.** The owner's recommendation, which you may adopt or argue against with evidence: mark the entry as answering before the adapter runs, so a detector teardown observed while an answer is in flight is attributed to the write and resolves rather than cancels; drop the redundant post-adapter state re-check. Decide and defend:
   - **Where the suppression lives** — inside `transition()` (one place, also covers `gateClosed()` in the answer route) or at the detector call site in `sessions.handlers.ts` (narrower, leaves the registry honest). Argue it.
   - **Which terminals it may swallow.** A `cancelled`/`provider_closed` caused by our own write is the case. `unavailable` from `invalidateSession` (the session ended) and `expired` are **not** — a dead session must not be reported as a settled answer. Name exactly what is suppressed and what still wins.
   - **What the wire sees — already ruled by the program owner, do not re-derive it.** An answered scraped gate emits **exactly one** terminal `prompt_event`, state `resolved`, and **never** a `cancelled` one. The legacy `permission_cancelled` broadcast may still go out unchanged — released legacy clients read it as "clear the card", which is correct for a gate that is gone, and contract clients (mobile `40ac02ac`) ignore legacy frames once the contract is present. **Dual emission stays.** Your plan states how your design produces exactly that, and additionally states the **ordering**: the `200` and the `resolved` event must both reflect the same transition, and a client that reconnects after the answer must find the `resolved` record in `snapshot()` within the terminal retention window (`PROMPT_TERMINAL_RETENTION_MS`, `promptRegistry.ts:11`). Cover the reconnect case in a test or say why the existing snapshot tests already do.
   - **The revision re-check :358–364** — keep it only if a detector `updated` bump during the write should fail an answer whose bytes already landed. Argue either way and commit to one.
3. **Tests, on the real detector path.** The existing unit tests pass because their adapter never triggers a detector transition — that is why this shipped. Required: a test that drives the real path (gate scraped → `/prompt/answer` → box gone → **200** with the record `resolved`), a positive control proving the harness observes a genuine cancel as a cancel, a negative control proving a cancel *not* caused by the write still fails the answer, and a **refusal test** — an invalid answer (row 2b's shapes) writes **zero bytes** and leaves the record open at its original revision, proving the marker did not drag validation past the write. Name each test and say what fails today.
4. **The pre-adapter validation boundary — stated explicitly, and defended.** Group C probe row 2b on the same rig: four invalid answers (unknown optionId; a real optionId belonging to a different prompt; fabricated questionId; empty optionIds) were each rejected **before** the adapter call, leaving the record open at revision 1 with zero bytes written. Every check that today runs pre-adapter (:331–346 — state, expiry, revision, response validation) **stays pre-adapter**. Your fix must not move validation across the adapter-call boundary in either direction, and the plan says so in as many words, naming the checks. The in-flight marker is set after those checks pass and immediately before the write, not at the top of `performAnswer`.

5. **The mutation**: restore the post-adapter re-check and confirm the new test goes red, reporting the failing test name and its verbatim assertion.
6. **Knock-on to check, not to fix**: #703's `promptState: "answered"` keys on `state === "resolved"` (`sessions.handlers.ts`), which on scraped gates never happened. Confirm your fix makes that branch reachable and that `__tests__/input-prompt-arbitration.test.ts` still passes; do not change #703's predicate.

## 3. Out of scope

`/queue`, `/plan-response`, status models, the legacy `/permission/answer` route's own behaviour, the detector, idempotency-record semantics, and anything you notice on the way. List findings at the end; do not fix them.

## 4. Mechanics

- Worktree `tb-streamer/.worktrees/fix/<slug>` off `origin/main` (`7cde4b9a`); `ln -s /Users/ronenmars/dev/ai-tools/tb-streamer/node_modules node_modules`; Node from `.nvmrc` (`export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`).
- `biome.json` ignores `.worktrees` — run `npx biome check <explicit files>` and `npx tsc --noEmit` separately. `tsconfig.json:21` excludes `__tests__`, so tsc does not type-check your tests; do not claim it does.
- `npm test` is ~14 min and exceeds the tool timeout — run it in the background and **wait on it inside your turn**, do not go idle with it pending.
- Prompt-broadcast spies must spy `broadcastToClients` (message is arg[1]) since #696.

## 5. Protocol

Plan first, then **stop**. I review, the program owner approves, then you implement. After implementation: full suite + tsc + biome + build green, then staged `git diff`, `--stat`, the exact commit message, and the mutation's failing test name with verbatim assertion — then stop again. No commit, push, PR or merge without my relayed approval.

Conventional title, imperative, lowercase, no trailing period. This is a `fix:`, so semantic-release cuts a release after the squash. No AI attribution. PR prose one sentence per line. Never push to `main`.
