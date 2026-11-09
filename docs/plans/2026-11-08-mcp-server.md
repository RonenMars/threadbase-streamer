# Execution plan: Threadbase MCP server, phase 1 (#1176)

**Status:** plan, nothing implemented.
Written 2026-11-08 against `main` at `483aceb9`.
**Spec:** [#1176](https://github.com/RonenMars/threadbase-streamer/issues/1176) is authoritative; this file only says how to build its phase 1 and who builds what.
**Tickets:** #1177 (shim + `streamer_info` + e2e harness), #1178 (`list_sessions`), #1179 (`read_conversation`), #1180 (`tail_terminal`), #1181 (docs + read-only lock).
**Worktree:** `tb-streamer-worktrees/mcp-server`, branch `feat/mcp-server`, holds this plan only; code lands through one PR per ticket.

## Kick-off

Goal: ship phase 1 of #1176, the read-only `tb-streamer mcp` stdio server, by running the milestones in `/Users/ronenmars/dev/ai-tools/tb-streamer-worktrees/mcp-server/docs/plans/2026-11-08-mcp-server.md`.
You are the orchestrator (Opus 5.5, medium effort): run `Skill("preflight")`, create `HANDOFF.md` in that worktree, then dispatch M0 with the agent, model and effort the plan's table names, and never implement a milestone yourself.
Every worker runs in its own worktree off `origin/main`, is test-first with a mutant check, and reports pass/fail counts, not exit codes.
After #1177 merges, run #1178, #1179, #1180 and the #1181 docs draft in parallel, each followed by its own reviewer, and open a PR only on a reviewer `PASS`.
Rules that never bend: read-only tools only, the key is never created or printed, loopback only, no `console.log` in anything the subcommand imports, conventional commit titles, no AI attribution, one PR merged at a time and every merge asked for separately.

## What #1176 fixes, restated for the workers

- A `tb-streamer mcp` subcommand runs an MCP server over stdio and calls the already-running streamer over HTTP on loopback with the existing local API key as a Bearer.
- The streamer process is not modified.
- Exactly four tools in phase 1: `streamer_info`, `list_sessions`, `read_conversation`, `tail_terminal`.
  No write tool of any kind; a test asserts the list is exactly these four.
- The shim adds no business logic beyond filtering, bounding and ANSI stripping.
- Errors (streamer unreachable, key missing or rejected, session not found, session not live) are one-line MCP tool errors, never a crash.
- The key never appears in stdout, stderr or any tool result, and the shim never creates one.
- The official MCP TypeScript SDK is the only new runtime dependency.
- Tests are end to end: a real in-process streamer on fixture data, the built shim spawned as a child process, the SDK's stdio client driving it.
  They run under `npm run test:e2e` next to `__tests__/e2e/api-e2e.test.ts`, and assert on tool results only.

## Facts the workers need (verified 2026-11-08)

- `cli/attach.ts:125` is the existing loopback HTTP client pattern (`fetch` + Bearer, injected `fetchFn`); copy it, do not invent a second one.
- `src/auth.ts:37` `loadOrCreateApiKey()` **creates** a key when none exists, which #1176 forbids for the shim.
  Add a pure `loadApiKey(): string | undefined` next to it in #1177 and use that; it is the one `src/` touch in phase 1, and it changes nothing the server runs.
- `tsup.config.ts:45` bundles everything but `node-pty` and `better-sqlite3` into `dist/cli.cjs`, so the SDK ships inside the deployed `cli.js` with no `node_modules`.
  The repo pins `zod ^4.4.3` (`package.json:122`); the SDK must accept zod 4 or be pinned to a version that does, never a second zod.
- `cli/index.ts:661` is the `codex` subcommand: lazy `import()` in the action, `--port` default `8766`, that is the shape `mcp` copies.
- `GET /api/info` (`src/api/routes/misc.routes.ts:393`) carries `version`, `platform`, `activeSessions`, `featureFlags`, and no update-availability field.
  `streamer_info` reports `updateAvailable` only if an existing route exposes it; otherwise it omits the field and #1177's PR says so, because the spec forbids new logic in the shim.
  Enabled providers come from `GET /api/providers`.
- Sessions carry `ownership?: "external" | "managed"` (`src/types.ts:637`) and `hasOpenPrompt` (`src/types.ts:605`); those are the spec's ownership and needs-you fields.
- `GET /api/conversations/:id` pages with `msg_limit` and `before_index` and answers `next_before_index`; that is the `read_conversation` cursor, verbatim.
- `GET /api/sessions/:id/output` is the rendered screen tail for `tail_terminal`; a session with no live PTY is the "not live" case.
- `docs/agents/tooling.md:11` currently says this repo declares no MCP servers; #1181 replaces that line.

## Files

```
cli/mcp/index.ts             createMcpServer({ baseUrl, apiKey, fetchFn }) + runMcp(opts); concatenates the tool arrays
cli/mcp/client.ts            Bearer, JSON, loopback check, error mapping, "streamer not running" sentence, key redaction
cli/mcp/streamer-info.ts     #1177
cli/mcp/list-sessions.ts     #1178
cli/mcp/read-conversation.ts #1179
cli/mcp/tail-terminal.ts     #1180 (incl. the ANSI/private-mode stripper)
cli/index.ts                 +1 commander subcommand `mcp`
src/auth.ts                  +loadApiKey() (additive)
__tests__/e2e/mcp-e2e.test.ts  one harness file; each ticket adds its describe block
docs/agents/tooling.md       #1181
```

One file per tool so parallel workers never edit the same file; each exports a tool array and `index.ts` concatenates them, so the only shared edit is one import line and one `describe` block.

## Milestones

A milestone is done when `npm run lint && npm test && npm run build && npm run test:e2e` pass in its worktree, the mutant check went red once per non-trivial changed line, and its reviewer answered `PASS`.

| # | Ticket | Deliverable | Verification | Depends on |
|---|---|---|---|---|
| M0 | part of #1177 | SDK installed and pinned; a scratch `McpServer` with one zod-4 tool passes `tsc --noEmit`; `dist/cli.cjs` size before and after recorded | `npm run lint`, `npm run build`, the size diff | none |
| M1 | #1177 | `cli/mcp/index.ts`, `client.ts`, `streamer-info.ts`, the `mcp` subcommand, `loadApiKey()`, the e2e harness | e2e: `streamer_info` fields, clean exit on stdin close, port flag and env, non-loopback refused, streamer down, missing key, rejected key, key absent from stdout/stderr/results | M0 |
| M2 | #1178 | `list-sessions.ts` with project/provider/status/needs-you filters and a cursor | e2e: unfiltered first page + cursor, each filter, an External fixture session, cursor walk with no duplicates | M1 merged |
| M3 | #1179 | `read-conversation.ts`, newest first, role + plain text | e2e: first page newest first, cursor to older page, no provider format leaking, unknown id error | M1 merged |
| M4 | #1180 | `tail-terminal.ts` with the stripper | e2e: bounded lines, ANSI and private-mode sequences stripped, "not live" result, unknown id error | M1 merged |
| M5a | #1181 docs | `docs/agents/tooling.md` setup for Claude Code, Codex, Cursor, Copilot; port override; the four tools; read-only and unredacted-content notes; API reference link | reviewer read-through; no real identifier (public repo) | M1 merged (draft can start earlier) |
| M5b | #1181 lock | the test that the tool list is exactly the four read-only tools | e2e | M2, M3, M4 merged |
| M6 | all | manual run of the built shim against the local prod streamer through `claude mcp add --scope user`, then removed; each ticket closed with its PR link | `gh pr view --json state,mergedAt` per PR | M5 merged |

## Parallel map

```
M0 ─► M1 (#1177) ─► PR ─► merge ─┬─► M2 (#1178) ─► review ─► PR ─┐
                                ├─► M3 (#1179) ─► review ─► PR ─┼─► merges, one at a time ─► M5b ─► PR ─► merge ─► M6
                                ├─► M4 (#1180) ─► review ─► PR ─┤
                                └─► M5a (#1181 docs draft) ─────┘  (folded into the M5b PR)
```

- M0 and M1 are serial; M1 must be on `main` before the rest branch, because they import `cli/mcp/index.ts` and the harness.
- M2, M3, M4 and M5a run at the same time in four worktrees off `origin/main`; disjoint files plus one import line and one `describe` each.
- Each reviewer starts as soon as its worker reports.
- PRs merge one at a time per the repo's rebase + squash rule; after each merge the orchestrator waits for the `chore(release)` commit, then rebases the next branch.
  Only the first of the three parallel PRs merges as-is; budget one rebase and CI cycle for each of the other two.
- The suite boots real servers and is not parallel-safe, so four workers running it at once are slow but not wrong; a timeout is rerun once unchanged before it is reported.

## Agents, models and effort

Dispatch with the Agent tool, `subagent_type: "general-purpose"`, `isolation: "worktree"`, one shot each, with the `model` and `effort` below.
A worker's brief is its ticket, its milestone row, the Facts and Files sections and the rules that never bend; it reads #1176 and this plan itself.
A reviewer gets the staged diff and the ticket's acceptance criteria, never the developer's summary.

| Task | Agent | Model | Effort | Why |
|---|---|---|---|---|
| Orchestrator (the session the user starts) | the main session | Opus 5.5 | medium | Dispatch, merge sequencing, push-window and merge-approval rules, HANDOFF upkeep; long session, so cost sits here |
| M0 spike | general-purpose | Sonnet 5.5 | medium | Mechanical: install, pin, `tsc`, size diff |
| M1 #1177 | general-purpose | Fable 5.1 | high | Sets the client, the harness and the stdout discipline that four tickets build on |
| M1 reviewer | general-purpose | Opus 5.5 | high | Independent read of the milestone everything depends on, incl. the key-redaction test |
| M2 #1178 | general-purpose | Opus 5.5 | medium | Filters, cursor, External fixture; more shape than M3 or M4 |
| M3 #1179 | general-purpose | Sonnet 5.5 | medium | Cursor passthrough and text flattening |
| M4 #1180 | general-purpose | Sonnet 5.5 | high | The ANSI stripper is where a cheap regex misses private-mode sequences |
| M5a #1181 docs | general-purpose | Sonnet 5.5 | low | Prose from the spec; the public-repo identifier rule is the only risk |
| M5b #1181 lock | general-purpose | Sonnet 5.5 | low | One test |
| M2 to M5 reviewers | general-purpose | Opus 5.5 | high | One per worker, `PASS`/`CHANGES` with the mutant evidence checked |
| M6 | the orchestrator itself | Opus 5.5 | medium | Needs the machine and the prod streamer |

Escalation: a worker that reports a blocker it cannot resolve is re-dispatched once on Fable 5.1 at high effort with the failure output in its brief; a second failure stops the run and goes to the user.

## Risks

- **zod 4 vs the SDK's peer range.** M0 settles it before anything depends on it.
- **`updateAvailable` has no route.** Reported in #1177's PR rather than invented in the shim.
- **Bundle size of `dist/cli.cjs`.** The SDK is imported lazily in the `mcp` action, so `serve` pays nothing at runtime; the size diff goes in the M0 commit body.
- **Three parallel PRs behind each other.** Expected; the merge order is the review order, and each later one is rebased once.

## Input for the phase 2 spec (not part of this plan)

A write surface was drafted before #1176 was read and is kept here as material for the phase 2 spec, which #1176 says comes separately.
Write tools as passthroughs with an `idempotencyKey` per call: `start_session`, `resume_session`, `fork_session`, `send_input`, `send_key`, `answer_prompt` (from `PromptAnswerSchema`), `answer_permission` (`gateId` + `optionIndex`), `cancel_turn`, `stop_session`, `terminate_session`, `rename_session`, `set_model`, `set_effort`.
One read-only convenience, `wait_for_turn`, that polls `GET /api/sessions/:id` at 1 s until `waiting_input`, `idle` or `hasOpenPrompt`, is also deferred because #1181 locks phase 1 to exactly four tools.
