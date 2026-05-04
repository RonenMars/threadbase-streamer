# Router Path Splitting Refactor

Refactor `src/server.ts` HTTP router to use `path.split('/')` instead of regex for dynamic route extraction.

## Background

The router currently uses `path.match(/^\/api\/...\/([^/]+)\/.../)` for every dynamic route. The `/adopt` route was already refactored as a reference — apply the same pattern to all remaining routes.

## Reference (already done — do not change)

```ts
const pathParts = path.split("/");
if (method === "POST" && pathParts[1] === "api" && pathParts[2] === "sessions" && pathParts[4] === "adopt" && pathParts.length === 5) {
  return await this.handleAdopt(pathParts[3], res);
}
```

## Routes to refactor

Find all remaining occurrences by grepping `path.match` in `src/server.ts`:

| Variable | Method | Path |
|----------|--------|------|
| `convMatch` | `GET` | `/api/conversations/:id` |
| `sessionMatch` | `GET` | `/api/sessions/:id` |
| `inputMatch` | `POST` | `/api/sessions/:id/input` |
| `filesMatch` | `POST` | `/api/sessions/:id/files` |
| `outputMatch` | `GET` | `/api/sessions/:id/output` |
| `cancelMatch` | `POST` | `/api/sessions/:id/cancel` |

## Rules

- Replace each `const xMatch = path.match(...)` + `if (method && xMatch)` pair with a `pathParts` check (same pattern as adopt)
- `pathParts` is already declared — do not redeclare it, just add `if` blocks alongside it
- The conversations route uses `decodeURIComponent` on the captured segment — preserve that
- Do not touch anything else in the file
- Run `npm run lint && npm test` after — all 180 tests must pass

## Kickoff message

```
Refactor the HTTP router in `src/server.ts` to replace regex-based path param extraction with `path.split('/')`.

Context: the router has no framework — it manually matches paths using `path.match(/^\/api\/.../)` to extract dynamic segments like session IDs. The `/adopt` route was already refactored as the reference pattern. Apply the same pattern to all remaining routes.

Reference (already done — do not touch):
  const pathParts = path.split("/");
  if (method === "POST" && pathParts[1] === "api" && pathParts[2] === "sessions" && pathParts[4] === "adopt" && pathParts.length === 5) {
    return await this.handleAdopt(pathParts[3], res);
  }

Routes to convert (grep `path.match` in `src/server.ts` to find them):
  - convMatch      → GET  /api/conversations/:id       (preserve decodeURIComponent on the ID)
  - sessionMatch   → GET  /api/sessions/:id
  - inputMatch     → POST /api/sessions/:id/input
  - filesMatch     → POST /api/sessions/:id/files
  - outputMatch    → GET  /api/sessions/:id/output
  - cancelMatch    → POST /api/sessions/:id/cancel

Constraints:
  - pathParts is already declared — do not redeclare it
  - Touch only the lines being replaced
  - Run `npm run lint && npm test` when done — all 180 tests must pass
```
