---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
status: planned
date: 2026-11-22
---

# MCP read tools, batch 2

## Goal Capsule

Add three read-only tools to the `tb-streamer mcp` server so an agent can find past work, see projects at a glance, and wait on another session without polling by hand.
The server stays read-only; the write tools in #1176 phase 2 remain a separate piece of work.

## Product Contract

### Requirements

- **R1 `search_conversations`.** Full-text search across conversation history for every provider the streamer indexes, backed by the existing `GET /api/search`.
  Each hit carries the session id (usable with `read_conversation`), provider, project, a text snippet and a time.
  Results are paged the same way `list_sessions` is (`cursor` / `nextCursor`).
- **R2 `list_projects`.** Projects the streamer knows, with recent activity and session counts, backed by `GET /api/projects/summary`.
  Each project's name and path match what `list_sessions` reports, so its `project` filter accepts them.
- **R3 `wait_for_turn`.** Given a session id, return once the session is `waiting_input`, `idle`, or `needsYou`, or a caller-supplied timeout elapses.
  The result says which of those four happened and carries the session as `list_sessions` shapes it.
  The timeout has a default and a cap, so a call cannot hang the client indefinitely.
  An unknown id fails at once with a one-line error, like the existing tools.

### Scope boundaries

- No write tool of any kind: no input, start, stop, terminate, answer or rename.
- No `get_pending_prompt` in this batch: considered and not chosen; `needsYou` on `list_sessions` stays the signal.
- No new server endpoints: each tool wraps a route that already exists.

### Success criteria

- `tools/list` returns exactly seven tools, and the existing test asserting the exact tool list is updated to say so.
- Each tool answers a one-line error when the streamer is down or the key is rejected, as the existing four do.
- A manual run through `claude mcp` finds a known conversation by a phrase from it, lists this repo as a project, and returns from `wait_for_turn` when a live session finishes a turn.

## Implementation Plan

### Decisions

- **D1 `wait_for_turn` polls; it never opens a WebSocket.** The shim's one transport is `StreamerClient.get()` (`cli/mcp/client.ts`), which the phase 3 relay swap depends on; a WS would be a second transport to swap. It polls `GET /api/sessions/:id` every 1 s.
- **D2 Timeout: default 120 s, max 600 s** (`timeoutSeconds`). On timeout it returns `{ outcome: "timeout", session }`, not an error, so the agent can call again.
- **D3 Outcome order** when several hold at once: `needsYou` beats `waiting_input` beats `idle`. A session already settled on the first poll returns immediately.
- **D4 Search filters:** `q` (required), `provider`, `project` (mapped to `projectPath` after `canonicalizeProjectPath`), `limit`. `/api/search` pages by `offset`; the tool exposes it as an opaque `cursor` string (the next offset), so every paged tool reads alike.
- **D5 `list_projects`** wraps `GET /api/projects/summary`, which also pages by `offset`/`hasMore`; same cursor mapping. It returns name, path, conversation count, live session count and last activity, and drops the rest.
- **D6 Errors:** reuse the client's existing one-line errors (`NOT_RUNNING`, `KEY_*`); a 404 from the session route is "no such session"; a 400 from search passes its `error` text through; a 503 `CACHE_UNAVAILABLE` becomes one line saying the index is still building.

### Units

1. **`cli/mcp/search-conversations.ts`** — tool per R1/D4/D6. Test `__tests__/mcp-search-conversations.test.ts` with a stub `fetchFn`: query string built correctly, cursor round-trip, provider enum rejected client-side, 400 text passed through.
2. **`cli/mcp/list-projects.ts`** — tool per R2/D5. Test `__tests__/mcp-list-projects.test.ts`: field mapping, cursor from `hasMore`, a name/path that `list_sessions`' `project` filter accepts.
3. **`cli/mcp/wait-for-turn.ts`** — tool per R3/D1-D3. Test with fake timers: returns on each of the three states, outcome priority, timeout result, 404 fails at once, timeout capped at 600.
4. **Register** the three in `TOOLS` (`cli/mcp/index.ts`) and update the exact-list assertion in `__tests__/e2e/mcp-e2e.test.ts` ("lists exactly the phase-1 tools") to seven names.
5. **Docs:** add the three tools to `docs/agents/tooling.md`'s MCP section.

### Verification

- `npm run lint && npm test` (redirect to a file; triage by failure kind per CLAUDE.md).
- Mutant check: break the outcome order in D3 and the cursor mapping in D4 once each; a test must fail.
- Manual: the success criteria's `claude mcp` run against local prod after deploy.

### Risks

- An MCP client with a shorter tool-call timeout than 120 s cuts `wait_for_turn` off; the description tells agents to pass a smaller `timeoutSeconds` and loop.
- Search over a large history is slow; `limit` caps at the route's own maximum.
