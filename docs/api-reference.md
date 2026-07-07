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
| GET | `/api/sessions/:id/output` | Get terminal output buffer |
| POST | `/api/sessions/:id/files` | Upload a file attachment |
| GET | `/api/conversations` | Paginated conversation history |
| GET | `/api/conversations/:id` | Full conversation with messages |
| GET | `/project-chats` | Active sessions + historical conversations, combined |
| GET | `/api/search?q=...` | Full-text search across conversations |
| GET | `/api/browse` | Browse the file system |
| GET | `/api/profiles` | List scan profiles |
| POST | `/api/pair/start` / `/api/pair/exchange` | Mobile pairing handshake |
