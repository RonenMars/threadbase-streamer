# X-server REST envelope — parallel continuation prompt

Session name: `e2ee-Xserver-opus5-high`.

You are the orchestrator for the Streamer REST-envelope half of E2EE.
Continue the preserved X-server worktree; do not create a replacement and do not modify the Streamer root checkout.
Development and verification may run while the release-notes PR is open, but the release-notes track owns the Streamer PR slot first.

## Read first

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/AGENTS.md`
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/PLAN-FINISH-E2EE-2026-08-30.md`, Task 2
3. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/X-server/prompt.md`
4. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/X-server/PLAN-X-server.md`, especially §§3–6a
5. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/X-server/BRIEF-2b.md`
6. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/X-server/ADVERSARY-BRIEF-X-server.md`
7. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/W/REPORT-W1b.md`, Task 1E
8. `/Users/ronenmars/dev/ai-tools/tb-streamer/AGENTS.md`
9. `/Users/ronenmars/dev/ai-tools/tb-streamer/CLAUDE.md`
10. `~/dotfiles/docs/claude-code/merge-rebase-squash.md` before rebasing
11. The `operating-git-and-github` skill before rebase, push, PR, merge, or GitHub-writing actions

The approved X-server plan and BRIEF-2b are authoritative.
This prompt updates only the launch state and Streamer PR-slot sequencing.

## Verified starting point to re-check

- Worktree: `/Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/feat/e2ee-rest-envelope`
- Branch: `feat/e2ee-rest-envelope`
- Current worktree HEAD: `f95150cc03c33a165ba221f694206a5b11636001` (`v1.71.0`)
- The branch is behind current `origin/main`.
- Modified tracked paths:
  - `src/api/app.ts`
  - `src/e2ee/context.ts`
- Untracked task paths:
  - `__tests__/e2ee-rest-envelope.test.ts`
  - `__tests__/e2ee-rest-window.test.ts`
  - `src/api/middleware/e2ee-envelope.middleware.ts`
  - `src/e2ee/rest-window.ts`
- W1b exact downstream tag: `v1.72.0`
- W1b release commit: `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`

Before changing anything:

```bash
cd /Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/feat/e2ee-rest-envelope
/opt/homebrew/bin/git status --porcelain=v2 --branch
/opt/homebrew/bin/git diff --stat
/opt/homebrew/bin/git diff --cached --stat
/opt/homebrew/bin/git ls-files --others --exclude-standard
/opt/homebrew/bin/git ls-remote --tags origin refs/tags/v1.72.0
```

Fingerprint all six task paths with SHA-256.
Compare them with the recovery records in `tracks/STATUS.md` and `tracks/X-server/PLAN-X-server.md`.
Because four paths are untracked, `git diff --quiet` alone cannot prove that no mutation is stranded.
Stop if another writer is active, a task path disappeared, or the recovered bytes cannot be classified.

## Work sequence

1. Finish the interrupted header remedy on the recovered pre-rebase bytes.
2. Read framing headers through `c.req.header("content-length")` and `c.req.header("transfer-encoding")`.
3. Add the prototype-pollution regression and see its bracket-read mutation red.
4. Restore `Object.prototype` in `finally` and assert cleanup.
5. Verify tag `v1.72.0` contains the pure `authenticateContext` seam with exactly:
   - resolved `E2eeContext` input;
   - success `{ ok: true, principal }`;
   - failure reasons `device-revoked`, `credential-mismatch`, and `no-device-store`;
   - no destroy, logging, status, or body policy inside the helper.
6. Rebase the preserved branch onto exact tag `v1.72.0`.
7. Resolve the known `src/api/app.ts` overlap by retaining exactly one `e2eeContext?: E2eeContext` declaration.
8. Do not modify `src/e2ee/record.ts`.
9. Implement BRIEF-2b's authentication, refusal, capability, and response-sealing seam.
10. Add the complete real-chain test matrix from the approved plan.
11. Run targeted tests, TypeScript, pinned Biome, and the complete 18-row mutation campaign.
12. Run the real loopback `createHonoApp(deps)` positive and negative controls.
13. Run the full Streamer suite while holding `/tmp/tb-streamer-suite.lock`.
14. Freeze the artefact by SHA-256 and run the isolated 29-row REST adversary in a fresh audit worktree.
15. Resolve every finding through the same seen-red and restoration rules.
16. Prepare the final staged diff and exact commit message for owner read and explicit user approval.

## Streamer PR-slot gate

The release-notes track owns the first Streamer PR slot.
You may develop and verify in parallel, but do not open the X-server PR while the release-notes PR is open.

Before the final delivery cycle:

```bash
gh pr list --repo RonenMars/threadbase-streamer --state open --json number,title,headRefName,url
```

Wait until the release-notes PR is `MERGED`, its semantic-release workflow is complete, and the open Streamer PR list is empty.
Then fetch current `origin/main`, rebase onto that exact commit, and rerun the entire 18-row campaign, focused tests, pinned Biome, TypeScript, real-chain control, and lock-protected full suite.
If the rebase changes content, the final approval package must show those resulting bytes; an earlier approval does not authorize replacing them.

After explicit commit approval, commit and push only the feature branch.
Open exactly one X-server PR after rechecking that the Streamer PR slot remains empty.
Watch every required check.
On green, show current mergeability and exact squash title, then stop for fresh explicit squash-merge approval.
After approval, rebase if required, reverify changed bytes, push with `--force-with-lease` only if necessary, squash-merge, and verify the semantic-release tag.

## Non-negotiable protocol rules

- Unknown or expired `ctxId` is rejected before reading or allocating for the body.
- Body and `X-TB-Env` lengths are bounded before decode or decrypt.
- A request carrying both a body envelope and `X-TB-Env` is rejected.
- Paths and query remain plaintext and are bound through the frozen target hash.
- REST uses the 1024-bit sliding window; WebSocket contexts are rejected on REST.
- Every refusal before successful `unsealRequest` is plaintext.
- Every outcome after successful `unsealRequest` is sealed.
- `authenticateContext` remains pure.
- `device-revoked` is sealed before destroying the context.
- `credential-mismatch` is a sealed 401 and leaves the context intact.
- `no-device-store` is sealed 503 `STORE_UNAVAILABLE` and leaves the context intact.
- Capability checks still run for a principal resolved from a context.
- One accepted request counter receives at most one sealed response.
- No old unpinned-client behavior changes.
- No body, key, context state, credential, or plaintext is logged.

## Approval boundaries

Do not commit without the complete staged-diff and exact-message approval.
Do not open a Streamer PR until the release-notes track releases the slot.
Do not merge without a fresh explicit user approval after green CI.

## Report

Update `tracks/X-server/PLAN-X-server.md` and `tracks/STATUS.md` at each material gate.
Report the recovered SHA manifest, rebase result, seen-red assertions, all verification outputs and exit codes, adversary disposition for every row, final PR and tag SHAs, and any contradiction.

