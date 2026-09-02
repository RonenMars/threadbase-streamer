# E2EE three-lane parallel kickoff

Session name: `e2ee-parallel-owner-2026-08-31`.

You are the sole coordinator for three parallel E2EE continuation lanes.
Use agents or teammates immediately; do not execute any lane's product work in the coordinator session.
Remain responsible for dependency arbitration, approval packages, Streamer PR-slot ownership, cross-lane state, and final evidence reconciliation.

## Read first

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/AGENTS.md`
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-2026-08-31/README.md`
3. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/PLAN-FINISH-E2EE-2026-08-30.md`
4. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/STATUS.md`
5. The `superpowers:dispatching-parallel-agents` skill
6. The `operating-git-and-github` skill before coordinating any PR, rebase, push, merge, or GitHub-writing action

## Coordinator authority and ownership

You are explicitly authorized to spawn three lane leads in parallel and to keep them alive across their approval boundaries.
Dispatch all three in the same round with isolated context.
Each lane lead may spawn its own bounded implementer, reviewer, or isolated adversary when its track prompt requires one.

The coordinator owns these shared files exclusively:

- `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/STATUS.md`
- `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/PLAN-FINISH-E2EE-2026-08-30.md`
- `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-2026-08-31/README.md`
- `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-2026-08-31/kickoff.md`

Lane leads must report proposed status or checkbox updates to you instead of editing those shared files.
This overrides any instruction in an individual lane prompt that tells that lane to edit `tracks/STATUS.md` or the top-level finish plan.

Lane-specific coordination ownership is disjoint:

- Release-notes lead may update `tracks/W/REPORT-W1b.md`.
- X-server lead may update files under `tracks/X-server/`.
- XC1 lead may create or update files under `tracks/X-client/`.

Product-code ownership is also disjoint:

- Release notes: `/Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/fix/release-notes-rendering`
- X-server: `/Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/feat/e2ee-rest-envelope`
- XC1: `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-transport`

No lane may edit another lane's worktree or coordination files.
No lane may edit a repository root checkout.

## Dispatch all three lanes now

Spawn these three lane leads concurrently, using one parallel dispatch round.
Do not fork the coordinator's full conversation into them; each prompt file is their authoritative context.

### Lane 1: release notes

Agent name: `w1b-release-notes-lead`.

Message:

```text
Read and execute /Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-2026-08-31/release-notes.md exactly.

You own only the release-notes lane and its named worktree.
You own the first Streamer PR slot.
Re-verify all live state before acting.
Opening the PR is authorized.
Do not merge without a fresh explicit user approval relayed by the coordinator after current CI and mergeability are shown.
Do not edit tracks/STATUS.md or tracks/PLAN-FINISH-E2EE-2026-08-30.md; send exact proposed updates and evidence to the coordinator.
Report immediately when the PR opens, when CI reaches a terminal state, when merge approval is needed, when semantic-release finishes, and when the Streamer PR slot is free.
```

### Lane 2: X-server

Agent name: `x-server-lead`.

Message:

```text
Read and execute /Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-2026-08-31/x-server.md exactly.

You own only the X-server lane, its preserved worktree, and files under tracks/X-server/.
Recover, rebase, implement, test, run the full mutation campaign, and prepare the isolated adversary in parallel with the release-notes lane.
Do not open a Streamer PR until the coordinator explicitly reports that the release-notes PR is MERGED, its semantic-release run is complete, and the Streamer PR slot is empty.
Do not commit without the complete staged diff and exact message being shown to the user through the coordinator and explicitly approved.
Do not merge without a separate fresh explicit user approval after current CI and mergeability are shown.
Do not edit tracks/STATUS.md or tracks/PLAN-FINISH-E2EE-2026-08-30.md; send exact proposed updates and evidence to the coordinator.
Report after recovery fingerprinting, after the v1.72.0 rebase, after every seen-red campaign, before and after the full suite, after adversary review, and at each approval boundary.
```

### Lane 3: mobile XC1

Agent name: `x-client-xc1-lead`.

Message:

```text
Read and execute /Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-2026-08-31/x-client-xc1.md exactly.

You own only XC1, its new mobile worktree, and files under tracks/X-client/.
Begin immediately against exact streamer tag v1.72.0.
Your first deliverable is tracks/X-client/PLAN-X-client.md; stop at its explicit approval boundary and send the plan to the coordinator for user approval before implementation.
Do not implement XC2 REST transport.
Do not modify, close, merge, or comment on unrelated mobile PRs.
Do not commit without the complete staged diff and exact message being shown to the user through the coordinator and explicitly approved.
Do not merge without a separate fresh explicit user approval after current CI and mergeability are shown.
Do not edit tracks/STATUS.md or tracks/PLAN-FINISH-E2EE-2026-08-30.md; send exact proposed updates and evidence to the coordinator.
Report after preflight, worktree creation and npm ci, plan completion, each seen-red campaign, loopback/Hermes verification, adversary review, and every approval boundary.
```

## Parallel coordination rules

After dispatch, continue coordinating rather than duplicating lane work.
Do not wait for all three when one lane reports an actionable approval or blocker.
Process whichever lane reports first, then return to monitoring the others.

Maintain this live state table in the coordinator's own notes and mirror material changes into `tracks/STATUS.md`:

| Lane | Development | Verification | Commit approval | PR slot | CI | Merge approval | Release |
|---|---|---|---|---|---|---|---|
| Release notes | prepared | locally green | already committed | owns first Streamer slot | pending | required | pending |
| X-server | active | pending | required | waits for release notes | pending | required | pending |
| XC1 | starts after plan approval | pending | required | mobile policy applies | pending | required | no Streamer release |

The release-notes lead owns the Streamer PR slot from kickoff until all of these are true:

1. Its PR reports `MERGED`.
2. Its semantic-release workflow has completed.
3. Its resulting remote tag and generated notes have been verified.
4. The open Streamer PR list is empty.

Only then send the X-server lead an explicit slot-release message.
The X-server lead must fetch and rebase onto the resulting current `origin/main` and rerun every post-rebase gate before opening its PR.

Streamer full suites from both Streamer lanes must serialize through `/tmp/tb-streamer-suite.lock`.
Do not cancel a legitimate lock holder merely to make another lane faster.

The mobile lane is independent of the Streamer PR slot.
Its PR submission remains subject to the mobile repository's current open-PR policy and overlap audit.
Unrelated mobile PRs are reported as blockers; they are never changed to clear the lane.

## Approval relay

When a lane reaches an approval boundary:

1. Read the evidence yourself.
2. Verify the actual worktree and live GitHub state.
3. Present the complete required package to the user.
4. Wait for an explicit approval tied to that package.
5. Relay the approval only to the requesting lane.

Never reuse one lane's approval for another lane.
Never interpret `go on`, `finish`, an earlier commit approval, or this kickoff as merge approval.

For commit approval, present:

- exact worktree and branch;
- `git status --short --branch`;
- complete `git diff --staged`;
- explanation of every changed path;
- exact commit message verbatim;
- verification and seen-red evidence.

For merge approval, present:

- PR number and title;
- current head and base SHAs;
- mergeability and up-to-date state;
- every required check conclusion;
- exact squash title;
- whether a final rebase or force-with-lease will be needed.

## Required stop-work events

Stop the affected lane and notify the user immediately if:

- a private key, ticket, device token, API key, or unsanitized credential appears in logs or evidence;
- plaintext appears on a channel declared sealed;
- two writers touch the same context counter or worktree;
- a lane needs to modify another lane's owned paths;
- X-server would open a PR while release notes still owns the Streamer slot;
- an approved protocol dilemma becomes load-bearing;
- compatibility would require changing a released client;
- an agent cannot prove restoration after a mutation.

Other lanes may continue when the stop is isolated and their state is independent.

## Completion conditions

Release-notes lane completes when the correction PR is merged, semantic-release succeeds, generated notes contain the expected commit entry, W1b Step 11 evidence is complete, and the Streamer PR slot is released.

X-server lane completes when its approved PR is merged, its semantic-release tag is independently verified, and the exact tag is recorded for XC2 and R1.

XC1 completes when its approved mobile PR reports `MERGED` with all required local, CI, interop, Hermes, mutation, and adversary evidence.

After each lane completes:

1. Update `tracks/STATUS.md` from live evidence.
2. Update the corresponding checkbox in `tracks/PLAN-FINISH-E2EE-2026-08-30.md` only when its complete gate is genuinely satisfied.
3. Close its lane agent after preserving the final report.
4. Report the next newly unblocked dependency.

Do not start XC2, D2, or rollout work from this kickoff.
Report that they are unblocked when their prerequisites become true and wait for the user's next instruction.

