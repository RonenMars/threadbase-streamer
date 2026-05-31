#!/usr/bin/env bash
# Publishes Formula/tb-streamer.rb to the homebrew-threadbase tap repo.
# Required env:
#   HOMEBREW_TAP_TOKEN  fine-grained PAT with contents:write on RonenMars/homebrew-threadbase
#   VERSION             release version (e.g. "1.2.0")
#   FORMULA_PATH        absolute path to the rendered tb-streamer.rb
# Run from CI after build-formula.mjs has produced FORMULA_PATH.

set -euo pipefail

: "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN required}"
: "${VERSION:?VERSION required}"
: "${FORMULA_PATH:?FORMULA_PATH required}"

if [[ ! -f "$FORMULA_PATH" ]]; then
  echo "Formula file not found at $FORMULA_PATH" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO_URL="https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/RonenMars/homebrew-threadbase.git"

git clone --depth 1 "$REPO_URL" "$WORK/tap"
mkdir -p "$WORK/tap/Formula"
cp "$FORMULA_PATH" "$WORK/tap/Formula/tb-streamer.rb"

cd "$WORK/tap"

if git diff --quiet Formula/tb-streamer.rb; then
  echo "Formula unchanged — nothing to publish for v${VERSION}."
  exit 0
fi

git -c user.name="threadbase-release-bot" \
    -c user.email="release-bot@threadbase.local" \
    add Formula/tb-streamer.rb

git -c user.name="threadbase-release-bot" \
    -c user.email="release-bot@threadbase.local" \
    commit -m "chore: tb-streamer v${VERSION}"

git push origin HEAD:main

echo "Published Formula/tb-streamer.rb v${VERSION} to homebrew-threadbase."
