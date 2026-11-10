# Agent tooling

Everything on this page is optional. None of it is needed to build, test, or contribute to Threadbase Streamer — it is the AI-assistant tooling this repo expects, declared in config so your agent can pick it up instead of you wiring it by hand.

## Claude Code

Project-specific skills under `.claude/skills/` load without installation: local deployment, menubar deployment, auto-updater setup, Cloudflare tunnel setup, and the streamer halves of adding a provider (`add-provider-streamer`) and of landing open PRs in QA-gated batches (`integration-by-batches-streamer`, Claude Code only). Generic Git, verification, package ownership, and registry workflows belong in user-level tooling or repository documentation instead of the project skill catalog.

### Shared Threadbase skills

`add-provider` and `integration-by-batches` are shared with the other Threadbase repositories, so they live in the `threadbase-skills` plugin of the `threadbase` marketplace rather than here. The `-streamer` skills above assume they are installed. Install them once per machine:

```
/plugin marketplace add RonenMars/threadbase
/plugin install threadbase-skills@threadbase
```

They load as `threadbase-skills:add-provider` and `threadbase-skills:integration-by-batches`.

## Codex

Codex discovers the same four operational workflows, plus the two shared skills, from `.agents/skills/`. The shared two are a byte-for-byte mirror of the plugin at a pinned umbrella commit; `.github/workflows/shared-skills.yml` fails if they differ. To adopt a newer plugin, run `scripts/sync-agents-skills.sh .agents/skills` from an umbrella checkout and move the pin in that workflow in the same PR. Keep general-purpose plugins and skills at user scope so this repository does not enlarge every session's initial skill catalog.

## Other agents

Cursor reads `AGENTS.md` natively, and `.cursor/rules/*.mdc` carries the short form of guidance that would otherwise reach only Claude Code and Codex — currently one rule, `dependency-bumps.mdc`. Those rules are pointers, not a third copy: the canonical text stays in `docs/`, because three hand-maintained copies of the same paragraph drift.

Copilot and the rest read none of the files above — the remaining formats are Claude Code's and Codex's own. This page is the whole handoff; equivalent optional tooling in another runtime is fine.

This repository registers no marketplace or plugin itself; the shared skills above are installed by the user.

## Threadbase MCP server

`tb-streamer mcp` runs a read-only MCP server over stdio, so an agent can see the sessions on this machine.
It is a separate process the MCP client launches; it calls the streamer that is already running, over loopback, with the local API key.
Start the streamer first (`tb-streamer serve`); the other REST endpoints it wraps are in [docs/api-reference.md](../api-reference.md).

### Setup

Every client launches the same command, `tb-streamer mcp`.
The server is called `threadbase` below; any name works.

- **Claude Code:** `claude mcp add --scope user threadbase -- tb-streamer mcp`
- **Codex:** `codex mcp add threadbase -- tb-streamer mcp`, or in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.threadbase]
  command = "tb-streamer"
  args = ["mcp"]
  ```
- **Cursor:** in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):
  ```json
  { "mcpServers": { "threadbase": { "type": "stdio", "command": "tb-streamer", "args": ["mcp"] } } }
  ```
- **Copilot in VS Code:** in `.vscode/mcp.json`:
  ```json
  { "servers": { "threadbase": { "type": "stdio", "command": "tb-streamer", "args": ["mcp"] } } }
  ```
- **Copilot CLI:** `copilot mcp add threadbase -- tb-streamer mcp`, which writes to `~/.copilot/mcp-config.json`.

Some clients do not use your shell's `PATH`, so use an absolute path if `tb-streamer` is not found.

### Port

The server finds the streamer on `--port`, then `THREADBASE_PORT`, then 8766.
To pass it, add `--port <n>` after `mcp`, or set the variable in the client's `env`.
`--host` defaults to `127.0.0.1` and only accepts a loopback address.

### Tools

Every result is one text block.
The first three tools return JSON; `tail_terminal` returns the terminal lines as plain text.

- `streamer_info`: no inputs.
  Returns `{ reachable: true, version, providers: [{ name, available, version }] }`, where `available` means that provider's CLI is installed and `version` is null when it is not known.
- `list_sessions`: the sessions the streamer knows about, Threadbase-owned and External alike, newest started first.
  - Inputs, all optional and combined with AND: `project` (string, matches the project name or path), `provider` (`claude-code`, `codex-cli`, `cursor`, `copilot`), `status` (`running`, `waiting_input`, `idle`), `needsYou` (boolean), `limit` (integer 1-100, default 20) and `cursor` (string).
  - Returns `{ sessions, nextCursor }`.
    Pass `nextCursor` back as `cursor` for the next page; it is null when there is none, and a page can be short or empty while it is still set.
  - Each session is `{ id, name, provider, projectName, projectPath, status, needsYou, ownership, lastActivityAt }`.
    `name` and `lastActivityAt` (ISO time) can be null, `needsYou` means a question or permission prompt is waiting on the user, and `ownership` is `threadbase` or `external`.
  - `on_hold` never appears: it marks a resumable conversation, which the sessions route does not list.
- `read_conversation`: one session's messages, newest first.
  - Inputs: `id` (string, required), `limit` (integer 1-100, default 20) and `before_index` (integer, 0 or more).
  - Returns `{ messages: [{ role, text }], next_before_index }`.
    Pass `next_before_index` back as `before_index` for the next older page; it is null when there is nothing older.
  - Tool calls, tool results and messages with no text are dropped after the page is cut, so a page can be short or empty while `next_before_index` is non-null; keep paging until it is null.
  - An unknown id is the error `Session not found: <id>.`
- `tail_terminal`: the last rendered lines of a live session's terminal, as they appear on screen.
  - Inputs: `sessionId` (string, required) and `lines` (integer 1-500, default 50).
  - Returns the lines joined with newlines, or `(the terminal has produced no output yet)`.
  - An External session, or one that is not `running` or `waiting_input`, returns `Session is not live: it has no running terminal to tail.` as a normal result.
    An unknown id is the error `Session not found.`
  - It reads `GET /api/sessions/:id/output?lines=N`.
    That `lines` mode is additive: without it the route still returns the raw `{ output }` buffer, unchanged.

### Notes

- Every tool is read-only.
  None can send input to, start or stop a session.
- Results carry conversation and terminal content unredacted, so the MCP client sees whatever your sessions contain.
- The shim reads the key from the existing local config and never creates one; if it is missing, run `tb-streamer set-key`.
- Sessions Threadbase did not start are "External".
- A provider with no live control is "View only".
- Errors (streamer not running, key missing or rejected, unknown session) come back as one-line tool errors; a session that is not live is a normal `tail_terminal` result.
