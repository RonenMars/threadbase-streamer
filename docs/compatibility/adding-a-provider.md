# Adding a Provider

How to add support for a new agent CLI, and how to keep an existing one working when its vendor changes something.

Background and rationale: [`docs/architecture/2026-07-24-provider-compatibility.md`](../architecture/2026-07-24-provider-compatibility.md).

---

## What a provider integration consists of

Two halves, deliberately separate:

- **`SessionRunner`** (`src/types.ts`) — the behavioural half. How to spawn the CLI, write input, read output, and tear it down. Implemented by `PTYManager` (Claude Code) and `CodexPtyRunner` (Codex).
- **`ProviderAdapter`** (`src/services/providers/capabilities.ts`) — the descriptive half. What the provider supports, which versions it has been verified against, and how to classify a line of its native history.

Registration happens in `LiveSessionManager` (`src/live-session-manager.ts`), whose `Map<ProviderName, SessionRunner>` is the runner registry.

---

## Steps

### 1. Add the provider name

`src/providers.ts` declares `ProviderName`. Note that `@threadbase-sh/scanner` declares its **own** copy of this union for history indexing — the two are not linked, so if the provider also needs bulk history scanning, the scanner must learn about it separately.

### 2. Declare capabilities

Add a `ProviderCapabilities` entry in `src/services/providers/capabilities.ts` and wire it into `capabilitiesFor`.

Every field must reflect what the runner *actually does*, not what would be convenient:

| Field | Ask |
|---|---|
| `freshSessionId` | Can we pass an id in (`explicit`), or does the CLI create its own and we discover it after (`late-bound`)? |
| `resume` | Can the CLI replay a prior transcript from an id? |
| `systemPrompt` | A dedicated flag, a positional argument, or unsupported? |
| `structuredQuestions` | Can we parse its question menus into cards? |
| `permissionGates` | Can we detect and programmatically answer its permission/trust prompts? |
| `liveControl` | Can we send input at all, or is this read-only observation? |

`__tests__/provider-capabilities.test.ts` anchors each declaration to the code implementing it. Add cases there — a capability table that drifts from its runner is worse than none, because clients hide and show actions based on it.

If the provider offers no semantic support at all, declare `GENERIC_TERMINAL_CAPABILITIES`. Streaming raw bytes and admitting we understand nothing is a legitimate, honest integration. Asserting capabilities we cannot deliver is not.

### 3. Implement line classification

Return a `NormalizeResult` for each native-history line:

- `message` — renderable chat, normalized to the client-facing shape.
- `ignored` — recognized, deliberately not rendered (headers, duplicate envelopes, injected context).
- `unknown` — **not recognized**.

The `ignored` / `unknown` split is the point. Never collapse them. An `unknown` result means the provider emitted something this adapter has never seen, which is a compatibility signal; an `ignored` result is a decision we made on purpose. Historically both were `null`, so a provider schema change rendered an empty conversation with no error anywhere — indistinguishable from a session that genuinely had no messages.

`src/utils/codexConversationLine.ts` is the worked example.

### 4. Capture a versioned fixture

```
__tests__/fixtures/providers/<provider>/<version>/
  manifest.json
  <capture>.jsonl
```

The manifest records `provider`, `providerVersion`, `capturedAt`, `sanitized`, and `envelopeTypes`. `__tests__/provider-fixtures.test.ts` asserts the directory name against the version the capture carries **in its own payload** — `cli_version` for Codex, `version` for Claude — so a fixture cannot claim a provenance it does not have.

**Sanitize real captures.** Transcripts contain user prompts, file contents, and absolute paths. Replace free-text payloads and normalize paths; the fixture exists to pin envelope *shape*, not content. A test verifies the scrub rather than trusting the manifest's claim about it.

Then add the version to `VERIFIED_AGAINST` in `src/services/providers/providerHealth.ts`.

### 5. Register the runner

Add the `SessionRunner` implementation to the `LiveSessionManager` map. Unknown providers throw a 501 from `assertSupportedProvider`.

### 6. Verify

```bash
npx vitest run __tests__/provider-capabilities.test.ts \
               __tests__/provider-fixtures.test.ts \
               __tests__/provider-health.test.ts
curl -H "Authorization: Bearer $KEY" localhost:8766/api/providers
```

---

## When a provider changes under you

The usual symptom is a session that never reaches `waiting_input`, a gate that never renders, or a conversation that comes back empty.

1. **Check `/api/providers`.** A `version_unverified` warning means the installed build is outside the range we hold fixtures for — the first thing to rule in or out.
2. **Look for `unknown` classifications.** They mean the history schema moved. Capture a fixture from the new version and extend the adapter until the fixture yields zero `unknown` results.
3. **If detection broke but parsing didn't**, the TUI copy changed. Prompt markers, gate regexes, and footer strings are provider UI text and are inherently fragile — see the *Known limits* section of the ADR. Update the constants and add a fixture for that version.

Capture the new version's fixture rather than loosening the parser to accept both shapes. A fixture per version keeps the compatibility claim honest; a permissive parser quietly hides the drift.

---

## What this framework does not do

Detection still depends on provider prose — marker strings, gate regexes, and footer text. C2 makes that matching explicit, versioned, and testable; it does not make it robust. A provider that reworders its TUI still breaks detection. The difference is that the fixture for that version fails in CI and `/api/providers` reports a warning, rather than the failure surfacing to users as a mysteriously stuck session.

Bulk history indexing belongs to `@threadbase-sh/scanner` and is outside this framework, so these fixtures do not cover it.
