# Deferred: consuming the scanner's subagent identity fields

**Status: deliberately not implemented.** This records what a future change would
consume, which field is a trap, and the conditions under which the work becomes
worth doing. Written 2026-09-08, after `@threadbase-sh/scanner@0.16.0` published
`subagentId` and `parentSessionUuid`.

## Background

A Claude subagent transcript lives at
`.../<parentSessionId>/subagents/agent-<agentId>.jsonl` and its lines carry
`isSidechain: true`, `agentId: "<child id>"` and `sessionId: "<PARENT's id>"`.
The scanner derives conversation identity from that in-file `sessionId`, so it
reports the **parent's** id as each child's identity and several subagents of one
parent collapse to a single identity.

Demonstrated against `@threadbase-sh/scanner@0.15.0` with a fixture of one parent
and two children (`agent-one.jsonl`, `agent-two.jsonl`):

```
{"sessionId":"parentuuid","isSubagent":true, "parentSessionId":"<abs>/projects/-tmp-proj/parentuuid.jsonl","base":".../subagents/agent-two.jsonl"}
{"sessionId":"parentuuid","isSubagent":true, "parentSessionId":"<abs>/projects/-tmp-proj/parentuuid.jsonl","base":".../subagents/agent-one.jsonl"}
{"sessionId":"parentuuid","isSubagent":false,"parentSessionId":null,             "base":"projects/-tmp-proj/parentuuid.jsonl"}
```

Both children report `sessionId: "parentuuid"`. That is why
`src/services/conversations/classification.ts` re-derives identity from the raw
JSONL and why `src/conversation-cache.ts` repairs aliases.

## Field mapping, if consumption is implemented

| Scanner field | Streamer column | Rule |
|---|---|---|
| `isSubagent` (required) | `is_subagent` | Safe to read. See the version constraint below. |
| `parentSessionUuid` (optional, 0.16.0+) | `parent_conversation_id` | The parent's UUID. This is the correct source. |
| `subagentId` (optional, 0.16.0+) | — | **Never** the conversation id. See below. |
| `parentSessionId` (required) | — | **Never read it.** See below. |

### `parentSessionId` is a path, not an id

It holds the parent's JSONL **file path**, not a conversation id — verified at
runtime, above. It is internally consistent for the scanner, whose own `id` is a
file path and whose `toTree()` matches the two against each other.

The streamer's `parent_conversation_id` holds a conversation id. Both fields are
`string`, so wiring one into the other **compiles, runs, and stores wrong data**
with no exception and no test failure unless a test asserts on the value. Use
`parentSessionUuid`.

### `subagentId` must never become the conversation id

`subagentId` is Claude's bare `agentId`; the streamer's persisted id is the file
stem. For `.../subagents/agent-one.jsonl` the streamer's id is `agent-one` while
`agentId` is `one`.

Adopting it would rewrite ids already in `conversation_meta.id` and
`managed_sessions.id` / `bound_conversation_id`, and already handed to released
tb-mobile builds that cannot be force-updated. Keep the file-stem id.

## Why the local derivation survives — two reasons, only one of which expires

### 1. Permanent: most call sites never hold a scanner meta

Of the eight sites that derive subagent identity, **only two ever hold a scanner
meta** and could consume these fields at all:

- `src/conversation-cache.ts` `upsertFromScannerMeta` — the scan path
- `src/api/handlers/conversations.handlers.ts` `publicScannerMeta`

The other six have only a file path, or raw JSONL lines:

- `classification.ts` (`ConversationClassifier`, `classifyConversationFile`)
- `conversation-cache.ts` `reconcileClassification` and `classifyAppendedLines`
  (the live tail — the scanner is not involved at all)
- `conversations.handlers.ts` `isExcludedSubagent`
- `sessions.handlers.ts` `resumeSession`

**This reason does not expire at any scanner version.** Those six keep a local
derivation permanently, so consumption adds a code path rather than removing one.

### 2. Version-scoped: the Windows separator bug, fixed in 0.16.0

Scanner **0.15.0 and earlier** computed `isSubagent` as
`filePath.includes("/subagents/")` while canonicalizing paths to **backslashes**
on Windows, so the field was **always `false` on Windows** for every Claude
subagent. Because `isSubagent` is a *required* field there is no absence to key a
fallback on — a consumer cannot distinguish a broken `false` from a true `false`.
Against such a scanner, consumption must be `local || scanner`, never a
replacement.

**0.16.0 fixed it**, shipping a separator-agnostic `/[\\/]subagents[\\/]/`.

**This reason expires with the dependency range, and the range settles it.**
`package.json` declares a caret range, and for `0.x` versions npm's caret admits
only patch-level changes:

```
semver.satisfies("0.15.9", "^0.16.0") === false
semver.satisfies("0.16.5", "^0.16.0") === true
```

So once the dependency is `^0.16.0`, the declared range **cannot** resolve to a
pre-0.16.0 scanner and this constraint is lifted. It would return only if the
range were widened to admit `0.15.x` again (for example `>=0.15.0`).

One build-hygiene caveat that is *not* a range problem: a `git pull` does not
refresh `node_modules`, so a checkout can have 0.15.x on disk while
`package.json` says `^0.16.0`. Verify with `npm ls --depth=0` and resync with
`npm ci` — see the dependency note in `CLAUDE.md`.

## Why this was judged not worth doing

Deferring work to another component pays off when it removes work here. This
removes none:

- The streamer opens every transcript **anyway** for `has_messages`
  classification, which depends on the streamer's own Codex injected-context
  filter (`src/utils/codexConversationLine`) and cannot move to the scanner.
  Identity falls out of that same parse for free, so deferring it saves no I/O.
- The parent id is already free: `classification.ts` reads it from the very line
  it is parsing. Resolving the scanner's path-shaped `parentSessionId` instead
  would mean canonicalizing and looking the path up — more work, plus a new
  failure mode (parent not yet indexed yields `null`, silently).
- Reason 1 above means six of eight sites keep their local derivation regardless.

The scanner's fix is still worth having for **every other consumer of the
scanner**, and the Windows bug was real and total on that platform. Those are
separate justifications from the streamer's own duplication, which is cheap to
keep and expensive to replace.

## If it is implemented anyway

- Bump the dependency **first, as its own change**, so a behaviour shift from a
  scanner minor can be bisected to the bump rather than to consumption.
- Consumption is a second, separate change.
- Do not delete the local derivation at the six sites that have no scanner meta.
- Cover both directions in tests: fields present (trusted) and absent (fallback).
