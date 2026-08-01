# Real-run prompt — execute the landing against `origin`

The third and last stage. Paste the fenced block into a fresh Claude Code session at the repo root.

- **Stage 1** — [`LANDING-integration-to-main.md`](../../LANDING-integration-to-main.md), the plan, written from static analysis.
- **Stage 2** — [`2026-08-01-rehearsal-notes.md`](2026-08-01-rehearsal-notes.md), a full local replay that corrected the plan and produced §8's script. `origin` was read-only.
- **Stage 3** — this. The same script, executed for real. **This one merges to `main`.**

It is deliberately short. The unknowns were spent in stage 2; what remains is execution plus the
discipline to stop when reality diverges from what the rehearsal predicted.

## Before you run this

- **Read §8 of the rehearsal notes first.** It is the script. This prompt only says how to run it.
- **The rehearsal is a prediction, not a guarantee.** `main` has moved since; a conflict the
  rehearsal did not record is a signal to stop, not to improvise.
- Expect this to span sessions. Wave 1 alone is sixteen rebase-and-merge cycles against a
  cross-OS CI matrix.
- **This run is supervised, not unattended.** The stop rule fires on thirteen known-unreviewed
  resolutions, eleven of them in Group E, so expect to be asked for a decision that many times
  before wave 5 completes. "Report after each wave" understates it — Group E alone halts eleven
  times. Know that going in rather than discovering it at the third stop.

---

```
Repo: /Users/ronenmars/dev/ai-tools/tb-streamer

Execute the landing of `integration/missing-prs-2026-07-23` onto `main` for real, following
§8 of docs/landing/2026-08-01-rehearsal-notes.md. That script is authoritative — it was
produced by a full local rehearsal that already hit and resolved these conflicts once.

This stage DOES push and merge. Everything before it was read-only.

## Authority and precedence

1. §8 of the rehearsal notes — the ordered script, the waves, the named resolutions.
2. §7 of the same file — corrections to the runbook. Where the runbook and the notes
   disagree, the notes win; the runbook was written before anything was replayed.
3. CLAUDE.md — rebase onto latest main, wait for green, squash-merge, one PR at a time.

Read §8 in full before the first command. Re-read the relevant wave before starting it.

## The stop rule — the point of this whole exercise

STOP and report, rather than improvising, whenever reality diverges from the rehearsal:

- a conflict in a file the rehearsal's ledger (§3) does not list for that PR
- a conflict whose resolution the ledger marks "judgement" rather than "mechanical"
- a CI failure the rehearsal did not predict
- a PR whose state changed since the audit (merged, closed, newly conflicting)
- any command in §8 that errors or returns an unexpected count

**Expect the first rule to fire on all of Group E and part of Group F, and treat that as
correct rather than noise.** §3's ledger covers Groups A/A′/B and the hand-resolved parts of C.
It has **no rows for Group E at all**. Thirteen commits (eleven in E, two in F — enumerated in
§9.1) were resolved by a blanket per-file script rather than by hand, so for every one of them
the ledger is silent by construction. Each needs a human decision, not a wave-through: read the
hunks, decide, and record it in the run log. `#313` is on that list and is what happens when one
of them is waved through.

The rehearsal's value is that it makes deviation legible. A deviation means its prediction was
wrong somewhere, and continuing past it blind is how a silent regression reaches `main`.

## Named hazards — do not rediscover these the hard way

- **Thirteen conflict resolutions in the rehearsal were never reviewed by a human, and `#313`
  is the one that is known to have gone wrong.** All thirteen came out of the same blanket
  per-file script — it picks a whole side of each file rather than resolving hunks — which is
  the defect §4 `D7` describes. **Neither `tsc` nor biome catches a repeat**: `#313` landed,
  compiled, linted clean, and silently reinstated the bug it exists to fix. Only a per-file
  diff against the branch catches it.

  Group E (11): `#309` `#311` `#312` **`#313`** `#319` `#321` `#324` `#327` `#329` `#332` `#334`.
  Group F (2): `#293` `#296`.

  **Seven of the thirteen decided `src/server.ts`** — the runbook's own hotspot file — namely
  `#309`, `#319`, `#324`, `#327`, `#329`, plus Group F's `#293` and `#296`. Resolve every one of
  these by hand, hunk by hunk, and diff the file against the branch afterwards.

  For `#313` specifically the answer is already known: resolve `src/pty-manager.ts` IN `#313`'s
  FAVOUR — keep `recheckReadyFromScreen()`, not the hand-written `markReady` line. §8's wave-5
  hazard note has the exact command. For the other twelve the rehearsal has no answer, which is
  precisely why they are listed here.
- **`#245` — close it, do not merge it.**
- **`#223` last, on its own**, after a real `npm install`.
- **`#237` after `#232`, `#253`, `#234` and `#267`**; `#266` follows `#237`. This ordering is
  **reasoned from four observed collisions, not validated by execution** — the rehearsal did the
  opposite (landed `#237` third) and paid the same three-way reconstruction four times. It is
  well-founded, but it is the one instruction in §8 that has never actually been run.
- **Wave 1's order is not free.** §8 calls the nineteen wave-1 PRs independent, which is true of
  their *ancestry* and not of their *conflicts*: `#257`, `#258` and `#259` collide on
  `docs/BACKLOG.md` purely because of the order they land in. **Land `#257` last** in the wave —
  it is the status-snapshot doc, and putting it after the PRs whose statuses it describes removes
  the conflicts entirely. If you do hit one, the rule is order-independent: the *fixing* PR's
  status line beats `#257`'s snapshot line.
- **Wave 2 children use `rebase --onto main origin/pr/<parent>`**, never a plain rebase.
- **`#275` and `#276` each introduce a biome import-order error that `#281` fixes.** Land
  `#281` immediately after, or lint is red in between.
- **Group D is a prerequisite for Group E**, not cleanup. Group E does not type-check without
  `90c1c07`, `20c02fc`, `36db39d` and `a60518c`.

## Untested ground — not the same as a deviation

The stop rule above is about the rehearsal predicting one thing and reality doing another. Some
things the rehearsal never exercised at all, and a failure there is **new information, not a
contradicted prediction**. Investigate it on its merits; do not read it as evidence that §8's
script is wrong.

Never run in the rehearsal:

- **`npm run test:contracts`** and **`npm run test:e2e`** — neither was executed once, despite
  `#267` (`session_name`), `#299` (terminal `seq`) and `#282` (provider capabilities) all
  changing the tb-mobile-facing contract. Contract drift is the risk class the rehearsal did
  nothing about.
- **The entire cross-OS smoke matrix.** Everything in the rehearsal ran on macOS locally.
  `Smoke (windows-latest)` and `Smoke (macos-latest)` have never seen this content, and
  `#272` (Windows updater), `#332` and `#337` (Windows ConPTY) are exactly the changes that
  matrix exists to check. `__tests__/pty-host-survival.test.ts` is already failing locally.
- **Booting the result.** The rehearsal's final trunk was never started — `node dist/cli.cjs
  serve` was not run, and no mobile client was ever paired against it. The post-landing boot
  check below is therefore a **first run, not a re-run**. Budget for it failing on something
  the rehearsal could not have seen.

## Per PR

Follow CLAUDE.md exactly: `git fetch && git rebase origin/main`, resolve preserving the PR's
intent, `git push --force-with-lease`, wait for required checks, `gh pr merge <n> --squash
--delete-branch`. One at a time — a merged PR advances `main`, so the next is behind again.

Required green: Gate, Setup, Warm cache, Lint, Build, Test (Node 20/22/24), and BOTH
`Smoke (macos-latest)` and `Smoke (windows-latest)`. Never merge red. If CI fails on something
that looks like infrastructure, re-run once; if the re-run fails, stop and report.

Show me the diff and the message before any commit you author yourself.

## Progress

Keep a running log at ../tb-streamer-landing-run/RUN-LOG.md: per PR, the SHA it merged as, any
conflict and how it was resolved, and whether that matched the rehearsal's prediction. Write it
after every merge, not at the end — this run will outlive its session.

Report after each wave. If you stop on the stop rule, say precisely what diverged and what the
rehearsal predicted instead.

## After the last wave

Run §8's closing checks, then confirm `main` builds and boots. **This is the first time any of
this is booted** — the rehearsal never started its trunk, so treat a failure here as new
information rather than a regression:

    npm ci && npm run build && npm test
    node dist/index.js --help

Then pair a tb-mobile client and confirm session list, conversation detail and PTY streaming
still work — `#267`, `#299` and `#282` all change the mobile-facing contract.
```

## What "done" looks like

`main` carries the content, the integration branch reports nothing new that matters, and
`RUN-LOG.md` records every deviation from the rehearsal so the next person landing a branch in
this repo knows what static analysis missed.

Do not delete `integration/missing-prs-2026-07-23` until that log is written and reviewed. It is
the only remaining witness if the run went wrong somewhere.
