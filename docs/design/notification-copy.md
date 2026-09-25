# Design note — what each push notification should say

**Status:** proposed, not implemented. Researched 2026-09-26.

**Scope:** the copy and payload shape of the Expo pushes `WaitingInputNotifier` sends (`src/services/push/notificationCopy.ts`, `waitingInputNotifier.ts`). Not the Live Activity content state, and not *when* a push fires — the turn-signal gating from #962 stays as it is.

## Problem

Every push today reads like every other push of its kind:

| Kind | Title | Body |
|---|---|---|
| `turn_done` | `✅ {project}` | `Claude finished — tap to read the reply and continue.` |
| `permission` | `✋ {project}` | `Claude needs your go-ahead to continue.` |
| `question` | `💬 {project}` | `Claude has a question for you.` |
| `failed` | `❌ {project}` | `Claude could not start.` |

The body carries one fact the title's emoji already told you, and nothing that lets the user decide from the lock screen whether to pick up the phone now.
Two sessions in the same project are indistinguishable.
A Codex usage-limit screen arrives as a `permission` push, so it tells the user the agent "needs your go-ahead" when what it needs is time.

## Why it is this thin

This is a policy choice, not an oversight.
The published privacy policy says notification payloads exclude prompts, terminal output, credentials and conversation content (see the comment on `waitingInputMessage`, and RonenMars/threadbase-mobile#636).
Expo's relay, APNs and FCM all see the payload in clear.
So the copy may say *which* session and *which* agent, and nothing about *what* was said or *what* the agent wants to run.

Everything below is therefore split into two tiers:

- **Tier 0 — metadata only.** Fits the current policy. Ship-able now.
- **Tier 1 — content.** What every other tool does. Needs one of the two routes in [Content tier](#content-tier-the-decision).

## What the field does

Research across agent tools, their issue trackers and platform guidelines. Every claim is linked; wording that could not be verified is listed at the end.

**The top complaint: "needs you" and "finished" look and sound the same.**

- Cursor forum: "Agent/subagent finished (FYI) must use a different sound than you need to click Allow / done / Take control" — <https://forum.cursor.com/t/make-a-sound-when-a-sub-agent-needs-approval/161505>. Cursor staff said on 2026-06-18 they could not pursue it yet.
- Claude Code #12048: `idle_prompt` "fires after EVERY response" and causes alert fatigue; asks for separate waiting-for-action, permission-required and response-complete types — <https://github.com/anthropics/claude-code/issues/12048>.
- Warp splits agent notifications into Complete, Request ("command approval, permission requests, and idle prompts") and Error, shows at most two toasts, and keeps a mailbox with an Errors filter — <https://docs.warp.dev/agent-platform/local-agents/agent-notifications>.
- The ChatGPT/Codex desktop app has separate toggles for completion alerts (never / background only / always) and for permission and question alerts — <https://learn.chatgpt.com/docs/notifications>.
- Claude Code's own mobile push (Remote Control) has two toggles, "Push when Claude decides" and "Push when actions required" — <https://code.claude.com/docs/en/remote-control>.

**Say which session.**

- Claude Code #36885: with several sessions open, "there's no way to know which session is blocked" — <https://github.com/anthropics/claude-code/issues/36885>.
- Codex #4005 asked for `cwd` in the notify payload "especially if multiple `codex` sessions are running in different folders" — <https://github.com/openai/codex/issues/4005>.
- A third-party Cursor write-up: the completion sound "does not tell you *which* project finished" — <https://www.aidonenow.com/blog/cursor-notification-when-done>.

**Say what the agent wants.**

- Codex TUI strings: `Agent turn complete`, `Approval requested: {command}`, `Codex wants to edit {path}`, `Approval requested by {server_name}`, `Question: {title}`; previews capped at 200 graphemes — <https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/chatwidget/notifications.rs>.
- Codex `notify` passes `last-assistant-message`, and the documented sample script puts it in the title — <https://learn.chatgpt.com/docs/config-file/config-advanced>.
- Claude Code's documented notification text is `Claude needs your permission to use Bash`; the hook gets `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, …) — <https://code.claude.com/docs/en/hooks>.
- Community Claude Code hooks: claude-notify titles `Permission Request - {project}` and formats the tool input into the body — <https://raw.githubusercontent.com/343max/claude-notify/main/claude-notify.ts>; claude-ntfy-hook shows the question text and command previews "instead of generic messages", with Allow/Deny buttons — <https://github.com/nickknissen/claude-ntfy-hook>.
- GitHub Mobile's live notifications for Copilot CLI sessions show state as In progress / Waiting for user input / Idle / Finished — <https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions/>.

**Platform rules.**

- Apple HIG: title is context ("a headline, event name, or email subject"), no app name; body in complete sentences; "avoid sending multiple notifications for the same thing"; provide generic text for hidden previews; action labels short and describing the result — <https://developer.apple.com/design/human-interface-guidelines/notifications>.
- Apple: subtitle offers "additional context in cases where the title alone isn't clear"; Time Sensitive is "only for notifications that are relevant in the moment"; `authenticationRequired` actions only run on an unlocked device.
- Android: title ≤ 30 characters, most important first, no app name; text ≤ 40 characters and not repeating the title; at most three actions, none duplicating the tap — <https://developer.android.com/design/ui/mobile/guides/home-screen/notifications>.
- Put "the most important, actionable part… in the first 40 characters" — <https://airship.com/blog/brevity-wit-the-ideal-push-notification-length/>.
- NN/g: no bursts, no notifications "for every little thing" — <https://www.nngroup.com/articles/push-notification/>.

## Structure

| Slot | Content | Why |
|---|---|---|
| Title | `{emoji} {project} · {branch}` — branch omitted when it is the default branch; whole title ≤ ~30 chars, truncate the branch first | Which session. `branch` is already on `ManagedSession` and is not conversation content. |
| Subtitle (iOS) | `{agent} {event}` — "Claude finished", "Codex wants to run a command" | What happened. Expo's `subtitle` is iOS-only, so on Android this goes first in the body. |
| Body | The detail: Tier 0 metadata, or Tier 1 content | What to do about it. Key point in the first 40 chars. |

Keep the emoji marks: they are what makes a stack scannable, in every locale.
Keep the current `threadId` / `collapseId` / `tag` per session: a newer state replacing the older banner is exactly the "don't notify twice" rule.

## Per kind

### Turn finished (`turn_done`)

| | Subtitle | Body |
|---|---|---|
| Today | – | Claude finished — tap to read the reply and continue. |
| Tier 0 | Claude finished | Worked for 12 min. |
| Tier 1 | Claude finished | First ~150 chars of the last assistant message, markdown stripped. |

Turn length is `Date.now() - openTurn.get(id)`, which the notifier already holds.
Under a minute, drop the duration rather than printing "0 min".
A count of files edited / commands run would be good Tier 0 material if the transcript parse can supply it cheaply; do not add a parse just for this.

Urgency: `active`, default sound. This is the FYI push.

### Permission (`permission`)

| | Subtitle | Body |
|---|---|---|
| Today | – | Claude needs your go-ahead to continue. |
| Tier 0 | Claude wants to run a command / edit a file / use {MCP server} | Paused until you answer. |
| Tier 1 | Claude wants to run a command | `npm test -- --watch` (or `src/auth.ts`, or the MCP tool name) |

The tool category comes from the gate itself: `PermissionGate.prompt` already reads "Claude needs your permission to use Bash".
Map the tool name to a fixed phrase (Bash → run a command, Edit/Write → edit a file, `mcp__{server}__*` → use {server}, anything else → use {tool}); the phrase is ours, not the agent's.
Whether naming the tool category is inside the current policy is a judgment call — it is not a prompt, output or conversation content, but it does say what kind of thing the agent wants to do. Decide once, and record it next to the policy text.
`PermissionGate.detail` holds the command/path for Tier 1.

Urgency: `time-sensitive`, distinct sound. The agent is blocked.

Actions: **Allow** and **Deny** (Deny destructive), both `authenticationRequired`.
They answer through the existing `POST /:id/permission/answer` with the gate's `contentKey`, so the push `data` must carry `contentKey` and the option indices for Allow and Deny.
"Always allow" is not offered from the lock screen.

### Question (`question`)

| | Subtitle | Body |
|---|---|---|
| Today | – | Claude has a question for you. |
| Tier 0 | Claude asked a question | 3 options — paused until you pick one. |
| Tier 1 | Claude asked: {header} | The question text, then `A · B · C`. |

Option count is metadata (`AskQuestion.options.length`); `header` and `question` are the agent's words, so Tier 1.
Answer buttons only for a two-option question: iOS registers category button labels ahead of time, so per-question labels need a notification service extension, and Android caps actions at three.
Everything else opens the app.

Urgency: `time-sensitive`, same sound as permission.

### Failed to start (`failed`)

| | Subtitle | Body |
|---|---|---|
| Today | – | Claude could not start. |
| Tier 0 | Claude could not start | Reason and next step, from a fixed table (below). |

`failureReason` is free text that embeds the project path, which is why the push never carries it.
`ManagedSession.failureCode` already exists but only Codex's `failStartup` sets it (`codex_active_writer`, `codexScreen.ts`).
Set it at the other sites too, and map the code to fixed copy:

| Code | Set at | Body |
|---|---|---|
| `project_dir_missing` (new) | the "Project directory not found" sites in `pty-manager.ts`, `codex-pty-runner.ts`, `cursor-pty-runner.ts`, `sessions.handlers.ts` | The project folder no longer exists on this computer. |
| `instant_exit` (new) | the "process exited immediately (code N)" sites in the same runners | Claude exited as it started. Check it is installed and signed in. |
| `codex_active_writer` (exists) | Codex single-writer refusal | This conversation is open in another terminal. Fork it to continue here. |

A missing CLI needs no push: `LiveSessionManager` refuses it before the spawn with 503 `PROVIDER_NOT_INSTALLED`, in front of the user.
Unmapped codes fall back to today's sentence. The copy is ours, so Tier 0 carries all of it.

Urgency: `active`.

### Usage or rate limit (new kind: `limited`)

Today this goes out as `permission`. Give it its own kind, and let it bypass the permission copy.

| | Subtitle | Body |
|---|---|---|
| Tier 0 | Codex hit its usage limit | Resets at 14:00. Paused until then. |

The reset time is on the limit screen the runner already matches (`codex.usage_limit`); parse it if it is there, and drop the sentence if not. It is a clock time, not conversation content.
It should follow the same `waitingInput` preference as today, so no user loses it.

Urgency: `active`. Nothing the user can do in the next minute.

### Hold / idle

No push, as today. The grace hold and the idle reaper act on sessions the user already left.
If the idle nudge in [idle-session-notifications.md](idle-session-notifications.md) is built, it is `passive`: "Parked for 6 h — stopped to save resources. Resume any time."

## Urgency, sound and channels

| Kind | iOS `interruptionLevel` | Sound | Android channel |
|---|---|---|---|
| permission, question | `time-sensitive` | distinct "needs you" sound | `needs-you` (high importance) |
| turn_done, failed, limited | `active` | default | `updates` (default importance) |

Constraints:

- Expo's `sound` field is iOS-only. Android plays the sound of the channel, so the distinct sound means two channels created by the app, and `channelId` on each push — but only to apps known to have created them (see [Implementation notes](#implementation-notes)), because a push naming a missing channel is not displayed at all.
- `time-sensitive` needs the `com.apple.developer.usernotifications.time-sensitive` entitlement in the app, and the user can still turn it off per app.
- Never `critical`.

This split is the single change users ask for most.

## Lock screen

When the user hides previews, iOS shows the category's `hiddenPreviewsBodyPlaceholder` instead of the body.
Register one per category in the app: "Needs your answer", "Finished", "Could not start".
Tier 0 copy is safe to show anyway; this matters once Tier 1 content appears.

## Content tier: the decision

Tier 1 contradicts the privacy policy as written. Two routes:

1. **Opt-in setting**, "Show agent messages in notifications", default off.
   Simple: the streamer fills the body when the recipient's token says so (`ExpoPushSender` already applies preferences per token).
   Costs: the policy text changes, and Expo, Apple and Google see the content.
2. **Encrypted payload, decrypted on the phone** — the Signal/WhatsApp pattern.
   The push carries Tier 0 copy plus an encrypted blob and `mutableContent: true`; an iOS notification service extension (and the Android equivalent in the app's messaging handler) decrypts it with the device key and rewrites title, body and buttons.
   The relays see only ciphertext, so the policy stays true. It also removes the static-button limit for questions.
   Costs: a native extension in tb-mobile, and it depends on the E2EE program's per-device keys.

**Recommendation:** ship Tier 0 now; do Tier 1 through route 2 when E2EE device keys land.

## Implementation notes

Streamer:

- `waitingInputMessage` gains `subtitle`, `interruptionLevel`, `channelId`, `categoryId`; `ExpoPushMessage` gains the same optional fields.
- `onPrompt` receives the gate (or question) rather than just its kind, so it can pick the tool phrase and carry `contentKey`.
- New `AttentionKind` `limited`; the Codex limit path calls it instead of `permission`.
- `failureCode` set at every `failureReason` site, not only Codex's `failStartup`.
- The title needs `branch`; `waitingInputMessage`'s `Pick<>` widens accordingly.
- New strings in all four locales (`en`, `he`, `ar`, `ru`); the non-English ones want native review, as the file header already says.

Mobile (separate PR):

- Two Android channels, and the iOS categories with Allow/Deny actions and hidden-preview placeholders.
- The time-sensitive entitlement.
- An action handler that posts the answer, and falls back to opening the session when it fails.

Mostly additive on the wire: an old app ignores `subtitle`, an unknown `categoryId` only means no buttons, and unknown `data` keys are ignored.
**`channelId` is the exception.** Expo: "If an ID is specified but the corresponding channel does not exist on the device … the notification will not be displayed to the user." Sending it to an app that has not created the channel silently drops the push.
So the streamer sends `channelId` only to tokens that say they have the channels. `push_tokens` has no such field today (it carries `locale` and `notification_prefs`, migrations 025/026); add one the same way — a per-token list of notification features the app registered with — and omit `channelId` for every token without it.

## Not verified

- Exact push wording of Happy, Copilot, Jules, Devin, Replit, Windsurf, Conductor, Terragon and Omnara — not published anywhere reachable.
- ChatGPT deep-research and Gemini "ready" wording.
- Cursor's built-in notification text.
- The often-quoted ~178-character iOS body limit appears only in vendor blogs, not in Apple documentation; this note relies on the 40-character guidance instead.
