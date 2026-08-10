# tb-streamer — merged action list from the PR-follow notes (as of 2026-08-10)

Every actionable item from the notes in this folder, in one list, ordered by priority (severity × urgency).
Derived from those notes — re-verify against them before acting; each carries its own snapshot date and is stale by default.

**Revised 2026-08-10** against `main` @ `f390d67`. Seven of the previous ten items had already shipped — the 2026-08-09 17:45 snapshot was written hours before the integration branch landed, so it listed as open a set of PRs that merged the same evening. Three remain.

| # | Action | Severity | Trigger / why now | Source |
|---|---|---|---|---|
| 1 | Replace the enumerated flaky-file list in `CLAUDE.md`'s Testing section with the failure-*signature* rule plus the grep triage (all timeouts ⇒ load, any assertion ⇒ real) | **Medium** | Free, pure process, and it pays off on the next suite run. Re-confirmed 2026-08-10: a full local run failed 33 tests across 9 files, **every one a 39–97 s timeout with zero assertion failures**, while CI was green. `CLAUDE.md`'s Testing section currently carries no triage guidance at all. | [FD-BUDGET §R5/R6](Streamer-FD-BUDGET-AND-SUITE-NOISE.md) |
| 2 | Verify the three live Codex ownership scenarios — standalone terminal, VS Code, desktop app — against the active-writer behaviour | **Medium** | The only genuinely unverified part of that work, now on `main` as [#476](https://github.com/RonenMars/threadbase-streamer/pull/476). This is the last gate before the behaviour reaches clients. | [CODEX-FORK](Streamer-CODEX-FORK-AND-FOLLOWUPS.md) |
| 3 | Delete the redundant refs `wip/lifecycle-starting-multi-agent-gate` and `integration/2026-08-08_14-22-prs-441-…-454` from origin; retire `integration/fresh-2026-08-09`, keeping `backup/int-streamer-2026-08-09` | **Low** | All fully subsumed by `main`. Confirmed still present on origin 2026-08-10. | [ORPHAN-FIX](Streamer-ORPHAN-LIFECYCLE-GATE-FIX.md), [OPEN-PRs](Streamer-OPEN-PRs.md) |

None of the three is a broken state — item 1 is process, item 2 is verification, item 3 is cleanup.

Open **product** work is no longer tracked here. It lives in GitHub issues ([#472](https://github.com/RonenMars/threadbase-streamer/issues/472), [#473](https://github.com/RonenMars/threadbase-streamer/issues/473), [#480](https://github.com/RonenMars/threadbase-streamer/issues/480)–[#483](https://github.com/RonenMars/threadbase-streamer/issues/483)) and, with the full audited inventory, in [`docs/2026-08-10-open-items-register.md`](../2026-08-10-open-items-register.md).

## Done since the last revision

Verified fixed on `main`, with the closing evidence:

- ~~Set fd limits in both service definitions~~ — **landed as [#474](https://github.com/RonenMars/threadbase-streamer/pull/474)**. `SoftResourceLimits`/`NumberOfFiles` in the `scripts/deploy.sh` plist generator, `LimitNOFILE=16384` in `scripts/deploy-linux.sh:266`. The live plist confirms `NumberOfFiles => 16384`.
- ~~Document the `fs.inotify.max_user_watches` sysctl~~ — **landed**, `docs/troubleshooting.md:1124`, alongside the reason the fd limit alone is not a fix on Linux.
- ~~Decide the integration branch's endgame~~ — **resolved**: all 19 PRs landed on `main`, `419746d` → `aac0b41`.
- ~~Review and land PRs #461 and #462~~ — **merged** as `6f691aa` (cwd-based project paths) and `70b8fe2` (drop dead `projects.message_count`).
- ~~Close #441~~ — **closed** by dependabot, which opened #475 in its place.
- ~~Update the `verify-against-base-before-blaming-your-change` memory~~ — **done**; failure-kind triage now runs first.
- ~~Record a decision **not** to build a boot-time rlimit self-check~~ — **done**, `docs/troubleshooting.md:1134`, with the darwin/`ulimit` reasoning that makes it untruthful cross-platform.
- ~~Cherry-pick `a681ac0`~~ — landed as `6c1ed95`; the `isLiveMultiAgent` lifecycle gate is verified present at **both** call sites on `main` (`src/session-store.ts:251` and `:261`), which was the specific risk this note flagged.
