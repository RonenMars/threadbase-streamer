Goal: ship phase 1 of #1176, the read-only `tb-streamer mcp` stdio server, by running the milestones in /Users/ronenmars/dev/ai-tools/tb-streamer-worktrees/mcp-server/docs/plans/2026-11-08-mcp-server.md (also issue #1208).
You are the orchestrator (Opus 5.5, medium effort): run Skill("preflight"), create HANDOFF.md in your worktree, then dispatch M0 with the agent, model and effort the plan's table names, and never implement a milestone yourself.
Every worker runs in its own worktree off origin/main, is test-first with a mutant check, and reports pass/fail counts, not exit codes.
After #1177 merges, run #1178, #1179, #1180 and the #1181 docs draft in parallel, each followed by its own reviewer, and open a PR only on a reviewer PASS.
Rules that never bend: read-only tools only, the key is never created or printed, loopback only, no console.log in anything the subcommand imports, conventional commit titles, no AI attribution, one PR merged at a time and every merge asked for separately.
