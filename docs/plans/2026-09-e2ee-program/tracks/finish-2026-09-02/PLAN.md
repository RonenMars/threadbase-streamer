# Finish E2EE — parallel execution plan, 2026-09-02

Splits `tracks/PROMPT-FINISH-E2EE-2026-09-02.md` into four groups that can run at once, with the sync points named. Everything here is a plan of record: when it disagrees with `tracks/STATUS.md`, STATUS wins.

## What actually serialises this work

Not task count. Three things:

1. **PR slots.** One PR at a time per repo. Mobile has one slot and three candidate PRs; the streamer has one slot and at most one. Groups may *develop* in parallel; they may not *open* in parallel.
2. **Hardware.** One rig, one phone, one pair of the user's hands. Every device row is serial with every other device row, and the rig is expensive to stand up (~10 min) so it is stood up **once**.
3. **One evidence dependency.** The retry loop's calling layer can only be identified from the device's own client log, and that log is captured during the rig session. Everything else in that group is independent of it.

Everything else is genuinely parallel.

## Groups

| Group | Scope | Model | Effort | PR slot | Needs the user |
|---|---|---|---|---|---|
| **G** — device evidence | G-1 continuation frames, G-2 Android, and capturing the client log for C1 | **Opus 5** | **high** | none (evidence only) | yes — at the phone, and sudo for capture |
| **C1** — the retry loop | Mobile defect 2: sticky permanent verdict, then the calling layer | **Opus 5** | **high** | mobile | no |
| **C2** — timer and guard | Mobile defects 3 and 4 | **Sonnet 5** | **medium** | mobile (after C1) | no |
| **R** — rollout | R2 escalation, R3 flip PR | **Sonnet 5** | **medium** | streamer | yes — R2 is a decision, R3 needs a go |

### Why these model tiers

**G is Opus 5 / high** because its failure mode is a *false pass*, not a crash. D2's capture method was wrong three times and two of those were caught only by a control or an outside reviewer; the surviving risk is a green result that is actually a blind spot. That is judgment work, and the model is idle most of the wall clock anyway — the bottleneck is the phone.

**C1 is Opus 5 / high** because the calling layer is unidentified and the obvious candidate is already ruled out. Finding it means reasoning across a log shipper, a socket close path, a silence timer and React Query from a server-side cadence. Weaker models converge on the first plausible story, and here the first plausible story is known to be wrong.

**C2 is Sonnet 5 / medium.** Two well-understood defects with the fix shape already written down. The care needed is in not over-reaching, which is a smaller ask than diagnosis.

**R is Sonnet 5 / medium**, matching the original R brief. Its hardest requirement is *not deciding* — presenting three options faithfully and stopping. Note that as an explicit instruction rather than trusting effort level to produce it.

## Dependency graph

```
G ──── G-1 (continuation frames) ──────────────► unblocks R2
   └── G-2 (Android) ──────────────────────────► unblocks the stage-2 flip
   └── client log capture ──┐
                            ▼
C1 ── item 1 (sticky verdict, caller-independent) ── PR ──┐
   └─ item 2 (name the layer, make it consult retryable) ─┤
                                                          ▼
C2 ── defect 3 (silence timer) ── defect 4 (prompt guard) ── PR (mobile slot, after C1)

R ─── R2 escalation (waits on G-1) ──► user decides ──► R2 code, if any
   └─ R3 flip PR (waits on G-2 + export compliance + the user's go) ──► opened, NEVER merged
```

**C1 item 1 does not wait for G.** It is caller-independent by construction: a permanent verdict per server that a later `429` cannot reset closes every candidate at once. It needs only a test-level reproduction, which the evidence file already describes. Start it immediately.

## Sync points, and who reports what

1. **G → C1**, when the client log is captured. G posts the log path and the observed request cadence; C1 uses it to name the layer. If G cannot reproduce the storm, C1 ships item 1 alone and item 2 stays open.
2. **G → R**, when G-1 lands. R2's escalation may then be presented.
3. **C1 → C2**, when C1's PR merges. C2 rebases and opens its own.
4. **G → R**, when G-2 lands. R3 may then be opened — and only opened.

Anything else is independent. Groups do not read each other's worktrees.

## PR ordering

Mobile: **C1 first**, then C2. C1 is the more serious defect and the one with a reproduction; C2 rebases behind it.
Streamer: **R only**, and only if R2's chosen option needs code. R3's PR is the last thing opened in this program.

## Rig policy

Stand the rig up **once**, for G. It serves G-1, G-2 and C1's client-log capture in a single session. Do not stand it up for anything smaller, and tear it down at the end with the "left as found" comparison. Rebuild recipe and the isolation rules are in `tracks/D/PLAN-D.md` §§3–4; the scrub rules are in the workspace `CLAUDE.md` §5.

## Documentation cadence — commit the record at every milestone

The workspace (`~/dev/ai-tools/tb-e2ee-program/`) is **not** a git repository, so its documents have no history of their own. The durable copy is `docs/plans/2026-09-e2ee-program/` in `threadbase-streamer`, merged 2026-09-02 as PR #755. That copy must not be allowed to go stale while this work runs.

**One writer.** Sub-agents update their own track files in the workspace and report; **only the orchestrator mirrors and commits**. Four agents on one branch is the two-writers hazard this program has a stop-work trigger for.

**Mechanism.** A single long-lived branch in the streamer — `docs/e2ee-program-record-updates` — off `origin/main`, in a worktree. The orchestrator commits to it after each milestone and pushes the branch. Pushing a branch is not opening a PR, so this never contends for the streamer PR slot.

**What counts as a milestone** — commit after each of these, not at the end of the day:

| Group | Milestone |
|---|---|
| G | rig up and the control's coverage figure known · G-1 captured and swept · G-2 captured and swept · the D2 addendum written · rig torn down |
| C1 | item 1's reproduction is red in a test · item 1 merged · the layer named (or recorded unknown) · item 2 merged or deferred |
| C2 | both issues filed · each fix merged |
| R | escalation drafted · the user's decision recorded · R2 landed (if it needs code) · R3 opened |
| any | a stop-work trigger, a surprise that changes the plan, or a finding worth keeping |

**Each commit carries** the updated `tracks/STATUS.md` plus whatever track documents changed, with a conventional message naming the milestone — `docs(e2ee): record G-1 continuation-frame evidence`, not `docs: update`. One sentence per line in the body. The body says what changed and why it matters, so the branch reads as a log of the work rather than a series of snapshots.

**The PR** opens when the streamer slot is free and there is something worth reviewing — at program close at the latest. If R needs the slot first, R gets it; the docs branch waits, because it is already safe on the remote.

**Scrub before every commit.** The streamer repo is **public**. The 2026-09-02 copy scrubbed a Cloudflare account id and a Zero Trust team domain; the same scan runs again each time — keys, tokens, device tokens, account identifiers, private LAN topology beyond what is already published. Raw captures, decoded payloads, screenshots and logs are never copied, only the markdown and instruments.

## Definition of done for the program

- G-1 and G-2 cleared on the R row of STATUS, with evidence.
- C1 item 1 merged; item 2 either merged or explicitly deferred with the layer named as unknown.
- C2 merged, or its two defects filed as issues with the analysis attached if the fixes are deferred.
- R2 presented and the user's choice recorded in the decisions log.
- R3 opened, green, and **not merged**.
- `tracks/STATUS.md` current, and a close-out note added to `docs/plans/2026-09-e2ee-program/` in the streamer.
