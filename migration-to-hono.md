# Clean Code Practices for Hono Backend APIs

This guide summarizes recommended clean-code practices for building or refactoring a TypeScript backend with **Hono**, especially for a server like `@threadbase/streamer`: a Node.js API server with REST endpoints, WebSocket streaming, background services, SQLite persistence, and strict mobile-client compatibility.

---

## Core Philosophy

Hono is intentionally lightweight and unopinionated.

That is a strength, but it also means the project must define its own architecture boundaries.

The recommended rule is:

```txt
Hono should own HTTP routing and middleware.
Business logic should stay framework-agnostic.
WebSocket protocol should stay isolated from HTTP routing.
Core services should not know about Hono Context.
``


---

## Recommended Project Structure

```txt
src/
  api/
    app.ts
    server.ts

    env.ts
    deps.ts

    routes/
      health.routes.ts
      sessions.routes.ts
      conversations.routes.ts
      projects.routes.ts
      scanner.routes.ts

    handlers/
      health.handler.ts
      sessions.handler.ts
      conversations.handler.ts
      projects.handler.ts
      scanner.handler.ts

    middleware/
      auth.middleware.ts
      error.middleware.ts
      validation.middleware.ts
      request-id.middleware.ts
      logging.middleware.ts

    schemas/
      sessions.schema.ts
      conversations.schema.ts
      projects.schema.ts
      scanner.schema.ts

    response/
      json.ts
      errors.ts

    types/
      app-env.ts
      api-deps.ts

  ws/
    ws-hub.ts
    ws-protocol.ts
    ws-auth.ts

  core/
    session-manager.ts
    session-fsm.ts
    ring-buffer.ts
    process-discovery.ts

  services/
    session.service.ts
    conversation.service.ts
    project.service.ts
    scanner.service.ts

  persistence/
    sqlite/
      db.ts
      migrations.ts
      repositories/
        sessions.repository.ts
        conversations.repository.ts
        projects.repository.ts
        metadata.repository.ts

  background/
    idle-sweeper.ts
    conversation-watcher.ts
    reconcile.ts

  cli/
    index.ts
    config.ts

  lib/
    logger.ts
    time.ts
    crypto.ts
    result.ts

  index.ts
```

For a smaller codebase, this can be simplified, but the boundaries should remain the same.

---

## Layer Responsibilities

### `api/app.ts`

Creates and configures the Hono app.

Responsibilities:

- create `new Hono<AppEnv>()`
- register global middleware
- register route groups
- configure error handling
- return the app

Example:

```ts
export const createHonoApp = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>()

  app.use('*', requestIdMiddleware())
  app.use('*', loggingMiddleware(deps.logger))
  app.use('*', authMiddleware(deps))
  app.onError(errorMiddleware(deps.logger))

  app.route('/healthz', createHealthRoutes(deps))
  app.route('/sessions', createSessionRoutes(deps))
  app.route('/conversations', createConversationRoutes(deps))
  app.route('/projects', createProjectRoutes(deps))

  return app
}
```

---

### `api/server.ts`

Owns the Node.js server lifecycle.

Responsibilities:

- delegate HTTP requests to Hono
- start listening
- handle shutdown

---

### `api/routes/*`

Route files should be declarative.

They should define:

- HTTP method
- path
- middleware
- handler binding

They should not contain business logic.

Good:

```ts
export const createSessionRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>()

  app.get('/', listSessionsHandler(deps))
  app.post('/', validateJson(createSessionSchema), createSessionHandler(deps))
  app.post('/:sessionId/input', validateJson(sendInputSchema), sendInputHandler(deps))

  return app
}
```

Avoid:

```ts
app.post('/sessions', async (c) => {
  const body = await c.req.json()
  const row = db.prepare(...).get()
  await pty.write(...)
  return c.json(...)
})
```

---

### `api/handlers/*`

Handlers translate HTTP into service calls.

Responsibilities:

- read validated input
- read path/query params
- call services
- return API response
- avoid business logic

Handlers may know about Hono.

Services should not.

Example:

```ts
export const createSessionHandler =
  (deps: ApiDeps): Handler<AppEnv> =>
  async (c) => {
    const body = c.get('validatedBody')
    const session = await deps.sessionService.createSession(body)

    return c.json(session, 201)
  }
```

---

### `services/*`

Services contain application logic.

Responsibilities:

- coordinate core engine and persistence
- enforce use-case rules
- emit domain events
- call repositories
- avoid Hono imports

Example:

```ts
export const createSessionService = (deps: SessionServiceDeps) => ({
  createSession: async (input: CreateSessionInput) => {
    const session = await deps.sessionManager.spawn(input)
    await deps.sessionRepository.save(session)
    deps.wsHub.broadcastSessionUpdate(session)

    return session
  },
})
```

---

### `persistence/*`

Repositories own database access.

Responsibilities:

- SQL queries
- transactions
- persistence mapping
- SQLite-specific details

Avoid raw SQL in handlers.

Good:

```ts
await deps.sessionRepository.findById(sessionId)
```

Not:

```ts
db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
```

inside a route handler.

---

### `ws/*`

WebSocket logic should stay protocol-focused and isolated.

Responsibilities:

- connection lifecycle
- subscribe/unsubscribe
- terminal replay
- broadcast/unicast
- protocol validation

For this project, prefer:

```txt
Hono HTTP + raw Node WS
```

because the existing WebSocket hub likely has important lifecycle behavior tied to PTY output, replay buffers, and mobile-client compatibility.

---

## Clean Code Practices

## 1. Keep Hono Context out of core logic

Only `api/routes` and `api/handlers` should know about Hono.

Avoid this:

```ts
export const createSession = async (c: Context) => {
  const body = await c.req.json()
  ...
}
```

Prefer this:

```ts
export const createSession = async (input: CreateSessionInput) => {
  ...
}
```

This keeps services testable and portable.

---

## 2. Use dependency injection manually

Hono does not force a DI container.

That is good.

Prefer explicit dependency passing:

```ts
export const createSessionRoutes = (deps: ApiDeps) => {
  ...
}
```

Avoid global imports for stateful services:

```ts
import { sessionManager } from '../globals'
```

Explicit dependencies make tests and refactors easier.

---

## 3. Keep route files declarative

Route files should read like an API map.

Good route file:

```ts
app.get('/', listSessionsHandler(deps))
app.get('/:sessionId', getSessionHandler(deps))
app.post('/:sessionId/input', validateJson(inputSchema), sendInputHandler(deps))
```

Bad route file:

```ts
app.post('/:sessionId/input', async (c) => {
  // validation
  // database access
  // PTY write
  // WebSocket broadcast
  // response shaping
})
```

---

## 4. Keep handlers thin

Handlers should do translation, not orchestration-heavy work.

Handler responsibilities:

```txt
HTTP request -> validated input -> service call -> HTTP response
```

Service responsibilities:

```txt
business rules -> persistence -> core engine -> side effects
```

---

## 5. Validate at the edge

Use Zod at HTTP boundaries.

Invalid input should not reach services.

Recommended pattern:

```ts
app.post(
  '/',
  validateJson(createSessionSchema),
  createSessionHandler(deps),
)
```

Then handlers consume already-validated values:

```ts
const body = c.get('validatedBody')
```

---

## 6. Centralize error handling

Avoid `try/catch` in every handler.

Use:

```ts
app.onError(errorMiddleware(logger))
```

Create domain/API errors:

```ts
throw new ApiError({
  status: 404,
  code: 'SESSION_NOT_FOUND',
  message: 'Session not found',
})
```

Then normalize them in one place.

Benefits:

- stable API errors
- less duplicated code
- easier logging
- safer mobile compatibility

---

## 7. Preserve response contracts

For mobile compatibility, response shapes are part of the API contract.

Do not casually change:

- field names
- nested shapes
- status strings
- HTTP status codes
- event names
- WebSocket payloads

Safe:

```txt
Add optional fields.
```

Unsafe:

```txt
Rename existing fields.
Remove fields.
Change status strings.
Change array/object shape.
```

---

## 8. Define API contract tests

For a mobile-backed API, tests should verify paths and response shapes.

Recommended contract test coverage:

```txt
GET /healthz
GET /sessions
POST /sessions
GET /sessions/:id
POST /sessions/:id/input
POST /sessions/:id/kill
GET /conversations
GET /projects
scanner/cache endpoints
WebSocket subscribe/replay
```

Tests should assert:

- method
- path
- status code
- required fields
- auth behavior
- validation errors

---

## 9. Use typed Hono environment

Define app-level variables once.

Example:

```ts
export type AppEnv = {
  Variables: {
    requestId: string
    authToken?: string
    validatedBody?: unknown
    validatedQuery?: unknown
    validatedParams?: unknown
  }
}
```

For stronger typing, create route-specific helpers when needed.

---

## 10. Keep middleware focused

Good middleware examples:

```txt
auth middleware
request ID middleware
logging middleware
validation middleware
error middleware
```

Avoid middleware that does too much.

Bad:

```txt
auth + database lookup + permission logic + response shaping + logging
```

One middleware should have one clear responsibility.

---

## 11. Keep WebSocket protocol stable

For `@threadbase/streamer`, WebSocket compatibility is as important as REST compatibility.

Do not rename:

```txt
terminal_output
session_update
session_list
terminal_replay
```

Do not change payload structure unless the Expo app is updated at the same time.

Recommended split:

```txt
ws-hub.ts       -> connection management and fan-out
ws-protocol.ts  -> event names and payload types
ws-auth.ts      -> auth parsing/validation
```

---

## 12. Do not over-abstract early

Hono is lightweight.

Avoid bringing in:

- heavy DI containers
- Nest-like module systems
- abstract controller factories
- generic repository layers for tiny tables
- excessive class hierarchies

Prefer simple functions and explicit dependencies.

---

## 13. Keep background services outside Hono

Background services should not depend on Hono.

Examples:

```txt
IdleSweeper
ConversationWatcher
reconcile.ts
```

They should depend on services/core objects directly.

The server bootstrap should compose them.

---

## 14. Keep server startup explicit

Recommended startup flow:

```txt
load config
open database
run migrations
create repositories
create core services
create ws hub
create Hono app
create Node server
attach Hono request handler
attach WebSocket hub
start background services
listen
```

This is easier to debug than hiding startup inside route files or framework hooks.

---

## 15. Use stable status strings

Because mobile depends on status strings, define them as constants.

Example:

```ts
export const SessionStatus = {
  Running: 'running',
  WaitingInput: 'waiting_input',
  OnHold: 'on_hold',
  Completed: 'completed',
  Failed: 'failed',
} as const
```

Avoid inline string duplication.

---

## Recommended Hono Migration Strategy

For migrating from `node:http` + `InlineRouter` to Hono:

### Step 1: Inventory current contract

Document:

- all endpoints
- methods
- request shapes
- response shapes
- status codes
- auth behavior
- WebSocket messages/events

No code changes.

### Step 2: Add Hono beside the existing router

Add:

```bash
npm install hono @hono/node-server
```

Create `createHonoApp(deps)`.

Do not remove `InlineRouter` yet.

### Step 3: Port simple endpoints first

Start with low-risk routes:

```txt
/healthz
/version
/static metadata endpoints, if any
```

### Step 4: Port sessions routes

Move session endpoints carefully.

Session endpoints are high risk because they likely affect the Expo app and PTY lifecycle.

### Step 5: websockets
 without any hesitations go with Hono HTTP + @hono/node-ws
For a modern, clean refactor, using Hono's official Node WebSocket adapter (@hono/node-ws) is the better architectural choice.
Here is why:
1. Unified Authentication (The Biggest Advantage)
Currently, your server requires Bearer token auth (tb_<32-hex-chars>).
• With raw ws: You have to manually intercept the HTTP upgrade event on the Node server, manually parse the headers or query strings, and implement the constant-time comparison outside of your normal routing logic.
• With @hono/node-ws: You get to use Hono's routing and middleware. You can drop your Hono Bearer auth middleware right on the /ws route, and Hono handles the rejection before the WebSocket upgrade ever happens.
2. Clean Route Grouping
It keeps your API surface area in one place. Your WebSocket endpoints become just another route in your Hono tree (app.get('/ws', upgradeWebSocket(...))), rather than living in a detached HTTP upgrade listener.
How to adapt ws-hub.ts for @hono/node-ws
Because @hono/node-ws abstracts the connection into a cross-platform API, it doesn't give you a global wss.clients Set to iterate over for broadcasting.
To make your ws-hub.ts work, you will need to manually register connections into a Map or Set when they open, which you are likely doing anyway to track session subscriptions (session_update, terminal_replay).

’’’
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.get(
  '/ws', 
  authMiddleware, // Your Bearer auth runs first!
  upgradeWebSocket((c) => {
    return {
      onOpen(event, ws) {
        // Register the connection to your custom ws-hub
        WsHub.addClient(ws); 
      },
      onMessage(event, ws) {
        // Route messages to your PTY sessions
        WsHub.handleMessage(ws, event.data);
      },
      onClose(event, ws) {
        WsHub.removeClient(ws);
      }
    }
  })
)

const server = serve(app)
injectWebSocket(server) // Attaches the WS upgrade listener to the Node server
’’’

### Step 6: Add contract tests

Add tests before deleting the old router.

Verify paths, status codes, and response fields.

### Step 7: Remove InlineRouter

Only remove it after parity is proven.

---

## Recommended File-Level Conventions

## Exports

Prefer named exports:

```ts
export const createSessionRoutes = ...
```

Avoid default exports.

---

## Functions

Prefer arrow functions:

```ts
export const createSessionHandler = ...
```

---

## Naming

Use clear suffixes:

```txt
*.routes.ts
*.handler.ts
*.service.ts
*.repository.ts
*.schema.ts
*.middleware.ts
```

---

## Validation

Use schema names that describe the API input:

```ts
createSessionBodySchema
sendSessionInputBodySchema
listSessionsQuerySchema
sessionParamsSchema
```

---

## Responses

Centralize response helpers only if they preserve existing shapes.

Example:

```ts
export const jsonOk = <T>(c: Context, data: T) => {
  return c.json(data, 200)
}
```

Do not introduce wrappers like `{ success: true, data }` unless the current API already uses them.

---

## Error Handling Pattern

Recommended:

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
```

Central handler:

```ts
export const errorMiddleware =
  (logger: Logger) =>
  (err: Error, c: Context) => {
    if (err instanceof ApiError) {
      return c.json(
        {
          error: err.code,
          message: err.message,
          details: err.details,
        },
        err.status,
      )
    }

    logger.error({ err }, 'Unhandled API error')

    return c.json(
      {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      },
      500,
    )
  }
```

Important: adapt the exact error shape to the current API contract.

---

## Auth Middleware Pattern

For bearer-token auth:

```ts
export const authMiddleware =
  (deps: ApiDeps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const authorization = c.req.header('authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return c.json(existingUnauthorizedBody, 401)
    }

    const token = authorization.slice('Bearer '.length)

    if (!isValidTokenFormat(token)) {
      return c.json(existingUnauthorizedBody, 401)
    }

    if (!constantTimeTokenCompare(token, deps.config.apiToken)) {
      return c.json(existingUnauthorizedBody, 401)
    }

    await next()
  }
```

Preserve current error response body exactly.

---

## Testing Checklist

Before considering the migration complete:

```txt
npm run typecheck
npm run lint
npm test
npm run build
```

Use the actual package scripts.

Also manually verify:

```txt
Expo app can list sessions
Expo app can open a session
Expo app receives terminal replay
Expo app receives terminal output
Expo app sees session status updates
Expo app can send input
Expo app can resume/kill sessions if supported
Cloudflare Tunnel path still works
Bearer auth still works externally
```

---

## Summary Recommendation

For `@threadbase/streamer`, the cleanest architecture is:

```txt
Hono for HTTP routing, validation, auth, and error handling.

Hono HTTP + @hono/node-ws for the existing streaming protocol.
Framework-agnostic services for PTY/session/conversation logic.
SQLite repositories isolated from handlers.
Background workers composed at server startup.
Strict API/WebSocket contract tests to protect tb-mobile.
```

This gives you a cleaner server without turning the project into a framework-heavy rewrite.
