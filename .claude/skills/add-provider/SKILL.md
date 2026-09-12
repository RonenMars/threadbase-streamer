---
name: add-provider
description: Add a new agent CLI as a live SessionRunner in threadbase-streamer (capabilities, PTY spawn, health, fixtures). Use when adding Cursor, Codex, Gemini, Amp, Aider, OpenCode, Goose, ClawCode, Hermes, cursor-cli, a new provider name, /api/providers, or when the user says add a provider. Phone chips and history indexing are other repos — see Companions.
---

# Add a provider (streamer)

This repo is the **live PTY** half. Scanner, streamer, and mobile each declare `ProviderName`. They are not linked. Shipping this repo never updates the phone or the history index.

Canonical wire name: kebab (`claude-code`, `codex-cli`, `cursor-cli`, `aider`, `opencode`, `goose`). Product label is separate. Binary argv[0] may differ from both (Cursor CLI is `agent`, not `cursor`).

Human procedure: [docs/compatibility/adding-a-provider.md](../../../docs/compatibility/adding-a-provider.md). Copy Codex (`src/codex-pty-runner.ts`), not Claude, unless the CLI is Claude-shaped.

## Companions

| Half | Repo | Skill |
|---|---|---|
| Live PTY | `threadbase-streamer` (this repo) | `.claude/skills/add-provider/` |
| Phone chips | [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md) |
| History index | [`threadbase-scanner`](https://github.com/RonenMars/threadbase-scanner) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-scanner/blob/HEAD/.claude/skills/add-provider/SKILL.md) |

Streamer-only is a server that accepts the name while the phone never sends it. Land **this PR before mobile**. Do not mix an `@threadbase-sh/scanner` bump into the live-runner PR.

Worktrees are siblings: `git worktree add ../tb-streamer-worktrees/<slug> -b feat/<slug> origin/main`. Never nest under the repo root.

## 0. Vendor intake — stop or continue

Do this **before** adding a name. Paste answers in the PR; do not guess spawn flags.

| Ask | If no |
|---|---|
| Is there a **spawnable interactive CLI** (PTY, not a VS Code sidebar)? | **History-only** (scanner skill) or skip. Do not fake a runner. |
| Exact argv[0] on PATH (`aider`, `opencode`, `goose`, `agent`, …)? | Resolve it; never assume it equals the product name. |
| Fresh start flags (workspace, trust, model)? | Honest `systemPrompt` / no extra flags. |
| Native resume from an id? | `resume: "unsupported"`. Do not reuse Claude `--resume` or Codex `codex resume`. |
| Documented transcript path? | Live still ships; skip the JSONL watcher and leave history to the scanner skill. |

**Live v1 is valid** with raw PTY and no gates. Gates, scanner, and effort sliders are later slices.

`coerceProviderForRunner` maps unknown names to Claude. A first-class provider must be in `PROVIDER_NAMES` so it is **not** coerced. Do not add a friendly alias that silently becomes `claude-code`.

Short binaries (`agent`, `code`) collide. Discovery must require distinctive argv (subcommand denylist *and* a positive flag or path), not exe name alone.

## Iron rules

1. **Honest capabilities.** Unknown TUI → `structuredQuestions: false`, `permissionGates: false`, `liveControl: true`. Inventing gates is worse than a raw terminal.
2. **Do not watch another provider's JSONL.** Claude's watcher is Claude's layout.
3. **Do not classify another provider's files.** `classifyConversationFile` is Claude/Codex until this layout is added there.
4. **`PROVIDER_NAMES` must include the new id.** Replace leftover two-item lists with the array (`server.ts` log, `/api/providers`, diagnostics).
5. **Do not install the vendor CLI** unless asked. Missing → `available: false` / `PROVIDER_NOT_INSTALLED`.
6. **Do not invent terminal chrome filters** until the TUI is captured.

## 1. Name

`src/providers.ts`: constant, `PROVIDER_NAMES`, `isProviderName`, `commandNameForProvider` (install/which name).

## 2. Capabilities

`src/services/providers/capabilities.ts` + `capabilitiesFor`. Anchor in `__tests__/provider-capabilities.test.ts` against **runner source with comments stripped**.

| Field | Honest question |
|---|---|
| `freshSessionId` | Can we pass an id in, or does the CLI mint one? |
| `resume` | Native replay from an id? |
| `systemPrompt` | Flag, positional, or unsupported? |
| `structuredQuestions` / `permissionGates` | Have we parsed those TUIs? If not: `false`. |
| `liveControl` | Can we write to the PTY? |

## 3. Binary resolution

`src/platform.ts`: `resolve<Name>Exe`, Homebrew / `~/.local/bin` fallbacks, cache + clear-on-miss like Codex. `locateProviderExe` must branch on the new name. Tests in `__tests__/platform.test.ts`.

## 4. Runner

New `src/<name>-pty-runner.ts` implementing `SessionRunner`. Register in `LiveSessionManager`. Spawn flags must match declared capabilities.

Process discovery: reject non-interactive subcommands (`login`, `mcp`, `update`, `serve`, …).

## 5. Line classifier + fixture (even without scanner)

`src/utils/<name>ConversationLine.ts`: `message` | `ignored` | `unknown` — never collapse ignored/unknown. Skip this file if there is no line-oriented transcript yet (SQLite stores belong in the scanner).

```
__tests__/fixtures/providers/<wire-name>/<version>/{manifest.json,conversation.jsonl}
```

Sanitize paths and secrets. `VERIFIED_AGAINST`: no live `--version` pin → transcript-shape era + `version_unverified`, do not invent a captured CLI build.

## 6. Start-session gates

Positional-prompt providers: `capabilitiesFor`, not `provider === 'codex-cli'`. Skip `classifyConversationFile` unless this layout is in that classifier.

## 7. Verify

```bash
npx vitest run __tests__/provider-capabilities.test.ts \
  __tests__/provider-fixtures.test.ts \
  __tests__/<name>-pty-runner.test.ts \
  __tests__/<name>-conversation-line.test.ts \
  __tests__/platform.test.ts
```

`GET /api/providers` lists the name. Missing CLI → unavailable. Existing providers' start paths unchanged.

## Out of scope here

Bulk history — [scanner skill](https://github.com/RonenMars/threadbase-scanner/blob/HEAD/.claude/skills/add-provider/SKILL.md). Phone chips — [mobile skill](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md). TUI scraping. Installing the vendor CLI. VS Code-only / protobuf agents.

Worked example: `cursor-cli` in PR #892.
