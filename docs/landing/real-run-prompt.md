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

The rehearsal's value is that it makes deviation legible. A deviation means its prediction was
wrong somewhere, and continuing past it blind is how a silent regression reaches `main`.

## Named hazards — do not rediscover these the hard way

- **`#313` / `src/pty-manager.ts`.** Apply `#313`, and resolve its conflict IN ITS FAVOUR —
  keep `recheckReadyFromScreen()`, not the hand-written `markReady` line. The rehearsal made
  exactly this mistake: it compiled, it linted, and it silently reinstated the bug `#313`
  exists to fix. Nothing but a per-file diff catches it. §8's wave-5 hazard note has the
  exact command.
- **`#245` — close it, do not merge it.**
- **`#223` last, on its own**, after a real `npm install`.
- **`#237` after `#232`, `#253`, `#234` and `#267`**; `#266` follows `#237`.
- **Wave 2 children use `rebase --onto main origin/pr/<parent>`**, never a plain rebase.
- **`#275` and `#276` each introduce a biome import-order error that `#281` fixes.** Land
  `#281` immediately after, or lint is red in between.
- **Group D is a prerequisite for Group E**, not cleanup. Group E does not type-check without
  `90c1c07`, `20c02fc`, `36db39d` and `a60518c`.

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

Run §8's closing checks, then confirm `main` builds and boots:

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
