# Agent tooling

Everything on this page is optional. None of it is needed to build, test, or contribute to Threadbase Streamer — it is the AI-assistant tooling this repo expects, declared in config so your agent can pick it up instead of you wiring it by hand.

## Claude Code

This repository enables no Claude plugins or third-party marketplaces. Four project-specific operational skills under `.claude/skills/` load without installation: local deployment, menubar deployment, auto-updater setup, and Cloudflare tunnel setup. Generic Git, verification, package ownership, and registry workflows belong in user-level tooling or repository documentation instead of the project skill catalog.

## Codex

This repo declares no Codex MCP servers. If it grows one, it goes in a `.codex/config.toml` at the repo root under `[mcp_servers.<name>]`; Codex merges that file once the project is trusted.

Codex discovers the same four operational workflows from `.agents/skills/`. Keep general-purpose plugins and skills at user scope so this repository does not enlarge every session's initial skill catalog.

## Other agents

Cursor, Copilot, and the rest read none of the files above — the formats are Claude Code's and Codex's own. This page is the whole handoff; equivalent optional tooling in another runtime is fine.

No marketplace or plugin is registered by this repository.
