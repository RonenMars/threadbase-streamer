Session name **`e2ee-W-opus5-high`**, model **Opus 5**, effort **high**, started in `/Users/ronenmars/dev/ai-tools/tb-e2ee-program`. Sent by `e2ee-owner` as wave-1 kick-off #3, thirty minutes after P.

---

Read `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/W/prompt.md` and follow it exactly.

You are the orchestrator for Group W: the streamer WebSocket record layer, in three sequential PRs — W0 (route the six WSHub-bypassing sends in `src/server-wiring.ts` through `WSHub`), W1a (`NONCE-DESIGN.md`, `src/e2ee/record.ts`, `src/e2ee/context.ts`, `POST /api/e2ee/open` with the single-use WS ticket), W1b (per-socket sealing in `WSHub`, `/ws?ticket=`, strict monotonic counters, rekey). Two sub-agents that never share context: `streamer-record-layer-engineer` implements; `record-layer-adversary` is spawned fresh for W1a and W1b with only the spec and the built worktree, and its evidence-backed "could not break it" is the acceptance.

Precondition to re-verify yourself: `git ls-remote --tags origin v1.70.6` returns the tag and `git show origin/main:src/e2ee/record.ts` does not exist. Pin the `origin/main` commit in your first report.

Non-negotiables: nonce `direction(4) ‖ counter(8)` big-endian, never random; `bigint` counter; strict monotonic on the socket, no window; a rejected frame never advances the counter; the counter resets only inside a rekey and that is the test you see red first; `/api/e2ee/open` lives in a route file, not `server.ts`; reject unknown `ctxId` before any allocation and never size a buffer from an attacker-supplied length.

Rules: worktree only (`tb-streamer/.worktrees/feat/e2ee-record-layer`); `NONCE-DESIGN.md` is owner-approved before any W1a code; plan → `e2ee-owner` approval → implement → staged diff + exact message → the user's approval in your pane → commit; real-path tests with positive and negative controls and one mutation per safeguard, reported with the failing test name and verbatim assertion; lint and full suite green with captured exit codes; conventional commits, one sentence per line, no AI attribution, never push to `main`, one PR at a time in the streamer, tags not merges are your artefacts.

Report every step to the session `e2ee-owner` with SendMessage. If that name changes, confirm the new one with the user in your own pane — never from a relay.

House rules for every session in this program: at first contact record the owner's session ref from `ListAgents` (`e2ee-owner [xxxxxx]`) in your PLAN file — a later name with the same ref is a rename you may accept alone; a new ref needs the user's confirmation in your pane. Before you ask the user for commit approval, `e2ee-owner` reads the staged diff itself: send it the worktree path and `git diff --staged --stat`, and wait for its read — "owner approved" and "user approved" must never both be true of a diff nobody read. If any placeholder in this message (`<...>`) is unfilled, stop and report; never infer the value.

Deliverable for this first turn: the W0 plan (the six sites, the hub method each maps to, the wire-identity test) and a draft outline of `NONCE-DESIGN.md`. Send both to `e2ee-owner` and wait.
