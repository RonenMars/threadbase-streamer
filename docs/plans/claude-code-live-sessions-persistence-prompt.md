# Claude Code Prompt: Live Sessions Persistence Plan

You are working in the tb-streamer repository.

Task:
Create a new worktree from branch integration/missing-prs-2026-07-23, analyze the live-session system end to end, and produce an implementation plan to make live sessions persistent across:
1. Server restart
2. Full machine restart

Important:
Do not implement code yet.
Only produce analysis and a concrete execution plan in files inside the new worktree.

Worktree requirements:
1. Create a new worktree from integration/missing-prs-2026-07-23 on a new branch named plan/live-sessions-persistence.
2. Keep all plan artifacts inside that worktree.
3. Show exact commands you ran.

Scope to analyze, minimum files:
1. @src/server.ts
2. @src/session-store.ts
3. @src/live-session-manager.ts
4. @src/pty-manager.ts
5. @src/codex-pty-runner.ts
6. @src/types.ts
7. @src/services/sessions/reconcileSessions.ts
8. @src/db/repositories/managed-sessions.repository.ts
9. @src/db/repositories/sessions.repository.ts
10. @src/db/migrations/010_create_managed_sessions.sql
11. @src/api/routes/sessions.routes.ts
12. @src/api/types/api-deps.ts
13. @src/api/app.ts
14. @docs/compatibility/tb-mobile.md
15. @docs/architecture/2026-07-24-durable-session-runtime.md

What to produce:
1. A concise architecture audit document:
- Current behavior on server restart
- Current behavior on machine restart
- What state is durable today
- What state is in-memory only
- Failure modes and gaps
- Mobile compatibility constraints that must not break

2. A phased implementation plan document with:
- Proposed target behavior
- Data model changes
- Boot-time rehydration strategy
- PTY reattachment vs resumable fallback strategy
- Provider-specific handling for claude-code and codex-cli
- API and websocket compatibility strategy for tb-mobile
- Migration strategy
- Rollout strategy behind feature flags if needed
- Risk list and mitigations
- Test plan with exact test files to add or modify
- Observability and diagnostics additions
- Acceptance criteria per phase

Output files to create:
1. @docs/plans/live-sessions-persistence-audit.md
2. @docs/plans/live-sessions-persistence-plan.md

Quality bar:
1. Be explicit about what is feasible versus not feasible for true PTY continuity across process and machine restart.
2. If true PTY reattachment is not reliable, design robust fallback semantics and user-visible behavior.
3. Keep backward compatibility with tb-mobile session statuses and endpoints.
4. Include concrete code touchpoints by file and function name.
5. Include sequencing so work can be executed in small PRs.

At the end:
1. Print a short summary in chat.
2. Include a PR-sized task breakdown checklist ready for execution.
