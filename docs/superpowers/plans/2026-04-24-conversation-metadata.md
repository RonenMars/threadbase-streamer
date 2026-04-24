# Conversation Metadata in Managed Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend managed sessions with conversation metadata (session name, model, account, message count, preview, first/last messages, file path) so the session list API returns rich data without a second round-trip.

**Architecture:** New migration adds nullable columns to `managed_sessions`. `ManagedSession` type gains optional fields. `handleResume` in `server.ts` looks up `ConversationMeta` from the scanner cache and populates the new fields at resume time. All downstream code (persistence, response mapping) passes through the new fields.

**Tech Stack:** TypeScript, PostgreSQL (ALTER TABLE), vitest

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `src/db/migrations/002_add_conversation_metadata.sql` | Create | ALTER TABLE adds 10 columns |
| `src/types.ts` | Modify | Add optional fields to `ManagedSession` and `SessionResponse` |
| `src/db/pg-session-persistence.ts` | Modify | Update save INSERT, update fieldMap, loadAll SELECT mapping |
| `src/session-store.ts` | Modify | Update `managedToResponse` to map new fields |
| `src/server.ts` | Modify | Populate new fields from ConversationMeta in `handleResume` |
| `__tests__/db/pg-session-persistence.test.ts` | Modify | Update `makeSession`, add assertions for new columns |
| `__tests__/session-store.test.ts` | Modify | Update `makeManagedSession`, verify new response fields |

---

### Task 1: Migration

**Files:**
- Create: `src/db/migrations/002_add_conversation_metadata.sql`

- [ ] **Step 1: Create the migration file**

Create `src/db/migrations/002_add_conversation_metadata.sql`:

```sql
ALTER TABLE managed_sessions
  ADD COLUMN IF NOT EXISTS session_name TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS account TEXT,
  ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preview TEXT,
  ADD COLUMN IF NOT EXISTS first_message_text TEXT,
  ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_text TEXT,
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS file_path TEXT;
```

- [ ] **Step 2: Verify migration runs on the live DB**

```bash
npm run build && node dist/cli.cjs serve --verbose --local-no-auth
```

Check for `Database migrations applied` in output, then Ctrl+C. Verify:

```bash
psql "postgresql://postgres:password@localhost:5432/threadbase" -c "\d managed_sessions"
```

All 10 new columns should appear.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/002_add_conversation_metadata.sql
git commit -m "feat(streamer): add migration 002 for conversation metadata columns"
```

---

### Task 2: Extend Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add optional fields to `ManagedSession`**

In `src/types.ts`, add after `lastOutput: string;` (line 15):

```typescript
  sessionName?: string;
  model?: string;
  account?: string;
  messageCount?: number;
  preview?: string;
  firstMessageText?: string;
  firstMessageAt?: Date;
  lastMessageText?: string;
  lastMessageAt?: Date;
  filePath?: string;
```

- [ ] **Step 2: Add fields to `SessionResponse`**

In `src/types.ts`, add after `pid?: number;` (line 51):

```typescript
  sessionName?: string;
  model?: string;
  account?: string;
  messageCount?: number;
  preview?: string;
  firstMessageText?: string;
  firstMessageAt?: string;
  lastMessageText?: string;
  lastMessageAt?: string;
  filePath?: string;
```

- [ ] **Step 3: Run type check**

```bash
npx tsc --noEmit
```

Expected: PASS (new fields are all optional, so no existing code breaks).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(streamer): add conversation metadata fields to ManagedSession and SessionResponse"
```

---

### Task 3: Update PgSessionPersistence

**Files:**
- Modify: `src/db/pg-session-persistence.ts`
- Modify: `__tests__/db/pg-session-persistence.test.ts`

- [ ] **Step 1: Update test factory to include new fields**

In `__tests__/db/pg-session-persistence.test.ts`, update `makeSession` to include the new optional fields in its default:

```typescript
function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "ses_abc123",
    conversationId: "conv_xyz",
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-04-18T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    sessionName: "test-session",
    model: "claude-opus-4-6",
    account: "default",
    messageCount: 42,
    preview: "Hello world",
    firstMessageText: "Hi there",
    firstMessageAt: new Date("2026-04-18T09:55:00Z"),
    lastMessageText: "Goodbye",
    lastMessageAt: new Date("2026-04-18T10:00:00Z"),
    filePath: "/tmp/conv.jsonl",
    ...overrides,
  };
}
```

- [ ] **Step 2: Add test for save with new fields**

Add to the `save` describe block:

```typescript
    it("includes conversation metadata columns in insert", async () => {
      mockQuery.mockResolvedValueOnce({});
      await persistence.save(makeSession());

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("session_name");
      expect(sql).toContain("model");
      expect(sql).toContain("file_path");
      expect(params).toContain("test-session");
      expect(params).toContain("claude-opus-4-6");
      expect(params).toContain("/tmp/conv.jsonl");
    });
```

- [ ] **Step 3: Add test for loadAll deserialization of new fields**

Replace the existing `loadAll` "returns deserialized ManagedSession objects" test with:

```typescript
    it("returns deserialized ManagedSession objects with metadata", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "ses_abc123",
            conversation_id: "conv_xyz",
            project_path: "/tmp/project",
            project_name: "project",
            branch: "main",
            status: "running",
            started_at: new Date("2026-04-18T10:00:00Z"),
            completed_at: null,
            prompt_count: 0,
            last_output: "",
            session_name: "test-session",
            model: "claude-opus-4-6",
            account: "default",
            message_count: 42,
            preview: "Hello world",
            first_message_text: "Hi there",
            first_message_at: new Date("2026-04-18T09:55:00Z"),
            last_message_text: "Goodbye",
            last_message_at: new Date("2026-04-18T10:00:00Z"),
            file_path: "/tmp/conv.jsonl",
          },
        ],
      });

      const sessions = await persistence.loadAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses_abc123");
      expect(sessions[0].conversationId).toBe("conv_xyz");
      expect(sessions[0].sessionName).toBe("test-session");
      expect(sessions[0].model).toBe("claude-opus-4-6");
      expect(sessions[0].account).toBe("default");
      expect(sessions[0].messageCount).toBe(42);
      expect(sessions[0].preview).toBe("Hello world");
      expect(sessions[0].firstMessageText).toBe("Hi there");
      expect(sessions[0].firstMessageAt).toEqual(new Date("2026-04-18T09:55:00Z"));
      expect(sessions[0].lastMessageText).toBe("Goodbye");
      expect(sessions[0].lastMessageAt).toEqual(new Date("2026-04-18T10:00:00Z"));
      expect(sessions[0].filePath).toBe("/tmp/conv.jsonl");
    });
```

- [ ] **Step 4: Add test for loadAll with null metadata**

```typescript
    it("handles null metadata fields from DB", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "ses_abc123",
            conversation_id: "conv_xyz",
            project_path: "/tmp/project",
            project_name: "project",
            branch: "main",
            status: "running",
            started_at: new Date("2026-04-18T10:00:00Z"),
            completed_at: null,
            prompt_count: 0,
            last_output: "",
            session_name: null,
            model: null,
            account: null,
            message_count: 0,
            preview: null,
            first_message_text: null,
            first_message_at: null,
            last_message_text: null,
            last_message_at: null,
            file_path: null,
          },
        ],
      });

      const sessions = await persistence.loadAll();

      expect(sessions[0].sessionName).toBeUndefined();
      expect(sessions[0].model).toBeUndefined();
      expect(sessions[0].filePath).toBeUndefined();
    });
```

- [ ] **Step 5: Run tests to verify they fail**

```bash
npx vitest run __tests__/db/pg-session-persistence.test.ts
```

Expected: FAIL — save doesn't include new columns yet, loadAll doesn't map them.

- [ ] **Step 6: Update `save` method in `pg-session-persistence.ts`**

Replace the `save` method:

```typescript
  async save(session: ManagedSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO managed_sessions (
        id, conversation_id, project_path, project_name, branch,
        status, started_at, completed_at, prompt_count, last_output,
        session_name, model, account, message_count, preview,
        first_message_text, first_message_at, last_message_text, last_message_at, file_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        completed_at = EXCLUDED.completed_at,
        prompt_count = EXCLUDED.prompt_count,
        last_output = EXCLUDED.last_output,
        message_count = EXCLUDED.message_count,
        last_message_text = EXCLUDED.last_message_text,
        last_message_at = EXCLUDED.last_message_at,
        updated_at = NOW()`,
      [
        session.id,
        session.conversationId,
        session.projectPath,
        session.projectName,
        session.branch,
        session.status,
        session.startedAt,
        session.completedAt,
        session.promptCount,
        session.lastOutput,
        session.sessionName ?? null,
        session.model ?? null,
        session.account ?? null,
        session.messageCount ?? 0,
        session.preview ?? null,
        session.firstMessageText ?? null,
        session.firstMessageAt ?? null,
        session.lastMessageText ?? null,
        session.lastMessageAt ?? null,
        session.filePath ?? null,
      ],
    );
  }
```

- [ ] **Step 7: Update `update` fieldMap**

Add to the `fieldMap` object in the `update` method, after the `lastOutput` entry:

```typescript
      sessionName: "session_name",
      model: "model",
      account: "account",
      messageCount: "message_count",
      preview: "preview",
      firstMessageText: "first_message_text",
      firstMessageAt: "first_message_at",
      lastMessageText: "last_message_text",
      lastMessageAt: "last_message_at",
      filePath: "file_path",
```

- [ ] **Step 8: Update `loadAll` row type and mapping**

Replace the `loadAll` method:

```typescript
  async loadAll(): Promise<ManagedSession[]> {
    const { rows } = await this.pool.query<{
      id: string;
      conversation_id: string;
      project_path: string;
      project_name: string;
      branch: string;
      status: string;
      started_at: Date;
      completed_at: Date | null;
      prompt_count: number;
      last_output: string;
      session_name: string | null;
      model: string | null;
      account: string | null;
      message_count: number;
      preview: string | null;
      first_message_text: string | null;
      first_message_at: Date | null;
      last_message_text: string | null;
      last_message_at: Date | null;
      file_path: string | null;
    }>("SELECT * FROM managed_sessions ORDER BY started_at DESC");

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      projectPath: row.project_path,
      projectName: row.project_name,
      branch: row.branch,
      status: row.status as ManagedSession["status"],
      startedAt: row.started_at,
      completedAt: row.completed_at,
      promptCount: row.prompt_count,
      lastOutput: row.last_output,
      ...(row.session_name != null && { sessionName: row.session_name }),
      ...(row.model != null && { model: row.model }),
      ...(row.account != null && { account: row.account }),
      ...(row.message_count && { messageCount: row.message_count }),
      ...(row.preview != null && { preview: row.preview }),
      ...(row.first_message_text != null && { firstMessageText: row.first_message_text }),
      ...(row.first_message_at != null && { firstMessageAt: row.first_message_at }),
      ...(row.last_message_text != null && { lastMessageText: row.last_message_text }),
      ...(row.last_message_at != null && { lastMessageAt: row.last_message_at }),
      ...(row.file_path != null && { filePath: row.file_path }),
    }));
  }
```

- [ ] **Step 9: Run tests**

```bash
npx vitest run __tests__/db/pg-session-persistence.test.ts
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/db/pg-session-persistence.ts __tests__/db/pg-session-persistence.test.ts
git commit -m "feat(streamer): persist conversation metadata in PgSessionPersistence"
```

---

### Task 4: Update SessionStore Response Mapping

**Files:**
- Modify: `src/session-store.ts`
- Modify: `__tests__/session-store.test.ts`

- [ ] **Step 1: Update test factory**

In `__tests__/session-store.test.ts`, the `makeManagedSession` factory is fine as-is — new fields are optional so existing tests still work. Add a new test at the end of the `"response shape"` describe block:

```typescript
    it("maps conversation metadata fields to response", () => {
      store.addManaged(
        makeManagedSession({
          sessionName: "test-session",
          model: "claude-opus-4-6",
          account: "default",
          messageCount: 42,
          preview: "Hello world",
          firstMessageText: "Hi there",
          firstMessageAt: new Date("2026-04-18T09:55:00Z"),
          lastMessageText: "Goodbye",
          lastMessageAt: new Date("2026-04-18T10:00:00Z"),
          filePath: "/tmp/conv.jsonl",
        }),
      );

      const resp = store.get("ses_abc123");
      expect(resp?.sessionName).toBe("test-session");
      expect(resp?.model).toBe("claude-opus-4-6");
      expect(resp?.account).toBe("default");
      expect(resp?.messageCount).toBe(42);
      expect(resp?.preview).toBe("Hello world");
      expect(resp?.firstMessageText).toBe("Hi there");
      expect(resp?.firstMessageAt).toBe("2026-04-18T09:55:00.000Z");
      expect(resp?.lastMessageText).toBe("Goodbye");
      expect(resp?.lastMessageAt).toBe("2026-04-18T10:00:00.000Z");
      expect(resp?.filePath).toBe("/tmp/conv.jsonl");
    });

    it("omits undefined metadata fields from response", () => {
      store.addManaged(makeManagedSession());

      const resp = store.get("ses_abc123");
      expect(resp?.sessionName).toBeUndefined();
      expect(resp?.model).toBeUndefined();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run __tests__/session-store.test.ts
```

Expected: new tests FAIL because `managedToResponse` doesn't map the fields yet.

- [ ] **Step 3: Update `managedToResponse` in `session-store.ts`**

Replace the `managedToResponse` function:

```typescript
function managedToResponse(s: ManagedSession): SessionResponse {
  return {
    id: s.id,
    status: s.status,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    lastOutput: s.lastOutput,
    elapsedMs: (s.completedAt ?? new Date()).getTime() - s.startedAt.getTime(),
    promptCount: s.promptCount,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    conversationId: s.conversationId,
    source: "managed",
    ...(s.sessionName != null && { sessionName: s.sessionName }),
    ...(s.model != null && { model: s.model }),
    ...(s.account != null && { account: s.account }),
    ...(s.messageCount != null && { messageCount: s.messageCount }),
    ...(s.preview != null && { preview: s.preview }),
    ...(s.firstMessageText != null && { firstMessageText: s.firstMessageText }),
    ...(s.firstMessageAt != null && { firstMessageAt: s.firstMessageAt.toISOString() }),
    ...(s.lastMessageText != null && { lastMessageText: s.lastMessageText }),
    ...(s.lastMessageAt != null && { lastMessageAt: s.lastMessageAt.toISOString() }),
    ...(s.filePath != null && { filePath: s.filePath }),
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run __tests__/session-store.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-store.ts __tests__/session-store.test.ts
git commit -m "feat(streamer): map conversation metadata in session responses"
```

---

### Task 5: Populate Metadata at Resume Time

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update `handleResume` to look up ConversationMeta and populate fields**

In `src/server.ts`, replace the `handleResume` method. The key change: after finding the conversation, look up its `ConversationMeta` from the scanner cache and populate the new fields on the session before calling `addManaged`.

Replace the full `handleResume` method:

```typescript
  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { conversationId, projectPath: explicitPath } = body;

    if (!conversationId) {
      json(res, 400, { error: "Missing conversationId" });
      return;
    }

    let projectPath = explicitPath;
    const conv = await this.findConversationByUuid(conversationId);
    if (!projectPath) {
      if (!conv) {
        json(res, 404, { error: "Conversation not found" });
        return;
      }
      projectPath = (conv as any).projectPath;
    }

    const session = await this.ptyManager.start({
      conversationId,
      projectPath,
      projectName: body.projectName,
      branch: body.branch,
    });

    // Enrich session with conversation metadata
    if (conv) {
      session.sessionName = (conv as any).sessionName ?? undefined;
      session.messageCount = (conv as any).messageCount ?? 0;
      session.account = (conv as any).account ?? undefined;
      session.filePath = (conv as any).filePath ?? undefined;

      // Look up ConversationMeta from scanner cache for richer fields
      const scanner = await this.getScanner();
      const meta = conv.filePath ? scanner.getMetadataCache().get(conv.filePath) : undefined;
      if (meta) {
        session.model = meta.model ?? undefined;
        session.preview = meta.preview ?? undefined;
        session.firstMessageText = meta.firstMessage?.text ?? undefined;
        session.firstMessageAt = meta.firstMessage?.timestamp
          ? new Date(meta.firstMessage.timestamp)
          : undefined;
        session.lastMessageText = meta.lastMessage?.text ?? undefined;
        session.lastMessageAt = meta.lastMessage?.timestamp
          ? new Date(meta.lastMessage.timestamp)
          : undefined;
      }
    }

    this.sessionStore.addManaged(session);

    // Watch the conversation's JSONL file for structured events
    this.watchConversationFile(session.id, conversationId);

    const resp = this.sessionStore.get(session.id);
    this.wsHub.broadcast({ type: "session_list", sessions: this.sessionStore.list() });

    json(res, 201, resp ?? session);
  }
```

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run lint**

```bash
npx biome check src/server.ts
```

Fix any import ordering or formatting issues with `npx biome check --write src/server.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(streamer): populate conversation metadata on session resume"
```

---

### Task 6: Build, Migrate, and Verify

- [ ] **Step 1: Run full lint + type check**

```bash
npx tsc --noEmit && npx biome check src/ __tests__/
```

Expected: clean.

- [ ] **Step 2: Run all tests**

```bash
npx vitest run __tests__/db/ __tests__/session-store.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: success (migrations copied to dist/).

- [ ] **Step 4: Start server and verify migration applies**

```bash
node dist/cli.cjs serve --verbose --local-no-auth
```

Should see `Database migrations applied` — migration 002 runs. Ctrl+C.

- [ ] **Step 5: Verify new columns exist**

```bash
psql "postgresql://postgres:password@localhost:5432/threadbase" -c "\d managed_sessions" | grep -E "session_name|model|account|message_count|preview|first_message|last_message|file_path"
```

All 10 new columns should appear.
