# JSONL Fields Propagation Plan

> Propagating new `@threadbase/scanner` fields through tb-streamer → REST API → tb-mobile.
>
> Scanner changes are already merged on `feat/align-with-jsonl-format-spec`.
> This document covers the two remaining layers.

---

## Layer 1: tb-streamer `src/server.ts`

### 1a. Per-message fields — `messagesPayload` mapper

Current mapper (inside `handleGetConversation`):

```typescript
const messagesPayload = slice.map((m: any, localIdx: number) => ({
  message_index: fromIdx + localIdx,
  role: m.role,
  timestamp: m.timestamp,
  text: m.text,
  tool_calls: m.metadata?.toolUses ?? [],
  content: [
    ...(m.metadata?.toolUseBlocks ?? []).map(...),
    ...(m.metadata?.toolResults ?? []).map(...),
  ],
}));
```

Add these fields to every message object:

| Field added to response | Source in `ConversationMessage` | Notes |
|---|---|---|
| `thinking` (inside `content[]`) | `isThinking`, `thinkingContent`, `thinkingSignature` | Push `{ type: "thinking", thinking: m.thinkingContent ?? "", signature: m.thinkingSignature }` into `content[]` when `m.isThinking` |
| `has_images` | `m.hasImages` | `has_images: m.hasImages ?? false` |
| `parent_uuid` | `m.parentUuid` | `parent_uuid: m.parentUuid ?? null` |
| `permission_mode` | `m.permissionMode` | `permission_mode: m.permissionMode ?? null` |
| `is_sidechain` | `m.isSidechain` | `is_sidechain: m.isSidechain ?? false` |
| `attachment` | `m.attachment` | `attachment: m.attachment ?? null` |

Resulting message object shape:

```json
{
  "message_index": 3,
  "role": "assistant",
  "timestamp": "2026-05-01T10:00:01.000Z",
  "text": "I'll run the tests now.",
  "tool_calls": ["Bash"],
  "has_images": false,
  "parent_uuid": "u1",
  "permission_mode": null,
  "is_sidechain": false,
  "attachment": null,
  "content": [
    { "type": "thinking", "thinking": "", "signature": "EoMCClsIDBgC..." },
    { "type": "tool_use", "id": "tu1", "name": "Bash", "input": { "command": "npm test" } }
  ]
}
```

### 1b. Conversation-level fields

**`meta` object** — add `last_prompt`:

```json
"meta": {
  "id": "...",
  "profile_id": "...",
  "project_name": "...",
  "project_path": "...",
  "file_path": "...",
  "last_updated_at": "...",
  "message_count": 12,
  "last_prompt": "Fix the bug in main.ts"
}
```

**Top-level `body`** — add `turn_durations`:

```json
{
  "meta": { ... },
  "messages": [ ... ],
  "message_pagination": { ... },
  "turn_durations": [
    { "duration_ms": 5432, "message_count": 2, "uuid": "s4" }
  ]
}
```

### Files to change in tb-streamer

- `src/server.ts` — only `handleGetConversation`, the `messagesPayload` mapper and `body` construction

---

## Layer 2: tb-mobile

### 2a. Types — `types/api.ts`

**Add to `MessageContent` union:**

```typescript
| { type: 'thinking'; thinking: string; signature?: string }
```

**Add to `Message` interface:**

```typescript
has_images?: boolean
parent_uuid?: string | null
permission_mode?: string | null
is_sidechain?: boolean
attachment?: Record<string, unknown> | null
```

**Add to `ConversationDetail`:**

```typescript
turn_durations?: TurnDuration[]
```

**Add new `TurnDuration` interface:**

```typescript
export interface TurnDuration {
  duration_ms: number
  message_count: number
  uuid?: string
}
```

**Add `last_prompt` to `RawSessionMeta` (in `useConversations.ts`):**

```typescript
interface RawSessionMeta {
  ...
  last_prompt?: string
}
```

**Add `last_prompt` to `Conversation`:**

```typescript
lastPrompt?: string
```

### 2b. Parsing — `hooks/useConversations.ts`

**In `adaptRawMessage`**, add handling for `thinking` blocks inside `m.content`:

```typescript
} else if (block.type === 'thinking') {
  content.push({ type: 'thinking', thinking: block.thinking ?? '', signature: block.signature })
}
```

**Pass through new message-level fields:**

```typescript
return {
  id: `${convId}-${idx}`,
  role: m.role as 'user' | 'assistant',
  content,
  timestamp: m.timestamp,
  has_images: m.has_images,
  parent_uuid: m.parent_uuid,
  permission_mode: m.permission_mode,
  is_sidechain: m.is_sidechain,
  attachment: m.attachment,
}
```

**In `adaptRawConversation`**, forward `last_prompt` and `turn_durations` from the raw response to the `ConversationDetail` object.

### 2c. Rendering — `app/conversation/[id].tsx` + components

**Thinking blocks** — add a `ThinkingCard` component (or handle inside `ToolCard`):
- Rendered as a collapsible "Reasoning" section
- Shows `thinking` text when present; shows "Reasoning redacted" placeholder when `thinking` is empty but `signature` is present
- Collapsed by default

**`has_images` badge** — add a small image indicator on messages where `has_images === true` (since the actual image data is not forwarded, just a badge/label)

**`renderContent` in `[id].tsx`** — add:

```typescript
if (block.type === 'thinking') {
  return <ThinkingCard key={index} block={block} />
}
```

### Files to change in tb-mobile

| File | Change |
|---|---|
| `types/api.ts` | Add `thinking` block type, `TurnDuration`, new fields on `Message`, `Conversation`, `ConversationDetail` |
| `hooks/useConversations.ts` | Parse `thinking` blocks, pass through new fields, forward `last_prompt` + `turn_durations` |
| `app/conversation/[id].tsx` | Add `thinking` case to `renderContent` |
| `components/conversation/ThinkingCard.tsx` | New component — collapsible reasoning block |

---

## Backward Compatibility

All new fields are additive:
- Older mobile clients will ignore unknown fields in the JSON response — safe
- New mobile build on older streamer (pre-this-change) — all new fields will be `undefined`/absent; graceful fallback needed in `adaptRawMessage` (already handled by `?? false` / `?? null` defaults)

---

## Implementation Order

1. `tb-streamer/src/server.ts` — forward fields in REST response
2. `tb-mobile/types/api.ts` — add types
3. `tb-mobile/hooks/useConversations.ts` — update parsing
4. `tb-mobile/components/conversation/ThinkingCard.tsx` — new component
5. `tb-mobile/app/conversation/[id].tsx` — wire up rendering
