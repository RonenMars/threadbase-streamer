# Orchestrator session — finish the E2EE program

**Model: Opus 5. Effort: high.** You coordinate; you do not implement. The one exception is R2's escalation document, which is prose and yours to draft.

You run from `~/dev/ai-tools/tb-e2ee-program/`. Read the workspace `CLAUDE.md` first — it is binding, especially §2 (strict no-go), §3 (cryptographic guardrails), §4 (verification methodology), §5 (program rules) and §6 (stop-work triggers). Then read `tracks/STATUS.md`, which outranks every brief including this one.

## What you own

- The plan: `tracks/finish-2026-09-02/PLAN.md`.
- Four sub-agents, defined in `tracks/finish-2026-09-02/agents/`. Dispatch each with the kick-off message in `KICKOFF.md`, adapted only where that file says it may be.
- `tracks/STATUS.md` — row cells **and** the decisions log, updated on **every** child report, not at the end. This is an explicit standing instruction from the user, not a nicety.
- **The committed record.** The workspace is not a git repository, so the durable copy is `docs/plans/2026-09-e2ee-program/` in `threadbase-streamer`. You mirror and commit it **after every milestone** — see `PLAN.md` → "Documentation cadence" for the milestone list. You are the only writer; sub-agents update their track files and report, and you carry them across.
- Every gate that reaches the user. Sub-agents do not ask the user for anything; they report to you and you ask.

## What you must not do

- Do not implement in a sub-agent's repo or worktree. If a group is stuck, send it a message; do not fix its code.
- Do not let two groups hold the same PR slot. Mobile has one slot, the streamer has one.
- Do not decide R2. Present the three options and stop.
- Do not merge R3. Ever, under any phrasing, without the user's explicit go relayed in their own words.
- Do not rebuild the device rig for anything except the single G session.

## Dispatch order

Start **G**, **C1** and **R** immediately and in parallel. Hold **C2** until C1's PR is merged — it contends for the same mobile slot, and starting it early only produces a branch that rots behind a rebase.

Two of the three starters need nothing from anyone: C1's item 1 is caller-independent, and R's escalation document can be drafted while it waits on G-1 to present it.

## Sync points you must police

| When | What you do |
|---|---|
| G captures the client log | Relay the path and the observed cadence to C1. If G could not reproduce the storm, tell C1 to ship item 1 alone and leave item 2 open with the layer recorded as unknown. |
| G-1 lands | Clear G-1 on the R row. Tell R it may present R2. |
| C1's PR merges | Release the mobile slot; dispatch C2. |
| G-2 lands | Clear G-2 on the R row. Tell R it may open R3 — opening only. |
| Any group reports a stop-work trigger | Stop that group, tell the user immediately, and do not let another group route around it. |
| **Any milestone at all** | Update STATUS, mirror the changed documents into the streamer worktree, scrub, commit with a message that names the milestone, and push the branch. Do not batch milestones. |

## The three things this program has learned the hard way

Repeat these to any group that touches evidence, because each one already cost a day:

1. **A control that exercises only the easy path certifies only the easy path.** D2's capture control dissected 100 % of its payload because every body and frame fitted in one TCP segment — which is exactly why it could not reveal that the sealed captures left ~30 % of payload bytes ungrepped, including the frames most likely to carry terminal output.
2. **An empty result is evidence only after a positive control proves the same invocation can return data.** This is in the user's global instructions and it has bitten this program twice: once on the capture grep, once on a Cloudflare API listing that returned `[]` for an application the dashboard was showing.
3. **Derive marker lists from the run's own artefacts, never from memory.** Two independent reviewers hand-wrote D2's marker list and both were incomplete, in opposite directions.

## Keeping the record committed

Set this up before dispatching anything, so the first milestone has somewhere to land:

```
cd ~/dev/ai-tools/tb-streamer
git fetch origin
git worktree add .worktrees/docs/e2ee-program-record-updates -b docs/e2ee-program-record-updates origin/main
```

After each milestone: copy the changed markdown from `~/dev/ai-tools/tb-e2ee-program/tracks/` into `docs/plans/2026-09-e2ee-program/tracks/` in that worktree, **markdown and instruments only — never `.pcap`, `.bin`, `.log` or screenshots**, then scrub, commit and push the branch.

The scrub is not optional and the repo is **public**. Before every commit, grep the staged files for keys, tokens, device tokens, account identifiers and anything resembling a credential. The 2026-09-02 copy had to replace a Cloudflare account id and a Zero Trust team domain; assume each new capture session adds more.

Pushing the branch is not opening a PR, so this never competes for the streamer PR slot. Open the PR when the slot is free, or at program close.

## Reporting

After every child report, update STATUS and give the user a short summary: what landed, what it cost, what is now unblocked, and what you need from them. Never batch several children's outcomes into one silent stretch — the user asked specifically to see the state move.

When all four groups are done, write the close-out: update `tracks/STATUS.md`, then add a close-out note to `docs/plans/2026-09-e2ee-program/` in the streamer as its own docs PR.

## First actions

1. Read `tracks/STATUS.md` top entry and the R row.
2. Verify from the remote, not from this brief: streamer `origin/main` and its latest tag, mobile `origin/main`, and that neither repo has a human PR open. Bot PRs (dependabot, Snyk) do not hold the slot but do not touch them either.
3. Confirm the rig is down and the phone's stale server entries are the user's to clear.
4. Tell the user your dispatch plan in four lines, then start G, C1 and R.
