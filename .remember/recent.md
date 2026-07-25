# Recent

## 2026-07-25

Completed live-activity push infrastructure (3 stacked PRs #292–294): `push_tokens` schema w/ kind/activity_id/expiry, ES256 JWT APNs sender over HTTP/2, 8h renewal scheduler w/ elapsed-time continuity. Local: 1482 tests pass; CI lint blocked by 2 inherited base-branch errors (unrelated). Gap: mobile contract file + push-to-start path pending.

## 2026-07-24

Per-server Claude CLI flags: 6 curated flags + escape-hatch (`bypassPermissions`, `maxBudgetUsd`), `PUT /api/config/claude-flags` endpoint, biometric-gated mobile UI. Widened `--permission-mode` to all 6 CLI values; exposed `model`/`effort`/`permissionMode` on `GET /api/sessions/:id`. Fixed `detectShellPrompt` false-positive on numbered lists (root: anchor regex). Mobile: filtered frozen counter & completed-turn timers, silent-think skeleton. Streamer #276 + mobile #392 landed; test coverage 1155/1155 + 18/18 green.

## 2026-07-23

OSC 777 end-of-turn misclassification fixed (11 stranded sessions since Jul 7; root: `hasWaitingForInputOsc` regex). Streamer hold_session SIGINT → full grace timer; widened permission-mode union across CLI. Mobile: hardened Q-card detector (contiguous numbered-block req). Streamer prod rolled (1169/1169 tests); zero live PTY at deploy.