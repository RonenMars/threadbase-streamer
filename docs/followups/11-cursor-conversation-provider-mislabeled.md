# Cursor live session returns `provider: "claude-code"` when looked up by streamer id

**Status: fixed in #934 (released in 1.98.3).** Written 2026-09-19 against a live Cursor session (`4367097c-7334-4905-a57f-8e0aa7b09ba6` → bound transcript `f22ba10f-30e9-40b6-b27e-e35974fd7bf3`).

## Symptom

`GET /api/conversations/:id` for the **same Cursor transcript file** returns different `meta.provider` depending on which id the client uses:

| Request id | `meta.provider` | Cache row |
|---|---|---|
| Streamer session UUID (`4367097c-…`) | `claude-code` | none (id is not a cache key) |
| Bound transcript UUID (`f22ba10f-…`) | `cursor` | `conversation_meta.provider = cursor` |

Both responses share the same `file_path` under `~/.cursor/projects/…/agent-transcripts/…`. Mobile deep-links and live-session polls use the streamer session UUID, so the mislabel is what the client usually sees.

## Mechanism

In `handleGetConversation` the response provider is:

```ts
const cachedConvMeta = this.cache?.getMetaById(id);
const convProvider = coerceProviderForRunner(conv.provider ?? cachedConvMeta?.provider);
```

Two gaps stack:

1. **Cache lookup uses the request `id`, not `lookupId`.** For a fresh Cursor (or Codex) session, `id` is the PTY placeholder UUID. The cache row — and the only durable provider label — is keyed by `boundConversationId` (the transcript / rollout UUID). `resolveConversationLookupId` already maps placeholder → bound id for locate/find paths; this meta block does not use it.
2. **`coerceProviderForRunner(undefined)` defaults to `claude-code`.** When the scanner `Conversation` object has no `provider` (or it is missing on this path) and the cache miss above returns nothing, the coerce helper in `src/providers.ts` silently maps to Claude.

So a Cursor agent-transcripts conversation is labeled Claude whenever the client asks with the live session id.

## Why it matters

- Clients that branch on `meta.provider` (resume flags, parsing hints, UI badges) treat a live Cursor chat as Claude.
- Resume / availability paths that trust this field can disagree with `GET /api/sessions/:id` (which correctly reports `provider: "cursor"`).
- It is easy to mis-diagnose transcript rendering bugs as “Claude parser on Cursor data” when the wire label is wrong even though message bodies were normalized via the Cursor path.

## Suggested fix

Resolve provider from the bound conversation id before coercing:

```ts
const lookupId = this.deps.resolveConversationLookupId(id);
const cachedConvMeta =
  this.cache?.getMetaById(lookupId) ?? this.cache?.getMetaById(id);
const liveProvider = this.sessionStore.getManaged(id)?.provider;
const convProvider = coerceProviderForRunner(
  liveProvider ?? conv.provider ?? cachedConvMeta?.provider,
);
```

Prefer the live managed session’s provider when present — it is authoritative for an attached PTY — then cache-by-lookupId, then the scanner conversation field. Keep `coerceProviderForRunner` as the last resort only.

Also consider classifying from `file_path` (`agent-transcripts` → cursor, `rollout-*.jsonl` → codex) when every other source is missing, so a cold path cannot default to Claude for a Cursor file.

## Verified state (2026-09-19)

- Live session `4367097c-7334-4905-a57f-8e0aa7b09ba6`, `provider: "cursor"` on `GET /api/sessions/:id`, `boundConversationId: "f22ba10f-…"`.
- `GET /api/conversations/4367097c-…` → `meta.provider: "claude-code"`, same `file_path` as below.
- `GET /api/conversations/f22ba10f-…` → `meta.provider: "cursor"`.
- `conversation_meta` has a row only for `f22ba10f-…` with `provider = cursor`.

## Done when

- Looking up a live Cursor session by either the streamer UUID or the bound transcript UUID returns `meta.provider: "cursor"`.
- A unit or handler test covers placeholder-id lookup with a bound Cursor cache row (and ideally a Codex placeholder → rollout pair) so the default-to-Claude coerce cannot regress.
