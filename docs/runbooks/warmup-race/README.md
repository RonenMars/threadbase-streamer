# Reproduce and measure the startup warm-up race — turn a rare CI 503 into a red test

A test that calls `server.listen(0)` and then requests a warm-up-gated route can get `503 SERVER_WARMING_UP` if the request lands before the startup scan finishes.
It reproduces about 1 run in 5 in a 4-CPU Linux container and never on an idle Mac, so it is invisible unless you widen the window on purpose.
This runbook does that with a test-only patch, and reads the result with a small script.

## Who should run this

Anyone who sees `expected 503 to be 200` (or `undefined` where a session field should be) in a test that boots a `StreamerServer`, or who is adding such a test and wants to know if it needs `awaitReady`.

## The mechanism

`activeWarmups` starts as `[[0, "startup"]]` (`src/server.ts`, anchor `activeWarmups = new Map`) and clears in the warm-up scan's `finally`.
`listen()` awaits that only with `{ awaitReady: true }` (anchor `if (opts?.awaitReady) await warmUp`).
`rejectIfWarmingUp` answers 503 while any warm-up is active, on eight GET routes: `/api/sessions`, `/sessions/count`, `/sessions/recents`, `/sessions/:id`, `/api/conversations`, `/conversations/count`, `/conversations/:id`, `/api/projects/summary`.
Everything else (POST start/resume/adopt, PATCH, `/healthz`, `/ws`, `/api/pair/*`) is ungated.

The failure needs the warm-up window to outlast the time the test spends before its first gated request.
On Linux CI those two are only 1–12 ms apart for a file's first, cold server.

## Steps

1. From a worktree, apply the lever.
   It is instrumentation, not a fix; never commit it.
   ```bash
   git apply docs/runbooks/warmup-race/warmup-lever.patch
   ```
2. Run the suspect test with the flag-clear delayed.
   Start at 100 ms and raise it; a test that does not fail by a few seconds is not exposed.
   ```bash
   TB_WARMUP_LOG=/tmp/wu.jsonl TB_WARMUP_DELAY_MS=200 npx vitest run __tests__/<file>.test.ts
   ```
3. Read the result.
   ```bash
   python3 docs/runbooks/warmup-race/window-stats.py /tmp/wu.jsonl
   ```
   It prints the window distribution per file, the first gated request time, and every 503 served.
4. Prove the fix the same way: with `{ awaitReady: true }` the test must pass at a much larger delay (3000 ms).
5. Revert the instrumentation.
   ```bash
   git checkout -- src/server.ts
   ```

## What failure looks like

- `expected 503 to be 200` at the first `fetch` of a gated route.
- Or, when a helper parses the body without checking the status, `expected undefined to be 'medium'` — the 503 body has no session fields.
- A test that compares two values read from a 503 (`undefined` vs `undefined`) passes vacuously; assert `res.status` in the helper.

## Known traps

- **Window versus gap.** A file's first server has a window 2–6× longer than later servers in the same file, so the cold first test is the exposed one.
- **The lever only delays the flag clear.** It does not model a scan that is itself slow, which can give empty-cache results instead of 503s.
- **Measure on the runner's shape.** The idle-Mac window for `session-status-line` is 5–8 ms; the failing Linux 4-CPU container window was 22–35 ms with a 27–44 ms gap.
- **Other warm-up states are not this bug.** `cache_reset` and `conversation_refresh` are set by the cache-alert resolve route and the conversations list/count handlers, so a test that never calls those cannot hit them.

## Moving target

The patch touches `src/server.ts` and will drift.
If `git apply --check` fails, regenerate it by re-adding the same three hooks: log in `rejectIfWarmingUp`, delay in the warm-up `finally`, and timestamps around `listen()`.
`window-stats.py` depends on the log fields the patch writes (`ev` of `clear`, `firstGated` or `rejected`, `potentialWindowMs`, `sinceListenMs`); keep them in sync.

## History

The original failure was `session-status-line.test.ts` in CI run 35434990202 (PR #932); it failed 8 times between #894 turning on file parallelism and its fix in #935.
The other exposed files were fixed in #940, #943 and #944.
