# Archive

## Week of 2026-07-21

Awaiting next task; memory accessible (MailerLite PR #60, Expo prebuild drift recovery, threadbase work tracked).

## Week of 2026-07-14

OSC 777 conflation fixed (11 stranded sessions); status-line counter freeze resolved. Per-server Claude flags: registry + server.yaml + HTTP PUT + 6-value CLI union. hold_session grace-timer defers 4.5m inactivity. Shell-prompt detection tightened; mobile counter spinner filtered + silent-think skeleton; per-server flags via API + React Query + biometric gate w/ 4-locale i18n. Streamer 1.33.0 deployed stable; mobile perf audit identified 3 bugs (freezeOnBlur, blank-terminal WS replay, unbounded VT grid).

## Week of 2026-07-07

Cache-integrity alert system shipped (+1406L): monitor, backup, retention, 4 resolve actions (98/98 tests). Numbered-option shell-prompt detection fixed (PR #209, 17 tests); 5 streamer PRs landed. 11 sequential PR merges (rebase→CI→squash): Node cache, CORS, search ID unif, vitest 4 compat. Vitest 3→4 migration started; linear history maintained.

## Week of 2026-06-30

Codex provider bugs fixed (3: system prompt routing, rollout-id binding; 5 tests). SessionRunner interface extracted; LiveSessionManager refactored to provider-keyed runners. CodexPtyRunner+resolveCodexExe impl'd (13/13 tests). 9 PRs merged: security hardening, projects API pagination, updater logging, @hono/node-server v2, api-key rotation. TS 6.0 DTS + @types/node 26 stdin narrowing resolved.

## Week of 2026-06-23

Node-server v1→v2 upgrade complete (WS/ETag/NDJSON smoke tests). better-sqlite3 ABI fixed; v1.18.5 deployed. Interactive prompts leaking as raw TUI (JSONL-gating timing drift) diagnosed. blockedOnPrompt signal + detectShellPrompt fix designed. POST /api/sessions/:id/stop, WS conversation_event, useConversationStream hook, LiveConversationView impl'd. Invalid-date crash fixed; v1.13.1 deployed (80 tests).

```