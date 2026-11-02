---
name: add-provider-streamer
description: The threadbase-streamer half of adding an agent CLI as a live SessionRunner (capabilities, PTY spawn, binary resolution, health, fixtures). Use together with the shared `threadbase-skills:add-provider` when adding Cursor, Codex, Gemini, Amp, Aider, OpenCode, Goose, ClawCode, Hermes, a new provider name, /api/providers, or when the user says add a provider. Phone chips and history indexing are other repos — see Companions.
---

# Add a provider (streamer)

Read the shared `threadbase-skills:add-provider` first (install: [docs/agents/tooling.md](../../../docs/agents/tooling.md)). It holds the wire-name convention, the vendor intake table, the iron rules every repo shares and the land order across repos. This file holds only what is specific to this repo.

This repo is the **live PTY** half. Streamer-only is a server that accepts the name while the phone never sends it. Land **this PR before mobile**, and never mix an `@threadbase-sh/scanner` bump into the live-runner PR.

Human procedure: [docs/compatibility/adding-a-provider.md](../../../docs/compatibility/adding-a-provider.md). Copy Codex (`src/codex-pty-runner.ts`), not Claude, unless the CLI is Claude-shaped.

## Companions

| Half | Repo | Skill |
|---|---|---|
| Live PTY | `threadbase-streamer` (this repo) | `.claude/skills/add-provider-streamer/` |
| Phone chips | [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) | `.claude/skills/add-provider/SKILL.md` in that repo |
| History index | [`threadbase-scanner`](https://github.com/RonenMars/threadbase-scanner) | `.claude/skills/add-provider/SKILL.md` in that repo |

Changing the shared core reaches every repo through the plugin. Changing **this** file's steps means checking the other two repos' skills in the same change set, so none is left on a stale step or a moved path.

Worktrees are siblings: `git worktree add ../tb-streamer-worktrees/<slug> -b feat/<slug> origin/main`. Never nest under the repo root.

## 0. Streamer additions to vendor intake

Paste the answers in the PR; do not guess spawn flags. Beyond the shared table:

| Ask | If no |
|---|---|
| Fresh start flags (workspace, trust, model)? | Honest `systemPrompt` / no extra flags. |
| Native resume from an id? | `resume: "unsupported"`. Do not reuse Claude `--resume` or Codex `codex resume`. |

**Live v1 is valid** with raw PTY and no gates. Gates, scanner, and effort sliders are later slices.

`coerceProviderForRunner` maps unknown names to Claude. A first-class provider must be in `PROVIDER_NAMES` so it is **not** coerced. Do not add a friendly alias that silently becomes `claude-code`.

Short binaries (`agent`, `code`) collide. Discovery must require distinctive argv (subcommand denylist *and* a positive flag or path), not exe name alone.

## Streamer iron rules

1. **Honest capabilities.** Unknown TUI → `structuredQuestions: false`, `permissionGates: false`, `liveControl: true`.
2. **Do not watch another provider's JSONL.** Claude's watcher is Claude's layout.
3. **Do not classify another provider's files.** `classifyConversationFile` knows Claude, Codex, and Cursor (`cursor` agent-transcripts). Unknown layouts stay unclassified until that parser is added there.
4. **`PROVIDER_NAMES` must include the new id.** Replace leftover two-item lists with the array (`server.ts` log, `/api/providers`, diagnostics).
5. A missing CLI → `available: false` / `PROVIDER_NOT_INSTALLED`.

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
| `multiDirectory` | Does the CLI take extra directories at spawn (an `--add-dir`-style flag) on fresh, resume *and* fork? Check `--help` for each subcommand, then emit them from the runner from `options.additionalPaths`. If not: `false`, and the start handler refuses `additionalPaths` for this provider. |

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

Bulk history — the scanner's `add-provider` skill. Phone chips — the mobile `add-provider` skill. TUI scraping. Installing the vendor CLI. VS Code-only / protobuf agents.

Worked example: `cursor` live runner in PR #892 (shipped as `cursor-cli`; wire name is now `cursor`). History indexing is a **later** scanner + `@threadbase-sh/scanner` bump (`cursorRoots`, default `~/.cursor/projects`); do not mix that bump into the live-runner PR. Copy scanner import flags onto `conversation_meta` / list items (`isImportedFromClaude` / `isImportedFromCodex` / `isImportedFromCursor`). List/count accept `include=` and `isImportedFrom*=`.
