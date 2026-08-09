# tb-streamer — merged action list from the PR-follow notes (as of 2026-08-09 17:00)

Every actionable item from the four notes in this folder, in one list, ordered by priority (severity × urgency).
Derived from those notes — re-verify against them before acting; each carries its own snapshot date and is stale by default.

| # | Action | Severity | Trigger / why now | Source |
|---|---|---|---|---|
| 1 | Cherry-pick `a681ac0` (`fix(sessions): scope lifecycle-starting gate to the PTY path`) onto `main` and PR it | **Critical** | Arms itself: the moment the *second* of #456/#448 merges, every idle multi-agent session reports `lifecycle: "starting"` to tb-mobile — a wrong client-visible value. Cannot be PR'd before then, since it needs symbols from both. | [ORPHAN-LIFECYCLE-GATE-FIX](Streamer-ORPHAN-LIFECYCLE-GATE-FIX.md) |
| 2 | Set fd limits in both service definitions: `SoftResourceLimits`/`NumberOfFiles` in the `scripts/deploy.sh` plist generator, `LimitNOFILE=` in `scripts/deploy-linux.sh` (suggested 16384) | **Critical** | Neither sets one today. Node does not raise its own `RLIMIT_NOFILE`; where the supervisor applies the 256 default the streamer hits EMFILE at ~249 fds against a 2415 steady state — broken from first boot, and it surfaces as unrelated `fs` failures rather than as a watcher problem. | [FD-BUDGET §R1](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 3 | Document the `fs.inotify.max_user_watches` sysctl in the Linux deploy guide, alongside #2 | **High** | `LimitNOFILE` does not cover inotify. The corpus already sits at ~26% of an 8192 default, shared with every other watcher on the box. Raising the fd limit alone looks like a fix and is not one. | [FD-BUDGET §R2](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 4 | Merge PR #463 (Codex active-writer resume) | **High** | Green at 11/11 checks and unmerged. It is the server half of mobile #572, which mobile's notes wrongly record as nonexistent. | [CODEX-FORK](Streamer-CODEX-FORK-AND-FOLLOWUPS.md) |
| 5 | Review and land PRs #461 (cwd-based project paths) and #462 (drop dead `projects.message_count`) | **High** | Together they are the entire ADR-0001 streamer kickoff scope, and both already exist. The risk is someone reimplementing them. | [CODEX-FORK](Streamer-CODEX-FORK-AND-FOLLOWUPS.md) |
| 6 | Replace the enumerated flaky-file list in `CLAUDE.md`'s Testing section with the failure-*signature* rule plus the grep triage (all timeouts ⇒ load, any assertion ⇒ real) | **Medium** | Free, pure process, and it pays off on the next suite run. The enumerated list was already wrong by three files. | [FD-BUDGET §R5/R6](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 7 | Verify the three live Codex ownership scenarios — standalone terminal, VS Code, desktop app — against #463 | **Medium** | The only genuinely unverified part of #463; nothing has exercised them. Do this after #4. | [CODEX-FORK](Streamer-CODEX-FORK-AND-FOLLOWUPS.md) |
| 8 | Update the `verify-against-base-before-blaming-your-change` memory so failure-kind triage runs first, and note that retargeting a PR invalidates a base run | **Low** | Scopes the existing rule rather than repealing it. | [FD-BUDGET §R8/R9](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 9 | Regenerate `Streamer-OPEN-PRs.md` | **Low** | The snapshot is 2026-07-19, three weeks stale — most rows are merged or superseded. | [OPEN-PRs](Streamer-OPEN-PRs.md) |
| 10 | Record a decision **not** to build a boot-time rlimit self-check | **Low** (negative) | It cannot be made truthful cross-platform: `process.report` carries no `rlimit` on darwin, and `ulimit -n` reports the shell's limit rather than the process's. Write the decision down so it is not proposed again. | [FD-BUDGET §R4](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |

Items 1 and 2 are the only outright broken states here; everything else is debt.
Both are latent — #1 until a merge lands, #2 until the code runs on a machine where the supervisor actually applies the 256 default.
