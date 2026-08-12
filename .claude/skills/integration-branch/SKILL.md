---
name: integration-branch
description: Build an integration branch that merges open PRs together, one at a time, with a live merge log and a final summary. Runs as a local rehearsal, as a real run replaying that rehearsal, or (with an explicit danger approval) as a real run with no rehearsal. Defaults to every open PR; accepts a PR range or explicit list, and can additionally merge named local/remote branches that have no PR. Use when the user says "create an integration branch", "merge all open PRs into one branch", "integration branch for PRs 441-456", "rehearse the integration merge", "combine the open PRs so we can test them together", or asks to rebuild/refresh an existing integration branch.
---

# Integration branch

Merges a set of PRs into one branch so they can be tested together, in dependency-correct order,
recording the run as it happens. Two documents come out of it:

- a **log** written continuously — [`docs/integration/log-format.md`](../../../docs/integration/log-format.md)
- a **summary** written at the end from the log — [`docs/integration/summary-format.md`](../../../docs/integration/summary-format.md)

Read both formats before starting. The log is not a write-up at the end; it is appended after every
action, because the obstacles are the part worth keeping and they are the first thing memory loses.

**This skill never pushes to `main` and never merges a PR into `main`.** It produces an integration
branch and two documents. Landing the PRs is a separate, explicitly-requested operation.

## Step 0 — Pick the flow

Three flows, differing only in **what they are allowed to write**. Ask the user which one, unless they
already said.

| Flow | Writes to | Produces | Danger |
|---|---|---|---|
| **A — Rehearsal** | nothing outside the local worktree; `origin` is read-only | log + summary | none |
| **B — Real, no rehearsal** | `origin`: integration branch, force-pushed PR heads, merged/closed PRs | log + summary, written live | **high — requires explicit approval** |
| **C — Real, from a rehearsal** | same as B | a *new* log + summary that reference the rehearsal's | moderate — every resolution was rehearsed first |

**Default: A, then C.** Run the rehearsal, report it, and ask before proceeding to the real run.
Never chain into C automatically — C writes to `origin`, and that consent is separate from the consent
to rehearse.

Flow B exists for when the user knowingly skips the rehearsal. It is not a shortcut with the same
outcome; see the gate below before offering it.

### Flow A — Rehearsal (local, `origin` read-only)

Run every step below in a throwaway worktree, resolving conflicts for real, running the suite for real.
The output is a **conflict ledger and a verified command sequence** — the thing that makes the real run
mechanical instead of improvised.

Forbidden for the whole of flow A: `git push` (any form), `gh pr merge`, `gh pr edit`, `gh pr close`,
`git push --delete`, and deleting any remote branch. Read commands against `origin` are fine.

Name the documents `<date>-<slug>-rehearsal-log.md` and `-rehearsal-summary.md`.

Before reporting done, prove nothing escaped:

```bash
git ls-remote --heads origin | grep -c "<integration-branch>"    # expect 0
```

<!-- ponytail: an after-the-fact assertion, not a sandbox. It catches the branch push, which is the
     likely slip; it does not catch a force-pushed PR head. Use a separate clone if that matters. -->

### Flow B — Real run with no rehearsal (**dangerous — approval gate**)

**Warn the user in these terms before doing anything, and get an explicit yes.** Do not soften it, and
do not treat "yes, do the integration" from earlier in the conversation as covering this.

What makes it dangerous, concretely:

- **Every conflict resolution is made once, live, with no ledger to check it against.** A wrong
  whole-file resolution deletes routes and unrelated additions while `tsc` stays green — the rehearsal
  is what normally catches that, and it is not running.
- **Force-pushing a rebased PR head rewrites a branch other people, CI and review threads point at.**
  It un-restacks any child PR and can strand review comments on commits that no longer exist.
- **Merging a stack base retargets its children silently** — GitHub's auto-restack is not reliable, so
  the child goes `DIRTY` with its head unchanged and nothing announces it.
- **Merges, branch deletions and force-pushes are not undoable from the client.** Recovery is only as
  good as the backup refs pushed beforehand.
- The suite has not been run on the merged result yet, so the first evidence that the set is broken
  arrives *after* `origin` has been written.

The gate:

1. Print the exact write list before the first write — every ref to be pushed, every PR head to be
   force-pushed, every PR to be merged, every branch to be deleted.
2. Push a backup ref and an annotated tag for **every** branch that will be force-pushed or deleted.
3. Get an explicit approval for that list. A blanket yes does not carry: re-confirm immediately before
   any force-push of a PR head and before any branch deletion.
4. Use `--force-with-lease`, never `--force`. Never force-push `main`.
5. Log every write as it happens — in this flow the log is the only record that a write occurred.

If the user is undecided, recommend A → C and say why: the rehearsal costs one extra pass and converts
the whole run into replaying decisions that are already known-good.

### Flow C — Real run from a rehearsal

Input is the rehearsal's log and summary. Do not re-derive the order or the resolutions; execute them.

1. **Re-verify the preconditions the rehearsal assumed** — they expire:
   ```bash
   git fetch origin
   git rev-parse --short origin/main                       # vs the rehearsal's cut point
   gh pr view <n> --json headRefOid                        # vs the rehearsal's recorded head, per PR
   ```
   Any SHA that moved invalidates the ledger **for that PR only**. Re-rehearse that PR in the worktree,
   or resolve live and mark the row as a deviation — do not silently apply a stale resolution.
2. Execute the recorded order from the rehearsal summary's §3, applying the recorded resolutions.
3. Write a **new** log for the real run that cites the rehearsal's, rather than editing it. Where the
   two disagree, **the real run wins** — and the disagreement itself is a log entry.
4. Everything in flow B's gate still applies to the writes: backup refs first, `--force-with-lease`,
   re-confirm before force-pushing a PR head or deleting a branch.
5. The final summary folds both: what the rehearsal predicted, and where reality differed.

## Step 1 — Settle the scope

Three modes. Pick from what the user said; ask only if genuinely ambiguous.

| Mode | Trigger | Set |
|---|---|---|
| **All open** (default) | "integration branch", no qualifier | every open PR |
| **Range / list** | "PRs 441-456", "just #442, #447, #451" | exactly those |
| **All open + extra branches** | "…plus my local fix/x branch", "and the branches that have no PR yet" | open PRs ∪ named branches |

In every mode, confirm the resolved list back to the user before cutting anything — a wrong set is
discovered at merge 12, not merge 1.

Carry a **standing exclusion list**. Ask the user for one if the repo has none; anything excluded goes
in the log with its reason.

Also capture one option here, because it changes whether the run can stop later: **may a red CI halt the
run?** If the user says up front that it must not — "don't stop for red CI", "merge them regardless" —
record that and honour it in Step 6's check. Absent that, the default is to stop and ask.

## Step 2 — Preflight

```bash
git status --porcelain                  # must be empty
git fetch origin
git rev-parse --short origin/main       # state this SHA in the first report
```

`origin/main` is a cached ref. **Re-fetch immediately before cutting** — a stale one silently produces
a branch that is not from today's `main`, with no error at any point.

Work in a **dedicated worktree**, never the primary checkout:

```bash
git worktree add ../<repo>-worktrees/int-<date> -b integration/<date>-<slug> origin/main
```

Give the worktree its own `npm ci`. A copied `node_modules` is a version behind by the time it matters,
and native modules (`better-sqlite3`, `node-pty`) are compiled against a specific Node ABI.

If an integration branch already exists and is being replaced: **push a backup first**
(`backup/<old-name>-<date>`) and an annotated archive tag. Do not delete the old one — the coverage
gate in Step 8 validates against it.

## Step 3 — Baseline

Run `npm run lint` and `npm test` on `main` **before merging anything**, and record the counts in the
log's §2. `main` being green is an assumption, not a fact; every later count is a delta against this
one. Skipping this is how a pre-existing failure gets blamed on a merge.

## Step 4 — Collect the set and find the real order

```bash
gh pr list --state open --json number,title,headRefName,headRefOid,baseRefName,isDraft,createdAt
```

Then, **per PR** (bulk mergeability is not computed — a list query returns `UNKNOWN` for every row):

```bash
gh pr view <n> --json mergeable,mergeStateStatus,isDraft,statusCheckRollup
```

- `isDraft` is invisible in the readiness fields — a draft reads as `MERGEABLE`/`CLEAN` and still will not merge.

**Drafts are the user's call, never yours.** As soon as the set is resolved, list every draft in it and
ask whether this run includes them — before cutting the branch, not at the merge that hits one:

```bash
gh pr list --state open --json number,title,isDraft --jq '.[]|select(.isDraft)|"#\(.number) \(.title)"'
```

Do not infer the answer in either direction. A PR is draft because it is unfinished, or because its
author is blocked on something with nothing to do with the code, and those want opposite treatment.
Record the answer in the log's §3 — included drafts flagged as such, declined ones in the exclusions
table as "draft — user declined".

Including a draft does **not** require flipping it ready: this skill merges the PR's head locally, and
GitHub's draft flag only gates merging on GitHub. Leave the flag alone — flipping a batch of PRs ready
so an integration branch can be built is a change to their state that nobody asked for.
- `DIRTY` means the merge ref is missing, so CI never ran on it: a lone green Snyk check is not "CI passed".

Detect two things that override chronological order:

1. **Stacked PRs** — `baseRefName` is another PR's head branch, or one PR's head is an ancestor of another:
   ```bash
   git merge-base --is-ancestor <pr-a-head> <pr-b-head>
   ```
   The base merges first. **Never drop the child's own commits** — they routinely fix the base/child
   interaction and exist in no other PR.
2. **Forced-order constraints** — a lint error one PR introduces and another clears; a refactor that
   moves code a later PR edits; a dependency bump superseded by a newer one. Chronology is the default;
   these override it.

Write the planned order, the stack table and the constraint table into the log's §4 **before merging**.

## Step 5 — Cut the branch

Per the requested procedure: start from the **earliest PR's branch**, then rebase onto `main`.
The earliest PR is the only one rebased onto `main` — every PR after it rebases onto the integration
branch (Step 6), because by then the integration branch is what it has to be correct against.

```bash
git checkout -b integration/<date>-<slug> <earliest-pr-head>
git rebase origin/main
```

Fetch every PR head into a private namespace — **not** `refs/remotes/origin/pr/*`:

```bash
git fetch origin "pull/<n>/head:refs/integration/pr/<n>"
```

`git fetch origin --prune` deletes every `origin/pr/*` ref, mid-run, silently. The private namespace
survives it.

## Step 6 — Merge, one PR at a time

### Before each merge — check that branch's CI

Applies to **every** member of the set, the earliest one included, and runs immediately before that
branch is taken.

1. **Does the head branch exist on `origin`?**
   ```bash
   git ls-remote --heads origin <head-branch>
   ```
   A local-only branch has no CI to read. Record that in the log — "no remote, unverified" is a real
   state and must not look like a pass — and continue.

2. **If it exists, read its checks.**
   ```bash
   gh pr view <n> --json statusCheckRollup,mergeStateStatus     # PR
   gh api repos/{owner}/{repo}/commits/<sha>/check-runs         # branch with no PR
   ```
   Count the check **names**, not the conclusions. A `DIRTY` PR has no merge ref, so the real suite never
   ran and only a security scanner reports — that is *unverified*, not green. Compare any failure against
   the Step 3 baseline: a test already red on `main` is not this branch's fault, and the log should say so.

   **A short name list can also mean you read too early.** For a few seconds after a push the rollup still
   carries only the previous run's stale contexts, which looks identical to "the suite never ran". Confirm
   the run exists before drawing a conclusion, and re-read once it has registered:
   ```bash
   gh run list --branch <head-branch> --limit 3 \
     --json headSha,status,conclusion,workflowName
   ```

3. **If CI is red or never ran: tell the user — do not ask.** One message naming the branch, the failing
   checks, and that the run is continuing. No approval, no pause. Log it.

4. **Then look for the fix inside the integration set**, since the most common cause is a PR that another
   PR in the same set repairs — one introduces a lint error, the next clears it:
   ```bash
   gh pr view <n> --json body,comments        # "depends on #N", "fixed by #N", "needs #N first"
   gh pr diff <m> --name-only                 # per candidate: does it touch the failing file/test?
   ```
   If a member of the set fixes it, that is a **forced-order constraint**, not a problem: record it in the
   log's §4 with the reason, order the fixer accordingly — before, if it unblocks; immediately after, if
   the failure only clears once both are in — and carry on **without asking**.

5. **If nothing in the set fixes it, stop and ask.** Present the options rather than a bare question: drop
   the branch from the set, merge it and accept a red checkpoint, wait for its author, or pull in an
   out-of-set fix. Log the answer as a decision in §11.

6. **The exception:** if the user said up front that a red CI must not stop the run (Step 1), never stop.
   Steps 1–4 still run and still get logged — the opt-out removes the halt, not the check. A run that
   skipped the check entirely cannot tell later which failures it inherited.

**Rebase first, then merge.** Every PR after the earliest one — and every extra non-PR branch — rebases
onto the *current integration tip*, not onto `main`. The tip already carries everything merged before
it, so that is the tree this change has to be correct against. Rebasing puts the conflict where it can
be resolved per-commit with the PR's own context, and leaves a merge that is trivially clean.

```bash
git checkout -B rebase/pr-<n> refs/integration/pr/<n>
git rebase integration/<date>-<slug>          # conflicts surface here, not in the merge
git checkout integration/<date>-<slug>
git merge --no-ff rebase/pr-<n> -m "integrate PR #<n>: <title>"
```

Record both SHAs in the log's §6 (`head before → head after`, and what it was rebased onto). The repo's
own merge logs read this way — "rebased `2e80a3a` → `1ff4dfc` onto `6003e18`" — and that chain is what
makes a later bisect possible.

**The rebase is local until you decide otherwise.** In flow A it never leaves the worktree. In flows B
and C, publishing it means force-pushing the PR's head, which is a write with every consequence listed
in the Step 0 gate — back it up, use `--force-with-lease`, and re-confirm first. Integrating a PR does
not require publishing its rebase; only re-pointing the PR itself does.

After **each** merge, before moving on:

1. Resolve conflicts. Classify each one **M** (mechanical — one side is a strict superset, or the rule
   is obvious) or **J** (judgment — a real either/or). For every `J`, record the discarded side and what
   it was trying to do, not just the winner.
2. `npm run lint && npm test` — compare against the **baseline**, not against zero.
3. Append to the log: action entry (§5), per-PR block (§6), any conflict rows (§7), any obstacle (§9),
   and the checkpoint row (§10) with the branch SHA and the delta.
4. Confirm the PR's diff scope is unchanged: `gh pr diff <n> --name-only` against the same paths on the
   branch. A rebase that silently widens or narrows a PR's file set survives every green check.

A `DIRTY` PR is not a special case under this order — it rebases onto the tip like every other one. Log
the resolution anyway: the conflict is usually a doc line rather than code, and that distinction is
what tells the next reader whether the PR was actually at odds with the set.

**Do not batch.** Merging three PRs then testing turns one red suite into a three-way bisect.

## Step 7 — Sweep for what git did not flag

A clean three-way merge routinely produces wrong code: one PR extracts a function while another edits
the old body, and both sides apply without a marker. `tsc` will not catch it.

After any merge touching a refactor:

- For every function moved or extracted by a PR in the set, grep its call sites and confirm the guards
  and side effects survived.
- List every blanket per-file resolution (`--ours`/`--theirs` on a whole file) — each one deletes
  unrelated additions from the losing side.
- Confirm every flag, env var or wiring the set introduces is still read.

Record the sweeps in the log's §8 **even when clean** — "checked, empty" and "not investigated" must not
look alike.

## Step 8 — Coverage gate

Before reporting done, prove the branch contains everything it claims:

```bash
gh pr diff <n> --name-only     # per PR, compare against the branch
```

The audit's "missing" list is **not a verdict** — it false-negatives whenever a later PR edited the same
files. Hand-verify every reported miss and name the false negatives in the log; the next run hits the
same ones.

If an old integration branch is being replaced, diff the two: anything on the old branch and not the new
one is either a PR you missed or work that was never in a PR at all. Both need a line in the log.

## Step 9 — Write the summary and hand off

Write the summary from the log using the summary format, then report:

- branch name + SHA, PR count, commits ahead of `main`
- lint/test delta vs baseline
- the judgment calls, the exclusions, and anything not verified
- paths to both documents

**Flow A stops here** — nothing is pushed. Report the result and ask whether to proceed to flow C.

**Flows B and C** push the integration branch (never `main`). Ask before opening a PR for it, and never
merge PRs to `main` as part of this skill.

## Traps that recur

| Trap | Consequence | Guard |
|---|---|---|
| Stale `origin/main` | Branch is not from today's `main`, no error anywhere | `git fetch` immediately before the cut; state the SHA |
| `git fetch --prune` | Deletes `origin/pr/*` mid-run | Fetch heads to `refs/integration/pr/*` |
| Bulk `mergeable` query | Every row `UNKNOWN` | Per-PR `gh pr view` |
| Draft PRs | Read as mergeable, will not merge | Request `isDraft` explicitly, then ask the user whether the run includes them |
| Stacked child | Does not auto-restack when its base merges; goes `DIRTY` | Merge base first, verify the child's unique commits survive |
| `main` not green | Every count misattributed | Baseline in Step 3 |
| Commit hooks rejecting merge commits | The whole shell call aborts, not just the commit | Expect it; ask the user how to proceed rather than reaching for `--no-verify` |
| Copied `node_modules` | Native ABI mismatch, phantom failures | `npm ci` in the worktree |
| Whole-file conflict resolution | Silently deletes routes/additions; `tsc` stays green | List every one in §8 and diff the losing side |
