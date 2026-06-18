# Claude Code Source of Truth: Backend ProjectChat + Projects Migration for `@threadbase-sh/streamer`

## Purpose

You are working on the Node.js backend package:

```txt
@threadbase-sh/streamer
```

This document is the consolidated backend implementation prompt for Claude Code.

It merges:

1. The backend architecture/migration plan for introducing a normalized `projects` table.
2. The corrected product lifecycle around sessions and conversations.
3. The `project_path` → `project_id` migration plan.
4. The ProjectChat API/listing model.
5. The cache refresh strategy based on the latest HDD conversation id.
6. Recommended backend libraries and where to use them.

The goal is to evolve the existing backend safely.

Do **not** rewrite the backend from scratch.

---

# Current Backend Context

The package currently has:

```txt
better-sqlite3
pino
pino-http
Vitest
TypeScript
tsx
tsup
Biome
existing src/db/migrations copied into dist during build
```

It currently does **not** use:

```txt
Kysely or Drizzle
a dedicated migration library
zod
date-fns
chokidar
```

Current package characteristics:

```txt
ESM package
Node >= 18
TypeScript-first
Vitest tests
tsx scripts
existing DB migrations folder convention
```

The existing build script copies:

```txt
src/db/migrations -> dist/migrations
```

So any migration solution should respect the current migration folder convention.

---

# Current Product/Data Model

The app has two types of project chats:

```txt
Session       = active/live chat
Conversation = historical/resumable chat scanned from HDD
ProjectChat  = UI-facing union of Session or Conversation
```

Currently, both sessions and conversations have:

```txt
project_path
```

This `project_path` is effectively the project identity.

However, there is currently no normalized `projects` table.

---

# Target Data Model

Introduce a real `projects` table.

Target relationship:

```txt
projects.id -> sessions.project_id
projects.id -> conversations.project_id
```

During migration, keep both fields:

```txt
project_id   = primary relationship
project_path = temporary compatibility/display/debug metadata
```

Long-term direction:

```txt
Use project_id everywhere internally.
Use projects.path as the canonical project path source.
Stop treating sessions.project_path / conversations.project_path as the main identity.
```

---

# Critical Lifecycle Correction

Sessions do **not** introduce project paths that are missing from historical conversations.

Correct lifecycle:

```txt
session created successfully
  ↓
conversation is created on disk immediately after
  ↓
conversation scanner/cache sees the new conversation
  ↓
project is created/updated from conversation.project_path
  ↓
session and conversation are linked to project_id
```

Therefore:

```txt
Project discovery is conversation/HDD-based.
```

Do **not** create a separate project-discovery path from sessions.

If a session has a `project_path` that is missing from `projects`, it usually means:

```txt
the conversation index/cache is stale
```

In that case, refresh the conversation cache first.

---

# Current Cache Behavior

The existing cache layer behaves roughly like this:

```txt
Request comes in
  ↓
Check cache layer
  ↓
If cached data exists:
  return cached data
  ↓
If no cached data exists:
  fetch entity data from DB/source
  cache the data
  return the data
  ↓
If refresh=1 query param exists:
  fetch fresh entity data from DB/source
  replace cache data
  return fresh data
```

Preserve this general behavior.

But make the behavior source-specific:

```txt
Sessions:
  active/live
  built from SessionStore / DB / runtime state
  short in-memory cache around OS/process discovery is OK

Conversations:
  historical/indexed
  backed by persistent SQLite cache
  refreshed from HDD only when needed or explicitly requested
```

---

# Desired Cache Refresh Rule

Reload the projects/conversations list only when needed.

Recommended rule:

```txt
Check latest conversation created on HDD.
Compare it to latest conversation id known by app/cache.
If same:
  no need to re-fetch/reload projects/conversations.
If different:
  refresh or incrementally update conversations/projects.
```

Explicit refresh should still work:

```txt
refresh=1
refreshConversations=1
```

Suggested semantics:

```txt
GET /project-chats
  normal request
  backend decides whether refresh is needed based on latest HDD conversation id

GET /project-chats?refreshConversations=1
  force conversation/project refresh

GET /conversations?refresh=1
  existing explicit refresh behavior
```

---

# Recommended Backend Libraries

## Already installed: `better-sqlite3`

Keep using it.

Use it for:

```txt
SQLite DB access
transactions
projects table
conversations cache
cache_metadata table
schema migrations
project_path -> project_id backfill
```

Use transactions for:

```txt
upsert project
update conversation.project_id
update session.project_id
update cache_metadata.last_conversation_id
message insert + latest_message metadata update
```

Example:

```ts
const linkConversationAndSessionToProject = db.transaction(() => {
  const project = upsertProjectByPath(projectPath);

  updateConversationProjectId({
    conversationId,
    projectId: project.id,
  });

  updateSessionProjectId({
    sessionId,
    projectId: project.id,
  });

  setCacheMetadata("last_conversation_id", conversationId);
});
```

---

## Already installed: `pino` / `pino-http`

Keep using it.

Add structured logs around:

```txt
projects.migration.started
projects.migration.completed
projects.upserted
conversations.refresh.started
conversations.refresh.completed
cache.latestConversation.changed
cache.latestConversation.unchanged
session.created.conversationLinked
session.projectId.backfilled
conversation.projectId.backfilled
resume.projectId.repaired
```

Example:

```ts
logger.info(
  {
    conversationId,
    projectId,
    projectPath,
  },
  "conversation.projectId.backfilled",
);
```

Avoid noisy per-row logs unless debug mode is enabled.

---

## Add now: `zod`

Install:

```bash
npm install zod
```

Use `zod` for runtime validation at boundaries.

Where to use it:

```txt
src/schemas/
src/http/handlers/
src/services/projectChats/
src/services/conversations/
src/services/sessions/
src/db/repositories/
```

Suggested files:

```txt
src/schemas/projectChat.schema.ts
src/schemas/messageCursor.schema.ts
src/schemas/queryParams.schema.ts
src/schemas/conversation.schema.ts
src/schemas/project.schema.ts
```

Validate:

```txt
refresh query params
ProjectChat API shape
MessageCursor
scanner/HDD conversation records
cache metadata shape
legacy/new data during migration
```

Example query param schema:

```ts
import { z } from "zod";

export const ListProjectChatsQuerySchema = z.object({
  refresh: z.enum(["1"]).optional(),
  refreshConversations: z.enum(["1"]).optional(),
});
```

Example cursor schema:

```ts
export const MessageCursorSchema = z.object({
  timestamp: z.string().datetime(),
  id: z.string().min(1),
});
```

Example scanned conversation schema:

```ts
export const ScannedConversationSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  latestMessageAt: z.string().datetime().nullable().optional(),
});
```

---

## Add now: `date-fns`

Install:

```bash
npm install date-fns
```

Use it for safer date parsing/comparison around ISO timestamps.

Where to use it:

```txt
src/utils/dates.ts
src/services/projectChats/sortProjectChats.ts
src/services/cache/cacheMetadata.ts
src/services/conversations/getLatestConversation.ts
```

Create a small wrapper instead of spreading date helpers everywhere:

```ts
// src/utils/dates.ts
import { compareDesc, isValid, parseISO } from "date-fns";

export const parseIsoDateOrNull = (value?: string | null): Date | null => {
  if (!value) return null;

  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
};

export const compareIsoDesc = (
  a?: string | null,
  b?: string | null,
): number => {
  const dateA = parseIsoDateOrNull(a);
  const dateB = parseIsoDateOrNull(b);

  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;

  return compareDesc(dateA, dateB);
};
```

Use this for:

```txt
latest conversation selection
ProjectChat sorting
cache freshness checks
timestamp fallback sorting
```

Do not overuse it for simple:

```ts
new Date().toISOString()
```

---

## Add if useful now: `chokidar`

Install:

```bash
npm install chokidar
```

Use it as an optimization for HDD conversation changes.

Important:

```txt
chokidar should not be the only correctness mechanism.
```

File watchers can miss events or behave differently across OS/filesystems.

Reliable fallbacks must remain:

```txt
refresh=1
latest HDD conversation id check
manual full refresh
startup consistency check
```

Where to use it:

```txt
src/services/conversations/conversationWatcher.ts
src/services/cache/conversationInvalidation.ts
```

Recommended behavior:

```txt
watch conversation directory/directories
detect add/change/unlink
mark conversations/projects cache as dirty
optionally update latest_conversation_id metadata
debounce file bursts
avoid full rescan immediately on every event
```

Example:

```ts
import chokidar from "chokidar";

export const startConversationWatcher = ({
  conversationsDir,
  onConversationChanged,
}: {
  conversationsDir: string;
  onConversationChanged: () => void | Promise<void>;
}) => {
  const watcher = chokidar.watch(conversationsDir, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on("add", onConversationChanged);
  watcher.on("change", onConversationChanged);
  watcher.on("unlink", onConversationChanged);

  return watcher;
};
```

Recommended cache interaction:

```txt
file event
  -> mark cache dirty
  -> next /project-chats request checks dirty flag/latest id
  -> refresh if needed
```

---

## Consider later: Kysely or Drizzle

Do **not** install both.

### Option A: Kysely

Install if chosen:

```bash
npm install kysely
```

Use Kysely if you want:

```txt
typed SQL
minimal abstraction
safer refactors
less stringly-typed repository code
```

Suggested locations:

```txt
src/db/kysely.ts
src/db/schema.ts
src/repositories/projects.repository.ts
src/repositories/conversations.repository.ts
src/repositories/sessions.repository.ts
```

Good use cases:

```txt
projects table queries
conversation backfill queries
sessions project_id repair
cache_metadata queries
ProjectChat list queries
```

Recommendation:

```txt
Use Kysely later if raw SQL gets hard to maintain.
```

### Option B: Drizzle

Install if chosen:

```bash
npm install drizzle-orm
npm install -D drizzle-kit
```

Use Drizzle if you want:

```txt
schema as TypeScript
typed queries
migration generation
less manual schema drift
```

If choosing Drizzle, make sure `drizzle-kit` generates into the existing migration convention:

```txt
src/db/migrations
```

Do not create a second competing migration system.

Recommendation:

```txt
Use Drizzle only if the team wants schema-driven DB ownership now.
```

### Preferred choice for this codebase

Given the existing package already has `better-sqlite3`, `pino`, `tsx`, Vitest, and `src/db/migrations`, prefer:

```txt
better-sqlite3
custom migration runner
zod
date-fns
optional chokidar
```

Consider Kysely later.

---

# Migration Runner Recommendation

Do **not** introduce a heavy migration framework immediately.

Because the project already has:

```txt
src/db/migrations
build copies migrations to dist/migrations
better-sqlite3
tsx
```

Use a small custom migration runner first.

Suggested files:

```txt
src/db/migrate.ts
src/db/migrations/001_create_projects.sql
src/db/migrations/002_add_project_id_columns.sql
src/db/migrations/003_create_cache_metadata.sql
scripts/migrate.ts
scripts/migrate-projects.ts
scripts/validate-db.ts
```

Migration tracking table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

Runner behavior:

```txt
read migrations directory
sort by filename
skip already applied migrations
run each migration in transaction
insert into schema_migrations
log applied/skipped
```

Suggested package scripts:

```json
{
  "migrate": "tsx scripts/migrate.ts",
  "migrate:projects": "tsx scripts/migrate-projects.ts",
  "db:validate": "tsx scripts/validate-db.ts"
}
```

---

# Phase 1: Create `projects` Table

Add:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,

  -- Canonical normalized path used to dedupe projects.
  path TEXT NOT NULL UNIQUE,

  -- Optional display name derived from the directory name or existing metadata.
  name TEXT,

  -- Conversation-based indexing metadata.
  last_conversation_id TEXT,
  last_conversation_created_at TEXT,
  last_indexed_at TEXT,

  -- Optional project-level activity metadata.
  latest_message_at TEXT,
  latest_message_id TEXT,
  message_count INTEGER DEFAULT 0,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Notes:

```txt
projects.path is the canonical project path.
projects.id is the stable identity used by sessions/conversations/UI.
last_conversation_id is used for cache freshness decisions.
```

---

# Phase 2: Add `cache_metadata` Table

Add:

```sql
CREATE TABLE IF NOT EXISTS cache_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Suggested keys:

```txt
last_conversation_id
last_conversation_created_at
projects_last_indexed_at
conversations_last_indexed_at
conversations_dirty
```

Use this table to decide whether to reload projects/conversations.

---

# Phase 3: Add `project_id` to Conversations and Sessions

Add nullable columns first:

```sql
ALTER TABLE conversations ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN project_id TEXT;
```

If SQLite migration tooling cannot safely add foreign keys after table creation, keep the field without FK initially and enforce consistency in code.

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_conversations_project_id
ON conversations(project_id);

CREATE INDEX IF NOT EXISTS idx_sessions_project_id
ON sessions(project_id);
```

Keep `project_path`.

Do not drop it yet.

---

# Phase 4: Canonicalize `project_path`

Create one shared utility.

Suggested location:

```txt
src/utils/canonicalizeProjectPath.ts
```

Example:

```ts
export const canonicalizeProjectPath = (projectPath: string): string => {
  return projectPath.trim().replace(/\/+$/, "");
};
```

Important rules:

```txt
Use this same function everywhere.
Do not dedupe raw project_path strings.
Do not aggressively lowercase unless product explicitly accepts it.
Avoid merging different real projects accidentally.
```

Use it in:

```txt
conversation scan/refresh
project upsert
migration/backfill script
session creation after disk conversation creation
resume repair path
```

---

# Phase 5: Backfill Projects from Scanned Conversations

Project creation should happen after conversations have been scanned/indexed.

Implementation:

```txt
1. Run/use existing conversation scan/cache refresh.
2. Read all scanned/cached conversations.
3. Extract conversation.project_path.
4. Canonicalize paths.
5. Dedupe paths.
6. Insert/upsert one project row per unique path.
7. Track latest conversation id per project.
8. Update cache_metadata.last_conversation_id.
```

Pseudo-code:

```ts
export const ensureProjectsFromConversations = async (
  conversations: Conversation[],
): Promise<Map<string, string>> => {
  const conversationsByProjectPath = new Map<string, Conversation[]>();

  for (const conversation of conversations) {
    if (!conversation.projectPath) continue;

    const canonicalPath = canonicalizeProjectPath(conversation.projectPath);
    const existing = conversationsByProjectPath.get(canonicalPath) ?? [];
    existing.push(conversation);
    conversationsByProjectPath.set(canonicalPath, existing);
  }

  const pathToProjectId = new Map<string, string>();

  for (const [path, projectConversations] of conversationsByProjectPath) {
    const latestConversation = getLatestConversation(projectConversations);

    const project = await upsertProjectByPath(path, {
      lastConversationId: latestConversation?.id ?? null,
      lastConversationCreatedAt: latestConversation?.createdAt ?? null,
      latestMessageAt: latestConversation?.latestMessageAt ?? null,
    });

    pathToProjectId.set(path, project.id);
  }

  return pathToProjectId;
};
```

Suggested upsert behavior:

```sql
INSERT INTO projects (
  id,
  path,
  name,
  last_conversation_id,
  last_conversation_created_at,
  latest_message_at,
  created_at,
  updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  name = COALESCE(excluded.name, projects.name),
  last_conversation_id = excluded.last_conversation_id,
  last_conversation_created_at = excluded.last_conversation_created_at,
  latest_message_at = COALESCE(excluded.latest_message_at, projects.latest_message_at),
  updated_at = excluded.updated_at
RETURNING *;
```

If `RETURNING` is not available:

```sql
INSERT OR IGNORE INTO projects (...);
UPDATE projects SET ... WHERE path = ?;
SELECT * FROM projects WHERE path = ?;
```

---

# Phase 6: Backfill `project_id` on Conversations

After projects exist, update conversations.

Prefer TypeScript-level backfill to ensure canonicalization is applied:

```ts
const conversations = await listConversationsFromDb();

for (const conversation of conversations) {
  const canonicalPath = canonicalizeProjectPath(conversation.projectPath);
  const project = await upsertProjectByPath(canonicalPath);

  await updateConversationProjectId({
    conversationId: conversation.id,
    projectId: project.id,
  });
}
```

If the DB already stores canonical paths, SQL is acceptable:

```sql
UPDATE conversations
SET project_id = (
  SELECT projects.id
  FROM projects
  WHERE projects.path = conversations.project_path
)
WHERE project_id IS NULL
  AND project_path IS NOT NULL;
```

---

# Phase 7: Backfill `project_id` on Sessions

Sessions should not be used as primary project discovery.

Backfill sessions by resolving their `project_path` against existing projects.

Preferred behavior:

```txt
Use existing project by canonical path.
If missing, refresh conversation cache first.
Only create project from session as a last-resort self-healing fallback, with a clear warning log.
```

Pseudo-code:

```ts
const sessions = await listSessionsFromDbOrStore();

for (const session of sessions) {
  const canonicalPath = canonicalizeProjectPath(session.projectPath);

  let project = await getProjectByPath(canonicalPath);

  if (!project) {
    await refreshConversationCache();
    project = await getProjectByPath(canonicalPath);
  }

  if (!project) {
    logger.warn(
      { sessionId: session.id, projectPath: canonicalPath },
      "session.projectId.missingProjectAfterConversationRefresh",
    );

    project = await upsertProjectByPath(canonicalPath);
  }

  await updateSessionProjectId({
    sessionId: session.id,
    projectId: project.id,
  });
}
```

---

# Phase 8: Update Conversation Scan/Refresh Flow

Current conceptual flow:

```txt
scan HDD
extract conversation
store conversation with project_path
cache conversation
return conversations
```

Target flow:

```txt
scan HDD
extract conversation
validate scanned conversation with zod
extract project_path
canonicalize project_path
upsert project by path
store conversation with project_id and project_path
cache conversation
update projects metadata
update cache_metadata.last_conversation_id
return conversations
```

Keep both fields:

```ts
{
  projectId: project.id,
  projectPath: canonicalPath,
}
```

---

# Phase 9: Update Session Creation Flow

Correct lifecycle:

```txt
create session
create conversation on disk
derive project_path from created conversation/session
upsert project by canonical path
link conversation.project_id
link session.project_id
update cache_metadata.last_conversation_id
```

Pseudo-code:

```ts
export const createSessionForProjectPath = async ({
  projectPath,
  ...rest
}) => {
  const canonicalPath = canonicalizeProjectPath(projectPath);

  const session = await createSessionInternal({
    ...rest,
    projectPath: canonicalPath,
  });

  const conversation = await createConversationOnDiskForSession(session);

  const project = await upsertProjectByPath(canonicalPath, {
    lastConversationId: conversation.id,
    lastConversationCreatedAt: conversation.createdAt,
    latestMessageAt: conversation.latestMessageAt,
  });

  await updateSessionProjectId({
    sessionId: session.id,
    projectId: project.id,
  });

  await updateConversationProjectId({
    conversationId: conversation.id,
    projectId: project.id,
  });

  await setCacheMetadata("last_conversation_id", conversation.id);
  await setCacheMetadata("last_conversation_created_at", conversation.createdAt);

  return {
    ...session,
    projectId: project.id,
  };
};
```

Important:

```txt
Update project/project-cache after the conversation is created on disk.
Do not reload the whole projects list if latest conversation id did not change.
```

---

# Phase 10: Latest Conversation ID Refresh Strategy

Create helper:

```ts
export const shouldRefreshProjectsFromHdd = async (): Promise<boolean> => {
  const latestOnDisk = await getLatestConversationOnDisk();
  const cachedLastConversationId = await getCacheMetadata("last_conversation_id");

  if (!latestOnDisk) return false;

  return latestOnDisk.id !== cachedLastConversationId;
};
```

Use in list flow:

```ts
export const listProjects = async ({ refresh }: { refresh: boolean }) => {
  if (refresh) {
    return refreshProjectsFromConversations();
  }

  const shouldRefresh = await shouldRefreshProjectsFromHdd();

  if (shouldRefresh) {
    return refreshProjectsFromConversations();
  }

  return getProjectsFromCacheOrDb();
};
```

For `/project-chats`:

```txt
if refreshConversations=1:
  force refresh conversations/projects
else:
  check latest HDD conversation id
  refresh only if changed
```

---

# Phase 11: Update Resume Flow

When resuming a conversation:

```txt
conversation -> session
```

Target:

```txt
conversation.project_id -> session.project_id
conversation.project_path -> fallback only
session.resumed_from_conversation_id = conversation.id
```

Pseudo-code:

```ts
export const resumeConversation = async (conversationId: string) => {
  const conversation = await getConversation(conversationId);

  let projectId = conversation.projectId;

  if (!projectId) {
    const canonicalPath = canonicalizeProjectPath(conversation.projectPath);

    let project = await getProjectByPath(canonicalPath);

    if (!project) {
      await refreshConversationCache();
      project = await getProjectByPath(canonicalPath);
    }

    if (!project) {
      project = await upsertProjectByPath(canonicalPath);
    }

    projectId = project.id;

    await updateConversationProjectId({
      conversationId,
      projectId,
    });
  }

  const session = await createSession({
    projectId,
    projectPath: conversation.projectPath,
    resumedFromConversationId: conversation.id,
  });

  return {
    conversationId: conversation.id,
    sessionId: session.id,
    status: "resumed",
  };
};
```

Important:

```txt
Resume should not create duplicate projects.
The active session should hide/dedupe the original conversation in ProjectChat list.
```

---

# Phase 12: ProjectChat Type

Expose UI-facing union type:

```ts
export type ProjectChat =
  | {
      type: "session";
      id: string;
      projectId: string;
      projectPath?: string | null;
      title: string;
      latestMessageAt: string | null;
      updatedAt?: string | null;
      createdAt?: string | null;
      status: "active";
      source: "session-store";
      resumedFromConversationId?: string | null;
    }
  | {
      type: "conversation";
      id: string;
      projectId: string;
      projectPath?: string | null;
      title: string;
      latestMessageAt: string | null;
      updatedAt?: string | null;
      createdAt?: string | null;
      status: "archived" | "resumable";
      source: "hdd-cache";
      indexedAt?: string | null;
      fileMtime?: string | null;
      filePath?: string | null;
      sourceHash?: string | null;
    };
```

During migration:

```txt
projectId should be required in the response.
projectPath can remain optional compatibility metadata.
```

---

# Phase 13: Normalize Sessions and Conversations

Create pure normalizers.

Suggested files:

```txt
src/services/projectChats/normalizeSessionToProjectChat.ts
src/services/projectChats/normalizeConversationToProjectChat.ts
```

Session:

```ts
export const normalizeSessionToProjectChat = (session: Session): ProjectChat => ({
  type: "session",
  id: session.id,
  projectId: session.projectId,
  projectPath: session.projectPath ?? null,
  title: session.title,
  latestMessageAt: session.latestMessageAt ?? null,
  updatedAt: session.updatedAt ?? null,
  createdAt: session.createdAt ?? null,
  status: "active",
  source: "session-store",
  resumedFromConversationId: session.resumedFromConversationId ?? null,
});
```

Conversation:

```ts
export const normalizeConversationToProjectChat = (
  conversation: Conversation,
): ProjectChat => ({
  type: "conversation",
  id: conversation.id,
  projectId: conversation.projectId,
  projectPath: conversation.projectPath ?? null,
  title: conversation.title,
  latestMessageAt: conversation.latestMessageAt ?? null,
  updatedAt: conversation.updatedAt ?? null,
  createdAt: conversation.createdAt ?? null,
  status: "resumable",
  source: "hdd-cache",
  indexedAt: conversation.indexedAt ?? null,
  fileMtime: conversation.fileMtime ?? null,
  filePath: conversation.filePath ?? null,
  sourceHash: conversation.sourceHash ?? null,
});
```

Preferred:

```txt
Resolve project_id in service layer before normalization.
Do not hide missing project_id inside pure normalizers.
```

---

# Phase 14: Merge/Dedupe ProjectChats

Create pure merge function.

Suggested file:

```txt
src/services/projectChats/mergeProjectChats.ts
```

Behavior:

```txt
include active sessions
include archived/resumable conversations
hide conversations resumed into active sessions
sort by latest activity
handle null timestamps safely
```

Dedupe rule:

```txt
if session.resumedFromConversationId === conversation.id:
  show session
  hide conversation
```

Example:

```ts
export const mergeProjectChats = ({
  sessions,
  conversations,
}: {
  sessions: ProjectChat[];
  conversations: ProjectChat[];
}): ProjectChat[] => {
  const resumedConversationIds = new Set(
    sessions
      .filter((chat) => chat.type === "session")
      .map((chat) => chat.resumedFromConversationId)
      .filter(Boolean),
  );

  const visibleConversations = conversations.filter((chat) => {
    if (chat.type !== "conversation") return true;
    return !resumedConversationIds.has(chat.id);
  });

  return [...sessions, ...visibleConversations].sort(sortProjectChats);
};
```

Sort order:

```txt
latestMessageAt DESC
updatedAt DESC
createdAt DESC
title ASC
```

Use `date-fns` wrapper for safe ISO comparison.

---

# Phase 15: Unified List API / Handler

Preferred endpoint:

```txt
GET /project-chats
GET /project-chats?refreshConversations=1
```

Implementation flow:

```ts
export const listProjectChats = async ({
  refreshConversations,
}: {
  refreshConversations: boolean;
}): Promise<ProjectChat[]> => {
  const conversations = await listConversations({
    refresh: refreshConversations,
    refreshIfLatestConversationChanged: true,
  });

  const sessions = await listSessions();

  await ensureSessionProjectIdsFromExistingProjects(sessions);

  const sessionChats = sessions.map(normalizeSessionToProjectChat);
  const conversationChats = conversations.map(normalizeConversationToProjectChat);

  return mergeProjectChats({
    sessions: sessionChats,
    conversations: conversationChats,
  });
};
```

Important:

```txt
Do not refresh conversations on every request.
Do not scan HDD fully on every /project-chats request.
Do check latest HDD conversation id.
Do force refresh when refreshConversations=1.
```

---

# Phase 16: Session Message Sync

For active sessions, use delta sync.

Avoid timestamp-only cursors.

Preferred cursor:

```ts
export type MessageCursor = {
  timestamp: string;
  id: string;
};
```

SQL pattern:

```sql
SELECT *
FROM messages
WHERE project_id = ?
  AND (
    created_at > ?
    OR (created_at = ? AND id > ?)
  )
ORDER BY created_at ASC, id ASC;
```

Adapt table/column names to existing schema.

Recommended index:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_project_created
ON messages(project_id, created_at DESC, id DESC);
```

If the schema uses `session_id`, adapt:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_session_created
ON messages(session_id, created_at DESC, id DESC);
```

Fallback:

```txt
if client cursor is valid:
  return delta
else:
  return full snapshot
```

Full snapshot only when:

```txt
cursor invalid
schema/cache version changed
cursor too old
messages edited/deleted without change log
incremental sync unsafe
```

---

# Phase 17: Validation Queries

Add validation queries/scripts.

Conversations without project_id:

```sql
SELECT id, project_path
FROM conversations
WHERE project_id IS NULL;
```

Sessions without project_id:

```sql
SELECT id, project_path
FROM sessions
WHERE project_id IS NULL;
```

Duplicate project paths:

```sql
SELECT path, COUNT(*)
FROM projects
GROUP BY path
HAVING COUNT(*) > 1;
```

Conversation references missing project:

```sql
SELECT conversations.id, conversations.project_id
FROM conversations
LEFT JOIN projects ON projects.id = conversations.project_id
WHERE conversations.project_id IS NOT NULL
  AND projects.id IS NULL;
```

Session references missing project:

```sql
SELECT sessions.id, sessions.project_id
FROM sessions
LEFT JOIN projects ON projects.id = sessions.project_id
WHERE sessions.project_id IS NOT NULL
  AND projects.id IS NULL;
```

---

# Phase 18: Migration/Backfill Script

Create idempotent script:

```txt
scripts/migrate-projects.ts
```

Responsibilities:

```txt
1. Ensure schema migrations are applied.
2. Run/use existing conversation scan/index cache.
3. Read existing conversations.
4. Collect conversation.project_path values.
5. Canonicalize and dedupe paths.
6. Insert/upsert projects.
7. Update conversations.project_id.
8. Update sessions.project_id by resolving against existing projects.
9. If session project is missing, refresh conversation cache before fallback.
10. Update cache_metadata.last_conversation_id.
11. Print a summary.
```

Example output:

```txt
Projects migration complete:
- discovered conversation project paths: 42
- projects inserted: 39
- projects reused: 3
- conversations updated: 128
- sessions updated: 7
- sessions requiring conversation-cache refresh: 0
- skipped missing project_path: 0
- last conversation id: conv_abc123
```

Must be safe to run multiple times.

---

# Phase 19: Backward Compatibility

Keep `project_path` for now.

Transition rules:

```txt
project_id is the primary relationship.
project_path stays as compatibility/display/debug metadata.
projects.path is the canonical source of project path.
```

Do not:

```txt
drop project_path immediately
use projectPath as primary identity
use raw project_path for dedupe
```

---

# Phase 20: Testing Plan

The project already uses Vitest.

Add tests for:

## Project migration

```txt
creates one project per unique canonical conversation project path
dedupes duplicate project_path
handles trailing slash differences if canonicalization removes them
does not duplicate projects when run twice
updates conversations with project_id
updates sessions with project_id from existing projects
does not treat sessions as primary project discovery
preserves project_path for compatibility
```

## Latest conversation refresh

```txt
if latest HDD conversation id equals cached/app last conversation id, no reload
if latest HDD conversation id differs, refresh happens
refresh=1 forces refresh
refreshConversations=1 forces refresh
cache metadata updates after refresh
session creation updates cache metadata after creating conversation on disk
```

## Conversation refresh

```txt
refresh scans conversations
scanner output is validated with zod
project is created/upserted
conversation is saved with project_id
cached conversation response includes projectId
last_conversation_id is updated
```

## Session creation

```txt
session creation creates conversation on disk
created conversation project path upserts project
session stores project_id
session still stores project_path during migration
project cache metadata updates only when new conversation id differs
```

## Resume flow

```txt
conversation with project_id resumes into session with same project_id
conversation without project_id is repaired during resume
session stores resumedFromConversationId
unified ProjectChat list hides resumed conversation
resume does not create duplicate projects
```

## Unified ProjectChat list

```txt
sessions include projectId
conversations include projectId
projectPath remains available as compatibility metadata
sorting works by latestMessageAt/updatedAt/createdAt/title
dedupe works by resumedFromConversationId
```

## Library-specific tests

```txt
canonicalizeProjectPath
zod schemas
date sorting helpers
migration runner idempotency
chokidar invalidation callback mocked
```

Mock chokidar.

Do not rely on real filesystem watchers in unit tests.

---

# Recommended File Organization

Adapt to existing codebase conventions.

Possible additions:

```txt
src/
  db/
    migrate.ts
    migrations/
      001_create_projects.sql
      002_add_project_id_columns.sql
      003_create_cache_metadata.sql
    repositories/
      projects.repository.ts
      conversations.repository.ts
      sessions.repository.ts
      cacheMetadata.repository.ts

  schemas/
    project.schema.ts
    conversation.schema.ts
    projectChat.schema.ts
    messageCursor.schema.ts
    queryParams.schema.ts

  services/
    projects/
      canonicalizeProjectPath.ts
      ensureProjectsForConversations.ts
      upsertProjectByPath.ts

    conversations/
      conversationWatcher.ts
      getLatestConversation.ts
      refreshConversationCache.ts

    cache/
      cacheMetadata.ts
      conversationInvalidation.ts

    projectChats/
      listProjectChats.ts
      mergeProjectChats.ts
      normalizeSessionToProjectChat.ts
      normalizeConversationToProjectChat.ts
      sortProjectChats.ts

    sessions/
      createSessionForProjectPath.ts
      ensureSessionProjectIdsFromExistingProjects.ts

  handlers/
    handleListProjectChats.ts

scripts/
  migrate.ts
  migrate-projects.ts
  validate-db.ts
```

Do not create this exact structure blindly.

Follow existing repo conventions.

---

# Do Not Do These

Do not:

```txt
rewrite the backend
drop project_path immediately
scan HDD fully on every /project-chats request
treat sessions as primary project discovery
assume sessions have unknown project paths that never appear in conversations
reload projects when latest HDD conversation id is unchanged
use projectPath as primary identity after migration
create a second DB just for project/latest-message cache
install both Kysely and Drizzle
introduce a migration framework that conflicts with src/db/migrations
make chokidar the only correctness mechanism
hide project_id repair logic inside random handlers
```

---

# Recommended Implementation Order

1. Inspect current schema, migrations, handlers, stores, scanner, and cache helpers.
2. Add dependencies:

```bash
npm install zod date-fns
```

Optionally:

```bash
npm install chokidar
```

3. Add custom migration runner if missing.
4. Add `projects` table migration.
5. Add `cache_metadata` migration.
6. Add nullable `project_id` columns and indexes.
7. Add `canonicalizeProjectPath`.
8. Add `zod` schemas for query params, scanner output, ProjectChat, cursor.
9. Add date utility wrapper.
10. Add `upsertProjectByPath`.
11. Add `ensureProjectsFromConversations`.
12. Update conversation scan/refresh to create/update projects and `project_id`.
13. Add latest HDD conversation id refresh check.
14. Add migration/backfill script.
15. Update session creation to link project after conversation is created on disk.
16. Update resume flow to preserve/repair `project_id`.
17. Add ProjectChat type.
18. Add normalizers.
19. Add merge/dedupe/sort.
20. Add `/project-chats` handler.
21. Add/verify session message cursor sync.
22. Add tests.
23. Run migration locally against test/dev DB.
24. Run:

```bash
npm run lint
npm run test
npm run build
```

---

# Success Criteria

Implementation is successful when:

```txt
projects table exists
projects.path is unique
projects are derived from conversation project_path values
conversations have project_id
sessions have project_id
project_path remains available during migration
conversation refresh creates/updates projects
session creation creates conversation on disk and then updates project/project cache
project/conversation list reloads only when latest HDD conversation id differs from cached/app latest conversation id
/project-chats returns active sessions + historical conversations
ProjectChat exposes projectId
resumed conversations are deduped
existing cache behavior is preserved
migration script is idempotent
zod validates runtime boundaries
date-fns utilities handle ISO sorting/comparison
chokidar, if added, only marks cache dirty and does not replace correctness checks
tests cover migration, refresh, session creation, resume, sync, and unified list behavior
```

---

# Final Architecture

```txt
projects
  id
  path
  name
  last_conversation_id
  last_conversation_created_at
  last_indexed_at
  latest_message_at
  latest_message_id
  message_count
  created_at
  updated_at

sessions
  id
  project_id
  project_path    // temporary compatibility field
  resumed_from_conversation_id
  ...

conversations
  id
  project_id
  project_path    // temporary compatibility field
  indexed_at
  file_mtime
  file_path
  ...

cache_metadata
  key
  value
  updated_at
```

Relationship:

```txt
projects.id -> sessions.project_id
projects.id -> conversations.project_id
```

UI/API model:

```txt
ProjectChat
  type: session | conversation
  projectId
  projectPath // temporary compatibility/debug/display field
```

Core rule:

```txt
conversations remain the project discovery source.
latest HDD conversation id controls project/conversation cache refresh.
project_id becomes the stable identity.
```
