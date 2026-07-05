# Test-Isolation & Resilience Hardening Plan

_Written: 2026-07-05. Scope: the systemic roots surfaced by the six-bug (→ seven-bug)
investigation that produced PR #175 (`perf/refresh-reconcile`) and tb-scanner PR #40
(scanner 0.9.4)._

> **Status: proposal. Nothing here is implemented.** Present for review; each item
> below is scoped so it can be landed as its own small PR.

---

## Why this plan exists

The investigation behind PR #175 spent most of its effort not on the six catalogued
bugs but on **four distinct systemic roots** that made the test suite lie — each one
independently capable of turning a green product into red tests (or, worse, a red
product into green tests). Every "should be fixed now" that turned out wrong traced
back to one of these four. They are not the same failure and they don't share a fix,
but they share a shape: **state that leaks across a boundary that was assumed
isolated.**

The four roots, and where each bit this session:

| # | Root | How it manifested | Already addressed? |
|---|------|-------------------|--------------------|
| R1 | **Native-addon ABI mismatch** | `better-sqlite3` compiled for the wrong Node ABI → `cache.open_failed` → server ran cacheless-degraded → every cache-dependent test 404'd. Masqueraded as product/test bugs for 4 rounds. | Partly — `scripts/check-native-abi.mjs` (PR #176) detects it at `preinstall`/`pretest`. Gaps remain (see R1). |
| R2 | **Shared SQLite path across tests** | Multiple servers/scanners in one vitest worker sharing the default `~/.config/threadbase-scanner/index.db`, cross-contaminating. Two concrete instances: the mis-nested `dbPath` in `codex-scan.test.ts`, and the `TB_SCANNER_DB` env-leak between `server.test.ts` blocks. | Point-fixed per test (ETag/reconcile blocks set `TB_SCANNER_DB`; codex-scan now nests `persistent.dbPath`). No shared discipline. |
| R3 | **Fire-and-forget cache writes vs. close()** | Warm-up + `refreshCountInBackground` wrote `this.cache` un-awaited; a shutdown/hold could `close()` mid-write → `database connection is not open`. | Yes — `inFlightCacheWrites` drain (`server.ts:164`, this PR). Convention not yet documented or enforced. |
| R4 | **Scanner shared persistent-index cross-contamination** | The dir-mtime gate committed a `scanned_dirs` watermark before the file rows; a second connection sharing the index reused an empty list → `GET /api/conversations/:id` 404 forever. | Yes, scanner-side — tb-scanner #40 / 0.9.4. Server-side exposure (every `StreamerServer` shares one global index) is untouched. |

The **isolation-vs-resilience ratio** matters for how we invest. R2 and R4-server are
**isolation** problems: state that should be per-instance is global. R1 and R3 are
**resilience** problems: a real runtime hazard (stale binary, close-during-write) that
must fail loud or drain safely. The catalogued six bugs were all resilience-class; the
tail of this investigation was dominated by isolation-class roots that the six-bug
framing didn't name. **My recommendation is to weight the plan ~60% isolation / 40%
resilience** — because the isolation roots are the ones that repeatedly *hid* the
resilience bugs and cost the investigation its time, and because they're structurally
cheap to fix once (a shared helper, a per-instance path) versus paying per-test
discipline forever.

---

## R1 — Native-addon ABI guard (resilience)

**Where:** `scripts/check-native-abi.mjs`, wired at `package.json:51-52`
(`preinstall`, `pretest`).

**What's already true:** the guard probes whether *this* Node can `dlopen` the
`better-sqlite3` binary and fails loudly with the fix command. This is the right
mechanism and it shipped in #176.

**Gaps to close:**

1. **The nested scanner copy is unchecked.** The guard only probes the top-level
   `node_modules/better-sqlite3`. The scanner ships its own nested
   `node_modules/@threadbase-sh/scanner/node_modules/better-sqlite3`, which is a
   *different version* (`11.x` vs the top-level `12.x`) and can have a *different* ABI
   state. This session, the nested copy was the one that silently broke while the
   top-level looked fine.
   **Fix:** extend `check-native-abi.mjs` to probe every `better_sqlite3.node` it
   finds under `node_modules` (glob), not just the top-level one.

2. **No runtime guard, only build/test-time.** In production the server *already*
   self-diagnoses (`cache.open_failed` with `abiMismatch:true`) and degrades to
   cacheless. That's correct for prod resilience, but a global test-setup assertion
   would turn the same signal into an immediate, unmissable test failure instead of a
   silent 101×-repeated log line.
   **Fix:** add a `vitest` global setup file that opens a throwaway `ConversationCache`
   and hard-fails the run if it can't open — converting "silent cacheless degrade" into
   "the suite refuses to run against a broken binary." (Small, high-leverage: this alone
   would have saved the first 4 rounds of this investigation.)

3. **Machine-specific documentation.** The `.nvmrc` (Node 24 / ABI 137) is the
   canonical node; the nested `better-sqlite3@11.10.0` **cannot compile on Node 26**
   (V8 API removals). This trap is now in the agent memory but not in the repo.
   **Fix:** a short `docs/troubleshooting.md` entry: symptom (`NODE_MODULE_VERSION
   137 vs 147`), cause (shell-node-vs-execPath split), fix (align the nodes; never
   target Node 26 for the nested copy).

---

## R2 — Test SQLite-path isolation (isolation)

**Where:** `vitest.config.ts:25-26` sets `pool: "forks"` + `singleFork: true`, so
**all test files share one worker process and therefore one `process.env`**. Any test
that reads the scanner's default index path (`$TB_SCANNER_DB ?? ~/.config/...`) shares
state with every sibling unless it sets its own `TB_SCANNER_DB`.

**Two failure instances this session:**
- `codex-scan.test.ts` passed `new ConversationScanner({ dbPath })` — but the option is
  `persistent.dbPath`, so the bare form was ignored and all three tests shared the
  default index → the first test's codex fixture leaked into "returns zero codex
  sessions" (`expected 0, got 1`). Fixed by nesting `persistent: { dbPath }` (this PR).
- `server.test.ts` blocks (`stale-snapshot`, `paged`) that *don't* set `TB_SCANNER_DB`
  inherit whatever a sibling block left set/deleted.

**The current approach is per-file discipline** (each block declares `scannerDb`, sets
`process.env.TB_SCANNER_DB` in `beforeEach`, `delete`s + `rmSync`s in `afterEach`). The
ETag block (`server.test.ts:1347-1386`) is the reference pattern, copied by ~4 blocks.
Per-file discipline is exactly what failed: a new block forgets it, or a `dbPath` is
mis-nested, and nothing catches it.

**Fix — replace discipline with a shared helper.** Add a test util
(`__tests__/helpers/isolatedScannerDb.ts`) that returns a fresh temp `TB_SCANNER_DB`
and registers its own `beforeEach`/`afterEach` set+cleanup. One line per block:
`const scannerDb = useIsolatedScannerDb()`. Then migrate the existing hand-rolled
blocks to it. Cost: one small helper + mechanical migration. Benefit: the isolation is
declared once and can't be half-forgotten.

**Stronger option (consider, don't necessarily do):** a global `beforeEach` that assigns
a unique `TB_SCANNER_DB` to *every* test unconditionally, so no test can ever hit the
real `~/.config` index. This is the most robust and removes the failure mode entirely,
but it's a broader change (some tests may rely on the current default); stage it after
the helper migration proves the shape.

**Explicitly out of scope here:** flipping `singleFork` off. It would give real
process-level isolation but is a large behavioral change to the whole suite's timing and
memory profile — a separate decision, not a bug fix.

---

## R3 — Awaited-drain resilience convention (resilience)

**Where:** `server.ts:164` (`inFlightCacheWrites`), `979` (`trackCacheWrite`), `997`
(the `await Promise.all([...])` drain before `cache.close()`).

**What's already true:** the two known fire-and-forget sites (warm-up at `:919`,
`refreshCountInBackground` at `:1321`) now register through `trackCacheWrite`, and
`close()` drains them before closing the cache. Bugs #4/#5 are fixed and verified
(zero closed-DB signatures across the suite this session).

**Gaps to close:**

1. **The convention is undocumented and unenforced.** A future fire-and-forget cache
   write that *doesn't* call `trackCacheWrite` silently reintroduces the exact bug. The
   audit this session enumerated all 8 fire-and-forget sites in `server.ts` and
   confirmed only 2 write `this.cache` un-awaited — but that audit isn't captured
   anywhere a future author would see.
   **Fix:** a code comment at the `inFlightCacheWrites` declaration stating the rule
   ("every un-awaited write to `this.cache` MUST go through `trackCacheWrite`"), plus a
   one-paragraph note in `CLAUDE.md` under a "Cache write lifecycle" heading.

2. **Watcher callbacks are safe today by a subtle invariant, not by construction.**
   `onNewLines`/`onConversationChanged`/`onFileDeleted` write `this.cache`
   *synchronously* inside the chokidar tick, and `close()`'s cache-close→watcher-dispose
   steps are a synchronous run-to-completion block, so they can't observe a closed
   cache. This is correct but fragile — an `await` added inside any of those callbacks
   would break it silently.
   **Fix:** document the invariant at those call sites; optionally add a guard that
   no-ops a cache write when `this.cache` is closed (defense-in-depth, cheap).

---

## R4 — Scanner shared persistent-index, server side (isolation)

**Where:** `server.ts:1416-1417` — `newScanner()` constructs
`new ConversationScanner(this.scannerPersistenceDisabled ? { persistent: false } :
undefined)`. Passing `undefined` means the scanner uses its **global default index**
(`$TB_SCANNER_DB ?? ~/.config/threadbase-scanner/index.db`). Every `StreamerServer` on
a machine — and every server instance in a test worker — shares that one index.

**What's already true (scanner side):** tb-scanner #40 / 0.9.4 fixed the specific race
(watermark committed before file rows) that made a shared index drop conversations. The
streamer now pins `^0.9.4`. The 404-forever behavior is eliminated.

**The residual server-side exposure:** the *architecture* still shares one global index
across all server instances. In production this is benign — one machine runs one
streamer, so "shared" means "its own." But:
- It's the reason the test suite was so fragile: N test servers = N writers to one
  index. The scanner fix makes this *correct* now, but still *coupled*.
- If the streamer ever runs multiple instances on one host (e.g. prod + dev on
  different ports, which the prod/dev lifecycle explicitly supports), they'd share and
  contend on one scanner index.

**Fix (consider):** give each `StreamerServer` a per-instance scanner index derived
from its `cacheDir` (which is already per-instance), by passing
`{ persistent: { dbPath: join(this.cacheDir, "scanner-index.db") } }` to `newScanner()`
instead of `undefined`. This makes the index share the server's existing isolation
boundary. Benefits: test servers stop contending by construction (R2 and R4 collapse
into one fix for the scanner path); prod+dev instances get separate indexes.
**Caveat:** this changes where the prod index lives (from `~/.config/threadbase-scanner`
to `~/.threadbase/cache/scanner-index.db`) — a migration/compat consideration, and a
coordination point with anything that reads the scanner index directly. Stage carefully;
this is the largest-blast-radius item and the one most worth a design review before
touching.

---

## Suggested sequencing

Land as independent PRs, cheapest-and-highest-leverage first:

1. **R1.2 (global test-setup cache-open assertion)** + **R1.1 (probe nested binary)** —
   tiny, and would have prevented the entire ABI rabbit hole. Do first.
2. **R2 (shared `useIsolatedScannerDb` helper + migrate blocks)** — removes the
   most-recurring isolation failure; mechanical.
3. **R3 (document the drain convention + invariant, optional closed-cache guard)** —
   docs + a small guard; protects the fix already in `main`.
4. **R1.3 (troubleshooting doc)** — docs only.
5. **R4-server (per-instance scanner index)** — largest blast radius; design-review
   first, land last. May supersede parts of R2 for the scanner path.

---

## What this plan deliberately does NOT do

- It does not flip `singleFork` off (large timing/memory change; separate decision).
- It does not re-open the scanner fix — 0.9.4 is correct; R4 here is only the
  server-side *coupling*, not the race.
- It does not add speculative isolation to code paths that never leaked. Every item
  above traces to a failure actually observed this session.
