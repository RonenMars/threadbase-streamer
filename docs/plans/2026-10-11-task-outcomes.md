# Task outcomes: knowing which conversations actually finished

Status: proposal, not started. Nothing here is filed as an issue yet.
Code anchors were read on 2026-10-11 against `origin/main` at `0b5c9d77`; re-grep before relying on a line number.

## Goal

The streamer reports whether a session is `running`, `waiting_input` or `idle`.
That says nothing about whether the *task* the conversation was started for is done.
This feature adds a second, independent axis, the **outcome**, so a phone list can answer "which of these did I finish, which did I abandon, which still need me".

The outcome is derived from evidence in the transcript, can be changed by the user, and can go back to open when the user asks for something new.

Not in scope: changing `SessionStatus`, push notifications on outcome change, any model-generated text.

## Decisions this plan makes (and the default if you don't object)

1. **Separate axis, new field.** `SessionStatus` is untouched. `completed` and `failed` are legacy mobile values (`CLAUDE.md`, "Backward compatibility"), so the outcome vocabulary avoids them.
2. **Manual changes are events on the timeline, not a permanent lock** (confirmed). If you mark a conversation `done` and then send a real follow-up, it goes to `reopened` like any other done conversation. A separate "lock" is a v2 option.
3. **Flag off means byte-identical responses.** No new field, route, WS event or `/api/info` key.
4. **Weak evidence is shown as weak.** PR evidence is `high` confidence. A local merge and a plan-mode indicator are `medium`. Research verdicts are `low`, and the phone says "likely done" rather than "done".
5. **No outcome filtering in v1** (confirmed), neither server-side nor in the mobile list. Outcome is a badge and an action only.
6. **A plan that has not been executed is `partial`.** Any plan-mode indicator at the end of a turn marks the conversation `partial` (reason `plan_pending`), because the task the plan was for is not done. Approving the plan and executing it hands the conversation back to the normal rules. A conversation that was only ever meant to produce a plan is marked `done` by hand.
7. **A local `git merge` counts as completion, but only on the default branch.** See Evidence.

## States

| `state` | Meaning | Typical way in |
|---|---|---|
| `open` | No terminal evidence yet. The default. | start, or a manual reset |
| `in_review` | A PR was opened and is still open. | `gh pr create` result |
| `partial` | Work ended without answering everything, or a plan exists but was not executed. | research verdict, plan-mode indicator, manual |
| `done` | The task finished. | PR merged, local merge, research answered, manual |
| `dropped` | Finished on purpose without doing the thing. | PR closed unmerged (duplicate, redundant), manual |
| `reopened` | Was `done` or `dropped`, then the user asked for more. | a real user turn after the terminal event |

`reason` is a second, finer field: `pr_merged`, `local_merge`, `pr_closed_duplicate`, `pr_closed_unmerged`, `pr_open`, `research_answered`, `research_partial`, `plan_pending`, `manual`.
`reason` is free-form for the client (unknown values render as the state alone), so new reasons never need a mobile release.

`source` is `evidence | heuristic | manual`: `evidence` is a tool event in the transcript (a PR command, a git merge, a plan-mode event), `heuristic` is a reading of prose, `manual` is the user. `confidence` is `high | medium | low`.

## The resolver: one pure function

All state logic lives in one pure function over a timeline, so it is table-testable and shared by every caller.

```
resolveOutcome(events: OutcomeEvent[]): { state, reason, source, confidence, evidence[] }

OutcomeEvent =
  | { kind: "user_turn", at, substantive: boolean }
  | { kind: "pr_opened" | "pr_merged" | "pr_closed", at, pr: { repo, number, url }, hint?: "duplicate" | "redundant" }
  | { kind: "local_merged", at, branch: string }
  | { kind: "plan", at, phase: "pending" | "approved" | "rejected" }
  | { kind: "verdict", at, value: "answered" | "partial" | "unanswered", source: "heuristic" }
  | { kind: "manual", at, state }          // includes "auto" (clears earlier manual events)
```

Rules, applied in order of `at`:

- `pr_opened` adds the PR to an open set. State becomes `in_review`.
- `pr_merged` removes it. When the set is empty the state is `done` (`pr_merged`).
- `pr_closed` removes it. When the set is empty the state is `dropped`, reason `pr_closed_duplicate` if the hint says so, else `pr_closed_unmerged`. If the set was mixed (one merged, one closed) the result is `done`: a merge wins.
- Several PRs: the state is `in_review` while *any* PR from the current cycle is open. Opening PR A and PR B and merging only A is not done.
- `local_merged` gives `done` (`local_merge`, confidence `medium`, because nothing proves it was pushed) **only when the open PR set is empty**. With a PR still open, the conversation stays `in_review`.
- `plan pending` gives `partial` (`plan_pending`, confidence `medium`). `plan approved` gives `open`: execution starts, and later PR, merge or verdict events decide the outcome. `plan rejected` leaves `partial` (the user is still shaping the plan). Because events apply in order, a plan that was approved and then merged ends `done`, not `partial`.
- `verdict answered` gives `done` (`research_answered`). `verdict partial` gives `partial`. `unanswered` leaves state alone.
- A **substantive** `user_turn` after `done` or `dropped` gives `reopened`, and the PR set resets. After `partial` it gives `open`. After `in_review` it changes nothing (the user is iterating on the PR).
- `manual` sets the state directly with `source: manual`, `confidence: high`.
- Substantive means: not an acknowledgement. v1 rule: more than 40 characters, or contains `?`, or is not on a short list of "thanks / ok / lgtm / nice" phrases. `// ponytail: phrase list, add phrases when a real follow-up is misread`.

The reopen rule is the part that is easy to get wrong, so it gets the most test cases (see Testing).

## Evidence: what the detector reads

### PRs (high confidence)

Hook: `onNewLines` in `src/server-wiring.ts` (`createConversationWatcherEvents`, about line 225), next to `cache.updateFromLines`. It fires for managed sessions and external tails.
Pre-filter by substring (`gh pr`, `/pull/`, `pull_request`) before any JSON parse, so the ~3700-file corpus pays nothing for ordinary lines.

What counts as evidence, and what does not:

- Only a `tool_use` block on the shell tool, paired by `tool_use_id` with its `tool_result`. Never assistant prose and never user text: this repo's own `CLAUDE.md` contains the strings `gh pr merge` and `gh pr create`, and so do countless pasted snippets.
- `gh pr create` with a result containing `https://github.com/<o>/<r>/pull/<N>` gives `pr_opened`. A create that errored gives nothing.
- `gh pr merge <N>` gives `pr_merged` only when the result text says merged. **Not the exit status**: `gh` has exited non-zero on a merge that landed (and zero on one that did not). `--auto` means *queued*, so it stays `in_review`.
- `gh pr close <N>` gives `pr_closed`. The `hint` comes from the closing comment text and the nearest preceding user turn ("duplicate", "redundant", "superseded", "already covered").
- MCP GitHub tools (`create_pull_request`, `merge_pull_request`, `update_pull_request` with `state: closed`) map to the same events.

### Local `git merge` (medium confidence)

The plain git CLI merge, with no PR involved, is also evidence. It needs three things together, because a merge command alone proves little:

1. **A shell `tool_use` running `git merge <ref>`** (also `git -C <path> merge ...`), whose result text shows a merge actually happened: `Fast-forward`, or `Merge made by the '<strategy>' strategy`. These give nothing: `Already up to date.`, `CONFLICT` or `Automatic merge failed`, `--abort`, and `--squash` or `--no-commit` (they stage a result without committing one).
2. **The merge landed on the default branch.** Merging `origin/main` into a feature branch to catch up is the most common merge in a session and is not completion. So the event counts only when the branch the session was on is `main` or `master`. Merging a feature branch into an integration or release branch (the batch-integration workflow does this on purpose) also gives nothing.
3. **The open PR set is empty** (see the resolver rule).

How the branch is known: conversation metadata already carries `gitBranch` (`conversation-cache.ts:138`, mapped to `branch` at `:1621`). **Unverified:** whether that value is per line or one value per file. If it is per file, it cannot tell where the merge ran. The fallback is the nearest preceding `git checkout main` / `git switch main` / `git branch --show-current` result in the same session, and if neither is found the merge gives nothing. Decide which from a captured transcript before writing the detector (see Plan mode, step 0).

Not counted: `git pull` (a fetch plus merge in the other direction), `git rebase`, `git cherry-pick`. The merge is `medium` rather than `high` because it can be unpushed, and a later `git reset` can undo it.

### Plan mode (medium confidence)

I read "plan madnessage type" as "plan mode message type". If you meant something else, tell me.

Indicators, by provider, and how well each is known:

| Provider | Indicator | Status |
|---|---|---|
| Copilot | `tool.execution_start` with `toolName: "exit_plan_mode"` (pending until its `tool.execution_complete`), and `session.mode_changed` with `plan` moving to `interactive` on accept | **Documented as live-verified** in `docs/compatibility/copilot-cli-questions.md` (row 7 and the event table) |
| Claude, live managed session | The session's `permissionMode` scraped from the status line (`types.ts:560`), and `plan` is a valid spawn mode (`claude-flags.ts:22`) | Known to exist in code. Not yet tied to turn end |
| Claude, transcript | An `ExitPlanMode` tool call and its result (approved or rejected), and a permission-mode marker on lines | **Unverified here.** The repo has no fixture or reference for it, and real transcripts are outside this workspace |
| Codex, Cursor | None known | Not planned |

Rules, in the resolver: a pending plan (the plan was presented and not yet accepted, or the session is sitting in plan mode at a signalled turn end) is `plan pending`. An accepted plan is `plan approved`. A rejected one is `plan rejected`.

**Step 0, before any code:** capture one real Claude plan-mode session (accepted and rejected) with the existing PTY capture harness or a saved transcript, and commit a synthetic fixture shaped like it. The Claude transcript indicator is not built on a guess. Until the fixture exists, Claude plan mode relies on the live `permissionMode` only, and Copilot ships first.
- Providers: Claude first. Codex, Cursor and Copilot already pass through normalised line helpers (`claudeShapedLine.ts`, `cursorConversationLine.ts`, `copilotConversationLine.ts`); extend after Claude is proven. A provider whose shell result is not recoverable simply never produces PR events.

Known gap, stated on purpose: a PR merged in the GitHub UI, or by another session, is invisible to the transcript. Such a conversation sits in `in_review` until the user changes it or a deferred `gh pr view` reconcile (not planned for v1) checks the PRs the session opened.

### Research and plans (low confidence)

There is no hard signal, so this is a heuristic and the weakest layer. Runs at a signalled turn end (the same `statusSource: "turn-signal"` the push notifier trusts), not per line. A conversation with no PR evidence, whose final assistant turn is long-form and has no failure language ("couldn't", "unable to", "not able to determine", "didn't get to", "remaining questions", "TODO") yields `verdict answered`. Failure language yields `partial`. Anything short or ambiguous yields no verdict.

Because this layer is the weakest, the manual override is the backstop and the UI labels it "likely".

## Storage: two files, split by the repo's own rule

`CLAUDE.md` says the cache is rebuildable and `runtime.db` is authoritative; user-set state must survive "delete the cache and restart". So:

- **`runtime.db`, new migration `006_create_conversation_outcome_overrides.sql`** (latest today is `005`): `conversation_id TEXT PRIMARY KEY, state TEXT NOT NULL, note TEXT, set_at INTEGER NOT NULL, set_by_device TEXT`. New repository beside `devices.repository.ts`, wired in `server.ts` next to `devicesRepo` and independent of the cache handle. `auto` deletes the row.
- **`cache.db`, new migration `028_create_conversation_outcome_derived.sql`** (latest today is `027`): `conversation_id TEXT PRIMARY KEY, state, reason, source, confidence, evidence_json, events_json, derived_through_offset, updated_at`. `events_json` holds the compact timeline so the resolver can re-run when a manual event arrives, without re-reading the transcript. No foreign key to `conversation_meta`, so a cache rebuild cannot cascade.

The effective outcome is `resolveOutcome(derived events + the override as a manual event)`. A cache reset loses only derived data, and the next scan rebuilds it.
Re-check both migration numbers when implementing: several worktrees are open and may have taken them.

Adjacent finding, not acted on: the existing `session_names` table lives in `cache.db` (`src/conversation-cache.ts:250`), so user-set names are lost on cache clear. Worth its own issue.

## API (all additive, all behind the flag)

Flag: `taskOutcomes` in `FEATURE_FLAGS` (`src/feature-flags.ts`), env `THREADBASE_FEATURE_TASK_OUTCOMES`, default `false`. A new `docs` row goes in the `feature-flags` skill table.

- **`/api/info`**: `outcomes: { version: 1, states: ["open", ...] }`, present only when on. This is the capability probe mobile already refreshes on every WS `connected`, so it is the better gate than `/api/config/feature-flags` (which the app does not poll).
- **Conversation list items, conversation detail, and session objects**: `outcome: null | { state, reason, source, confidence, manual, updatedAt, evidence: [{ kind: "pr", url, number, state } | { kind: "merge", branch } | { kind: "plan", phase }] }`. When the flag is on the field is always present (`null` for no data), following the "absence must never carry meaning" rule used by `subStatus`. Two inline adapters in `conversations.handlers.ts` (~322 and ~355) both need it. The list gets it from one `IN (...)` query per page against each db; no cross-db join.
- **`PATCH /api/conversations/:id/outcome`** body `{ "state": "done" | "dropped" | "partial" | "open" | "reopened" | "auto", "note"?: string }`, zod-validated, 200 with the new `outcome`. `auto` clears the override. Registered before the greedy `/:id{.+}` catch-all in `conversations.routes.ts` (same ordering note as the `QUERY .../search-target` route). Mirrors `PATCH /api/sessions/:id/name`. Excluded sub-agent conversations are refused the same way the `QUERY` route does. With the flag off the route is not registered, so it 404s exactly like an old server.
- **WS**: `conversation_outcome { conversationId, outcome }` added to the `WSMessage` union in `src/types.ts` next to `conversation_updated`, sent with `wsHub.broadcast`, emitted by the detector and the PATCH handler. Flag off: never sent.
- **No filter in v1.** There is no `?outcome=` parameter. If it is wanted later it needs the effective state denormalised into a `cache.db` column so SQL can filter and `total`/`hasMore` stay honest.

Docs to update in the same PRs: `docs/compatibility/tb-mobile.md` (new field, endpoint, WS event; all in the "no check needed, additive" tier), `docs/api-reference.md`, `docs/env.example`.

## Backward compatibility

| Pair | Result |
|---|---|
| Flag off, any client | Responses identical to today. Migrations still create two empty tables; they are inert. Rolling back leaves them behind harmlessly. |
| Flag on, old mobile | Unknown list/detail field is ignored. Unknown WS type is ignored (verify in `ws-client.ts` with a test, do not assume). Nothing shows. |
| New mobile, old streamer or flag off | `/api/info` has no `outcomes`, so the badge and actions are hidden. A server that cannot be reached is not read as "unsupported". |
| New streamer value, older new-mobile | State is narrowed with a fallback (`open`, no badge), never an exhaustive `switch`. |
| Multi-server | Gate per row on `conv.serverId`, never globally. |

## Mobile (tb-mobile)

Anchors from a read of the checkout on 2026-10-11.

1. **Types and capability.** `taskOutcome?` on `Conversation` (`types/api.ts:189`) with a `narrowOutcome(raw): TaskOutcome | null` helper. `outcomes?` on `ServerInfo` (`types/api.ts:479`). Map it in `adaptPage` (`hooks/useConversations.ts:74`) and `RawSessionMeta` (`:32`). A small `useOutcomeSupport(serverId)` reads `serverInfo.outcomes` from `stores/servers.ts`.
2. **Badge.** New optional prop on `components/sessions/shared/ConversationListItem.tsx` (meta line), used by `EarlierRow`, `ConvRow` and `ConversationList`. Reuse theme tokens rather than add keys to all 8 themes: `done` to `text.success`, `partial` to `text.warning`, `in_review` and `reopened` to `status.waiting`, `dropped` to `status.idle`. Colour is never the only signal: each state gets an icon and a label, and a `low` confidence shows "likely".
3. **Manual actions.** New items in `QuickAccessActionSheet` (conversation long-press in `NowList`), in `SessionActionSheet` via `useSessionRowActions`, and in the detail header menu and `InfoModal` (`app/conversation/[id].tsx`, `lib/infoFields.ts`). Items: Mark done, Mark dropped, Reopen, Back to automatic. Note `useSessionRowActions` returns early for external sessions (`:46`); outcome belongs to the conversation, so offer it from the detail screen for those.
4. **Mutation.** `useSetConversationOutcome`, copying `useSessionActions.setModel`: `cancelQueries`, optimistic `setQueryData` on `['conversation', serverId, id]`, then invalidate `['conversations']`. API call next to `updateClaudeFlags` in `services/api-client.ts`. A 404 means unsupported: hide the entry point for that server and do not retry.
5. **WS.** `conversation_outcome` added to the `WSMessage` union (`services/ws-client.ts`) and a handler in `app/_layout.tsx` (near `conversation_updated`, `:246`) that patches the cache in place like `session_update` and pushes its unsubscribe into the effect cleanup.
6. **No filter, no sort** in v1.
7. **i18n.** `sessions.outcome.*` in `en`, `he`, `ar`, `ru`; keys resolved by an exhaustive `switch` in a label helper like `sessionStatusLabel.ts`. `npm run test:i18n` is a CI gate.
8. **Open question for the mobile side:** the home list cache key `['conversations-eager']` is only invalidated in the code I read and I did not find what fills it. Confirm what actually feeds the home list before wiring cache patches.

## Phases and PRs

Each PR is small, conventional, rebased and merged one at a time. Docs-only PRs carry `[skip-ci]`.

| # | PR | Repo | Contents |
|---|---|---|---|
| 0 | `docs(plans): task outcomes plan [skip-ci]` | streamer | this file |
| 1 | `feat(outcomes): pure outcome resolver` | streamer | types, `resolveOutcome`, table tests. No wiring. |
| 2 | `feat(outcomes): derive PR and merge outcomes behind a flag` | streamer | flag, local `git merge` detector, both migrations and repos, the `onNewLines` detector, `outcome` on list/detail/session, `/api/info`, WS event, compat docs |
| 3 | `feat(outcomes): manual outcome override` | streamer | `PATCH` route, override repo, WS emit, tests |
| 4 | `feat(outcomes): show outcome badges` | mobile | types, capability, badge, i18n, read-only |
| 5 | `feat(outcomes): change outcome from the phone` | mobile | action sheets, mutation, WS handler |
| 6 | `feat(outcomes): plan-mode partial and research verdicts` | streamer | plan-mode indicators (Copilot first, Claude after the step-0 fixture), turn-end research heuristic |

Deferred, not planned: outcome filtering, `gh pr view` reconcile, history backfill.

Phases 1 to 5 deliver the PR half of the request end to end. Phase 6 is the research half and is last because it is the least certain.

## Testing

- **Resolver:** table-driven. Cases: merge, close duplicate, close redundant, create only, A merged with B open, A merged with B closed, done then substantive follow-up, done then "thanks", partial then follow-up, manual then follow-up, manual `auto` after manual, events out of order.
- **Detector fixtures come from raw transcript bytes**, not printed views (a blank-stripped print once became a fixture and shipped an inert detector). Include the negative cases with a **positive control in the same test**: the same text as assistant prose and as pasted user text must produce nothing while the real `tool_use` produces an event, so a `false` cannot pass for the wrong reason. Also: failed `gh pr create`, `--auto` merge, non-zero exit with a merged result.
- **Local merge:** `git merge feature` on `main` with `Fast-forward` and with `Merge made by` gives `done`. Each of these gives nothing, with the successful case as the positive control in the same test: `git merge origin/main` while on a feature branch, `Already up to date.`, a `CONFLICT` result, `--abort`, `--squash`, a merge into an integration branch, and a merge on `main` while a PR is still open (stays `in_review`).
- **Plan mode:** a pending plan gives `partial`; pending then approved then merged gives `done`; pending then rejected stays `partial`; a plan-mode session with no `exit_plan_mode` and no turn end gives nothing yet. Copilot cases use the documented event shapes; Claude cases wait for the step-0 fixture.
- **Research heuristic:** synthetic fixtures only (the repo is public): a long answered reply, a reply with each failure phrase, a short reply, and a reply that quotes a failure phrase inside a code block. The last two must yield no verdict.
- **Flag off:** snapshot the list and detail responses with the flag off and assert they equal the pre-change shape, key for key.
- **Persistence:** set an override, clear the cache, restart, expect the override intact. This is the test that justifies the two-file split.
- **Mobile:** run all three suites (`unit`, `integration`, e2e), not `test:unit` alone. Hook test with the flag on, off and 404, modelled on `useClaudeFlags.test.tsx`. Heavy `SessionScreen.*` suites re-run with `--runInBand` before a failure is believed.
- Streamer suites run on the `.nvmrc` Node, and `vitest` output is redirected to a file in full.

## Risks

- **False "done" from a misread merge.** Mitigated by text-not-exit-status, tool_use-only matching, and showing evidence (the PR link) next to the badge so a wrong guess is visibly checkable.
- **Reopen misfires** on short real follow-ups ("and the tests?"). The `?` rule catches most; the manual override is the remedy.
- **False "done" from a merge that was only a catch-up.** The default-branch rule and the success-text rule exist for this; a merge whose branch cannot be determined gives nothing rather than a guess.
- **`partial` for a conversation that was only meant to produce a plan.** Accepted: the badge says "plan not executed", and Mark done fixes it in one tap.
- **Stale `in_review`** for PRs merged elsewhere. Accepted in v1; the manual override is the remedy.
- **Mobile releases cannot be force-updated.** Every client-facing change here is additive by construction, and the capability probe is the only switch.
- **Public repo:** no real hostnames, repo names or identifiers go into fixtures or docs; use `example.com` and `example/repo`.
- **Issue tracker:** when this is accepted, file one `P<N>:` issue per repo (streamer and mobile separately, linked by URL) using `threadbase/docs/issue-tracker.md`, and close or comment on each as its PR lands.

## Questions for you

Answered 2026-10-11: a follow-up after `done` reopens it, v1 has no filtering, and there is no model-based judging anywhere in this feature.

None open.
