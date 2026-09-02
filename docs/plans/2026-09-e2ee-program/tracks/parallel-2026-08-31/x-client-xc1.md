# X-client XC1 WebSocket transport — launch prompt

Session name: `e2ee-Xclient-opus5-high`.

You are the orchestrator for XC1 only: the mobile WebSocket record layer, context open, single-use header ticket, and sealed `WSClient` boundary.
Do not implement XC2 REST transport in this track.
XC1 is unblocked by exact streamer tag `v1.72.0` and may proceed independently of the two Streamer tracks.

## Read first

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/AGENTS.md`
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/PLAN-FINISH-E2EE-2026-08-30.md`, Task 3
3. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/X-client/prompt.md`, applying only XC1 scope
4. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/W/REPORT-W1b.md`, Task 1E
5. Streamer `v1.72.0:specs/end-to-end-encryption/NONCE-DESIGN.md`
6. Streamer `v1.72.0:specs/end-to-end-encryption/mobile-design.md`, §4 and §9
7. Streamer `v1.72.0:specs/end-to-end-encryption/design.md`, §§3.3–3.5, §4.3, and §8
8. Streamer `v1.72.0:specs/end-to-end-encryption/dilemmas.md`, D-2 and D-3
9. `/Users/ronenmars/dev/ai-tools/tb-mobile/AGENTS.md`
10. `/Users/ronenmars/dev/ai-tools/tb-mobile/CLAUDE.md`
11. Mobile `origin/main` versions of:
    - `services/ws-client.ts`
    - `services/e2ee/noise.ts`
    - `services/e2ee/pair-handshake.ts`
    - `stores/servers.ts`
12. The `superpowers:using-git-worktrees` skill before creating the worktree
13. The `operating-git-and-github` skill before any rebase, push, PR, merge, or GitHub-writing action

## Preconditions to verify

- Streamer PR #748 reports `MERGED`.
- Remote tag `v1.72.0` resolves to `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`.
- The tag contains:
  - `src/e2ee/record.ts`;
  - `src/e2ee/context.ts`;
  - `specs/end-to-end-encryption/NONCE-DESIGN.md`;
  - `__tests__/fixtures/e2ee-record-vectors.json`.
- Mobile pairing prerequisites #908, #915, #917, and #919 report `MERGED`.
- No existing worktree owns branch `feat/e2ee-ws-transport`.
- `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-transport` does not already exist.

Fetch mobile `origin/main`, record its exact SHA, and inspect the open mobile PR queue without changing it.
The root checkout is read-only even if its local `main` is stale.

If the XC1 worktree or branch already exists when this prompt runs, stop and ask whether to continue it or create another; do not overwrite it.

## Worktree

Create:

- Worktree: `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-transport`
- Branch: `feat/e2ee-ws-transport`
- Base: freshly fetched mobile `origin/main`

Run `npm ci` inside the new worktree.
Record exact mobile base SHA, Expo 57.0.18, React Native 0.86.3, `@stablelib/*` 2.0.1, Jest 29.7.0, and streamer interoperability baseline `v1.72.0`.
Do not add a new streamer package dependency merely to record the pin; pin the exact tag in the XC1 plan, fixtures, and loopback rig evidence.

## First deliverable: approved XC1 plan

Create `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/X-client/PLAN-X-client.md`.
The plan must define:

- `bigint` counters and explicit refusal at the 64-bit ceiling;
- one fresh E2EE context per `WSClient` socket instance;
- `open -> ticket -> upgrade` as one generation-guarded single-flight sequence;
- ticket only in `X-TB-Ticket`;
- no `Authorization` on a ticketed upgrade;
- no `?ticket=` URL parameter;
- deletion of the plaintext `{ type: "auth" }` frame;
- sealed `{ type: "register" }` sent within 10 seconds of upgrade;
- sealing before every outbound application write;
- unsealing before every inbound dispatch;
- strict `counter === expected`, with duplicate, gap, reorder, reflection, and plaintext injection treated as protocol failure;
- one fresh `/open` plus one upgrade retry after a ticketed-upgrade failure;
- no re-authentication flow, pin change, or plaintext fallback after that retry fails;
- fresh msg1 for every `/open` retry;
- no persisted keys, context IDs, or counters;
- two simultaneous `WSClient` instances never sharing one mutable context or counter;
- exact interop against the `v1.72.0` fixture;
- real loopback and Hermes/device verification;
- isolated adversary rows and the staged-diff, commit, PR, CI, and merge gates.

Present the plan for explicit approval before implementation.

## Implementation scope

Expected product paths:

- Create `services/e2ee/record.ts`.
- Create `services/e2ee/context.ts`.
- Modify `services/ws-client.ts`.
- Modify `stores/servers.ts` only if required by the existing stable-server-ID and stored-key seam.
- Add focused tests following existing mobile conventions.

Do not touch `services/authed-fetch.ts` or implement REST envelope behavior; those belong to XC2 after X-server releases.
Do not change pairing UX, copy, D-5 persistence inversion, or the require-encryption UI.

## Verification bar

Use real record/context objects and the real `WSClient` boundary.
Run byte-for-byte interoperability against the tagged Streamer fixture.
Run a real loopback socket against exact streamer `v1.72.0`.

Required controls:

- Positive: a captured sealed frame reveals its application `type` only after unseal.
- Negative: the same capture path sees plaintext on an explicitly unsealed and unpinned control.

Required seen-red mutations include:

- counter represented as `number` past `2^53`;
- direction removed from AAD;
- a socket window accepting a gap;
- plaintext fallback restored after failed open or upgrade;
- ticket reuse attempted;
- context/counter persisted;
- two `WSClient` instances sharing one context;
- plaintext `auth` or application frame written to the socket.

The isolated adversary must probe nonce reuse across reconnect, reflection, rollback, duplicate, gap, plaintext injection, precision past `2^53`, swapped server IDs, stripped capability information, persisted state after kill, and two client instances.
Every row is `rejected`, `succeeded`, or `not attempted` with evidence and a negative control.

Run the repository checks required by current `AGENTS.md`:

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:scripts
npm run test:e2e:mock
```

Before committing JavaScript or TypeScript, run `npx eslint` on every staged JS/TS path.
Run the Hermes BigInt and `DataView.setBigUint64` probe on a device before claiming XC1 acceptance.
Record any iOS 26.x Maestro infrastructure failure separately from application failures.
Shut down only simulators or emulators started by this task and compare against the start-state record.

## Mobile PR gate

Before opening XC1's PR, inspect every open mobile PR and compare overlapping paths.
Do not modify, close, or merge unrelated PRs.
If the program's one-PR-per-repository rule cannot be satisfied because another mobile PR remains open, keep the verified XC1 branch safe and report the exact blocker rather than opening a competing PR.

When the slot is available, rebase onto current mobile `origin/main`, rerun every mutation and required check, and prepare the complete staged diff and exact message for explicit approval.
After approval, commit and push only the branch, open one XC1 PR, and watch all required checks.
On green, show mergeability and the exact squash title, then stop for fresh explicit squash-merge approval.
Confirm GitHub reports `MERGED` before treating XC1 as complete.

## Approval boundaries

The plan requires explicit approval before implementation.
The complete staged diff and exact commit message require explicit approval before commit.
The merge requires a separate explicit approval after green CI.

## Report

Update `tracks/X-client/PLAN-X-client.md` and `tracks/STATUS.md`.
Report the exact mobile base, streamer tag, dependency pins, seen-red assertions, interop and Hermes evidence, all command exit codes and totals, adversary results, PR state, and any contradiction.

