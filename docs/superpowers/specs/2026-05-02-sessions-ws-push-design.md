# Sessions WebSocket Push Optimization

**Date:** 2026-05-02  
**Status:** Approved  
**Scope:** tb-streamer (server) + tb-mobile (client)

---

## Context

With 9+ Claude sessions running simultaneously, opening a session in the mobile app shows a blank terminal for 1–2 seconds, and starting/resuming a session takes several seconds before anything appears.

**Root cause — two sequential pain points:**

1. **Blank terminal on open:** Mobile fires `GET /api/sessions/{id}/output` (HTTP), waits for a full round trip, then separately subscribes to WebSocket for live output. The HTTP call sits in a queue behind other server work (discovery, broadcasts), causing the blank black screen.

2. **Slow start/resume:** After `POST /api/sessions/start` or `resume`, mobile navigates to a `PendingSessionScreen` that spins waiting for a `session_update` WS event with `ptyAttached: true`. This is an inferred signal — the client has no way to know if the event it's waiting for has already happened.

**Goal:** Eliminate the HTTP round trip for terminal history, and replace the inferred `ptyAttached` polling with an explicit `session_ready` signal — making both transitions feel near-instant.

---

## Design

### New WebSocket Events

#### `terminal_replay` (server → specific client, unicast)

Sent by the server to a single client immediately after it sends `subscribe_session`. Contains the last 200 lines of the PTY ring buffer for that session.

```json
{
  "type": "terminal_replay",
  "sessionId": "abc-123",
  "lines": ["line1\r\n", "line2\r\n", "..."]
}
```

**Rules:**
- Only sent if the session has a live PTY (`ptyAttached`). On resume, the PTY is already attached by the time the client navigates and sends `subscribe_session` (resume is synchronous), so the ring buffer from the previous run is always available.
- Unicast to the subscribing client only — not broadcast
- Line count: last 200 lines (sliced from `outputBuffer`, split on `\n`)
- Sent synchronously in the `subscribe_session` handler, before any live `terminal_output` events

#### `session_ready` (server → all clients, broadcast)

Broadcast once the PTY is successfully spawned in `start()` / `startFresh()`. Carries the full `SessionResponse` shape (same as `session_update`).

```json
{
  "type": "session_ready",
  "session": { ...SessionResponse }
}
```

**Rules:**
- Broadcast to all connected clients (same as `session_update`)
- Fired once per PTY spawn — on `start()` and `startFresh()` (resume)
- Contains `ptyAttached: true` so clients can also handle it as a `session_update` if needed

---

### Server Changes (`tb-streamer`)

#### 1. `subscribe_session` handler → send `terminal_replay` (server.ts)

In the `ws.on("message")` handler where `subscribe_session` is processed, after calling `addSessionSubscriber()`, immediately unicast `terminal_replay` to the subscribing client:

```typescript
if (msg.type === "subscribe_session" && typeof msg.sessionId === "string") {
  this.addSessionSubscriber(msg.sessionId, ws);
  // NEW: replay ring buffer to this client only
  if (this.ptyManager.hasSession(msg.sessionId)) {
    const lines = this.ptyManager.getOutputLines(msg.sessionId, 200);
    ws.send(JSON.stringify({ type: "terminal_replay", sessionId: msg.sessionId, lines }));
  }
}
```

#### 2. `PTYManager.getOutputLines(sessionId, maxLines)` (pty-manager.ts)

New method alongside `getOutput()`. Splits the ring buffer on `\n`, returns the last `maxLines` entries:

```typescript
getOutputLines(sessionId: string, maxLines: number): string[] {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const raw = session.outputBuffer.toString("utf-8");
  const lines = raw.split("\n");
  return lines.slice(-maxLines);
}
```

#### 3. `session_ready` broadcast on PTY spawn (pty-manager.ts + server.ts)

Add an `onReady` callback to `PTYManagerOptions` (parallel to `onStatusChange`). Fire it at the end of `start()` / `startFresh()` once `ptyProcess` is set and the session is in `running` state.

In `server.ts`, wire the callback to broadcast `session_ready`:

```typescript
onReady: (session) => {
  const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
  if (resp) this.wsHub.broadcast({ type: "session_ready", session: resp });
}
```

#### 4. `POST /api/sessions/start` → 202 Accepted (server.ts)

Return immediately with a `pending_*` session before the PTY finishes spawning. The `session_ready` WS event carries the real session once ready.

```typescript
// Before PTY spawn:
const pendingId = `pending_${crypto.randomUUID()}`;
json(res, 202, { id: pendingId, status: "pending" });
// PTY spawn continues async → fires onReady when done
```

**Note:** Resume (`POST /api/sessions/resume`) already returns the session synchronously (PTY spawn is fast enough). Keep it as 201 for now — only add `session_ready` broadcast on top.

---

### Mobile Changes (`tb-mobile`)

#### 1. `useTerminalStream` — replace HTTP with WS `subscribe_session` + `terminal_replay`

Remove the `useQuery` for `/api/sessions/{id}/output`. Instead:

1. When the hook mounts (and WS is connected), send `{ type: "subscribe_session", sessionId }` via `wsManager`
2. Listen for `terminal_replay` events matching `sessionId`
3. Feed `lines.join("\n")` into `VirtualTerminal` exactly as today's HTTP response

**Backward compat fallback:** If no `terminal_replay` arrives within 2000ms of sending `subscribe_session`, fall back to `GET /api/sessions/{id}/output` (handles old streamers).

#### 2. `_layout.tsx` — handle `session_ready`

Add a `session_ready` listener alongside the existing `session_update` listener. Same navigation logic: push to `/session/${data.sessionId}`.

#### 3. `PendingSessionScreen` — listen for `session_ready` instead of inferring from `session_update`

Replace the `session_update` listener with:

```typescript
return client.on('session_ready', (msg) => {
  if (msg.type !== 'session_ready') return;
  router.replace(`/session/${msg.session.id}?server=${serverId}`);
});
```

Keep `session_update` as a fallback (for old streamers): if `ptyAttached: true` arrives via `session_update` before `session_ready`, still navigate.

---

### Types (`tb-streamer/src/types.ts`)

Add two new event types to the WS event union:

```typescript
| { type: "terminal_replay"; sessionId: string; lines: string[] }
| { type: "session_ready"; session: SessionResponse }
```

Add to `PTYManagerOptions`:
```typescript
onReady?: (session: ManagedSession) => void;
```

---

## Event Sequences

### Opening an existing session

```
Mobile                           Server
──────                           ──────
tap session card
navigate to /session/[id]
render empty terminal
WS send: subscribe_session   →   addSessionSubscriber()
                             ←   terminal_replay (last 200 lines, unicast)
feed lines → VirtualTerminal
render terminal
                             ←   terminal_output (live, broadcast)
stream continues
```

### Starting a new session

```
Mobile                           Server
──────                           ──────
POST /api/sessions/start     →   begin PTY spawn (async)
                             ←   202 { id: "pending_xyz" }
navigate /session/pending_xyz
PendingSessionScreen shown
                             ←   session_ready (PTY up)
router.replace /session/[id]
WS send: subscribe_session   →   addSessionSubscriber()
                             ←   terminal_replay (empty, PTY just started)
                             ←   terminal_output (live)
```

### Resuming an on_hold session

```
Mobile                           Server
──────                           ──────
POST /api/sessions/resume    →   spawn PTY
                             ←   201 { id, conversationId }
navigate /session/[id]
render empty terminal
WS send: subscribe_session   →   addSessionSubscriber()
                             ←   terminal_replay (ring buffer from before hold)
feed history
                             ←   session_ready (broadcast)
                             ←   terminal_output (live)
```

---

## Files to Change

### tb-streamer
| File | Change |
|------|--------|
| `src/types.ts` | Add `terminal_replay`, `session_ready` WS event types; add `onReady` to `PTYManagerOptions` |
| `src/pty-manager.ts` | Add `getOutputLines()` method; fire `onReady` callback at end of `start()` / `startFresh()` |
| `src/server.ts` | Wire `onReady` to broadcast `session_ready`; send `terminal_replay` in `subscribe_session` handler; make `POST /api/sessions/start` return 202 with pending ID |

### tb-mobile
| File | Change |
|------|--------|
| `hooks/useTerminalStream.ts` | Replace HTTP query with WS `subscribe_session` + `terminal_replay` listener; add 2s HTTP fallback |
| `app/_layout.tsx` | Add `session_ready` listener for navigation |
| `app/session/[id].tsx` | Update `PendingSessionScreen` to listen for `session_ready`; keep `session_update` fallback |
| `services/ws-client.ts` | Add `terminal_replay` and `session_ready` to the WS message union type |

---

## Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| New mobile + old streamer | `terminal_replay` never arrives → 2s timeout → HTTP fallback. `session_ready` never arrives → `session_update` fallback. No crash. |
| Old mobile + new streamer | Server sends `terminal_replay` / `session_ready` — old mobile ignores unknown event types. No regression. |
| New mobile + new streamer | Full optimized path. |

---

## Verification

### Server unit tests (vitest)
- `subscribe_session` → `terminal_replay` sent to subscribing client only, not others
- `terminal_replay` contains at most 200 lines
- `terminal_replay` not sent if session has no live PTY
- `session_ready` broadcast after PTY spawns in `start()` and `startFresh()`
- `POST /api/sessions/start` returns 202 before PTY is up

### Manual end-to-end
1. 9 sessions running → tap session → terminal fills within ~200ms (no blank screen)
2. Start new session → `PendingSessionScreen` resolves on `session_ready` without polling
3. Resume `on_hold` → previous ring buffer visible immediately on navigate
4. Kill WS mid-subscribe → 2s fallback fires, terminal loads via HTTP
5. Old streamer + new mobile → graceful degradation, no crash

### Performance target
- Time from tap to first terminal line: <300ms (down from ~1–2s)
- Log `subscribe_session` → `terminal_replay` latency server-side: target <10ms
