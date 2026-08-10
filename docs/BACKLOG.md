# Backlog — Threadbase Streamer

Known bugs and unresolved issues. Self-contained enough to pick up without re-reading the original conversation.

For planned features (work that adds new behavior rather than fixing broken behavior) see [ROADMAP.md](ROADMAP.md).
For the full audited inventory — every item across every doc, open **and** closed, with the code evidence for each — see [2026-08-10-open-items-register.md](2026-08-10-open-items-register.md).

---

## Status overview (2026-08-10)

Verified against `main` @ `f390d67` (v1.47.0). Everything previously on this list has shipped; what remains is tracked as GitHub issues, which are the source of truth for open bugs.

| Item | Severity | Status |
|---|---|---|
| Windows: supervised streamer writes no logs, `prod logs` throws | P0 | Open — [#472](https://github.com/RonenMars/threadbase-streamer/issues/472) |
| Live Activity: no install path provisions APNs credentials | P0 | Open — [#480](https://github.com/RonenMars/threadbase-streamer/issues/480) |
| Live Activity: APNs loading is launchd-only (Windows/Linux never enable push) | P0 | Open — [#481](https://github.com/RonenMars/threadbase-streamer/issues/481) |
| README states no security posture (no spend ceiling, permission modes) | P0 | Open — [#473](https://github.com/RonenMars/threadbase-streamer/issues/473) |
| `server.test.ts` grace-timer flake blocks the merge pipeline | P1 | Open — [#482](https://github.com/RonenMars/threadbase-streamer/issues/482) |
| Boot auto-resume spends a slot on sessions with no provider history | P1 | Open — [#483](https://github.com/RonenMars/threadbase-streamer/issues/483) |

Lower-severity open work (observability gaps, the `src/server.ts` split, the security items reverted by [#220](https://github.com/RonenMars/threadbase-streamer/pull/220), doc hygiene) is catalogued as P2–P4 in the register rather than as issues, to keep the issue list readable as a release gate.

**Why this file shrank.** Nine of the eighteen entries it previously carried were already fixed while still reading as "🔄 In flight" — the table listed eight merged PRs as open work. That drift is what makes work get redone, so closed items now live in the register with the PR that closed each, instead of lingering here.

---

## Boot auto-resume attempts sessions that have no provider history yet

**Status (2026-08-10):** Open, low severity — [#483](https://github.com/RonenMars/threadbase-streamer/issues/483). Observed while testing `auto_resume_on_boot` end to end on the live instance, not reported by a user.

**Symptom:** A session that was started but never used — spawned, reached `waiting_input`, and interrupted before any message was sent — is selected for boot auto-resume and then fails:

```
sessions.auto_resume_skipped  sessionId: c7a1ca86-…  reason: "history_file_missing"
sessions.auto_resume_completed  attempted: 2, resumed: 1, failed: 1
```

Nothing breaks. The failure is logged, the session stays in the list as a resumable stub, and the user can still tap it. The cost is one of the five `AUTO_RESUME_MAX` slots spent on a session that could never have worked, plus a `failed` count that looks like a defect when read in a log.

**Root cause:** the five eligibility rules in `autoResumeSkipReason` (`src/services/sessions/autoResumeOnBoot.ts`) check `status_source`, `status`, age, project directory, and provider resume identity — but **not whether the provider has written any history**. For Claude, `resumeIdForRow()` returns `session_id`, which is always non-null, so rule 5 passes for a session whose JSONL does not exist. `resumeSession()` then does the real lookup, finds neither a JSONL nor a cached conversation, and returns `history_file_missing`.

That reason is correct and non-retryable — Claude cannot `--resume` a conversation with no file — so the resume path is behaving properly. The gap is that eligibility promised something the resume path could not deliver.

**Suggested fix:** inject a `historyExists` predicate alongside the existing `projectExists`, and add a `history_missing` skip reason. `AutoResumeOptions` already takes injected predicates precisely so the decision stays a pure function:

```ts
export interface AutoResumeOptions {
  now: number;
  projectExists: (projectPath: string) => boolean;
  historyExists: (row: ManagedSessionRow) => boolean;   // new
}
```

The server supplies it at the single call site, resolving through the same path `resumeSession()` uses — `findJsonlPath(resumeIdForRow(row))` — so eligibility and execution cannot disagree. This mirrors how `rehydrateSkipReason` already refuses a row whose project directory is gone rather than offering a resume that would fail to spawn.

**Trade-off worth stating:** this adds a filesystem lookup per candidate row at boot. The candidate set is bounded by `REHYDRATE_MAX` (25) and the work happens on the fire-and-forget boot chain, so it is not on any request path — but it is not free, and `findJsonlPath` walks directories rather than doing a single `existsSync`. If that proves too costly, the cheaper alternative is to leave the behaviour alone and reclassify: catch `history_file_missing` in `autoResumePreviousSessions` and log it as a *skip* rather than a *failure*, so the counts read honestly without the extra I/O.

**Done when:** a session interrupted before its first message is reported as skipped with a reason naming the missing history, does not consume an `AUTO_RESUME_MAX` slot, and `sessions.auto_resume_completed` reports `failed: 0` for that case. A unit test against `autoResumeSkipReason` with a stubbed `historyExists` covers the decision without touching the disk.

---

## `server.test.ts` grace-timer flake blocks CI

**Status (2026-08-10):** Open — [#482](https://github.com/RonenMars/threadbase-streamer/issues/482). [PR #248](https://github.com/RonenMars/threadbase-streamer/pull/248) landed the port and grace fixes; the polling follow-up [PR #245](https://github.com/RonenMars/threadbase-streamer/pull/245) was **closed without merging and its branch has been deleted from origin**, so that work has to be rewritten rather than recovered.

**Symptom:** the grace-timer block in `__tests__/server.test.ts` fails intermittently on CI with no change to the code under test. It flaked twice on 2026-08-09 while merging [#475](https://github.com/RonenMars/threadbase-streamer/pull/475), a dependabot bump that touches no server code.

**Likely cause:** the tests use process-global prototype spies, a shared session id, fresh WebSocket servers per case, and fixed waits for WebSocket round trips, so they are sensitive to host load rather than to correctness. Note the file has been rewritten enough since the original 2026-07 diagnosis that its assertion names no longer match — the disconnect-arms-nothing change landed, and only one fixed sleep remains. Re-diagnose against the current file rather than assuming the old description still holds.

**Suggested fix:** replace the remaining fixed sleep with a deterministic condition or event, preferring the observable state transition over a duration. Avoid a blanket retry or a Vitest configuration change unless evidence rules out test-level isolation first.

**Done when:** zero failures across at least 10 consecutive runs of the focused file, then a full `npm test`, then `npm run lint`.

**Triage note.** A full local run on a loaded box currently produces ~30 failures that are *all* timeouts with zero assertion failures. That signature means host load, not regression — see the failure-kind rule below before spending time on it.

---

## Triage rule: judge a local suite failure by its kind, not its file

On this hardware, load-induced failures are **timeouts**; real regressions are **assertion failures**. Check which you have before spending anything:

```sh
grep -c "timed out" <output>                        # load
grep -cE "AssertionError|toBe|toEqual" <output>     # possibly real
```

All timeouts ⇒ load, not the change. Push and let CI decide — it runs a clean box across Node 20, 22 and 24, and it is the authoritative gate. Any assertion failure ⇒ compare against the base commit in full.

This replaced an enumerated list of "known flaky files", which was already incomplete by three files and drifted every time the box got busier.
