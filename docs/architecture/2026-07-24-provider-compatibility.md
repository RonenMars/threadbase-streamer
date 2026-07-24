# Provider Compatibility Framework

**Date:** 2026-07-24
**Status:** Proposed
**Scope:** tb-streamer (provider adapters, fixtures, capability reporting) — capability contract consumed by tb-mobile

---

## Problem

Everything we know about a provider is something the provider can change without telling us: its JSONL schema, its file locations, its process arguments, its TUI strings, and its resume semantics. Today that knowledge is spread across the codebase as literals, and there is no mechanism that notices when one of them stops being true.

### 1. Unknown events are silently discarded

`normalizeCodexLineToClaudeShape` (`src/utils/codexConversationLine.ts:42-93`) walks a Codex rollout line through five `return null` gates: not `response_item` (`:59`), payload not `message` (`:61`), role not user/assistant (`:64`), no extractable text (`:67`), and "looks injected" (`:72`).

Every one of those is indistinguishable at the call site from "this line was legitimately not chat". `toClientConversationLines` (`:115-127`) collects only the survivors, so a Codex release that renames `response_item`, nests `payload` differently, or introduces a new message envelope produces **an empty conversation and no error** — the same observable outcome as a session that genuinely had no messages.

That is the single most dangerous property in the current design: schema drift is silent, and it degrades to "the app looks broken" rather than "the app says the provider changed".

### 2. Detection depends on provider prose

Live state is inferred from English strings and box-drawing characters scraped off a rendered screen.

Claude: `CLAUDE_PROMPT_MARKERS = ["╭", "❯"]` (`src/pty-manager.ts:50`), `ASK_FOOTER_RE = /Enter to select/i` (`src/services/questions/detectQuestionFromScreen.ts:27`), `CLAUDE_CHROME_RE = /Enter to select|Esc to cancel|╭|╰|│.*│/` (`src/services/questions/detectShellPrompt.ts:52`), and an OSC 777 payload matched on the literal `Claude Code` notify string (`src/services/questions/detectPermissionGate.ts:3-5`).

Codex: `CODEX_PROMPT_READY_TEXT = "Ready"` (`src/codex-pty-runner.ts:44`), `CODEX_TRUST_GATE_REGEX = /trust the contents/i` (`:51`), plus hard-coded gate option labels like `"Trust all and continue"` and `"Continue without trusting (hooks won't run)"` (`:118-127`).

These are UI copy. A provider reworder — not even a breaking change from their perspective — turns a working session into one that never reaches `waiting_input`, or a permission gate mobile never renders.

### 3. The `services/questions/*` detectors are Claude-only despite generic names

`detectQuestionFromScreen`, `detectPermissionGate`, and `detectShellPrompt` read like shared services. They are not: they encode Claude's TUI chrome, and they are imported exclusively by `src/pty-manager.ts`. `CodexPtyRunner` re-implements its own parallel detection inline.

So "add a third provider" currently means writing a third bespoke runner with a third private copy of gate detection, with nothing enforcing that it implements the same surface.

### 4. Fixtures exist but carry no provenance

`__tests__/fixtures/codex-rollout.jsonl` is a real capture and its own payload records `cli_version: "0.140.0-alpha.19"` — but no code or test reads that field. Nothing states which provider version any fixture represents, so a passing suite proves only "we still parse the shape we captured at an unknown point in the past".

There is no mechanism to say *this adapter is verified against provider version X*, and therefore no mechanism to warn when the installed provider is something else.

### 5. Capability differences exist but are invisible

The code already branches on provider in ways that are really capability statements: Claude takes `--session-id` on fresh spawn while Codex has no equivalent and must late-bind a rollout id (`src/codex-pty-runner.ts:231-232`, `src/server.ts:4106-4215`); Claude accepts `--system-prompt` while Codex takes a positional (`src/codex-pty-runner.ts:300-323`); Claude's env is scrubbed of `CLAUDE_CODE_*` while Codex's is passed through (`src/pty-manager.ts:162-178` vs `src/codex-pty-runner.ts:260`).

None of this is queryable. `LiveSessionManager.assertSupportedProvider` (`src/live-session-manager.ts:123-129`) throws a 501 for unknown providers, which is the only capability signal that reaches a client — and it arrives as a failed action rather than an absent button. Mobile U7 ("hide unsupported actions, explain generic-terminal mode") has nothing to read.

### 6. Claude's schema is parsed twice, by two unrelated parsers

The scanner (`@threadbase-sh/scanner` v0.12.0) exports `parseJsonlLine`, and `src/conversation-cache.ts` imports it (`:1-8`) — but only for the offset index (`:646`, `:741`).

The **live tail** path does not use it. `updateFromLine` (`:959-1019`) hand-rolls its own `JSON.parse` against a locally-declared `JsonlLine` interface (`:141-160`), with its own field assumptions: `line.role ?? line.type`, `message.content`, `cwd`, `slug`, `entrypoint`.

So Claude's JSONL schema is encoded in two independent places that can drift apart silently — a scanner upgrade that adapts to a Claude change fixes history indexing while the live path keeps mis-parsing, or vice versa. Neither has a test that pins them to the same provider version.

The same split shows up in the provider enum itself: `ProviderName` is declared in `src/providers.ts:1-3` **and** independently in the scanner's `index.d.ts:26`. Nothing links them, so adding a provider means editing both and nothing catches a mismatch.

### 7. Unknown providers are silently coerced, not rejected

`coerceProviderForRunner` (`src/providers.ts:12-16`) maps any unrecognized provider string to `claude-code`. The comment explains the motivation — a legacy `"threadbase"` value in old caches would otherwise 501 — but the effect is that a genuinely unknown provider is quietly driven by the Claude runner, with Claude's argv, Claude's markers, and Claude's env scrubbing. `provider ?? CLAUDE_CODE_PROVIDER` appears again at `src/conversation-cache.ts:1235`, `:1366`, `:1441`.

That is the opposite of the generic-terminal fallback C2 requires: instead of admitting we do not know the provider, we assert the wrong one.

### 8. Where the boundary sits

Bulk history indexing belongs to the scanner (`CodexCliProvider`, `ThreadbaseProvider`, `parseJsonlLine`). Our `src/` owns the live path: the second Claude parser above, the Codex→Claude wire normalizer, PTY screen scraping, and gate detection.

C2 scopes to the live path. Changing the scanner's own parsing is a dependency-level concern and is out of scope — stated explicitly so the fixture coverage below is not mistaken for covering it.

---

## Goals

- An explicit adapter interface: adding a provider means implementing a declared surface, not copying a runner.
- Versioned fixtures whose provider version is recorded and asserted.
- Schema-tolerant parsing: unknown shapes are preserved and reported, never silently dropped.
- Capability detection exposed over a contract mobile can consume.
- Compatibility warnings when the installed provider differs from what the adapter is verified against.
- A documented process for adding a provider.
- Generic-terminal fallback when semantic support is unavailable.

### Non-goals

- Rewriting prompt detection to be provider-agnostic. The detectors stay provider-specific; C2 makes that *explicit and pluggable*, it does not attempt a universal TUI parser.
- Moving to provider-native server protocols (recorded as alternative C in the C1 ADR).
- Changing `@threadbase-sh/scanner`'s parsing.
- Session lifecycle and state confidence — C1 and C3.

---

## Design

### The adapter interface

`LiveSessionManager` already holds `Map<ProviderName, SessionRunner>` (`src/live-session-manager.ts:15-21`). That map is the adapter registry; it just lacks a declared capability surface alongside the behavioural one.

`SessionRunner` (execution) gains a sibling `ProviderAdapter` (description):

```ts
interface ProviderAdapter {
  name: ProviderName
  capabilities: ProviderCapabilities
  /** Provider versions this adapter's fixtures were captured against. */
  verifiedAgainst: { min?: string; max?: string; captured: string[] }
  /** Read the installed provider's version, or null if undetectable. */
  detectVersion(): Promise<string | null>
  /** Normalize one native-history line; never silently drops. */
  normalizeLine(line: string): NormalizeResult
}
```

Capabilities are the branches that already exist, promoted to data:

```ts
interface ProviderCapabilities {
  freshSessionId: 'explicit' | 'late-bound'   // --session-id vs rollout discovery
  resume: 'native' | 'unsupported'
  systemPrompt: 'flag' | 'positional' | 'unsupported'
  structuredQuestions: boolean   // AskUserQuestion-style menus we can parse
  permissionGates: boolean       // gates we can detect and answer
  liveControl: boolean           // can we send input at all, or is this read-only
}
```

Nothing new is invented here — each field has a current answer derivable from the code cited above. The change is that the answer becomes queryable instead of implied by a code path.

### Schema-tolerant parsing with preservation

`normalizeLine` returns a verdict rather than `string | null`:

```ts
type NormalizeResult =
  | { kind: 'message'; line: string }        // normalized, render it
  | { kind: 'ignored'; reason: string }      // recognized, deliberately not chat
  | { kind: 'unknown'; raw: string; reason: string }  // NOT recognized
```

The distinction between `ignored` and `unknown` is the whole point. `ignored` covers `session_meta`, `turn_context`, the duplicate `event_msg` copies, and injected-context blobs — shapes we recognize and choose not to render. `unknown` covers anything the adapter does not recognize at all.

`unknown` results are counted per session and surfaced as a compatibility warning. They are never rendered as chat (that would be worse than dropping them), but their existence stops being invisible: a Codex release that renames its envelope produces "12 unrecognized events — this Codex version may be newer than the adapter supports" instead of an empty screen.

The unknown *payload* is retained only in memory for diagnostics, capped, and never persisted or logged verbatim — rollout lines contain user prompts and file contents.

### Versioned fixtures

Fixtures move to `__tests__/fixtures/providers/<provider>/<version>/` with a `manifest.json` recording the provider version, capture date, and which capabilities the capture exercises.

The existing `codex-rollout.jsonl` already carries `cli_version: "0.140.0-alpha.19"` in its payload; the manifest makes that a first-class, asserted fact rather than incidental data. A regression test parses every fixture through its adapter and asserts zero `unknown` results — so a parser change that starts dropping a known shape fails loudly.

Adding a provider version means adding a directory, not editing a parser.

### Compatibility warnings

At startup (and on provider re-detection) each adapter compares `detectVersion()` against `verifiedAgainst`. Three outcomes:

- **Within range** → no warning.
- **Newer than `max`** → warn: unverified, degrade gracefully, keep working.
- **Undetectable** → warn once; treat as unverified rather than assuming compatibility.

A warning is a report, never a refusal to run. The user's provider working slightly outside our verified range is vastly better than us blocking it.

### Generic-terminal fallback

When an adapter's semantic support is unavailable — an unknown provider, or a known one whose detection has gone quiet — the session degrades to raw terminal: bytes stream through, input is accepted, and no structured questions/gates/status are claimed. `capabilities.structuredQuestions = false` and `liveControl = true` describe exactly that state, so mobile can render a terminal rather than a broken chat.

This is the honest failure mode. C1's principle applies again: never present a confident interpretation when confidence is absent.

---

## Contract additions

Additive, consumed by mobile U7. New endpoint rather than new `SessionResponse` fields, since capabilities are per-provider, not per-session:

```
GET /api/providers
→ { providers: [ { name, available, version, verifiedAgainst, capabilities, warnings[] } ] }
```

`SessionResponse` is untouched. Requires the API-contract lock before `contracts/*.schema.json` changes.

---

## Migration and rollback

No schema migration — this is code structure plus test data.

Each phase is independently revertible:

1. **Adapter interface + capabilities** — pure addition; the existing runners keep working unchanged, they just also describe themselves.
2. **`NormalizeResult`** — the one behavioural change. `toClientConversationLines` keeps its current signature and drops `ignored`/`unknown` exactly as today, so client-visible output is byte-identical; only the diagnostic channel is new.
3. **Fixtures + regression tests** — test-only.
4. **`/api/providers` + warnings** — new endpoint; nothing existing reads it.

Ordering: 1 before 2 (the result type belongs to the adapter), 3 after 2 (fixtures assert the new verdicts), 4 last.

---

## Known limits

- **Detection remains prose-dependent.** C2 makes provider-specific matching explicit, versioned, and testable; it does not make it robust. A provider that reworders its TUI still breaks detection — the difference is that a fixture for that version fails in CI and the adapter reports a compatibility warning, instead of the failure surfacing as a mysteriously stuck session.
- **`unknown` events are reported, not rendered.** We cannot invent a rendering for a shape we do not understand. Preservation here means "counted, diagnosable, and never mistaken for absence".
- **Version detection may be impossible** for some installs (shims, containers, PATH oddities). Undetectable is treated as unverified rather than assumed-good.
- **The scanner's own parsing is out of scope**, so a provider change that breaks bulk history indexing is not covered by these fixtures. That boundary is stated so it is not mistaken for coverage.

---

## Test plan

| Requirement | Test |
|---|---|
| Unknown-event preservation | A synthetic Codex line with an unrecognized `type` yields `unknown`, not a silent drop |
| Recognized non-chat | `session_meta` / `turn_context` / `event_msg` yield `ignored` with a reason, never `unknown` |
| No client-visible change | `toClientConversationLines` output is identical to today for every existing fixture |
| Versioned fixtures | Every fixture parses through its adapter with zero `unknown` results |
| Fixture provenance | Each fixture directory has a manifest whose version matches the capture's own metadata |
| Capability truth | Declared capabilities match actual runner behaviour (e.g. Codex `freshSessionId: 'late-bound'`) |
| Compatibility warning | A version outside `verifiedAgainst` warns and still runs; undetectable warns once |
| Generic fallback | An adapter reporting `structuredQuestions: false` still streams and accepts input |
| Provider addition | The documented process, exercised by a minimal fake adapter in tests |

---

## Implementation order

1. `ProviderAdapter` + `ProviderCapabilities`, implemented by both existing runners.
2. `NormalizeResult` in `codexConversationLine.ts`, with `toClientConversationLines` behaviour preserved.
3. Versioned fixture layout, manifests, and regression tests.
4. `/api/providers`, compatibility warnings, and the provider-addition doc.

Each is its own commit so a bisect lands on one change and phase 4 can be reverted without disturbing 1–3.
