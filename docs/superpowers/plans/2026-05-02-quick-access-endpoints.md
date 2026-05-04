# Quick Access Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only API endpoints — `GET /api/sessions/recents` and `GET /api/projects/popular` — so the mobile Quick Access Strip can display server-accurate recents and popular project directories.

**Architecture:** Both endpoints are thin handlers on the existing `StreamerServer` class in `src/server.ts`. Recents sorts the in-memory session store; Popular queries the existing SQLite `conversation_meta` table via a new `getPopularProjects()` method on `ConversationCache`.

**Tech Stack:** TypeScript, Node.js `http` module (no framework), `better-sqlite3` for the SQLite cache, existing `SessionStore` and `ConversationCache` classes.

---

### Task 1: Add `getPopularProjects` to ConversationCache

**Files:**
- Modify: `src/conversation-cache.ts`
- Test: `src/conversation-cache.test.ts` (create if absent, otherwise add to it)

- [ ] **Step 1: Check whether a test file exists**

```bash
ls src/conversation-cache.test.ts 2>/dev/null || echo "missing"
```

If missing, create `src/conversation-cache.test.ts` with this skeleton:

```ts
import { ConversationCache } from './conversation-cache'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'

function makeTempCache(): ConversationCache {
  const dir = mkdtempSync(join(tmpdir(), 'cache-test-'))
  return ConversationCache.open(join(dir, 'cache.db'))
}
```

- [ ] **Step 2: Write the failing test**

Add to `src/conversation-cache.test.ts`:

```ts
describe('getPopularProjects', () => {
  it('returns projects ranked by conversation count descending', () => {
    const cache = makeTempCache()

    const base = { filePath: '/f', branch: null, account: null, model: null,
      messageCount: 0, lastActivity: Date.now(), firstMessage: null,
      lastMessage: null, preview: null, updatedAt: Date.now(), title: null }

    cache.upsertFromScannerMeta([
      { ...base, id: 'a1', projectPath: '~/my-app',   projectName: 'my-app',  filePath: '/f1' },
      { ...base, id: 'a2', projectPath: '~/my-app',   projectName: 'my-app',  filePath: '/f2' },
      { ...base, id: 'a3', projectPath: '~/my-app',   projectName: 'my-app',  filePath: '/f3' },
      { ...base, id: 'b1', projectPath: '~/work/api', projectName: 'api',     filePath: '/f4' },
      { ...base, id: 'b2', projectPath: '~/work/api', projectName: 'api',     filePath: '/f5' },
      { ...base, id: 'c1', projectPath: null,          projectName: null,      filePath: '/f6' },
    ])

    const result = cache.getPopularProjects(10)

    expect(result).toHaveLength(2) // null project_path excluded
    expect(result[0]).toEqual({ path: '~/my-app', name: 'my-app', sessionCount: 3 })
    expect(result[1]).toEqual({ path: '~/work/api', name: 'api', sessionCount: 2 })
    cache.close()
  })

  it('falls back to last path segment when project_name is null', () => {
    const cache = makeTempCache()
    const base = { filePath: '/f', branch: null, account: null, model: null,
      messageCount: 0, lastActivity: Date.now(), firstMessage: null,
      lastMessage: null, preview: null, updatedAt: Date.now(), title: null }

    cache.upsertFromScannerMeta([
      { ...base, id: 'x1', projectPath: '~/work/frontend', projectName: null, filePath: '/fx1' },
    ])

    const result = cache.getPopularProjects(10)
    expect(result[0].name).toBe('frontend')
    cache.close()
  })

  it('respects the limit parameter', () => {
    const cache = makeTempCache()
    const base = { filePath: '/f', branch: null, account: null, model: null,
      messageCount: 0, lastActivity: Date.now(), firstMessage: null,
      lastMessage: null, preview: null, updatedAt: Date.now(), title: null }

    cache.upsertFromScannerMeta([
      { ...base, id: 'p1', projectPath: '~/a', projectName: 'a', filePath: '/p1' },
      { ...base, id: 'p2', projectPath: '~/b', projectName: 'b', filePath: '/p2' },
      { ...base, id: 'p3', projectPath: '~/c', projectName: 'c', filePath: '/p3' },
    ])

    const result = cache.getPopularProjects(2)
    expect(result).toHaveLength(2)
    cache.close()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx jest conversation-cache --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `cache.getPopularProjects is not a function`

- [ ] **Step 4: Implement `getPopularProjects` in `src/conversation-cache.ts`**

Add this method inside the `ConversationCache` class (after `close()`):

```ts
getPopularProjects(limit: number): Array<{ path: string; name: string; sessionCount: number }> {
  const rows = this.db
    .prepare(
      `SELECT project_path, project_name, COUNT(*) as cnt
       FROM conversation_meta
       WHERE project_path IS NOT NULL
       GROUP BY project_path
       ORDER BY cnt DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ project_path: string; project_name: string | null; cnt: number }>

  return rows.map((r) => ({
    path: r.project_path,
    name: r.project_name ?? r.project_path.split('/').pop() ?? r.project_path,
    sessionCount: r.cnt,
  }))
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest conversation-cache --no-coverage 2>&1 | tail -20
```

Expected: PASS (3 new tests green)

- [ ] **Step 6: Commit**

```bash
git add src/conversation-cache.ts src/conversation-cache.test.ts
git commit -m "feat: add getPopularProjects to ConversationCache"
```

---

### Task 2: Add `GET /api/sessions/recents` handler

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts` (add to existing or create)

- [ ] **Step 1: Write the failing test**

Add to `src/server.test.ts` (or create with appropriate test server setup matching existing patterns):

```ts
describe('GET /api/sessions/recents', () => {
  it('returns sessions sorted by lastActivityAt descending', async () => {
    // Use existing test server helper or instantiate StreamerServer with test config
    const res = await request(app).get('/api/sessions/recents').set('Authorization', `Bearer ${TEST_KEY}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sessions')
    expect(res.body).toHaveProperty('total')
    expect(Array.isArray(res.body.sessions)).toBe(true)
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/sessions/recents')
    expect(res.status).toBe(401)
  })

  it('respects limit query param', async () => {
    const res = await request(app).get('/api/sessions/recents?limit=2').set('Authorization', `Bearer ${TEST_KEY}`)
    expect(res.status).toBe(200)
    expect(res.body.sessions.length).toBeLessThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest server --no-coverage 2>&1 | tail -20
```

Expected: FAIL — 404 on `/api/sessions/recents`

- [ ] **Step 3: Register the route in `src/server.ts`**

In `handleRequest` (around line 364), add the new route **before** the `sessionMatch` catch-all (line 377). Insert after the `/api/sessions/count` line:

```ts
// existing line ~364:
if (method === "GET" && path === "/api/sessions") return await this.handleListSessions(res);
if (method === "GET" && path === "/api/sessions/count") return this.handleSessionsCount(res);
// ADD THIS LINE:
if (method === "GET" && path === "/api/sessions/recents") return this.handleGetRecentSessions(url, res);
if (method === "POST" && path === "/api/sessions/resume")
// ... rest unchanged
```

- [ ] **Step 4: Implement `handleGetRecentSessions` in `src/server.ts`**

Add this method near `handleListSessions` (around line 846):

```ts
private handleGetRecentSessions(url: URL, res: ServerResponse): void {
  const limit = intParam(url, "limit", 20);
  const all = this.sessionStore.list(this.ptyAttachedIds());
  const sorted = [...all].sort((a, b) => {
    const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : new Date(a.startedAt).getTime();
    const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : new Date(b.startedAt).getTime();
    return bTime - aTime;
  });
  const sessions = sorted.slice(0, limit);
  json(res, 200, { sessions, total: sessions.length });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest server --no-coverage 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: add GET /api/sessions/recents endpoint"
```

---

### Task 3: Add `GET /api/projects/popular` handler

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/server.test.ts`:

```ts
describe('GET /api/projects/popular', () => {
  it('returns 200 with projects array and total', async () => {
    const res = await request(app).get('/api/projects/popular').set('Authorization', `Bearer ${TEST_KEY}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('projects')
    expect(res.body).toHaveProperty('total')
    expect(Array.isArray(res.body.projects)).toBe(true)
  })

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/projects/popular')
    expect(res.status).toBe(401)
  })

  it('respects limit query param', async () => {
    const res = await request(app).get('/api/projects/popular?limit=5').set('Authorization', `Bearer ${TEST_KEY}`)
    expect(res.status).toBe(200)
    expect(res.body.projects.length).toBeLessThanOrEqual(5)
  })

  it('each project has path, name, sessionCount', async () => {
    const res = await request(app).get('/api/projects/popular').set('Authorization', `Bearer ${TEST_KEY}`)
    for (const p of res.body.projects) {
      expect(typeof p.path).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(typeof p.sessionCount).toBe('number')
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest server --no-coverage 2>&1 | tail -20
```

Expected: FAIL — 404 on `/api/projects/popular`

- [ ] **Step 3: Register the route in `src/server.ts`**

In `handleRequest`, add after the existing conversation routes (around line 362):

```ts
// existing lines:
if (method === "GET" && path === "/api/conversations") ...
if (method === "GET" && path === "/api/conversations/count") ...
// ADD THIS LINE:
if (method === "GET" && path === "/api/projects/popular") return this.handleGetPopularProjects(url, res);
```

- [ ] **Step 4: Implement `handleGetPopularProjects` in `src/server.ts`**

Add this method near the other handler methods:

```ts
private handleGetPopularProjects(url: URL, res: ServerResponse): void {
  const limit = intParam(url, "limit", 20);
  if (!this.cache) {
    json(res, 200, { projects: [], total: 0 });
    return;
  }
  const projects = this.cache.getPopularProjects(limit);
  json(res, 200, { projects, total: projects.length });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest server --no-coverage 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 6: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -10
```

Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "feat: add GET /api/projects/popular endpoint"
```

---

### Task 4: Manual smoke test

- [ ] **Step 1: Start the streamer locally**

```bash
npm run dev
```

- [ ] **Step 2: Get your API key**

```bash
cat ~/.config/threadbase/config.json | grep apiKey
# or wherever the key is stored locally
```

- [ ] **Step 3: Hit both endpoints**

```bash
curl -s -H "Authorization: Bearer <key>" http://localhost:3000/api/sessions/recents | jq .
curl -s -H "Authorization: Bearer <key>" http://localhost:3000/api/projects/popular | jq .
```

Expected: JSON with `sessions`/`projects` arrays and `total` field. Sessions sorted newest-first.

- [ ] **Step 4: Verify route ordering — recents not swallowed by session catch-all**

```bash
curl -s -H "Authorization: Bearer <key>" http://localhost:3000/api/sessions/recents | jq '.sessions | length'
```

Expected: a number (not a 404 or "session not found" error).
