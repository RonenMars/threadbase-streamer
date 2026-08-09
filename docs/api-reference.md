# REST API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/healthz` | Health check |
| GET | `/api/info` | Server info |
| GET | `/api/sessions` | List active sessions |
| GET | `/api/sessions/:id` | Get a session |
| POST | `/api/sessions/start` | Start a session |
| POST | `/api/sessions/resume` | Resume a conversation |
| POST | `/api/sessions/:id/input` | Send input |
| POST | `/api/sessions/:id/cancel` | Cancel a session |
| POST | `/api/sessions/:id/fork` | Fork a Codex conversation into an independent session (`codex fork`). 201/202, 409 `CONVERSATION_BUSY`, 501 `UNSUPPORTED_PROVIDER` |
| PATCH | `/api/sessions/:id/model` | Switch a LIVE session's model: `{model}` → 202. 409 `SESSION_BUSY` mid-turn, 409 `SESSION_IDLE` with no PTY, 501 `UNSUPPORTED_PROVIDER` for Codex |
| PATCH | `/api/sessions/:id/effort` | Switch a LIVE session's effort: `{effort}` (`low`…`max`) → 202. Same error codes |
| GET | `/api/sessions/:id/output` | Get terminal output buffer |
| POST | `/api/sessions/:id/files` | Upload a file attachment |
| GET | `/api/conversations` | Paginated conversation history |
| GET | `/api/conversations/:id` | Full conversation with messages |
| GET | `/project-chats` | Active sessions + historical conversations, combined |
| GET | `/api/search?q=...` | Full-text search across conversations |
| GET | `/api/browse` | Browse the file system |
| GET | `/api/profiles` | List scan profiles |
| GET | `/api/config/claude-flags` | Allowlisted Claude CLI flags: `{registry, values, extraArgs, persisted}` (admin) |
| PUT | `/api/config/claude-flags` | Update those flags; 403 while `--local-no-auth` is active (admin) |
| GET | `/api/config/feature-flags` | Server feature flags: `{registry, values}`. Read-only — flags resolve at boot (admin) |
| POST | `/api/pair/start` / `/api/pair/exchange` | Mobile pairing handshake |
