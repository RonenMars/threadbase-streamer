# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **Migrations at deploy**: `scripts/deploy.sh` (and Linux/Windows equivalents) copies `dist/migrations/` alongside `dist/cli.cjs` into `~/.threadbase/releases/`. The CJS bundle resolves `__dirname` to the releases directory at runtime, so the SQL files must be co-located.

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.) and branch names (`feat/`, `fix/`, `chore/`)
- Every new feature must have tests in `__tests__/`
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`
- `node-pty` is dynamically imported to allow graceful failure when not installed
- All session state mutations go through SessionStore for consistency

## Testing

Tests mock `node-pty` and shell commands. Integration tests spin up the HTTP server on random ports. Run the full verification before committing: `npm run lint && npm test`
