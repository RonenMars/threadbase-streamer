#!/usr/bin/env bash
# Deploy/rollback/status helper for the local launchd-managed threadbase-streamer.
#
# Usage:
#   scripts/deploy.sh                   # build + deploy current HEAD (uses pinned scanner submodule)
#   scripts/deploy.sh --force           # deploy even if working tree is dirty / not on main
#   scripts/deploy.sh --update-scanner  # bump vendor/scanner to its remote main, then deploy
#   scripts/deploy.sh rollback          # repoint cli.js to the previous release
#   scripts/deploy.sh status            # show current release, PID, and recent releases
#   scripts/deploy.sh healthcheck       # probe /healthz on the running server
#
# Layout:
#   ~/.threadbase/cli.js                     -> symlink into releases/
#   ~/.threadbase/releases/cli.<sha>.cjs     -> versioned build artifacts
#   ~/.threadbase/releases/.history          -> append-only log of activated releases
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${THREADBASE_INSTALL_DIR:-$HOME/.threadbase}"
RELEASES_DIR="$INSTALL_DIR/releases"
HISTORY_FILE="$RELEASES_DIR/.history"
ACTIVE_LINK="$INSTALL_DIR/cli.js"
LAUNCHD_LABEL="com.ronen.threadbase"
HEALTH_URL="${THREADBASE_HEALTH_URL:-http://localhost:8766/healthz}"
KEEP_RELEASES=5

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

SCANNER_DIR="$REPO_ROOT/vendor/scanner"

# Ensure the scanner submodule is checked out and built. Idempotent — skips
# `npm install`/`npm run build` if scanner's dist/ is already up-to-date with
# its src/.
ensure_scanner_built() {
  local update_remote="${1:-}"

  cd "$REPO_ROOT"
  if [[ ! -f "$SCANNER_DIR/package.json" ]]; then
    log "initializing vendor/scanner submodule"
    git submodule update --init --recursive vendor/scanner
  fi

  if [[ "$update_remote" == "1" ]]; then
    log "bumping vendor/scanner to remote main"
    git submodule update --remote vendor/scanner
    if [[ -n "$(git status --porcelain vendor/scanner)" ]]; then
      local new_sha
      new_sha="$(cd "$SCANNER_DIR" && git rev-parse --short HEAD)"
      warn "scanner pin moved to $new_sha — remember to commit the .gitmodules/vendor/scanner bump"
    fi
  fi

  # Build scanner only if dist/ is missing or older than the newest src file.
  local need_build=0
  if [[ ! -d "$SCANNER_DIR/dist" ]]; then
    need_build=1
  else
    local newest_src newest_dist
    newest_src="$(find "$SCANNER_DIR/src" -type f -newer "$SCANNER_DIR/dist" -print -quit 2>/dev/null || true)"
    [[ -n "$newest_src" ]] && need_build=1
  fi

  if (( need_build )); then
    log "building scanner submodule"
    ( cd "$SCANNER_DIR" && npm install --silent && npm run build )
  fi
}

cmd_check_browse_root() {
  local yaml="$INSTALL_DIR/server.yaml"
  local current=""

  if [[ -f "$yaml" ]]; then
    current="$(grep -E '^browse_root:' "$yaml" | sed 's/^browse_root:[[:space:]]*//' | sed 's/[[:space:]]*$//' | head -1)"
  fi

  if [[ -n "$current" ]] && [[ -d "$current" ]]; then
    return 0
  fi

  if [[ -n "$current" ]]; then
    warn "browse_root is configured but the directory does not exist: $current"
  else
    log "browse_root is not set in $yaml"
    printf '  The browse root lets the mobile app navigate your filesystem.\n'
    printf '  Set it to any directory you want to expose (e.g. ~/Desktop/dev).\n'
  fi

  if [[ ! -t 0 ]]; then
    err "No interactive terminal. Add 'browse_root: /your/path' to $yaml and re-run."
    exit 1
  fi

  local input
  while true; do
    printf '  Enter browse root path: '
    read -r input
    input="${input/#\~/$HOME}"
    [[ -z "$input" ]] && { warn "Path cannot be empty."; continue; }
    if [[ ! -d "$input" ]]; then
      warn "Directory does not exist: $input"
      printf '  Create it? [y/N] '
      local yn; read -r yn
      [[ "${yn,,}" != "y" ]] && continue
      mkdir -p "$input"
    fi
    break
  done

  local tmp
  tmp="$(mktemp)"
  if [[ -f "$yaml" ]] && grep -q '^browse_root:' "$yaml"; then
    awk -v root="$input" '/^browse_root:/ {print "browse_root: " root; next} {print}' "$yaml" > "$tmp"
    mv "$tmp" "$yaml"
  elif [[ -f "$yaml" ]]; then
    printf 'browse_root: %s\n' "$input" >> "$yaml"
    rm -f "$tmp"
  else
    printf 'browse_root: %s\n' "$input" > "$yaml"
    chmod 600 "$yaml"
    rm -f "$tmp"
  fi
  ok "browse_root set to: $input"
}

cmd_predeploy_check() {
  local force="${1:-}"
  cd "$REPO_ROOT"
  local branch dirty
  branch="$(git rev-parse --abbrev-ref HEAD)"
  dirty=""
  [[ -n "$(git status --porcelain)" ]] && dirty="dirty"

  if [[ "$force" == "--force" ]]; then
    [[ "$branch" != "main" ]] && warn "branch is '$branch', forcing"
    [[ -n "$dirty" ]] && warn "working tree is dirty, forcing"
    return 0
  fi

  if [[ "$branch" != "main" ]]; then
    err "not on main (current: $branch). Re-run with --force to override."
    exit 1
  fi
  if [[ -n "$dirty" ]]; then
    err "working tree is dirty. Commit/stash, or re-run with --force."
    exit 1
  fi
}

cmd_kickstart() {
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

cmd_healthcheck() {
  local deadline=$((SECONDS + 15))
  local last_status=""
  while (( SECONDS < deadline )); do
    if last_status="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
      ok "healthcheck passed: $last_status"
      return 0
    fi
    sleep 0.5
  done
  err "healthcheck failed after 15s ($HEALTH_URL)"
  warn "last 20 lines of stderr log:"
  tail -n 20 /tmp/threadbase.err 2>/dev/null || true
  return 1
}

cmd_status() {
  printf '\033[1mActive release:\033[0m\n'
  if [[ -L "$ACTIVE_LINK" ]]; then
    local target
    target="$(readlink "$ACTIVE_LINK")"
    printf '  %s -> %s\n' "$ACTIVE_LINK" "$target"
  elif [[ -e "$ACTIVE_LINK" ]]; then
    printf '  %s (regular file, %s)\n' "$ACTIVE_LINK" "$(stat -f '%Sm %z' "$ACTIVE_LINK" 2>/dev/null || stat -c '%y %s' "$ACTIVE_LINK")"
  else
    printf '  (none)\n'
  fi

  printf '\n\033[1mService:\033[0m\n'
  local row
  if row="$(launchctl list | awk -v l="$LAUNCHD_LABEL" '$3==l {print}')" && [[ -n "$row" ]]; then
    local pid status
    pid="$(awk '{print $1}' <<<"$row")"
    status="$(awk '{print $2}' <<<"$row")"
    printf '  label=%s pid=%s last_exit=%s\n' "$LAUNCHD_LABEL" "$pid" "$status"
    if [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" != "-" ]] && [[ "$pid" -gt 0 ]]; then
      ps -p "$pid" -o pid,etime,command 2>/dev/null | tail -n +1
    fi
  else
    printf '  not loaded\n'
  fi

  printf '\n\033[1mRecent releases:\033[0m\n'
  if [[ -d "$RELEASES_DIR" ]]; then
    ls -lt "$RELEASES_DIR"/cli.*.cjs 2>/dev/null | head -n "$KEEP_RELEASES" | awk '{print "  " $0}'
  else
    printf '  (no releases dir yet)\n'
  fi

  if [[ -f "$HISTORY_FILE" ]]; then
    printf '\n\033[1mActivation history (latest 5):\033[0m\n'
    tail -n 5 "$HISTORY_FILE" | awk '{print "  " $0}'
  fi
}

cmd_rollback() {
  if [[ ! -f "$HISTORY_FILE" ]]; then
    err "no history file at $HISTORY_FILE — nothing to roll back to"
    exit 1
  fi
  local prev
  # Find the most recent activation that is NOT the currently-active one.
  local current_target=""
  [[ -L "$ACTIVE_LINK" ]] && current_target="$(readlink "$ACTIVE_LINK")"
  prev="$(awk -v cur="$current_target" '$2 != cur {last=$2} END {print last}' "$HISTORY_FILE")"
  if [[ -z "$prev" ]]; then
    err "no prior release found in history (current: $current_target)"
    exit 1
  fi
  if [[ ! -f "$INSTALL_DIR/$prev" ]]; then
    err "previous release file missing: $INSTALL_DIR/$prev"
    exit 1
  fi
  log "rolling back to $prev"
  activate_release "$prev"
  cmd_kickstart
  cmd_healthcheck
}

# Atomically replace $ACTIVE_LINK with a symlink to $1 (relative to $INSTALL_DIR).
activate_release() {
  local rel_path="$1"
  ( cd "$INSTALL_DIR" && ln -sf "$rel_path" cli.js.new && mv -f cli.js.new cli.js )
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rel_path" >> "$HISTORY_FILE"
}

cmd_deploy() {
  local force="" update_scanner=0
  for arg in "$@"; do
    case "$arg" in
      --force)           force="--force" ;;
      --update-scanner)  update_scanner=1 ;;
      *) err "unknown deploy flag: $arg"; exit 2 ;;
    esac
  done

  cmd_predeploy_check "$force"
  cmd_check_browse_root

  ensure_scanner_built "$update_scanner"

  cd "$REPO_ROOT"
  if [[ "$force" == "--force" ]]; then
    warn "skipping lint + tests (--force)"
  else
    log "running lint + tests"
    npm run lint
    npm test
  fi

  log "building"
  npm run build

  local sha
  sha="$(git rev-parse --short HEAD)"
  [[ "$force" == "--force" ]] && [[ -n "$(git status --porcelain)" ]] && sha="${sha}-dirty-$(date -u +%Y%m%d%H%M%S)"
  local rel_filename="cli.${sha}.cjs"
  local rel_path="releases/${rel_filename}"

  mkdir -p "$RELEASES_DIR"
  log "stamping release: $rel_filename"
  cp dist/cli.cjs "$RELEASES_DIR/$rel_filename"
  chmod +x "$RELEASES_DIR/$rel_filename"

  log "activating symlink"
  activate_release "$rel_path"

  log "kickstarting $LAUNCHD_LABEL"
  cmd_kickstart

  cmd_healthcheck

  log "garbage-collecting old releases (keeping last $KEEP_RELEASES)"
  ls -t "$RELEASES_DIR"/cli.*.cjs 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f || true

  ok "deploy complete: $rel_filename"
}

case "${1:-deploy}" in
  deploy)
    shift
    cmd_deploy "$@"
    ;;
  --force|--update-scanner)
    cmd_deploy "$@"
    ;;
  "")
    cmd_deploy
    ;;
  rollback)     cmd_rollback ;;
  status)       cmd_status ;;
  healthcheck)  cmd_healthcheck ;;
  *)
    err "unknown command: $1"
    echo "usage: $0 [deploy [--force] [--update-scanner] | rollback | status | healthcheck]" >&2
    exit 2
    ;;
esac
