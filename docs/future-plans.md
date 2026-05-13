# Future Plans

Items deferred from the current implementation cycle. None of these are in scope for the active branch.

---

## 1. UI Display for Unrendered Fields

These fields are now parsed and available in the data pipeline (scanner → streamer → mobile) but not yet rendered in the tb-mobile UI. All of them require UI work in tb-mobile and forwarding work in tb-streamer.

### Per-message fields

| Field | Source | UI work needed |
|---|---|---|
| `isThinking` + `thinkingContent` + `thinkingSignature` | `ConversationMessage` | `ThinkingCard` component — collapsible "Reasoning" section; show placeholder when thinking is redacted (signature present, content empty) |
| `hasImages` | `ConversationMessage.hasImages` | Image badge/indicator on messages that contain images (base64 data is not forwarded — badge only) |
| `parentUuid` | `ConversationMessage.parentUuid` | Could power a conversation graph view or streaming-chunk grouping indicator |
| `permissionMode` | `ConversationMessage.permissionMode` | Session/message-level badge (e.g. "auto", "plan", "bypassPermissions") |
| `isSidechain` | `ConversationMessage.isSidechain` | Indicator distinguishing subagent messages from main conversation |
| `attachment` | `ConversationMessage.attachment` | Display deferred-tool delta info (which tools were added/removed at this point in the conversation) |

### Conversation-level fields

| Field | Source | UI work needed |
|---|---|---|
| `turnDurations` | `Conversation.turnDurations` | Per-turn timing display (e.g. "Turn took 5.4s") in conversation detail view |
| `lastPrompt` | `ConversationMeta.lastPrompt` | Show last user prompt as subtitle in conversation list or detail header |

### Implementation path (when ready)

1. **tb-streamer `src/server.ts`** — forward all per-message fields in `messagesPayload`; add `turn_durations` to `body` and `last_prompt` to `meta` (see `docs/jsonl-fields-propagation-plan.md` for exact shapes)
2. **tb-mobile `types/api.ts`** — add types for all new fields
3. **tb-mobile `hooks/useConversations.ts`** — parse and pass through new fields
4. **tb-mobile `components/conversation/ThinkingCard.tsx`** — new component
5. **tb-mobile `app/conversation/[id].tsx`** — wire up rendering

---

## 2. Deferred Scanner Items

These were explicitly out of scope during the scanner alignment work (`feat/align-with-jsonl-format-spec`).

| Item | Reason deferred |
|---|---|
| `entrypoint` / `userType` fields | Session-level constants (always `"cli"` / `"external"`); not useful as per-message signals |
| `sourceToolAssistantUUID` | Requires non-trivial cross-entry correlation to be useful; no concrete consumer use case yet |
| Full `SystemEntry` type for `stop_hook_summary` / `bridge_status` | Internal Claude Code housekeeping; `turn_duration` (already extracted) is the only field with general analytics value |
| Per-image metadata (`ImageBlock` type) | `hasImages` boolean is sufficient until a concrete consumer needs per-image data (media type, size, etc.) |
