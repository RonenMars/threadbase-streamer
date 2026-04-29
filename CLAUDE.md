# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Known deploy/runtime issues and their fixes: [docs/troubleshooting.md](docs/troubleshooting.md)

## Project

`@threadbase/streamer` — PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. TypeScript library + CLI that manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API. Replaces the Go CLI's `cch serve` command.

## Commands

- `npm test` — run all tests (vitest)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — dual ESM/CJS build via tsup (outputs to `dist/`)
- Single test: `npx vitest run __tests__/session-store.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/index.ts exports) → **CLI wrapper** (cli/).

The library and CLI are built as separate tsup entries — `src/index.ts` produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types, while `cli/index.ts` produces `dist/cli.js` with a shebang.

Key modules and their responsibilities:
- `pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap)
- `session-store.ts` — in-memory registry of managed (PTY) + discovered (process) sessions
- `process-discovery.ts` — find running claude processes via pgrep/lsof (Unix) or tasklist/wmic (Windows)
- `file-watcher.ts` — tail JSONL files via fs.watch, emit new lines for structured parsing
- `ws-hub.ts` — WebSocket hub broadcasting terminal_output, session_update, session_list events
- `server.ts` — HTTP server wiring REST endpoints + WebSocket upgrade + auth
- `auth.ts` — bearer token generation/validation with constant-time comparison

## Dependencies

- `@threadbase/scanner` — scan, parse, search, filter conversation history (used for REST endpoints)
- `node-pty` — native PTY management (external, not bundled by tsup)
- `ws` — WebSocket server
- `commander` — CLI argument parsing

## Build notes

- **CLI externals**: only `node-pty` is external for the CLI tsup entry. `pg` and all other deps must be bundled — the deployed CLI lives in `~/.threadbase/releases/` with no `node_modules`.
- **Migrations at deploy**: deploy scripts copy `dist/migrations/` so the CJS bundle can find them at runtime via `__dirname`.
  - macOS/Linux: symlink makes `__dirname` = `~/.threadbase/releases/` → copy to `~/.threadbase/releases/migrations/`
  - Windows: `cli.js` is a real copy at `~/.threadbase/` so `__dirname` = `~/.threadbase/` → copy to `~/.threadbase/migrations/`

## Cloudflare Tunnel

The streamer is exposed publicly via a Cloudflare Tunnel (`cloudflared` running as a Windows service). The active mapping is `https://tb-pc.rbv1000.win` → `http://127.0.0.1:8766`. Set `public_url: https://tb-pc.rbv1000.win` in `~/.threadbase/server.yaml` so the pairing QR code embeds the correct URL.

**Cloudflare Access behaviour:** the tunnel hostname is protected by Cloudflare Access. Requests without an `Authorization` header receive `401 Unauthorized` from the CF edge — including unauthenticated probes of `/healthz`. Requests that carry `Authorization: Bearer <api_key>` pass through to the origin. This means:
- Deploy-script healthchecks (which hit `http://localhost:8766/healthz` directly) are unaffected.
- External clients must always include the Bearer token — there is no anonymous access through the public URL, even for `/healthz`.
- `Test-NetConnection` and browser probes will be blocked by CF Access; use `Invoke-RestMethod` with the Bearer header to test the public URL.

**cloudflared config files:**
- `~/.cloudflared/config.yml` — user-level config (read when running `cloudflared` manually)
- `~/.cloudflared/config-system.yml` — used by the Windows service (runs under SYSTEM); this is the one that matters for the always-on tunnel
- Both must be kept in sync. After editing either file, restart the service: `Restart-Service cloudflared`

## Windows-specific notes

- **`npm install` before first deploy**: A fresh clone (or a branch that added new packages) will fail lint/build with "Cannot find module" if `node_modules` is missing or stale. Run `npm install` before the first `npm run deploy:windows`. The `postinstall` script also patches `qrcode-terminal` and sets permissions on the `node-pty` prebuild.
- **Path separators**: `path.resolve()` returns backslash-separated paths on Windows. Always use `path.sep` (not `"/"`) for path prefix guards. Same applies to any `startsWith` checks on resolved paths.
- **File timestamps**: `fs.stat().birthtimeMs` reflects the real Windows creation time and is unaffected by `fs.utimes()`. Use `mtimeMs` for any timestamp matching that needs to survive cross-platform test assertions.
- **Task Scheduler log redirection**: Task Scheduler has no native stdout/stderr redirection. The scheduled task action must use `pwsh.exe` as the executor and redirect inside the PowerShell command string (`>> logfile 2>> errfile`). Without this, `%TEMP%\threadbase.err` is never written and healthcheck failures are undiagnosable.
- **Task Scheduler env var inheritance**: `[Environment]::SetEnvironmentVariable(..., 'User')` writes to the registry but does NOT update the live session environment. Tasks started via `Start-ScheduledTask` in the same terminal session that set the var will not pick it up. Always read back from registry with `[Environment]::GetEnvironmentVariable(..., 'User')` and inline the value directly in the `$psArg` command string. This applies to `THREADBASE_DATABASE_URL` and `THREADBASE_INSTANCE_ID`.
- **Stale port 8766**: Before starting the task after a deploy, check for and kill any node process already bound to port 8766 (old streamer version, leftover dev process). The new task will fail silently if the port is taken.
- **Submodule SSH → HTTPS**: Windows machines without SSH keys configured will fail `git submodule update --init` with "Permission denied (publickey)". Fix once: `git config --global url."https://github.com/".insteadOf "git@github.com:"`.

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.) and branch names (`feat/`, `fix/`, `chore/`)
- Every new feature must have tests in `__tests__/`
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`
- `node-pty` is dynamically imported to allow graceful failure when not installed
- All session state mutations go through SessionStore for consistency

## Testing

Tests mock `node-pty` and shell commands. Integration tests spin up the HTTP server on random ports. Run the full verification before committing: `npm run lint && npm test`

## Contributing to docs

If you hit an undocumented issue during setup, deploy, or runtime — ask the user: "This doesn't seem to be covered in `docs/troubleshooting.md`. Would you like me to add it?" Then add a new section following the existing format (symptom → cause → fix) and commit it alongside any code fix.
