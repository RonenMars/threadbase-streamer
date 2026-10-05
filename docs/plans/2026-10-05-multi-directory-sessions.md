# Plan: select multiple directories for a session

Status: draft, 2026-10-05. Covers `threadbase-streamer` and `threadbase-mobile`.

## Where things stand

- **Every session has exactly one directory.**
  Mobile sends `POST /api/sessions/start { path, projectName, provider? }` (`hooks/useBrowse.ts:67-94`).
  The streamer resolves `path` under `browseRoot` (`sessions.handlers.ts:2672`, `src/browse.ts:16`) and uses it as `projectPath`.
- **`projectPath` is the spawn `cwd` for every runner.**
  Codex also gets it as `--cd` (`codex-pty-runner.ts:224, 305, 328`), and Cursor as `--workspace` (`cursor-pty-runner.ts:122`).
- **Claude `--add-dir` already exists, but only server-wide.**
  It is `claudeFlags.addDir` (`src/claude-flags.ts:125`), admin-gated and not confined to `browseRoot`.
  Nothing passes extra directories per session.
- **The start body has no zod schema, and nothing else is set per session.**
  Model, effort and permission mode are all server-wide (`server.ts:2754` `spawnFlagOverrides`).
- **Resume does not take a directory from the client.**
  It re-derives `projectPath` from the JSONL's `cwd` (`server.ts:2888`).
  `managed_sessions` stores one `project_path`. Auto-resume replays only `{sessionId, projectName, branch}` (`session-registry-boot.ts:401`).
- **Mobile picks one directory in `app/browse.tsx`.**
  It holds a single `currentPath` (:66) and passes it as a URL param to `/session/new` (:264-280).
  No store holds a new-session draft.
- **Every grouping keys on a single `projectPath`.**
  That covers hub, tree, recents, project-chats and the busy probe.

## Design

**One primary directory plus an ordered list of additional directories.**

- **The primary stays `path`/`projectPath`.**
  It is the `cwd`, the project identity, the grouping key, the busy-probe key and what resume derives. None of that changes.
- **Additional directories are a new, additive field: `additionalPaths: string[]`.**
  They grant the agent access only. They do not create a second project, a second transcript watcher or a second group.
- **The change is additive on the wire.**
  Old mobile builds ignore the field; new mobile builds hide the UI against an old server (absent capability = off).
  No compatibility grep is needed.

### Rules for `additionalPaths`

- Each entry goes through `resolveBrowsePath(browseRoot, p)`, so every entry must sit inside `browseRoot` and exist.
  This keeps `BROWSE_SYSTEM_PROMPT` truthful with no change and avoids a new escape hatch outside the sandbox root.
- After canonicalizing, the server drops:
  - duplicates,
  - an entry equal to the primary,
  - an entry nested inside the primary or inside another entry, since it is already covered.
- The cap is `MAX_ADDITIONAL_PATHS = 8` (a code constant). Above the cap, or with a non-array or non-string entry, the server answers `400 INVALID_ADDITIONAL_PATHS`.
- The response echoes the resolved list on the session, so the client shows what the agent actually got.

### Provider support

Add `multiDirectory: boolean` to `ProviderCapabilities` (`src/services/providers/capabilities.ts:18-44`).

| Provider | Flag | `multiDirectory` |
|---|---|---|
| Claude Code | `--add-dir A B …` (variadic), after `buildFlagArgs`, merged and deduped with server-wide `claudeFlags.addDir` | `true` |
| Codex CLI | `--add-dir <dir>` repeated, before the positional prompt | `true` (verified on 0.140.0 and 0.160.1, top-level, `resume` and `fork`) |
| Cursor CLI | none known | `false` |
| Generic terminal | n/a | `false` |

- When a provider has `multiDirectory: false` and a request carries a non-empty `additionalPaths`, answer `400 MULTI_DIRECTORY_UNSUPPORTED`.
  Do not ignore the field silently.
- Handlers branch on `capabilitiesFor(provider).multiDirectory`, never on `provider ===` (add-provider skill rule).

## Streamer work (lands first)

1. **Schema.** Add `src/schemas/sessionStart.schema.ts` (zod) for the start body, `{ path, projectName?, provider?, systemPrompt?, additionalPaths? }`.
   Parse it in `handleStartSession` (`sessions.handlers.ts:2625`).
   Unrelated fields keep their current behaviour.
2. **Resolve.** Add `resolveAdditionalPaths(browseRoot, primary, raw)` in `src/browse.ts`. It validates, canonicalizes and dedupes per the rules above, and has unit tests for each drop rule and each error.
3. **Thread through.** Add `additionalPaths?: string[]` to `StartSessionOptions`, `StartFreshSessionOptions` and `StartForkSessionOptions` (`src/types.ts:812-855`).
   It is JSON-safe, so it crosses the pty-host boundary (`src/pty-host/protocol.ts:61`) unchanged.
4. **Runners.**
   - **Claude** (`pty-manager.ts:344`, `:428`): emit one `--add-dir` group that unions the session list with `claudeFlags.addDir`.
     Remove `addDir` from the `buildFlagArgs` output for that spawn so it is not emitted twice.
   - **Codex** (`codex-pty-runner.ts`): emit `--add-dir` for resume, fresh and fork. The positional prompt must stay last.
   - **Cursor**: no change.
5. **Capability.** Add `multiDirectory` to all four capability constants.
   Update `__tests__/provider-capabilities.test.ts` and `__tests__/capabilities.test.ts`.
   `GET /api/providers` then serves it automatically.
6. **Session shape.** Add `additionalPaths?: string[]` to `ManagedSession` (`types.ts:82`) and `SessionResponse` (`types.ts:490`), and map it in `managedToResponse` (`session-store.ts:270`).
   It then flows through `session_update`, `session_list` and `session_ready` for free. Omit the field when the list is empty.
7. **Persistence.**
   - Add `src/db/runtime-migrations/006_add_additional_paths.sql`: `ALTER TABLE managed_sessions ADD COLUMN additional_paths TEXT` (a JSON array, NULL meaning none).
   - Write it in `recordSpawn` (`managed-sessions.repository.ts:204`) and add it to the upsert (`:87-110`).
8. **Resume, auto-resume, fork and adopt.**
   - Resume source order:
     1. an explicit `additionalPaths` in the resume body (optional; lets the client change the set on resume),
     2. otherwise the registry row for the conversation (`bound_conversation_id`),
     3. otherwise none.
     The JSONL does not record `--add-dir`, so a conversation with no registry row resumes with only its primary. Document that.
   - Re-validate the persisted entries at resume time. Drop and log any that no longer exist (`session.additional_path_missing`) rather than failing the resume, because the primary is what matters.
   - Auto-resume (`session-registry-boot.ts:401`) passes the row's list through.
   - Codex fork carries the source session's list.
   - Adopt cannot learn an external process's `--add-dir` (discovery does not parse argv), so adopt respawns with the primary only.
     Document that in the adopt section of `CLAUDE.md`.
9. **What does not change.**
   The busy probe, project upsert and `projectId`, project-chats grouping, transcript watchers, and `/api/projects*` all keep keying on the primary.
10. **Docs.**
    - Add a line under "Session lifecycle" in `CLAUDE.md`.
    - Add the field to `docs/compatibility/tb-mobile.md` (an additive entry).
    - Add a capability row in the add-provider skill.
11. **Tests (`__tests__/`).**
    - Start handler: accepts, dedupes, rejects outside root, rejects over cap, rejects an unsupported provider.
    - Runner argv snapshots for Claude and Codex.
    - The union with `claudeFlags.addDir`.
    - Migration 006 applied to an existing `runtime.db`.
    - Resume replays from the registry, and a body override wins.
    - Auto-resume replays.
    - A missing extra directory on resume is dropped and logged.

## Mobile work (after the streamer ships)

1. **Types.**
   - Add `additionalPaths?: string[]` to `Session` (`types/api.ts:29`) and to `useStartSession`'s variables (`hooks/useBrowse.ts:74`). Consider moving that inline type to a named `StartSessionRequest`.
   - Add `multiDirectory?: boolean` to `ProviderCapabilities` (`types/provider-health.ts:12-19`). It must be **optional** in `parseCapabilities` (:73-96), because the parser currently requires all six fields, and a required seventh would reject every older server's providers.
2. **Picker UX in `app/browse.tsx`.**
   - `currentPath` stays the primary.
   - Add an "Add another directory" action, shown only when the selected provider's health reports `capabilities.multiDirectory === true`, via the existing `findProviderHealth` read at :80-92.
     It pushes the current path into local `extraPaths` state and lets the user keep browsing to pick the primary, or the reverse. Decide which after a Storybook mock; see the open questions.
   - A new `components/browse/SelectedDirsTray.tsx` shows the selection as removable chips above the Start button, with the primary marked.
     It needs a matching `SelectedDirsTray.stories.tsx`, which the pre-commit check enforces.
   - Mirror the server's rules client-side so the tray never shows a duplicate or nested entry. The server stays authoritative.
   - Changing the provider to one without the capability clears the extras, with a one-line note.
   - The cap matches the server (8), with a disabled state at the limit.
   - Recent-dir rows keep their one-tap start. A recent row can also be added as an extra from the "Display all" modal (`RecentDirsModal.tsx`), which already has search.
3. **Navigation.**
   - Pass `extra` to `/session/new` as a JSON-encoded URL param in `navigateToStartScreen` (:264-280).
   - `app/session/new.tsx` parses it defensively; a malformed value means no extras.
   - It adds `additionalPaths` to the payload (:242-261), shows "projectName + N more" under the title (:290-292), and maps the two new error codes to `browse:error.*` copy.
4. **Display.**
   - In `lib/infoFields.ts`, add an "Additional directories" field (a list) when the field is present.
   - Hub, tree and recents keep using `projectPath`. Optionally add a "+N" badge on `ProjectHubCard` and session rows.
   - Missing field → render nothing (degrade, don't break).
5. **i18n.** Add keys to `locales/{en,he,ar,ru}/browse.json` and `sessions.json`. Copy goes through `t()` in function scope. `npm run test:i18n` must pass.
6. **Tests.**
   - Integration tests for the tray: add, remove, dedupe, cap, and the capability gate both ways.
   - `browse-provider-flow`: switching provider clears the extras.
   - `session-new-start`: the payload carries `additionalPaths`, and a malformed `extra` param is ignored.
   - A `provider-health` parser test where `multiDirectory` is absent (still parses, treated as false) and where it is present.
7. **E2E.**
   - Add `multiDirectory` to the mock `/api/providers` (`e2e/mock-server.js:435`).
   - Give mock `/api/browse` some directories (it returns `[]` today).
   - Add a `browse_multi_dir.yaml` flow that adds two directories and asserts the tray, then add it to `test:e2e:mock`.
   - The mock has no `POST /api/sessions/start`, so the flow stops before start. Adding that handler is a separate improvement.

## Follow-up (not in this plan)

- **Change the directories of a live session.**
  Claude supports an interactive `/add-dir`, which could be injected the way `applyLiveSessionSetting` (`server.ts:3275`) injects `/model`, via a `PATCH /api/sessions/:id/directories`.
  This is deferred because it needs busy/idle gating and has no Codex equivalent.
- **Let additional directories sit outside `browseRoot`** behind an admin allowlist.
  Deferred because it is a security-model change.

## Tracking

- File `P2: Sessions can include more than one directory` (`enhancement`, `provider`, `ux`) in **both** repos, each describing its own half and linked by URL, per `threadbase/docs/issue-tracker.md`.
- Order: the streamer PR lands, mobile reads the capability, and the mobile PR lands. Either can ship alone safely.

## Open questions

1. **Are extra directories limited to `browseRoot`?** The plan says yes.
2. ~~**Codex `--add-dir`**~~ — resolved: `codex --help`, `codex resume --help` and `codex fork --help` on 0.140.0 and 0.160.1 all list `--add-dir <DIR>`, "Additional directories that should be writable alongside the primary workspace".
3. **Picker interaction:** "browse to each, tap Add" (simplest, and reuses the screen) or checkbox multi-select on rows? Recommendation: "Add", because it keeps one-tap navigation into folders intact.
4. **Cap of 8:** is that the right number?
