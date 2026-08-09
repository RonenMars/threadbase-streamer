# tb-streamer — merged action list from the PR-follow notes (as of 2026-08-09 17:45)

Every actionable item from the notes in this folder, in one list, ordered by priority (severity × urgency).
Derived from those notes — re-verify against them before acting; each carries its own snapshot date and is stale by default.

| # | Action | Severity | Trigger / why now | Source |
|---|---|---|---|---|
| 1 | Set fd limits in both service definitions: `SoftResourceLimits`/`NumberOfFiles` in the `scripts/deploy.sh` plist generator, `LimitNOFILE=` in `scripts/deploy-linux.sh` (suggested 16384) | **Critical** | Neither sets one today. Node does not raise its own `RLIMIT_NOFILE`; where the supervisor applies the 256 default the streamer hits EMFILE at ~249 fds against a 2415 steady state — broken from first boot, and it surfaces as unrelated `fs` failures rather than as a watcher problem. | [FD-BUDGET §R1](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 2 | Document the `fs.inotify.max_user_watches` sysctl in the Linux deploy guide, alongside #1 | **High** | `LimitNOFILE` does not cover inotify. The corpus already sits at ~26% of an 8192 default, shared with every other watcher on the box. Raising the fd limit alone looks like a fix and is not one. | [FD-BUDGET §R2](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 3 | Decide the integration branch's endgame: merge `integration/prs-223-441-…-456` to `main`, or land its PRs individually | **High** | It now carries 15 open PRs' worth of content plus #463/#465 (merged into it) and `6c1ed95` — and **`main` has none of it**. Every item below that says "still open against `main`" is downstream of this one decision. | this file |
| 4 | Review and land PRs #461 (cwd-based project paths) and #462 (drop dead `projects.message_count`) | **High** | Together they are the entire ADR-0001 streamer kickoff scope, and both already exist. The risk is someone reimplementing them. Content is on the integration branch; both still open against `main`. | [CODEX-FORK](Streamer-CODEX-FORK-AND-FOLLOWUPS.md) |
| 5 | Close #441, or let dependabot re-raise it | **Medium** | Merging it is a **downgrade**: `@types/node` 26.1.2→26.1.1, `@types/semver` 7.8.0→7.7.1, `tar` 7.5.22→7.5.21. Superseded by #452/#453/#454, which merged after it. | [OPEN-PRs](Streamer-OPEN-PRs.md) |
| 6 | Replace the enumerated flaky-file list in `CLAUDE.md`'s Testing section with the failure-*signature* rule plus the grep triage (all timeouts ⇒ load, any assertion ⇒ real) | **Medium** | Free, pure process, and it pays off on the next suite run. Re-confirmed 2026-08-09: a full run on the synced branch failed 54 tests across 16 files, **every one a 60s timeout**, and the three suspicious files passed 15/15 in isolation. The enumerated list named only 6 of those 16. | [FD-BUDGET §R5/R6](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 7 | Verify the three live Codex ownership scenarios — standalone terminal, VS Code, desktop app — against #463 | **Medium** | The only genuinely unverified part of #463, and it is now merged into the integration branch, so this is the last gate before that behaviour reaches clients. | [CODEX-FORK](Streamer-CODEX-FORK-AND-FOLLOWUPS.md) |
| 8 | Delete the redundant refs `wip/lifecycle-starting-multi-agent-gate` and `integration/2026-08-08_14-22-prs-441-…-454` from origin | **Low** | Both fully subsumed. The first was a preservation ref for `6c1ed95`, now landed; the second is 4 merges plus the reverted TypeScript 7 bump. | [ORPHAN-FIX](Streamer-ORPHAN-LIFECYCLE-GATE-FIX.md) |
| 9 | Update the `verify-against-base-before-blaming-your-change` memory so failure-kind triage runs first, and note that retargeting a PR invalidates a base run | **Low** | Scopes the existing rule rather than repealing it. | [FD-BUDGET §R8/R9](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 10 | Record a decision **not** to build a boot-time rlimit self-check | **Low** (negative) | It cannot be made truthful cross-platform: `process.report` carries no `rlimit` on darwin, and `ulimit -n` reports the shell's limit rather than the process's. Write the decision down so it is not proposed again. | [FD-BUDGET §R4](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |

Item 1 is the only outright broken state left, and it is latent — it bites when the code runs on a machine where the supervisor actually applies the 256 default.

## Done since the last revision

- ~~Cherry-pick `a681ac0` onto a branch and PR it~~ — **landed as `6c1ed95`** on the integration branch. Syncing that branch merged #456 and #448 into one tree, which was both the first place the fix could apply and the first place the bug was live. Lint clean, 211 tests passing.
- ~~Merge PR #463 (Codex active-writer resume)~~ — **merged**, automatically, when the integration branch was advanced past its head. Into that branch, not `main`.
- ~~Regenerate `Streamer-OPEN-PRs.md`~~ — regenerated at 17:45; the previous snapshot was 2026-07-19 and every row in it was stale.
