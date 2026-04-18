# @threadbase/streamer — Design Document

**Date:** 2026-04-18
**Status:** Approved — ready for implementation
**Replaces:** Go CLI `cch serve` command

---

## Purpose

Extract the streaming, PTY management, and server capabilities from the Go CLI (`threadbase-cli`) into a standalone TypeScript package. This package becomes the new CLI and server, deprecating the Go implementation.

The scanner (`@threadbase/scanner`) already handles scan, parse, search, and filter. The streamer adds the **live** layer on top: spawning Claude sessions, streaming terminal output, broadcasting over WebSocket, and serving a REST API.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Package name | `@threadbase/streamer` | Named for function, like scanner |
| PTY library | `node-pty` with prebuilt binaries | VS Code uses it, cross-platform (macOS/Linux/Windows via conpty) |
| Prebuilt binaries | `prebuild-install` or `@mapbox/node-pre-gyp` | Zero build-tools friction for users on any OS |
| Dual-channel output | `node-pty` (raw ANSI) + `fs.watch` (structured JSONL) | Raw stream for terminal rendering, JSONL for structured events |
| Dual-mode | Library imports + standalone server/CLI | Electron/VS Code import directly; mobile/IntelliJ connect over HTTP/WS |
| Build | tsup (ESM/CJS library + CLI with shebang) | Same pattern as scanner |
| Go CLI | Rename `cli/` to `cli-deprecated/` | Fully replaced by streamer |

---

## Architecture

```
Mobile / Electron-web / IntelliJ
         │
    HTTP + WebSocket
         │
         ▼
┌─────────────────────────────────────┐
│        @threadbase/streamer         │
│                                     │
│   server.ts ── REST API + WS       │
│       │                             │
│   ws-hub.ts ── broadcast to clients │
│       │                             │
│   pty-manager.ts ── node-pty        │
│       │                             │
│   file-watcher.ts ── fs.watch JSONL │
│       │                             │
│   session-store.ts ── in-memory     │
│       │                             │
│   process-discovery.ts ── pgrep/ps  │
│       │                             │
│       ▼                             │
│   @threadbase/scanner               │
│   (scan, parse, search, filter)     │
└─────────────────────────────────────┘

Electron-app / VS Code
         │
    Direct import (no HTTP)
         │
         ▼
   PTYManager, FileWatcher, ProcessDiscovery
         │
         ▼
   @threadbase/scanner
```

---

## Module Structure

```
@threadbase/streamer/
├── src/
│   ├── index.ts              — library exports
│   ├── pty-manager.ts        — spawn/resume Claude sessions via node-pty
│   ├── session-store.ts      — in-memory state for active sessions
│   ├── process-discovery.ts  — find running claude processes
│   ├── file-watcher.ts       — watch JSONL files, emit structured events
│   ├── ws-hub.ts             — WebSocket hub: broadcast events
│   ├── server.ts             — HTTP server: REST + WS + auth
│   ├── auth.ts               — bearer token generation/validation
│   └── types.ts              — all type definitions
├── cli/
│   └── index.ts              — CLI entry point (commander)
├── __tests__/
├── tsup.config.ts
└── package.json
```

---

## Module Responsibilities

### `types.ts`

All shared type definitions:

```typescript
// Session lifecycle
type SessionStatus = "running" | "waiting_input" | "completed" | "failed";

// In-memory session state
interface ManagedSession {
  id: string;
  conversationId: string;
  projectPath: string;
  projectName: string;
  branch: string;
  status: SessionStatus;
  startedAt: Date;
  completedAt: Date | null;
  promptCount: number;
  lastOutput: string;        // ANSI-stripped preview
}

// Discovered (externally running) Claude process
interface DiscoveredProcess {
  pid: number;
  projectPath: string;
  projectName: string;
  branch: string;
  conversationId: string | null;
  startedAt: Date;
}

// WebSocket message types
type WSMessage =
  | { type: "terminal_output"; sessionId: string; data: string }
  | { type: "session_update"; session: SessionResponse }
  | { type: "session_list"; sessions: SessionResponse[] }
  | { type: "ping"; ts: number };

// REST response shapes
interface SessionResponse {
  id: string;
  status: SessionStatus;
  projectPath: string;
  projectName: string;
  branch: string;
  lastOutput: string;
  elapsedMs: number;
  promptCount: number;
  startedAt: string;           // ISO 8601
  completedAt: string | null;
  conversationId: string;
  source: "managed" | "discovered";
  pid?: number;
}

interface ConversationListResponse {
  conversations: ConversationMeta[];  // from scanner
  hasMore: boolean;
  offset: number;
  total: number;
}

interface ServerConfig {
  port: number;
  apiKey?: string;              // auto-generated if omitted
  localNoAuth?: boolean;        // skip auth for localhost
  scannerOptions?: ScanOptions; // passed to scanner
}
```

### `pty-manager.ts`

Spawns and controls Claude Code sessions via `node-pty`:

- **`start(conversationId, projectPath)`** — spawn `claude --resume <id>` in a PTY, return session ID
- **`sendInput(sessionId, input)`** — write to PTY stdin, increment prompt count
- **`cancel(sessionId)`** — send SIGKILL/terminate process
- **`getOutput(sessionId)`** — return buffered output (ring buffer, 64KB cap)

Callbacks:
- `onOutput(sessionId, rawData)` — fired on every PTY read chunk (4KB)
- `onStatusChange(session)` — fired when session status transitions

Ring buffer: append raw bytes, prune to last 64KB when exceeded. Store ANSI-stripped version in `lastOutput`.

### `session-store.ts`

In-memory registry of all active sessions (managed + discovered):

- `add(session)` / `remove(sessionId)` / `get(sessionId)` / `list()`
- Thread-safe (single-threaded Node, but guards against concurrent async)
- Merges managed (PTY) and discovered (process) sessions into one list

### `process-discovery.ts`

Finds Claude Code processes not started by the streamer:

- **macOS/Linux:** `pgrep -x claude` → enrich with `lsof` (cwd), `ps` (args, start time)
- **Windows:** `tasklist` / `wmic` equivalents
- Extracts `--resume <id>` from command args
- Returns `DiscoveredProcess[]`

### `file-watcher.ts`

Watches active JSONL files for new lines, emits structured events:

- **`watch(filePath)`** — start tailing a JSONL file
- **`unwatch(filePath)`** — stop watching
- Uses `fs.watch` + file offset tracking (read new bytes since last position)
- Parses new lines using scanner's parser
- Emits: `message` (new conversation turn), `tool_use`, `thinking`

### `ws-hub.ts`

WebSocket connection hub:

- `addClient(ws)` / `removeClient(ws)`
- `broadcast(message: WSMessage)` — send to all connected clients
- Ping keepalive every 30 seconds
- Wired to PTY manager callbacks (output → broadcast, status → broadcast)

### `server.ts`

HTTP server combining REST + WebSocket:

**REST endpoints (same API shape as Go CLI):**

| Endpoint | Method | Source |
|---|---|---|
| `/api/info` | GET | Server metadata |
| `/api/conversations` | GET | `scanner.scan()` with pagination |
| `/api/conversations/:id` | GET | `scanner.getConversation()` |
| `/api/search` | GET | `scanner.search()` |
| `/api/sessions` | GET | Session store (managed + discovered) |
| `/api/sessions/:id` | GET | Session store |
| `/api/sessions/:id/input` | POST | PTY manager `sendInput()` |
| `/api/sessions/:id/output` | GET | PTY manager `getOutput()` |
| `/api/sessions/:id/cancel` | POST | PTY manager `cancel()` |
| `/api/sessions/resume` | POST | PTY manager `start()` |
| `/ws` | GET | WebSocket upgrade → hub |

**Auth middleware:**
- Bearer token in `Authorization` header
- Fallback: `?key=` query param (for WebSocket)
- `localNoAuth` option skips auth for 127.0.0.1

### `auth.ts`

- `generateApiKey()` — returns `tb_<32 hex chars>`
- `validateApiKey(provided, expected)` — constant-time comparison
- Key persistence: `~/.threadbase/server.yaml`

### `cli/index.ts`

CLI entry point using commander:

```bash
threadbase-streamer serve [--port 3456] [--api-key KEY] [--local-no-auth]
```

Single command: `serve`. The scan/search/list CLI commands remain in the scanner package.

---

## Client Integration

| Client | Integration mode | What it imports/connects to |
|---|---|---|
| Mobile | HTTP + WebSocket | REST API + WS (same endpoints as Go CLI) |
| Electron (web mode) | HTTP + WebSocket | REST API + WS |
| Electron (app mode) | Direct import | `PTYManager`, `FileWatcher`, `SessionStore` |
| VS Code | Direct import | `PTYManager`, `FileWatcher` (adds resume capability) |
| IntelliJ | HTTP (child process) | Spawns `threadbase-streamer serve`, connects via REST + WS |

---

## Dependencies

```json
{
  "dependencies": {
    "node-pty": "^1.1.0",
    "ws": "^8.0.0",
    "@threadbase/scanner": "^0.1.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.12",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

No HTTP framework — uses Node.js built-in `node:http` for the REST server. Keeps dependencies minimal and avoids framework lock-in.

---

## Build

Same dual-build pattern as scanner (tsup):

1. **Library:** `src/index.ts` → `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types
2. **CLI:** `cli/index.ts` → `dist/cli.js` (ESM with shebang)

Prebuilt `node-pty` binaries bundled via `prebuild-install` in the `postinstall` script.

---

## Testing Strategy

- **Unit tests:** PTY manager (mock node-pty), session store, process discovery (mock shell commands), file watcher (temp JSONL files), auth
- **Integration tests:** Server endpoints with real HTTP requests, WebSocket connections
- **Fixtures:** Reuse scanner's `__fixtures__/` JSONL files where applicable
- **Platform:** Vitest, same as scanner

---

## Migration Plan

1. Build and publish `@threadbase/streamer`
2. Rename `cli/` → `cli-deprecated/` in the threadbase monorepo
3. Update mobile app to point at TypeScript server
4. Update Electron web mode to point at TypeScript server
5. Optionally: Electron app mode and VS Code import streamer library directly
