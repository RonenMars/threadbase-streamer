---
name: add-provider
description: Add a new agent CLI as a live SessionRunner in threadbase-streamer (capabilities, PTY spawn, health, fixtures). Use when adding Cursor, Codex, Gemini, Amp, cursor-cli, a new provider name, /api/providers, or when the user says add a provider. Phone chips and history indexing are other repos — see Companions.
---

# Add a provider (streamer)

This repo is the **live PTY** half. Scanner, streamer, and mobile each declare `ProviderName`. They are not linked. Shipping this repo never updates the phone or the history index.

Canonical wire name: kebab, matching `claude-code` / `codex-cli` (e.g. `cursor-cli`). Product label is separate (`Cursor`). Binary argv[0] may differ from both (Cursor CLI is `agent`, fallback `cursor-agent`).

Human procedure: [docs/compatibility/adding-a-provider.md](../../../docs/compatibility/adding-a-provider.md). Copy Codex (`src/codex-pty-runner.ts`), not Claude, unless the CLI is Claude-shaped.

## Companions

| Half | Repo | Skill |
|---|---|---|
| Live PTY | `threadbase-streamer` (this repo) | `.claude/skills/add-provider/` |
| Phone chips | [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md) |
| History index | [`threadbase-scanner`](https://github.com/RonenMars/threadbase-scanner) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-scanner/blob/HEAD/.claude/skills/add-provider/SKILL.md) |

Streamer-only is a server that accepts the name while the phone never sends it. Land **this PR before mobile**. Do not mix an `@threadbase-sh/scanner` bump into the live-runner PR.

Worktrees are siblings: `git worktree add ../tb-streamer-worktrees/<slug> -b feat/<slug> origin/main`. Never nest under the repo root.

## Iron rules

1. **Honest capabilities.** Declare only what the runner actually does. Unknown TUI → `structuredQuestions: false`, `permissionGates: false`, `liveControl: true`. Inventing gates is worse than a raw terminal.
2. **Do not watch another provider's JSONL.** Claude's transcript watcher is Claude's layout. Late-bound ids with no disk bind → skip the watcher.
3. **Do not classify another provider's files.** `classifyConversationFile` is Claude/Codex. Unknown layouts stay unclassified.
4. **`PROVIDER_NAMES` must include the new id** or `/api/providers` and diagnostics omit it. Replace hardcoded `[CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER]` lists with the array.
5. **Do not install the vendor CLI** unless asked. Missing binary → `available: false` / `PROVIDER_NOT_INSTALLED`.
6. **Do not invent terminal chrome filters** until the TUI is captured.

## 1. Name

`src/providers.ts`: constant, `PROVIDER_NAMES`, `isProviderName`, `commandNameForProvider` (the install/which name, e.g. `agent`).

## 2. Capabilities

`src/services/providers/capabilities.ts` + `capabilitiesFor`. Anchor in `__tests__/provider-capabilities.test.ts` against the **runner source with comments stripped** (a comment that mentions `--resume` must not satisfy "we pass `--resume`").

| Field | Honest question |
|---|---|
| `freshSessionId` | Can we pass an id in, or does the CLI mint one? |
| `resume` | Native replay from an id? |
| `systemPrompt` | Flag, positional, or unsupported? |
| `structuredQuestions` / `permissionGates` | Have we parsed those TUIs? If not: `false`. |
| `liveControl` | Can we write to the PTY? |

## 3. Binary resolution

`src/platform.ts`: `resolve<Name>Exe`, Homebrew / `~/.local/bin` fallbacks, cache + clear-on-miss like Codex. `locateProviderExe` must branch on the new name. Tests in `__tests__/platform.test.ts` (mock `existsSync` for the new path).

Do not confuse an **editor** binary (`cursor`) with the **agent** CLI (`agent`).

## 4. Runner

New `src/<name>-pty-runner.ts` implementing `SessionRunner`. Register in `LiveSessionManager`'s map. Spawn flags must match declared capabilities.

Process discovery: `looksLike<Name>Process` must reject non-interactive subcommands (`login`, `mcp`, `update`, …) so helpers are not treated as live sessions.

## 5. Line classifier + fixture (even without scanner)

`src/utils/<name>ConversationLine.ts`: `message` | `ignored` | `unknown` — never collapse ignored/unknown.

```
__tests__/fixtures/providers/<wire-name>/<version>/{manifest.json,conversation.jsonl}
```

Sanitize paths and secrets. `VERIFIED_AGAINST` in `providerHealth.ts`: if you have no live `--version` pin, record transcript-shape era and accept `version_unverified` rather than lying about a captured CLI build.

## 6. Start-session gates

Positional-prompt providers: gate via `capabilitiesFor`, not `provider === 'codex-cli'`. Skip `classifyConversationFile` unless this layout is in that classifier.

## 7. Verify

```bash
npx vitest run __tests__/provider-capabilities.test.ts \
  __tests__/provider-fixtures.test.ts \
  __tests__/<name>-pty-runner.test.ts \
  __tests__/<name>-conversation-line.test.ts \
  __tests__/platform.test.ts
```

`GET /api/providers` lists the name. Missing CLI → unavailable + start `PROVIDER_NOT_INSTALLED`. Claude/Codex start paths unchanged.

## Out of scope here

Bulk history — use the [scanner skill](https://github.com/RonenMars/threadbase-scanner/blob/HEAD/.claude/skills/add-provider/SKILL.md). Phone chips — use the [mobile skill](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md). TUI gate scraping. Installing the vendor CLI.

Worked example: `cursor-cli` in PR #892.
