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

# Feed the token to git via GIT_ASKPASS instead of embedding it in the remote
# URL — a tokenless URL can't leak the secret into command echoes or git's
# error output (which can include the full URL on a failed clone/push). The
# askpass script prints the token (read from the env) only when git prompts
# for credentials over HTTPS basic auth, where GitHub accepts a PAT as the
# password.
REPO_URL="https://github.com/RonenMars/homebrew-threadbase.git"
ASKPASS="$WORK/askpass.sh"
printf '#!/usr/bin/env bash\nprintf "%%s" "$HOMEBREW_TAP_TOKEN"\n' > "$ASKPASS"
chmod +x "$ASKPASS"
export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0

git clone --depth 1 "$REPO_URL" "$WORK/tap"
mkdir -p "$WORK/tap/Formula"
cp "$FORMULA_PATH" "$WORK/tap/Formula/tb-streamer.rb"

cd "$WORK/tap"

# Stage first, then check the staged diff. `git diff --quiet <path>` ignores
# untracked files (returns 0), so on a fresh tap with no Formula/ directory
# the script would silently skip the very first publish. Staging promotes
# the new file into the index so `git diff --cached --quiet` sees it.
git -c user.name="threadbase-release-bot" \
    -c user.email="release-bot@threadbase.local" \
    add Formula/tb-streamer.rb

if git diff --cached --quiet Formula/tb-streamer.rb; then
  echo "Formula unchanged — nothing to publish for v${VERSION}."
  exit 0
fi

git -c user.name="threadbase-release-bot" \
    -c user.email="release-bot@threadbase.local" \
    commit -m "chore: tb-streamer v${VERSION}"

if ! git push origin HEAD:main; then
  # A concurrent tap commit moved main under us. Re-sync onto the new tip,
  # re-apply the formula, and push once more.
  echo "Push rejected — re-syncing tap and retrying once."
  git fetch origin main
  git reset --hard origin/main
  cp "$FORMULA_PATH" Formula/tb-streamer.rb
  git -c user.name="threadbase-release-bot" \
      -c user.email="release-bot@threadbase.local" \
      add Formula/tb-streamer.rb
  if git diff --cached --quiet Formula/tb-streamer.rb; then
    echo "Formula already current on tap after re-sync — nothing to push."
    exit 0
  fi
  git -c user.name="threadbase-release-bot" \
      -c user.email="release-bot@threadbase.local" \
      commit -m "chore: tb-streamer v${VERSION}"
  git push origin HEAD:main
fi

echo "Published Formula/tb-streamer.rb v${VERSION} to homebrew-threadbase."
