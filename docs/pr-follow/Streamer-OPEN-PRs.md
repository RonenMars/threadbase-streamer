# tb-streamer — Open PRs

Snapshot: 2026-08-09 17:45. Regenerate with `gh pr list --state open --json number,title,headRefName,baseRefName,mergeStateStatus` in `tb-streamer`. Treat as stale by default — re-scan before acting.

The **On int** column is coverage of `integration/prs-223-441-…-456` at `6c1ed95`, measured by content equivalence rather than SHA ancestry — several of these were rebased, so `git branch --contains` reports them as absent when their content is present.

| PR | Title | Base | State | On int |
|---|---|---|---|---|
| [#468](https://github.com/RonenMars/threadbase-streamer/pull/468) | docs(pr-follow): add streamer PR-follow working notes [skip-ci] | integration | CLEAN | — (this PR) |
| [#464](https://github.com/RonenMars/threadbase-streamer/pull/464) | fix(deploy): bound Windows version check for forced deploys | main | UNKNOWN | yes |
| [#462](https://github.com/RonenMars/threadbase-streamer/pull/462) | refactor(db): drop the dead projects.message_count column | main | UNKNOWN | yes (equiv) |
| [#461](https://github.com/RonenMars/threadbase-streamer/pull/461) | fix(projects): resolve project paths from the recorded cwd, not the dir name | main | UNKNOWN | yes (equiv) |
| [#456](https://github.com/RonenMars/threadbase-streamer/pull/456) | feat(sessions): report a pre-attach session as lifecycle "starting" | main | UNKNOWN | yes |
| [#455](https://github.com/RonenMars/threadbase-streamer/pull/455) | docs(troubleshooting): document Windows dev-environment test quirks [skip-ci] | main | UNKNOWN | yes |
| [#454](https://github.com/RonenMars/threadbase-streamer/pull/454) | chore(deps-dev): bump @types/node to 26.1.2 | main | CLEAN | yes |
| [#453](https://github.com/RonenMars/threadbase-streamer/pull/453) | chore(deps-dev): bump @types/semver to 7.8.0 | main | CLEAN | yes |
| [#452](https://github.com/RonenMars/threadbase-streamer/pull/452) | chore(deps): bump tar to 7.5.22 | main | CLEAN | yes |
| [#451](https://github.com/RonenMars/threadbase-streamer/pull/451) | perf(server): keep detail fetches off the full-rescan critical path | main | UNKNOWN | yes |
| [#450](https://github.com/RonenMars/threadbase-streamer/pull/450) | fix(sessions): detach external tails promptly on JSONL delete | main | UNKNOWN | yes |
| [#449](https://github.com/RonenMars/threadbase-streamer/pull/449) | fix(server): do not re-arm scannerStale after a drained path set | main | UNKNOWN | yes |
| [#448](https://github.com/RonenMars/threadbase-streamer/pull/448) | fix(sessions): set lifecycle for historical and multi-agent sessions | main | BEHIND | yes |
| [#447](https://github.com/RonenMars/threadbase-streamer/pull/447) | fix(codex): hold input until Ready and quiesce before submit | main | **DIRTY** | yes |
| [#446](https://github.com/RonenMars/threadbase-streamer/pull/446) | docs(agents): add cloud dev environment setup + run notes | main | UNKNOWN | yes |
| [#444](https://github.com/RonenMars/threadbase-streamer/pull/444) | feat(docker): harden image — lean stages, non-root, healthchecks | main | UNKNOWN | yes |
| [#442](https://github.com/RonenMars/threadbase-streamer/pull/442) | fix(sessions): single-flight process discovery on list | main | UNKNOWN | yes |
| [#441](https://github.com/RonenMars/threadbase-streamer/pull/441) | chore(deps): bump the npm_and_yarn group across 1 directory | main | CLEAN | **no — see below** |
| [#223](https://github.com/RonenMars/threadbase-streamer/pull/223) | chore(deps-dev): bump typescript from 6.0.3 to 7.0.2 | main | **BLOCKED** | no — excluded |

19 open. `UNKNOWN` = GitHub has not recomputed mergeability; re-fetch per-PR before acting.

## Two deliberate exclusions

**#441 must not be merged into the integration branch — it is a downgrade.** Its `nanoid`/`postcss` bumps are already present, and on the three packages where it still differs it moves them *backwards*: `@types/node` 26.1.2 → 26.1.1, `@types/semver` 7.8.0 → 7.7.1, `tar` 7.5.22 → 7.5.21. The individual bumps #452/#453/#454 merged after it and supersede it. Close it or let dependabot re-raise it.

**#223 (TypeScript 7) is excluded by standing decision** — it breaks `rollup-plugin-dts`, and was reverted from the integration branch once already. The branch name still carries `prs-223-…` from that attempt; `package.json` on the branch pins `^6.0.3`, same as `main`.

## Merged this wave, no longer open

#463 (Codex active-writer resume) and #465 (claude open-file measurement) were **auto-merged by GitHub** when the integration branch — their base — was advanced to contain their commits. They are merged into the integration branch, *not* into `main`.

## Note on #447

`DIRTY` against `main`, but its content is on the integration branch: its test file is byte-identical there and `quiesce` appears in both. `src/codex-pty-runner.ts` diverges only because #463 edited it afterwards. Do not treat the conflict as "the fix is missing".
