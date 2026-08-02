# Session review consolidation — live-sessions persistence follow-ups

**Date:** 2026-07-30
**Branch at time of writing:** `integration/missing-prs-2026-07-23` (`13b5ff0`)
**Scope:** consolidated review of 10 open items raised across two parallel sessions in `tb-streamer`.

Item dispositions: 1 ignore · 2 re-check · 3 ship together · 4 yes · 5 ok · 6 elaborate · 7 elaborate · 8 write suggestion · 9 ack · 10 ack.

---

## 2 — Plan docs: content updated, structural risk unchanged

The docs did change:

| File | Then → Now | mtime |
|---|---|---|
| `live-sessions-persistence-plan.md` | 575 → **597 L** | 16:29 |
| `live-sessions-persistence-kickoff.md` | 112 → **222 L** | 16:32 |
| `session-source-visibility-and-control.md` | 592 L (unchanged) | 12:42 |
| `live-sessions-persistence-audit.md` | 247 L (unchanged) | 10:44 |
| `codex-source-visibility-investigation-prompt.md` | 166 L (unchanged) | 12:46 |

Growth is concentrated in **Phase 7** (now L345–429, was L345–409) — the `auto_resume_on_boot` setting, the first-run question, and the resume flow.
`git diff --stat` is empty, so the edits were re-staged cleanly.

The three risks flagged earlier all still hold:

- Branch `plan/live-sessions-persistence` is still at `90c1c07` — **nothing committed**.
- **Never pushed** — no remote branch, no PR.
- Still **2 commits behind** `origin/integration/missing-prs-2026-07-23` (`13b5ff0`).

1,825 lines across 5 docs exist in exactly one place on one disk.

**Open decision:** `live-sessions-persistence-kickoff.md` is staged (`A`), but the earlier instruction was to keep it on disk and out of the commit.
It is now in the index and would be committed — include it or unstage it.

## 3 — `adopt` confirm: ship streamer + mobile together

Agreed.
Worth making explicit in the plan's `§10 PR checklist`: this makes PR ordering **cross-repo**.
The streamer PR adding `confirm` must not merge before the mobile PR that sends it, or every overtake breaks in the window between.

## 4 / 5 / 9 / 10 — Acknowledged

- **4** — write tb-mobile-side tickets, sourced from plan `§5`/`§5.1` and spec `§3.3`/`§4.3`/`§5`.
- **9** — Codex investigation prompt written, not yet run.
- **10** — PR 0 → PR 12 unwritten. PR 0 is sequenced first and fixes a live defect: `ManagedSessionsRepository` is constructed inside the cache-open `try` (`server.ts:1577`), so a `better-sqlite3` ABI mismatch silently disables session persistence with no separate signal.

## 6 — Verifying the model override empirically

`GET /api/sessions/:id` already scrapes model/effort off the live PTY status line (`src/server.ts:3622-3637` → `src/services/questions/parseStatusLine.ts`).
Start a session, then `curl -H "Authorization: Bearer $KEY" .../api/sessions/<id>` and look for `"model":"Opus 4.8"` and `"effort":"high"`.

Three caveats make that weaker than it appears:

- `MODEL_RE` is `/(Opus|Sonnet|Haiku|Fable)\s+[\d.]+/` — `Opus 4.8` matches fine.
- **`session.model` is only assigned when it is already `null`** — the scanner value wins and can mask the scrape. `effort` has no such guard, so `effort: "high"` is the more trustworthy signal.
- The scrape reads the last 10 lines, best-effort; a missing footer yields *absent* fields rather than an error, so absence is not failure.

The decisive test skips the rendered UI entirely — inspect the actual argv:

```
pgrep -af claude
```

Confirm `--model claude-opus-4-8 --effort high` appears **after** the built-in `--model sonnet --effort low`.
That tests the last-wins assumption directly, which is the part never proven.

## 7 — The nightly restart

`com.ronen.threadbase-nightly-restart` runs `launchctl kickstart -k gui/501/com.ronen.threadbase` at 04:00 daily.
`-k` kills before restarting, so every live PTY dies with the process.
Effective max session lifetime is "until 04:00" — the 7-day `pty_grace_period_ms` can never be exercised past one night.

- **(a) Leave it; let Phase 7 (PRs 11–12) handle it.** `auto_resume_on_boot` makes the restart survivable by *resuming*, not *preserving* — a new PTY continuing from JSONL. An in-flight turn at 04:00 is still lost.
- **(b) Reschedule or drop `-k`.** Cheapest, but the job exists for an undocumented reason (memory, leaked handles, log rotation) — do not remove it blind.
- **(c) Phase 6 `pty-host` (PRs 6–10).** The only option giving true continuity, because the PTY master fd lives outside the restarted process. Correct and most expensive.

**Recommendation: (a).** Phase 7 targets exactly this case, and 04:00 is when an in-flight turn is least likely.

**Additional value worth adding to the plan:** the nightly restart is an already-deployed, recurring instance of the exact failure the plan addresses.
It is a free daily test harness for validating Phase 1 rehydration and Phase 7 auto-resume against real state, rather than a synthesized event.

## 8 — `claude_extra_args` fragility — **RESOLVED 2026-07-31 by #306, no further code change**

The harm here was never the deletion itself; it was that `claude_extra_args` had become the only home for model and effort, so clearing it silently reverted the spawn defaults.
#306 gave both a real home: `model` and `effort` are first-class entries in the claude-flags registry (`src/claude-flags.ts:112-113`), persisted under the separate `claude_flags:` key, and resolved at all three spawn sites through `spawnFlagOverrides()`.
A `PUT` that omits `extraArgs` can no longer change which model or effort a session spawns with.

What remains is a replacing `PUT` clearing a field the caller omitted, which is the correct semantics for a full-document `PUT` — and is exactly what the "not recommended" section below argues for keeping.
The response body echoes `extraArgs: null`, so the caller is told the resulting state rather than left guessing.
The analysis below is kept for the reasoning, not as an open action.

**Original finding — mechanism confirmed in code, not inferred.**
`setClaudeFlagsConfig()` (`src/server.ts:2132`) calls `setClaudeExtraArgs(extraArgs)` **unconditionally**.
A `PUT /api/config/claude-flags` that omits `extraArgs` passes `undefined` → `setConfigValue("claude_extra_args", undefined)` → the line is **deleted** from `server.yaml`.
The next spawn silently reverts to `--model sonnet --effort low`.
There is a forensic trail (`config.claude_flags_updated` logs `previousExtraArgs`) but no user-visible signal.

### Preferred fix — give model/effort a real home in config

Add `loadDefaultModel()` / `loadDefaultEffort()` to `src/auth.ts`, mirroring `loadDefaultPermissionMode()` (`src/auth.ts:120-131`) exactly, and fall back to them in `cli/index.ts` where `opts.defaultModel` / `opts.defaultEffort` are read (~L274).

Roughly 20 lines, and it:

- survives any claude-flags write, because it is a different config key.
- survives redeploy — the plist is regenerated by `deploy.sh`, `server.yaml` is not.
- sits beside `default_permission_mode` where it is discoverable.
- returns `claude_extra_args` to its documented role as an escape hatch rather than load-bearing config.

### Not recommended — make the PUT merge instead of replace

It looks like the smaller fix, but it changes the semantics of a trust-boundary endpoint where `extraArgs` is explicitly the unvalidated override, and a partially-replacing PUT is a worse API than a replacing one.
It also patches the symptom while leaving the real gap — model/effort having no home in config — unsolved.

### Consolidation opportunity

Phase 7 already builds a `server.yaml` user preference with a tri-state loader (`undefined` ≠ `false`) and an install-time question.
`default_model` / `default_effort` fit that same pattern and could ride **PR 11** rather than inventing a parallel mechanism.

---

## Recommended follow-up actions

1. **Protect the plan docs** — decide kickoff in/out, rebase `plan/live-sessions-persistence` onto `13b5ff0`, commit, push, open PR.
2. **Verify the model override** via the `pgrep -af claude` argv check.
3. ~~**Add `default_model` / `default_effort` loaders** in `src/auth.ts` + `cli/index.ts`, ideally folded into Phase 7 PR 11.~~ **Done differently in #306** — model and effort became claude-flags registry entries with their own persisted key, which closes §8 without a second config mechanism. PR 11 no longer needs to carry them.
4. **Record the `adopt` cross-repo pairing** in the plan's PR checklist.
5. **Add the nightly restart** to the plan as a recurring validation harness.

## Verification

- Item 2: `git -C <worktree> status --porcelain`, `git log --oneline -1`, `git ls-remote --heads origin plan/live-sessions-persistence`, `git rev-list --count HEAD..origin/integration/missing-prs-2026-07-23`.
- Item 6: `pgrep -af claude` after starting a session; confirm flag order. Cross-check `GET /api/sessions/:id` → `effort`.
- Item 8: after any `PUT /api/config/claude-flags`, `grep claude_extra_args ~/.threadbase/server.yaml` — absence reproduces the silent revert.
