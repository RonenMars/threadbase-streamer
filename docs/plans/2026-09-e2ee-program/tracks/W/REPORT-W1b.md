# W1b recovery baseline

Task 0 established recovery ownership and an immutable baseline for `/Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/feat/e2ee-ws-sealing`.

- Recovery coordinator: Codex `/root`.
- Reserved writer: single Codex implementer task `/root/task1_w1b_recovery`, before any product edit.
- The old Claude session `e2ee-W-opus5-high` is an evidence source, not a current writer.
- Baseline tag: `v1.71.0`; worktree HEAD: `f95150cc03c33a165ba221f694206a5b11636001`.
- Git state: 13 changed paths (12 staged paths plus the unstaged-only `src/api/routes/e2ee.routes.ts`), no untracked paths; staged implementation is distinct from unstaged recovery edits. The exact porcelain inventory, diff stats, lock/session checks, and full SHA-256 path/hash manifest are in the [Task 0 report](../../../tb-streamer/.worktrees/feat/e2ee-ws-sealing/.superpowers/sdd/PLAN-FINISH-E2EE-2026-08-30/task-0-report.md).
- Recovery line: W1b's nine source fixes landed before the weekly-limit stop, but its tests and verification did not.
- Final validation reproduced the same porcelain state and SHA-256 manifest; no product source, Git index, HEAD, branch ref, or worktree file was modified by Task 0.

## Task 1B campaign and verification — 2026-08-30

The recovered W1b artefact passed the complete 36-row falsifiability campaign: 36 named mutations produced the expected RED assertion, zero mutation produced GREEN or an import/transform failure, and every mutated file restored to its pristine SHA-256.

The permanent focused matrix passed 119 tests across four files.
The named production-boundary control run passed 16 tests across four files, covering the real loopback ciphertext/plaintext controls, ticket race, revocation isolation, strict counters, per-socket broadcast sealing, 64 KiB client-frame enforcement, first-valid-frame deadline, and producer-to-hub paths for terminal replay and user messages.
TypeScript exited 0.
Pinned Biome 2.5.10 checked 478 configured files with no fixes after using explicit configured roots to avoid the linked worktree's intentionally ignored container path.

The first lock-protected full suite had one failure in an unchanged base test because two automatic HTTP `Date` headers crossed a one-second boundary.
That exact test passed on its one isolated rerun.
The policy-permitted single full-suite rerun then passed 257 files and 2641 tests with five skipped.

The exact campaign ledger, scrubbed assertions, commands, totals, full-suite failure/rerun evidence, and final 13-path SHA-256 manifest are in `.superpowers/sdd/PLAN-FINISH-E2EE-2026-08-30/task-1b-report.md` in the W1b worktree.
No commit, stash, rebase, push, PR, merge, deployment, or restart occurred.

## Task 1C fix round 4 — 2026-08-31

The fix3 independent review found two Important ownership defects.
The concrete context exposed a caller-accessible runtime invalidation method, and bulk deletion of revoked device rows did not cut those devices' live registry and socket ownership.

Both permanent production-path tests were seen RED on the pre-fix source and GREEN after the minimal corrections.
Invalidation is now a module-private lexical capability held in a `WeakMap`, not a member of the returned context object.
Bulk deletion snapshots every revoked device ID before deletion and runs the existing registry-plus-hub teardown for each.
The file-scoped integration fixture now removes revoked rows between tests so the bulk response remains independently pinned to one row rather than inheriting earlier audit rows.

The definitive campaign passed 45/45 named mutations RED with byte-for-byte SHA-256 restoration.
M44 independently re-exposed runtime invalidation.
M45 independently removed bulk teardown.

Fresh local evidence on the final bytes:

- focused W1b matrix: 130/130;
- named production-path controls: 18/18;
- TypeScript: exit 0;
- no-NUL check: exit 0;
- pinned Biome 2.5.10: 478 files, no fixes;
- `git diff --check HEAD`: exit 0;
- exact boundary: 13 product paths at base `f95150cc03c33a165ba221f694206a5b11636001`.

The exact commands, scrubbed campaign output, and current SHA-256 manifest are in `.superpowers/sdd/PLAN-FINISH-E2EE-2026-08-30/task-1c-fix4-report.md`.
Fresh detached fix4 adversary and final-review seats are running on that manifest.
The final lock-protected full suite remains pending a credible host-load window.
No commit, stash, rebase, push, PR, merge, deployment, or restart occurred.

## Task 1C fix round 4 isolated acceptance — 2026-08-31

The fresh detached adversary and final-review seats completed against the exact frozen 13-path manifest.

- Adversary verdict: `could not break it`.
- Final review assessment: `Approved`.
- Review findings: no Critical, Important, or Minor findings.
- Both seats independently matched the detached base, exact 13-path scope, every staged SHA-256 digest, TypeScript, no-NUL, pinned Biome 2.5.10 over 478 files, and `git diff --check HEAD`.
- The adversary independently passed 84 core crypto/context tests, 48 Noise/pairing/protocol tests, 15 capability tests, 13 hub-routing/no-bypass tests, 33 device repository/identity tests, and 8 composed production-object probes.
- The adversary's managed sandbox could not complete `e2ee-ws-sealing.test.ts` or `e2ee-open-route.test.ts` because loopback cleanup reached `server.close` and timed out; no product assertion failed before those environment failures, and those attempts are not counted as passes.
- The controller's frozen-byte evidence remains 45/45 named mutations RED/restored, 130/130 focused tests, and 18/18 named production-path controls.

The local full-suite gate was deferred because sustained host saturation prevented a trustworthy run.

## Task 1D commit, PR, and GitHub CI — 2026-08-31

The user approved the exact 13-path staged diff and commit message `feat(e2ee): seal WebSocket transport per device context`.
Commit `6d71e7743b712530d9d621a2756e93ba10eaafe6` was created after the commit hook passed staged-file Biome and 48 tests with one skipped.
The clean branch `feat/e2ee-ws-sealing` was pushed without rewriting history, and its remote SHA matched the local commit.
Streamer PR #748 was opened against `main`.

GitHub CI completed with 11/11 successful checks:

- full test suite on Node 22;
- full test suite on Node 24;
- macOS smoke;
- Windows smoke;
- build, lint, setup, cache, gate, link check, and Snyk.

No retry was needed.
PR #748 is open and mergeable.
The remaining W1b gates are separate user approval to merge, refresh/rebase against current `origin/main`, squash merge on green, and verification of the semantic-release tag.
X-server remains frozen until that published tag is independently verified.

## PR #748 F1 follow-up — 2026-08-31

Independent review finding F1 showed that path-only ticket detection spent a valid ticket on a `/ws` request that could not upgrade, promoting its context to the 24 h lifetime without attaching a socket.

Two real-path tests were added before the fix.
On the unfixed middleware, both failed at the intended assertion:

- `leaves the ticket and context intact when GET /ws does not request an upgrade`: `AssertionError: expected +0 to be 1`;
- `leaves the ticket and context intact when POST /ws cannot reach the upgrade route`: `AssertionError: expected +0 to be 1`.

The middleware now mirrors `@hono/node-ws`'s upgrade predicate exactly: `GET`, `/ws`, and `Upgrade: websocket`.
The tests also prove that the preserved ticket can still complete a real upgrade and receive the two initial sealed frames.
NONCE-DESIGN §14 records the rule and mutation.

Local verification:

- focused W1b file: 63/63;
- TypeScript: exit 0;
- no-NUL and diff checks: exit 0;
- pinned Biome 2.5.10: 478 files, no fixes;
- full suite: 256 files and 2653 tests passed, with one unchanged `security-hardening.test.ts` case failing because random port 65438 was already in use;
- the policy-permitted isolated rerun of that file passed 16/16.

The literal `npm run lint` command processed zero Biome files because the linked worktree is ignored by the common repository.
The established explicit-root invocation checked all 478 configured files successfully.
The review brief expected the non-upgrade requests to fall through to 404, but after the ticket branch is correctly skipped they enter ordinary authentication and return 401; the required ticket, context, and hub state invariants hold.

The user approved commit message `fix(e2ee): spend a ws ticket only on a real upgrade`.
Commit `4edfa6c9baf3d4f21aac0c8d89a3699f3e8f089e` was pushed to the existing PR #748 branch.
The refreshed GitHub run passed all 11 checks without retry, including Node 22/24 full suites and macOS/Windows smoke.
PR #748 remains open, mergeable, and unmerged.

## Task 1E merge and release verification — 2026-08-31

The user approved the final refresh/rebase and squash merge.
The rebase onto current `origin/main` was a content-preserving no-op: HEAD, tree, patch ID, and base `f95150cc03c33a165ba221f694206a5b11636001` remained unchanged.
PR #748 squash-merged at `fd89defcd2460b77acad6ee8c0cc068bffb66efd`.
GitHub reports the PR as `MERGED`, and the remote feature branch is deleted.
The linked worktree is preserved because it contains ignored audit evidence.

The release workflow `33369508885` completed successfully and published:

- tag `v1.72.0`;
- release commit `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`, whose parent is the W1b merge;
- the npm package;
- four platform tarballs;
- `manifest.json`;
- the Homebrew formula update.

Independent tag verification established:

- the remote tag resolves to `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`;
- `fd89defcd2460b77acad6ee8c0cc068bffb66efd` is an ancestor of the tag;
- all 13 W1b paths exist in the tagged tree;
- the exact `GET` plus `/ws` plus `Upgrade: websocket` ticket predicate is present;
- the frozen pure-verdict `authenticateContext` seam is present;
- a deliberately missing path failed the same tag-read command, proving the path check can fail.

Post-merge CI workflow `33369508896` completed successfully at the W1b merge.
Gate, cache, setup, lint, build, Node 22 tests, Node 24 tests, macOS smoke, and Windows smoke all passed without retry.

### Direct release-notes control and contradiction

The required direct `generateNotes` control was run with `@semantic-release/release-notes-generator` 14.1.1, preset `conventionalcommits`, exact preset dependency `conventional-changelog-conventionalcommits` 10.3.0, and real merge `fd89defc` between `v1.71.0` and `v1.72.0`.
The plugin completed, but generated only:

```text
## [1.72.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.71.0...v1.72.0) (2026-08-31)
```

The assertion for `seal WebSocket transport per device context` failed.
The published GitHub release body and tagged `CHANGELOG.md` have the same header-only content.

A version-only causal control with preset 9.3.1 produced the expected `Features` section and W1b commit entry.
The repository-pinned 10.3.0 preset exposes function-based templates, while `conventional-changelog-writer` 8.4.0 used by the release-notes generator consumes legacy template fields, so it silently renders the release heading without commit groups.
This contradicts the expectation that the pinned 10.3.0 control would include the feature.
It is a release-notes metadata defect, not a missing W1b code or binary artefact, and changing release infrastructure is outside PR #748's minimum product scope.

W1b's transport artefact is released and downstream code tracks may consume exact tag `v1.72.0`.
The release-notes compatibility defect remains a separate streamer follow-up.

## Release-notes follow-up prepared — 2026-08-31

A fresh worktree, branch `fix/release-notes-rendering`, was created from current `origin/main` at `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`.
The existing historical `fix/release-notes-preset` worktree was preserved and not reused.

A real-plugin regression test was written before the dependency change.
Against preset 10.3.0 it failed:

```text
renders a release-worthy commit in the generated notes
AssertionError: expected '## [1.72.0](https://github.com/RonenM…' to contain '### Features'
```

The minimal fix pins `conventional-changelog-conventionalcommits` to 9.3.1, the last tested preset that supplies the legacy templates consumed by `conventional-changelog-writer` 8.4.0.
No release workflow or product code changes.

Fresh verification on the proposed bytes:

- release-notes plus release-precheck tests: 6/6 passed;
- TypeScript: exit 0;
- pinned Biome 2.5.10: 473 configured files, no fixes;
- direct `generateNotes` with real W1b commit `fd89defc`: version heading, `Features` section, and W1b entry present;
- lock-protected full suite: 258 files passed, one skipped; 2649 tests passed, 11 skipped; exit 0 in 678.34 seconds.

The three-file follow-up is staged and waiting at the required commit-approval boundary.

The user approved exact commit message `fix(release): render conventional commit entries in notes`.
Commit `87354b18722922a9e9268e817abf00b6501487fb` was created after the commit hook passed staged-file Biome and 48 tests with one skipped.
The branch was pushed as `origin/fix/release-notes-rendering`, and the local and remote SHAs match.

No PR was opened because unrelated Streamer PR #749 is already open, behind `main`, and red on lint.
The program's one-Streamer-PR-at-a-time rule forbids opening a competing PR.
PR #749's files do not overlap this release-notes fix, but changing, closing, or merging it is outside W1b's scope and authority.
The release-notes branch is safely remote and ready for PR creation after #749 leaves the open queue.

## Release-notes correction merged and verified — 2026-08-31

PR #750 opened against `main` with title `fix(release): render conventional commit entries in notes`.
Pre-merge verification: worktree clean, local/remote HEAD `87354b18722922a9e9268e817abf00b6501487fb`, origin/main unchanged at base `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`, exact three-path scope.
Fresh verification: focused tests 6/6 (including the real-plugin generateNotes control against W1b commit `fd89defc`), TypeScript exit 0, pinned Biome 2.5.10 473 files no fixes, lock-protected full suite 258 files (1 skipped) / 2655 tests passed (5 skipped) exit 0.
All 11 required GitHub checks passed with no retries; mergeStateStatus CLEAN/MERGEABLE.
User approved the squash-merge; PR #750 merged at `c2774364fff6ad7217353c05cd0eaf75a2064826`; GitHub reports MERGED; branch auto-deleted.
Semantic-release published tag `v1.72.1` at `4c582e48cabb1a2508803d517af50951cacbd19a`; the merge commit is a confirmed ancestor (independently verified by the coordinator via `git merge-base --is-ancestor`).
The tagged CHANGELOG.md and the published GitHub release both render a real `### Bug Fixes` section with the `fix(release)` entry, not a header-only body (independently confirmed by the coordinator via `gh release view v1.72.1`).
A direct `generateNotes` control against the real release commit reproduced this output exactly.
Post-merge CI workflow `33408075450` completed successfully on all nine jobs.
The coordinator independently confirmed the Streamer open-PR queue is empty (`gh pr list --state open` → `[]`).
This closes the release-notes-compatibility defect; W1b's release-notes gap (Task 1 Step 11) is resolved.
