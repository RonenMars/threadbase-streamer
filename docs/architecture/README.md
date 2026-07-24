# Architecture

Architecture documents for **@threadbase-sh/streamer** — problem framing, alternatives, and the chosen approach for each substantial change, written before code. Dated chronologically. Past designs are kept rather than deleted: together they explain how the system got to its current shape.

## Index

| Date | Document | Scope |
|---|---|---|
| 2026-04-18 | [streamer](2026-04-18-streamer.md) | Extracting streamer, PTY, and server layers from the original Go CLI into a standalone TypeScript package. Foundational. |
| 2026-04-18 | [github-actions-ci](2026-04-18-github-actions-ci.md) | CI workflow design — lint / build / test jobs. |
| 2026-04-24 | [optional-postgresql](2026-04-24-optional-postgresql.md) | Optional PostgreSQL persistence behind a `SessionPersistence` interface; in-memory remains the default. |
| 2026-04-30 | [cache-layer](2026-04-30-cache-layer.md) | SQLite-backed cache for conversation metadata and message tails to remove cold-load latency on `/api/conversations` and `/api/conversations/{id}`. |
| 2026-05-02 | [quick-access-endpoints](2026-05-02-quick-access-endpoints.md) | Server-side recents + popular endpoints for the mobile Quick Access strip. |
| 2026-05-02 | [sessions-ws-push](2026-05-02-sessions-ws-push.md) | Replace HTTP polling for `/api/sessions/{id}/output` with WebSocket push to remove the blank-terminal flash. |
| 2026-06-11 | [scanner-conversation-memory](2026-06-11-scanner-conversation-memory.md) | Analysis of the scanner conversation-LRU resident-memory cost; decision to ship as-is (non-issue under current usage) and instrument before optimizing. |
| 2026-07-24 | [durable-session-runtime](2026-07-24-durable-session-runtime.md) | Decoupling agent PTY lifetime from WebSocket subscribers and streamer uptime. Measures why restart survival needs the PTY master fd to outlive the streamer, and scopes accordingly. |
| 2026-07-24 | [session-state-confidence](2026-07-24-session-state-confidence.md) | Surfacing how each session status was derived and how far to trust it, so a timer-driven guess is never reported as an observation. |
| 2026-07-24 | [provider-compatibility](2026-07-24-provider-compatibility.md) | Provider adapter interface, capability declarations, and schema-tolerant parsing that reports unknown events instead of silently dropping them. |
| 2026-07-24 | [device-identity-and-capabilities](2026-07-24-device-identity-and-capabilities.md) | Per-device identity and scoped capabilities, replacing one shared API key that gave every paired device full authority with no revocation or attribution. |

## Conventions

- Each file starts with **Date**, **Status**, and a **Problem** section.
- Alternatives considered are recorded, not erased after the decision.
- Files are immutable once their feature ships — corrections go in a new document that supersedes the old one. The historical record stays intact.
