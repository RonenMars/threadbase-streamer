# Fix the flaky wall-clock assertion in `server-shutdown.test.ts` (tb-streamer only)

Tracked as [#659](https://github.com/RonenMars/threadbase-streamer/issues/659).

Paste this whole file into a new agent session. Work only in a **sibling worktree** of `tb-streamer`, cut from the latest `origin/main`. Do not touch `tb-mobile`.

This is a **test-only** change. Do not modify `src/server.ts`, `WSHub.dispose()`, or any shutdown behaviour — the production code is correct and is not what is failing.

## The symptom

`Smoke (windows-latest)` fails at random on `main`, taking whichever commit is merging down with it. Most recently on `main` @ `72783a80` (CI run `32353320394`):

```
FAIL __tests__/server-shutdown.test.ts > StreamerServer.close() port release
     > resolves quickly with no clients connected (common deploy path)
AssertionError: expected 3311 to be less than 1000
  __tests__/server-shutdown.test.ts:82   expect(Date.now() - start).toBeLessThan(1000);

Test Files  1 failed | 225 passed | 3 skipped (229)
     Tests  1 failed | 2250 passed | 29 skipped (2280)
```

Every other job passed: `Gate, Setup, Lint, Build, Test (Node 22), Test (Node 24), Smoke (macos-latest)`.

## Proof it is the test, not the code — do not re-litigate this

The commit blamed changed **only** `package-lock.json` (7 insertions / 7 deletions, two transitive bumps). More decisively, the tree that failed and the tree that passed are byte-identical:

```
git rev-parse 684e31a0^{tree}   # PR head — Smoke (windows-latest) SUCCESS
git rev-parse 72783a80^{tree}   # main    — Smoke (windows-latest) FAILURE
# both: e49fdc56d1024fa10f91b123f5b0c7846e83d162
```

Same artifact, opposite outcomes, ten minutes apart. Re-running the identical failed job then passed. It is a flaky assertion.

## The actual defect

`__tests__/server-shutdown.test.ts:82` asserts a **fixed 1 000 ms wall-clock budget** on a shared CI runner:

```ts
const start = Date.now();
await server.close();
expect(Date.now() - start).toBeLessThan(1000);
```

On a contended Windows runner it measured 3 311 ms. A duration measures the host as much as the code — the same lesson `CLAUDE.md` already records under **Query timing**, where a saturated box made a 0.87 ms p99 statement report a 118.7 ms median with nothing wrong with the query.

The file already knows this is fragile. `makeServer()` carries a comment explaining that watching the real `~/.claude/projects` would make chokidar teardown "take seconds, blowing every wall-clock budget below". The budget was always the weak point; CI hardware finally moved.

## What the test is actually protecting — preserve it

Read the header comment before changing anything. This file is a regression guard for a real production failure:

> `✗ healthcheck failed ... listen EADDRINUSE: address already in use :::8766`

On SIGTERM the old process awaited `httpServer.close(cb)`, whose callback only fires once every connection drains; a slow WebSocket peer kept `:8766` bound until launchd's SIGKILL, and the new instance hit `EADDRINUSE`.

So the contract is **"`close()` releases the port promptly"**. The stopwatch is a proxy for that, and a bad one. **The port being rebindable is the property that actually prevents `EADDRINUSE`** — and it is not timing-sensitive.

## Preferred fix

Re-express the assertion as an **event**, not a duration: after `await server.close()` resolves, a fresh listener must be able to bind the same port immediately. That tests the thing the incident was about, and cannot flake on a slow runner.

Keep a bound only as a hang-guard — a generous one, so it fires on a genuine regression and never on load. Note the sibling test on line ~85 already uses a 3 s `Promise.race` for exactly that purpose; follow that pattern rather than inventing a third style.

If you keep any wall-clock bound at all, it must have Windows headroom. `vitest.config.ts` already sets the precedent:

```ts
const testTimeout = process.platform === "win32" ? 900_000 : 45_000;
```

A `1000` that is not platform-adjusted is inconsistent with the config sitting beside it.

## Also look at, but change only with reason

Two other timing-shaped assertions live in the same `describe`. Judge each; do not reflexively rewrite them.

- `"releases :PORT even when a WebSocket client withholds its close ACK"` — 3 s race plus `toBeLessThan(3000)`. Has real headroom and has not been observed failing.
- `"retries the bind when the port is briefly still held (kickstart -k race)"` — releases the port at 600 ms to land inside a 6-attempt retry window. This one is a deliberate *scheduling* fixture, not a performance budget; a slow runner widens the window rather than breaking it. Leave it unless you can show otherwise.

Say in the PR body which ones you touched and which you deliberately left.

## Verify

The change must fail if the guard is removed — a green test that never went red is worth nothing.

1. Confirm the new assertion **catches the original bug**: temporarily make `WSHub.dispose()` graceful-only again (or otherwise leave a socket lingering), run the file, and see it go red. Revert that. Say in the PR that you did this and what you saw.
2. `npm run lint && npx vitest run __tests__/server-shutdown.test.ts`
3. Run it under load to prove the flake is gone — start a few CPU hogs, or run the full suite concurrently, and confirm the test still passes where the old assertion would have failed.
4. `npm test` for the whole suite before opening the PR.

Windows is where it fails and is not reproducible locally on macOS, so CI's `Smoke (windows-latest)` is the real verdict. Say plainly in the PR that local runs cannot prove the Windows case.

## Repo rules

- Branch from the latest `origin/main`; never commit to `main`.
- Conventional commit title, no AI attribution anywhere.
- **Not** a docs-only change — do not add `[skip-ci]`; the full matrix is exactly what needs to run.
- One sentence per line in the PR body.

## Stop and ask only if

- Removing the wall-clock bound would leave no assertion that fails on the original `EADDRINUSE` regression, and you cannot find a substitute.
- You conclude `close()` genuinely is slow on Windows rather than the runner being loaded — that would be a production bug and a different change; bring the evidence rather than fixing it here.

## Done when

- `__tests__/server-shutdown.test.ts` no longer asserts a fixed sub-second wall-clock budget.
- The `EADDRINUSE` contract is still enforced, demonstrated by a seen failure against a reintroduced bug.
- Full suite green locally, and CI green including both smoke jobs.
- The PR body states what was changed, what was left alone and why, and that Windows was verified only in CI.
