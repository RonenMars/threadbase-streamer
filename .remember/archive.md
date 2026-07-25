# Archive

## Week of 2026-07-21

Awaiting next task; memory accessible (MailerLite PR #60, Expo prebuild drift recovery, threadbase work tracked).

## Week of 2026-07-14

Fixed OSC 777 conflation (end-of-turn notify stranded 11 sessions) + status-line counter freeze (mobile now animates locally). Streamer: per-server Claude flags (registry + server.yaml persistence + HTTP PUT + CLI 6-value union); hold_session grace-timer defers 4.5m instead of immediate SIGINT; tightened shell-prompt detection. Mobile: filter counter spinner + silent-think skeleton states; integrate per-server flags via API client + React Query + biometric gate; 4-locale i18n. All test suites green; streamer 1.33.0+4889912 deployed stable. Inventory'd 39 worktrees; mobile perf audit (3 bugs: freezeOnBlur, blank-terminal WS replay, unbounded VT grid).

## Week of 2026-07-07

Shipped cache-integrity alert system (+1406L): monitor drift, backup+retention, 4 resolve actions, 98/98 tests pass. Resumed 404 returns `history_file_missing` code. Fixed numbered-option shell-prompt detection (PR #209, 17 tests); landed 5 streamer PRs (pty-grace-period-ms default 4.5m, hold-session-on-background). Landed 11 PRs sequentially (rebase→CI→squash-merge): Node cache perf, CORS, search ID unif, vitest 4 compat. Started vitest 3→4 migration; linear history maintained.

## Week of 2026-06-30

Fixed 3 Codex provider bugs (system prompt routing, rollout-id binding; 5 tests). Extracted SessionRunner interface; refactored LiveSessionManager to provider-keyed runners. Impl'd CodexPtyRunner+resolveCodexExe (13/13 tests). Merged 9 PRs: security hardening, projects API pagination, updater logging, @hono/node-server v2, api-key rotation. Resolved TS 6.0 DTS + @types/node 26 stdin narrowing.

## Week of 2026-06-23

Node-server v1→v2 upgrade complete (WS/ETag/NDJSON smoke tests). Fixed better-sqlite3 ABI; deployed v1.18.5. Diagnosed interactive prompts leaking as raw TUI via JSONL-gating timing drift. Designed blockedOnPrompt signal + detectShellPrompt fix. Impl'd POST /api/sessions/:id/stop, WS conversation_event, useConversationStream hook, LiveConversationView. Fixed invalid-date crash; deployed v1.13.1 (80 tests).
```