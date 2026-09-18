# `scripts/resume-sessions-tmux.sh`

Resumes cached conversations from `~/.threadbase/cache/cache.db` in tmux — one
tmux session per agent (`tb-claude`, `tb-codex`, `tb-cursor`), one window per
conversation — using each agent's native resume command. This is a local
convenience script, not part of the streamer's build/deploy pipeline.

## Usage

```bash
scripts/resume-sessions-tmux.sh <since> [options]
```

`<since>` filters conversations by `conversation_meta.last_activity` and
accepts:

- `today` / `yesterday`
- a bare time (`09:00`, `9:30:00`) — today at that clock time
- a date or datetime (`2026-09-18`, `2026-09-18 09:00`, ISO-8601 with offset)
- a bare epoch (seconds or milliseconds)

Key options: `--provider claude-code|codex-cli|cursor` (repeatable),
`--project SUBSTR`, `--limit N` (per provider), `--dry-run`,
`--attach claude|codex|cursor|all`, `--api-key`/`--streamer-url` overrides.
Run `--help` for the full list — the header comment in the script *is* the
help text (`usage()` slices and prints it directly).

Native resume command per provider (cwd = the conversation's `project_path`
when known):

| Provider | Command |
|---|---|
| `claude-code` | `claude --resume <id>` |
| `codex-cli` | `codex resume <id> --cd <project> --no-alt-screen` |
| `cursor` | `agent --workspace <project> --trust --resume=<id>` |

## Live-session handling (`--kill-live`)

Before launching, the script asks the streamer (`GET /api/sessions`) for any
`running` / `waiting_input` PTYs, since a second native resume can collide
with a session the streamer already owns (Codex refuses outright; Claude/
Cursor may not, which is worse — two processes writing the same JSONL).

- No live sessions → launches straight away.
- Live sessions found, `--kill-live` **not** passed → prints a warning and
  asks to continue anyway (collision risk) or abort.
- Live sessions found, `--kill-live` passed → asks for approval, then tears
  each one down via the streamer API before resuming (`-y`/`--yes` skips all
  prompts).

Teardown prefers `POST /api/sessions/:id/kill` (SIGKILL, added in
[PR #919](https://github.com/RonenMars/threadbase-streamer/pull/919)) and
falls back to `POST /api/sessions/:id/stop` (SIGINT) when `/kill` isn't
available on an older streamer build or the call fails. Either way this goes
through the streamer, never the agent CLIs directly — the live PTYs are
streamer-owned `node-pty` children, and `/stop`/`/kill` are the only paths
that also update the session registry and broadcast the state change (see
`putOnHold` in [`CLAUDE.md`](../../CLAUDE.md#session-lifecycle)).

## Requirements

`sqlite3`, `python3`, `tmux`, `curl`. The streamer API key is read from
`~/.threadbase/server.yaml` (`api_key:`) unless `--api-key` /
`THREADBASE_API_KEY` is set; without a key the live-session check is skipped
with a warning (resume still proceeds).

## Known limitations

- Not registered as an `npm run` script and not covered by any test.
- Assumes macOS/Linux bash (targets bash 3.2 compatibility for stock macOS
  `/bin/bash` — no associative arrays outside the final tmux-launch loop).
