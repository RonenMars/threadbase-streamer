# E2EE Program Recovery and Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation/review separation and `superpowers:verification-before-completion` before every completion claim. Use `operating-git-and-github` before any rebase, merge, push, PR, issue, or comment action. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish sealed WebSocket and REST transport between Threadbase streamer and mobile, prove it on real devices, and prepare the negotiated rollout without crossing either user-only rollout gate.

**Architecture:** Recover the two stranded streamer worktrees without losing their uncommitted state, finish W1b first, then rebase and finish X-server on W1b's release tag. Start the mobile WebSocket half after W1b releases, add the REST half after X-server releases, then run D2 hardware evidence and the rollout track. Each crypto change passes permanent tests, a falsifiability-mutation campaign, the full suite, and an isolated adversary before it can ship.

**Tech Stack:** TypeScript, Node v24.15.0, Hono 4.13.3, ws 8.21.3, Vitest 4.1.11, Biome 2.5.10, React Native 0.86.3, Expo 57.0.18, Jest 29.7.0, `@stablelib/*` 2.0.1, Maestro 2.8.0, Xcode 26.6.

**Specs:** `CLAUDE.md`; `tracks/paral calel-execution-plan.md`; `tracks/W/PLAN-W1b.md`; `tracks/X-server/PLAN-X-server.md`; `tracks/X-server/BRIEF-2b.md`; `tracks/X-client/prompt.md`; `tracks/D/PLAN-D.md` §14; `tracks/R/prompt.md`; streamer `v1.71.0:specs/end-to-end-encryption/NONCE-DESIGN.md`.

## Global constraints

- The neutral `tb-e2ee-program` directory owns plans, status, decisions, and scrubbed evidence; it never owns product code.
- Streamer root and mobile root checkouts are read-only. Streamer changes stay in `tb-streamer/.worktrees/...`; mobile changes stay in `../tb-mobile-worktrees/...`.
- Existing task worktrees contain unique uncommitted work. Before execution, ask the user whether to continue in each existing worktree or create a recovery worktree; recommend continuing in place. Do not edit until the user answers.
- Exactly one writer may occupy a worktree. A reviewer and an adversary use separate worktrees and never edit the implementer's tree.
- Never stash, reset, clean, discard, reformat, or overwrite the current W1b or X-server worktrees. Untracked files are part of the recovery state.
- Use `/opt/homebrew/bin/git`, `/opt/homebrew/bin/gh`, and `$HOME/.nvm/versions/node/v24.15.0/bin/node`. Run streamer lint with `npx --yes @biomejs/biome@2.5.10`, not the stale symlinked Biome.
- One PR at a time per repository. Rebase onto the latest permitted release/base, rerun the complete mutation campaign after every rebase, and squash-merge only on required green CI.
- Before every commit, show the complete staged diff, explain it, show the exact conventional-commit message, and wait for explicit user approval. Re-request approval if a rebase changes the staged bytes.
- Nonces are `direction(4) || counter(8)` with a `bigint` counter, never random. WebSocket counters are strict with no window; REST uses the 1024-bit RFC-6479 window.
- No in-place rekey. A new key means a new context. A reconnect opens a new WebSocket context; REST rollover opens a new context and drains the old one for 10 seconds.
- `authenticateContext` remains a pure three-arm verdict: success, `device-revoked`, `credential-mismatch`, or `no-device-store`; it never destroys, logs, or throws. The principal's `deviceId` comes from the context.
- Prefer Hono `c.req.header()` for Hono requests. Use `own()` only where a raw Node or attacker-shaped object must be read. Every pollution test restores `Object.prototype` in `finally` and proves cleanup.
- Crypto verification requires a real production-path object, positive control, negative control, one red mutation per safeguard, SHA-256 restoration against pristine bytes, and an isolated adversary report with every row answered.
- A private key, ticket, device token, API key, or plaintext frame on a declared sealed channel is an immediate stop-work event. Evidence records lengths or hashes, never secret bytes.
- `--no-e2ee` is a `serve` flag only. The stage-2 default flip is a separate one-line PR and never merges without the user's explicit go. Stage 3 is out of scope.
- Export-compliance approval is external to this program and gates any stage-2 rollout to testers.

## Current recovery baseline

| Track | Recoverable state | Missing gate |
|---|---|---|
| W1b | Released in PR #748; exact downstream artefact is `v1.72.0` at `d7a27ab5` | Release-notes feature entry is absent because the pinned 10.3.0 preset is incompatible with writer 8.4.0 |
| X-server | `feat/e2ee-rest-envelope` at `v1.71.0`; slice 1 and 2a uncommitted; header remedy stopped between raw-header `own()` and the final Hono-accessor ruling | Finish header test/remedy; wait for W1b tag; rebase; slice 2b; 18-row campaign; adversary; release |
| D1 | Accepted in `tracks/D/D1-REPORT.md` | None |
| X-client | Not started; XC1 unblocked on exact W1b tag `v1.72.0` | X-server tag for XC2 |
| D2 | Runbook drafted in `tracks/D/PLAN-D.md` §14 | XC2 merged and exact streamer tag pinned |
| R | Brief written | R1: W1b + X-server tags; R2/R3: XC2 merged + D2 accepted |

## Dependency order

```text
W1b release ───────┬──> X-server release ──┬──> XC2 REST ──> D2 ──> R2/R3
                   │                       └──> R1
                   └──> XC1 WebSocket ─────────> XC2 REST
```

W1b is the only initial critical-path writer. After its release, X-server and XC1 may proceed in parallel because they are in different repositories. R1 starts after X-server releases and can run in parallel with mobile work, subject to the one-streamer-PR rule.

---

### Task 0: Establish recovery ownership and immutable baselines

**Files:**
- Inspect: `tb-streamer/.worktrees/feat/e2ee-ws-sealing/**`
- Inspect: `tb-streamer/.worktrees/feat/e2ee-rest-envelope/**`
- Modify after ownership is confirmed: `tracks/STATUS.md`
- Create after ownership is confirmed: `tracks/W/REPORT-W1b.md`

**Interfaces:**
- Consumes: the two Claude JSONL tails, the current index/worktree state, `v1.71.0`.
- Produces: one named writer per worktree, a SHA-256 manifest, and a corrected recovery line in `STATUS.md`.

- [x] **Step 1: Ask the worktree question and stop for the answer**

  Ask whether to continue in the existing W1b and X-server worktrees or create recovery worktrees. Recommend the existing trees because their staged, unstaged, and untracked states are the primary artefacts.

- [x] **Step 2: Prove no other writer is active**

  Check the Claude sessions, process table without printing argv that may carry secrets, the suite lock, and Git lock files. Record only session/process state, never command arguments.

- [x] **Step 3: Inventory Git state without changing it**

  ```bash
  /opt/homebrew/bin/git worktree list --porcelain
  /opt/homebrew/bin/git status --porcelain=v2 --branch
  /opt/homebrew/bin/git diff --stat
  /opt/homebrew/bin/git diff --cached --stat
  /opt/homebrew/bin/git ls-files --others --exclude-standard
  ```

  Run the last four commands separately in each task worktree. Preserve the distinction between staged implementation, unstaged recovery fixes, and untracked slice files.

- [x] **Step 4: Fingerprint every changed and untracked file**

  Use `shasum -a 256` over the exact paths reported by Git. Store only path/hash pairs in the appropriate track report. Do not copy raw diffs into `tracks/` because they may contain fixtures or evidence that requires scrubbing.

- [x] **Step 5: Correct the status record**

  Record that W1b's nine source fixes landed before the weekly-limit stop but its tests and verification did not, and that X-server's header remedy is mid-transition. Append the reason to the decisions log; do not rewrite older evidence.

- [x] **Step 6: Validate the baseline**

  Re-run `git status --porcelain=v2` and the SHA manifest without changing files. A mismatch means another writer exists or the tree changed; stop before implementation.

---

### Task 1: Complete and release W1b WebSocket sealing

**Files:**
- Modify/review: `src/ws-hub.ts`
- Modify/review: `src/e2ee/context.ts`
- Modify/review: `src/api/middleware/auth.middleware.ts`
- Modify/review: `src/api/routes/e2ee.routes.ts`
- Modify/review: `src/api/routes/ws.routes.ts`
- Review staged integration: `src/api/app.ts`, `src/api/routes/devices.routes.ts`, `src/api/types/api-deps.ts`, `src/server-wiring.ts`, `src/server.ts`
- Modify/review: `specs/end-to-end-encryption/NONCE-DESIGN.md`
- Test: `__tests__/e2ee-ws-sealing.test.ts`
- Test: `__tests__/ws-capabilities.test.ts`
- Test as needed: `__tests__/e2ee-open-route.test.ts`, `__tests__/e2ee-context.test.ts`
- Evidence: `tracks/W/REPORT-W1b.md`

**Interfaces:**
- Consumes: record/context/open implementation from `v1.71.0` and the frozen `authenticateContext` seam.
- Produces: per-socket sealed WebSockets, header-only single-use tickets, W1b's release tag, and the exact seam X-server consumes.

- [x] **Step 1: Classify the nine stranded fixes against the source diff**

  Confirm all nine are present and contain no unrelated edit:

  1. `own(options, "firstFrameMs")` protects the 10-second deadline.
  2. The device-row lookup, `Object.hasOwn`, and `revoked_at` read are all inside the helper's `try`.
  3. `principal.deviceId` is `context.deviceId`; the row supplies only liveness and capabilities.
  4. The stale `contextIsDead` comment is removed.
  5. Record-error detail distinguishes misaddressed and unknown frames in logs.
  6. The send path cannot report a peer sequence violation for a server seal failure.
  7. A capability-refused consumed ticket destroys its orphaned context.
  8. A falsy `ws.raw` destroys its attached context.
  9. Raw Node `content-length` on `/api/e2ee/open` is read with `own()`.

- [x] **Step 2: Finish permanent tests before touching source again**

  Complete tests for the eight behavioral fixes. Retain the five visible prototype/header tests and add explicit cases for the hostile `revoked_at` accessor, row/context ID disagreement, log distinction, send-code coercion, capability-refusal cleanup, and falsy-raw cleanup. The documentation-only fix is checked by review rather than a synthetic mutation.

- [x] **Step 3: Run the focused W1b tests**

  ```bash
  npx vitest run __tests__/e2ee-ws-sealing.test.ts __tests__/ws-capabilities.test.ts __tests__/e2ee-open-route.test.ts __tests__/e2ee-context.test.ts
  ```

  Expected: every file runs and passes. A file that fails to import is `BROKEN — did not run`, not a pass.

- [x] **Step 4: Run the complete 33-row mutation ledger**

  Re-run the historical 25 W1b mutations plus eight behavioral post-adversary mutations. For every row: copy pristine bytes, record the SHA, apply one mutation inside `try`, run the named focused test, capture the verbatim red assertion, restore in `finally`, and confirm the restored SHA. Halt on a moved target or a module that fails to import.

- [x] **Step 5: Re-run real-path controls**

  Use real `WSHub`, real loopback `ws` sockets, and real record states. The positive control unseals terminal output, replay, conversation events, and user messages; the negative control proves the same tap sees plaintext when sealing is disabled. Confirm ticket single-use, revocation isolation, strict counters, per-socket broadcast sealing, 64 KiB client-frame enforcement, and the first-valid-frame deadline.

- [x] **Step 6: Run lint and the lock-protected full streamer suite**

  ```bash
  npx --yes @biomejs/biome@2.5.10 check .
  ```

  Acquire `/tmp/tb-streamer-suite.lock` with `mkdir`, install an `rmdir` trap, run `npm test`, and record the exact exit code and test totals in `REPORT-W1b.md`. Do not run a second streamer full suite concurrently.

- [x] **Step 7: Refreeze and run the targeted isolated adversary**

  Produce a SHA-256 manifest of the frozen staged tree. In a separate audit worktree with no implementer context, rerun only the affected adversary rows: prototype pollution, hostile device lookup, device-ID construction, log distinction, send-code mapping, both orphan-context paths, and raw-header pollution. Every row reports `rejected`, `succeeded`, or `not attempted` with evidence and a negative control.

- [x] **Step 8: Prepare the commit approval package**

  Stage only the thirteen W1b implementation/document/test files, including the newly hardened `e2ee.routes.ts`, show `git diff --staged --stat`, then show the complete staged diff. Explain why every file changed and present the exact message `feat(e2ee): seal WebSocket transport per device context`. Stop for explicit user approval.

- [x] **Step 9: Commit, rebase safely, and reverify**

  After approval, commit. Before rebasing, read `~/dotfiles/docs/claude-code/merge-rebase-squash.md` and invoke `operating-git-and-github`. Rebase onto current `origin/main`; rerun all 33 mutations and focused tests. If the rebase changes content, show the new staged diff and request renewed approval before replacing the approved commit.

- [x] **Step 10: Open, validate, and merge the W1b PR**

  Push the feature branch, open one PR, wait for the real required suite, and verify the PR is up to date. On authorized green merge, squash with the releasing `feat(e2ee):` title and delete only the remote branch after GitHub reports `MERGED`.

- [x] **Step 11: Verify W1b's release artefact**

  Wait for semantic-release, use `git ls-remote --tags origin` to identify the new tag after `v1.71.0`, and verify the tag contains the pure `authenticateContext` seam and W1b files. Run `generateNotes` directly with the pinned preset as the release-pipeline control. Record the exact tag and commit in `STATUS.md`; downstream tracks consume the tag, never the merge commit.

  **2026-08-31 result:** the code and binary artefact checks passed at `v1.72.0`, so X-server and XC1 are unblocked on that exact tag. The direct pinned control did not satisfy the release-notes assertion: preset 10.3.0 generated the version heading but omitted the W1b feature entry, matching the published release body and tagged changelog. A 9.3.1 version-only control rendered the feature. This checkbox remains open for a separate release-infrastructure correction; it does not invalidate the tagged transport artefact.

---

### Task 2: Rebase, complete, and release X-server

**Files:**
- Modify: `src/api/app.ts`
- Modify: `src/api/middleware/e2ee-envelope.middleware.ts`
- Modify: `src/api/middleware/auth.middleware.ts`
- Modify: `src/e2ee/context.ts`
- Create/review: `src/e2ee/rest-window.ts`
- Test: `__tests__/e2ee-rest-envelope.test.ts`
- Test: `__tests__/e2ee-rest-window.test.ts`
- Evidence: `tracks/X-server/PLAN-X-server.md`, `tracks/X-server/ADVERSARY-BRIEF-X-server.md`

**Interfaces:**
- Consumes: W1b's release tag and frozen context-auth verdict.
- Produces: sealed REST requests/responses, RFC-6479 receive window, D-9 rejection ordering, and X-server's release tag for XC2 and R1.

- [ ] **Step 1: Reconfirm ownership and fingerprint the six current slice files**

  Repeat Task 0 for the X-server worktree. Verify both untracked tests and both untracked production files by SHA; `git diff` alone cannot detect a stranded mutation in them.

- [ ] **Step 2: Finish the interrupted header remedy on the pre-rebase bytes**

  Replace framing decisions that read raw `incoming.headers` with Hono `c.req.header("content-length")` and `c.req.header("transfer-encoding")`. Add a pollution test whose mutation reverts the safe accessor to a raw bracket read and goes red; restore `Object.prototype` in `finally` and assert cleanup. Retake pristine hashes after this accepted edit.

- [ ] **Step 3: Verify W1b's tag and seam before rebasing**

  Confirm the remote tag exists and inspect its `src/e2ee/context.ts`. Stop if the verdict arms differ, the input is not a resolved context, the helper destroys/logs, or `no-device-store` is absent.

- [ ] **Step 4: Rebase onto the W1b release tag**

  Read the merge/rebase policy and use `operating-git-and-github`. Resolve the known `src/api/app.ts` conflict with exactly one `e2eeContext?: E2eeContext` declaration. Do not edit `src/e2ee/record.ts`.

- [ ] **Step 5: Implement slice 2b's authentication and capability seam**

  After authenticated counter/window admission, call `authenticateContext`. Seal every refusal with the live context; destroy only for `device-revoked`; keep the context for credential mismatch and store unavailability. On success, set the context principal and still run `requiredCapability`/`hasCapability`. Preserve the 503 body `{ error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }`.

- [ ] **Step 6: Complete the real-chain test matrix**

  Add the device-credential positive control, no-Authorization context authentication, row/context ID disagreement, hostile `revoked_at` accessor, mismatched device credential, shared API key mismatch, mid-flight revocation, null/throwing store, read-only capability refusal, and seal-before-destroy call order. Keep the call-order test labelled as an order pin, not proof of invalidation.

- [ ] **Step 7: Run focused checks and the full 18-row campaign**

  Run TypeScript, pinned Biome, `e2ee-rest-window.test.ts`, and `e2ee-rest-envelope.test.ts`. Then rerun all 18 mutations on rebased bytes, including the pollution/accessor row. Capture verbatim red assertions and SHA restoration; a green mutation is a finding, not a result to force.

- [ ] **Step 8: Run the real-chain control and lock-protected full suite**

  Exercise `createHonoApp(deps)` on loopback through a real `/api/e2ee/open` REST handshake and real sealed fetch. Prove the same request fails when the middleware is absent. Run the full suite under `/tmp/tb-streamer-suite.lock` and record exit codes.

- [ ] **Step 9: Run the isolated 29-row REST adversary**

  Create a fresh audit worktree at the frozen artefact. Give it only the frozen specs, fixture, built tree, and `ADVERSARY-BRIEF-X-server.md`. Require every row, including unknown-context allocation, oversized/chunked bodies, replay/window edges, context swaps, status/304 framing, credential-mismatch DoS, revocation ordering, capability, pollution, and log inspection.

- [ ] **Step 10: Commit, PR, merge, and verify the X-server tag**

  Present the full staged diff and exact releasing message for approval. After approval, commit, push the branch, open one PR, wait for required green CI, squash-merge when authorized, and verify the semantic-release tag on the remote. Record the exact tag/commit in `STATUS.md`.

---

### Task 3: Implement and merge X-client XC1 WebSocket transport

**Files:**
- Create: `tracks/X-client/PLAN-X-client.md`
- Create: `services/e2ee/record.ts`
- Create: `services/e2ee/context.ts`
- Modify: `services/ws-client.ts`
- Modify as required by the existing store seam: `stores/servers.ts`
- Test: matching `services/**/__tests__` files following mobile conventions

**Interfaces:**
- Consumes: W1b's exact release tag, record fixtures, stored server ID/static key/device credential.
- Produces: one context per WebSocket instance, header-ticketed upgrade, sealed send/onmessage boundary, and the merged XC1 PR.

- [ ] **Step 1: Create the mobile task worktree only after W1b's tag is verified**

  Use `superpowers:using-git-worktrees`, branch `feat/e2ee-ws-transport`, worktree `../tb-mobile-worktrees/e2ee-transport`, and run `npm ci`. Pin the streamer tag exactly and record the dist hash for any rig lasting over an hour.

- [ ] **Step 2: Write and approve the XC1 subplan**

  Resolve the counter representation as `bigint`, specify the one-context-per-socket state machine, single-flight `open -> ticket -> upgrade`, generation guards, 10-second sealed-register deadline, one retry after ticketed-upgrade failure, and hard failure without plaintext fallback. Save it in `PLAN-X-client.md` and stop for approval.

- [ ] **Step 3: Implement record/context code from fixtures first**

  Prove byte-for-byte streamer interop, direction binding, strict counter equality, no persistence of counter/context state, `#private` key/counter fields, exact byte validation, and error at the 64-bit ceiling.

- [ ] **Step 4: Wire `WSClient`**

  Put the ticket only in `X-TB-Ticket`, omit `Authorization` on ticketed upgrades, delete the dead auth frame, seal every outbound application frame, unseal before dispatching inbound messages, and treat failed ticketed upgrades as one fresh open/retry rather than re-authentication.

- [ ] **Step 5: Verify XC1**

  Run targeted tests, the required mutations, real loopback interop, the Hermes BigInt/`DataView.setBigUint64` device probe, TypeScript, lint, unit, integration, Jest E2E, and the Maestro mock suite with #909's baseline caveat reported separately.

- [ ] **Step 6: Run the isolated XC1 adversary and merge**

  Probe nonce reuse across reconnect, reflection, rollback/duplicate/gap, plaintext injection, precision past 2^53, swapped server IDs, stripped capability info, two client instances, and plaintext socket writes. After acceptance, use the staged-diff approval workflow, open one mobile PR, merge on authorized green CI, and confirm `MERGED`.

---

### Task 4: Implement and merge X-client XC2 REST transport

**Files:**
- Modify: `tracks/X-client/PLAN-X-client.md`
- Modify: `services/e2ee/context.ts`
- Modify: `services/authed-fetch.ts`
- Modify/test: `hooks/useTerminalStream.ts`
- Test: matching `services/**/__tests__` and hook tests

**Interfaces:**
- Consumes: merged XC1 and X-server's exact release tag.
- Produces: sealed REST envelope for every pinned-server API call and the merged XC2 PR that unlocks D2.

- [ ] **Step 1: Rebase the mobile worktree and pin X-server's tag**

  Rebase XC2 onto current mobile `main` only after XC1 is merged. Verify X-server's release tag and fixtures independently; update the exact streamer pin.

- [ ] **Step 2: Extend the approved mobile subplan for REST lifecycle**

  Specify single-flight REST open per server ID, request-counter allocation, 24-hour/1-GiB/foreground rollover to a new context, 10-second old-context drain, one reopen on `E2EE_CTX_UNKNOWN`, backoff on sealed `STORE_UNAVAILABLE`, and no persisted counter/context state.

- [ ] **Step 3: Wire `authedFetch` at its transport boundary**

  Seal body-bearing requests in the body and bodiless requests in `X-TB-Env`; set the marker/context/sequence headers; omit `Authorization`; bind AAD to the raw method/path/query target; unseal the response before existing JSON/error/cache handling. Retries re-seal plaintext with a new counter and never resend sealed bytes.

- [ ] **Step 4: Cover response and fallback semantics**

  Require a valid sealed response for application semantics, including sealed 304; handle the frozen plaintext refusal statuses only as specified; treat unsealed application responses as transport failures. Prove the 2-second terminal-replay HTTP fallback is sealed and never falls back to plaintext.

- [ ] **Step 5: Verify XC2 and merge**

  Run the full mobile verification set, Maestro baseline comparison, real streamer interop, safeguard mutations, and the isolated mobile adversary's REST rows. After acceptance, follow staged-diff approval, one mobile PR, green CI, authorized squash merge, and confirm `MERGED`.

---

### Task 5: Run and accept D2 sealed-transport device evidence

**Files:**
- Read: `tb-mobile/CLAUDE.md`
- Read: `tb-streamer/CLAUDE.md`
- Read/modify: `tracks/D/PLAN-D.md` §14
- Create: `tracks/D/D2-REPORT.md`
- Inspect existing worktree: `../tb-mobile-worktrees/e2ee-device-run`

**Interfaces:**
- Consumes: merged XC2, exact W1b/X-server streamer tag, physical-device build, isolated rig.
- Produces: accepted LAN ciphertext and production-topology functional evidence.

- [ ] **Step 1: Decide whether to reuse the D1 device worktree**

  Show its existing `ios/Podfile.lock` drift and ask whether to continue there or create a D2 worktree. Never overwrite or normalize it without identifying whether it is path noise through the repository script.

- [ ] **Step 2: Record and isolate the rig**

  Record pre-existing simulators, devices, streamers, tunnels, and ports. Use scratch `HOME` and `THREADBASE_CONFIG_DIR`; build/install physical iOS only through `scripts/dev-device.sh`.

- [ ] **Step 3: Run the plaintext positive control first**

  Capture the same terminal output, replay, conversation-event, and user-message actions on an unsealed/unpinned path. Decode WebSocket masking and fragmentation with `tshark`; prove the marker detector sees plaintext before trusting a zero count.

- [ ] **Step 4: Run D2's nine rows**

  Capture and decode LAN terminal output, terminal replay including the HTTP fallback, conversation events, and user messages; verify REST rollover/new context and old-context drain; verify fresh-ticket socket reconnect; verify restart recovery; verify live revocation; and run the named-tunnel/Cloudflare Access functional pass without calling it a wire-secrecy result.

- [ ] **Step 5: Scrub, report, and independently review evidence**

  Scrub keys, credentials, tokens, device identifiers, and tunnel hosts before copying evidence into the report. Record positive-control counts, sealed-run counts, frame/body totals, commands, exact builds/tags, and PASS/FAIL/NOT RUN for every row. A second reader verifies the report against the captures before `STATUS.md` says accepted.

- [ ] **Step 6: Tear down everything started by D2**

  Kill the scratch streamer/tunnel/capture processes, shut down only simulators/emulators started by this task, and compare final state to the preflight record.

---

### Task 6: Complete negotiated rollout R1, R2, and R3

**Files:**
- Create: `tracks/R/PLAN-R.md`
- Modify for R1: streamer CLI serve-option, feature-flag resolution seam, boot logging, `/api/info`, device-count query, and matching tests identified by the approved R plan
- Modify for R2 only if the user's choice requires code
- Modify for R3: `src/feature-flags.ts` plus tests that pin the default

**Interfaces:**
- Consumes: W1b and X-server tags for R1; merged XC2 and accepted D2 for R2/R3.
- Produces: safe operator opt-out, a resolved D-8 decision, and a stage-2 PR that remains user-gated.

- [ ] **Step 1: Implement and release R1 after both streamer tags exist**

  Add `--no-e2ee` only to `serve`; emit the console warning and structured `e2ee.disabled` warning with the pinned-device count; expose `/api/info` reason `disabled by --no-e2ee`; prove the flag never unpins a device and pinned plaintext stays 426. If streamer #744 has not landed, either exclude never-authenticated orphan rows from the count or state that caveat explicitly in the warning. Run mutations, full suite, approval, one streamer PR, and release verification.

- [ ] **Step 2: Present the D-8 collision without choosing**

  After XC2 and D2, present the three recorded options: exempt E2EE from the environment rung; accept the environment off-switch and retire D-8's prohibition; or keep it and emit the same warning/count/reason for every flag-off source. Include Cloudflare shared-IP `/open` rate limiting and credential-less sealed-request Access behavior in the rollout consequences. The user decides.

- [ ] **Step 3: Implement the user's R2 choice if it changes code**

  Create a separate PR, prove the chosen source/precedence and warning behavior through the real CLI/feature resolver, run mutations and the full suite, and follow commit/merge approval gates.

- [ ] **Step 4: Open the stage-2 default PR and stop**

  Change only the E2EE feature default from false to true plus tests that pin the transition. Open the separate PR with an explicit statement that it must not merge without the user's direct go and export-compliance readiness. Do not merge it as part of ordinary task completion.

- [ ] **Step 5: Define the rollout terminal state correctly**

  The engineering program is complete when R1 is released, R2 is resolved, R3 is open and green, XC2 is merged, and D2 is accepted. R3 merging is a separate user/product action. Stage 3 remains an open issue with a minimum app-version floor and no date-based automation.

---

### Task 7: Close the program without losing evidence or user work

**Files:**
- Modify: `tracks/STATUS.md`
- Modify/create: `tracks/W/REPORT-W1b.md`, X-server evidence, `tracks/X-client/PLAN-X-client.md`, `tracks/D/D2-REPORT.md`, `tracks/R/PLAN-R.md`
- Update owned GitHub worklist issues only after reading the GitHub comments policy and verifying `RonenMars` ownership

**Interfaces:**
- Consumes: every merged PR, release tag, adversary report, CI result, and D2 report.
- Produces: one auditable completion record and cleanly retired task worktrees.

- [ ] **Step 1: Reconcile the final matrix from ground truth**

  Query remote tags and each named PR individually. Record exact commit/tag pairs, CI conclusions, mutation totals, adversary dispositions, and D2 acceptance. Do not infer success from local branches or a lone security check.

- [ ] **Step 2: Update worklist issues and decisions**

  Read `~/dotfiles/docs/ai-tools/codex/github-comments-policy.md`, verify repository ownership, inspect authorship, and update only `RonenMars` issues/comments. Use one sentence per line and cite exact evidence. Keep #743, #747, #909, export compliance, and stage 3 explicitly outside the completed transport scope unless separately authorized.

- [ ] **Step 3: Retire only clean, merged task worktrees**

  For each task tree, prove `git status --porcelain` is empty, the PR is `MERGED`, the release tag contains its tree, and no other worktree uses the branch. Remove only the task's own clean worktrees. Preserve any tree with untracked evidence or user changes and report it instead.

- [ ] **Step 4: Run the completion audit**

  Confirm: no open unapproved transport PR; no task process/rig/tunnel left; no plaintext capture on a declared sealed LAN channel; no unsanitized evidence; latest mobile can interoperate with the exact latest streamer tag; legacy unpinned clients remain byte-compatible; R3 is either explicitly user-merged or still open and gated.

- [ ] **Step 5: Report completion with the remaining user decisions**

  Separate completed engineering from the two user-owned outcomes: R3 merge/go-live and export-compliance readiness. Never describe an open R3 gate as an implementation failure or silently cross it to call the program complete.
