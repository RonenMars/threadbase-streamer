# Agent tooling

Everything on this page is optional. None of it is needed to build, test, or contribute to Threadbase Streamer — it is the AI-assistant tooling this repo expects, declared in config so your agent can pick it up instead of you wiring it by hand.

## Claude Code

Project-specific skills under `.claude/skills/` load without installation: local deployment, menubar deployment, auto-updater setup, Cloudflare tunnel setup, and the streamer halves of adding a provider (`add-provider-streamer`) and of landing open PRs in QA-gated batches (`integration-by-batches-streamer`, Claude Code only). Generic Git, verification, package ownership, and registry workflows belong in user-level tooling or repository documentation instead of the project skill catalog.

### Shared Threadbase skills

`add-provider` and `integration-by-batches` are shared with the other Threadbase repositories, so they live in the `threadbase-skills` plugin of the `threadbase` marketplace rather than here. The `-streamer` skills above assume they are installed. Install them once per machine:

```
/plugin marketplace add RonenMars/threadbase
/plugin install threadbase-skills@threadbase
```

They load as `threadbase-skills:add-provider` and `threadbase-skills:integration-by-batches`.

## Codex

This repo declares no Codex MCP servers. If it grows one, it goes in a `.codex/config.toml` at the repo root under `[mcp_servers.<name>]`; Codex merges that file once the project is trusted.

Codex discovers the same four operational workflows, plus the two shared skills, from `.agents/skills/`. The shared two are a byte-for-byte mirror of the plugin at a pinned umbrella commit; `.github/workflows/shared-skills.yml` fails if they differ. To adopt a newer plugin, run `scripts/sync-agents-skills.sh .agents/skills` from an umbrella checkout and move the pin in that workflow in the same PR. Keep general-purpose plugins and skills at user scope so this repository does not enlarge every session's initial skill catalog.

## Other agents

Cursor reads `AGENTS.md` natively, and `.cursor/rules/*.mdc` carries the short form of guidance that would otherwise reach only Claude Code and Codex — currently one rule, `dependency-bumps.mdc`. Those rules are pointers, not a third copy: the canonical text stays in `docs/`, because three hand-maintained copies of the same paragraph drift.

Copilot and the rest read none of the files above — the remaining formats are Claude Code's and Codex's own. This page is the whole handoff; equivalent optional tooling in another runtime is fine.

This repository registers no marketplace or plugin itself; the shared skills above are installed by the user.
