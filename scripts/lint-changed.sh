#!/usr/bin/env bash
# Lints changed files with biome, auto-dispatching based on cwd.
#
# Root checkout: biome.json excludes .worktrees/ (avoids double-linting nested
# worktree checkouts of the same files), so --changed is safe to run as-is.
#
# Inside a worktree (.git is a file, not a dir): that worktree's checkout root
# has its own biome.json with the same exclude, but it's irrelevant there --
# run --changed from within the worktree so its own source files aren't excluded.
set -euo pipefail

if [ -f .git ]; then
  worktree_root="$(git rev-parse --show-toplevel)"
  cd "$worktree_root"
fi

# --staged covers what's about to be committed (working-tree diff); falls back
# to --changed (committed-but-unmerged diff vs main) when nothing is staged.
if ! git diff --cached --quiet; then
  exec npx biome check --staged .
else
  exec npx biome check --changed --since=main .
fi
