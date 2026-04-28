#!/usr/bin/env bash
# Deploy/rollback/status helper for the Linux (systemd-user) threadbase-streamer.
# Mirrors scripts/deploy.sh; the only differences are the service-restart
# mechanism (systemctl --user) and the absence of macOS-specific bits.
#
# Usage:
#   scripts/deploy-linux.sh                   # build + deploy current HEAD
#   scripts/deploy-linux.sh --force           # skip lint/test gates and dirty-tree check
#   scripts/deploy-linux.sh --update-scanner  # bump vendor/scanner pin first
#   scripts/deploy-linux.sh rollback          # repoint cli.js to the previous release
#   scripts/deploy-linux.sh status            # show current release and unit status
#   scripts/deploy-linux.sh healthcheck       # probe /healthz
#
# Layout:
#   ~/.threadbase/cli.js                      -> symlink into releases/
#   ~/.threadbase/releases/cli.<sha>.cjs      -> versioned build artifacts
#   ~/.threadbase/releases/.history           -> append-only activation log
#
# Service unit (created out-of-band by the local-deploy skill):
#   ~/.config/systemd/user/threadbase.service
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${THREADBASE_INSTALL_DIR:-$HOME/.threadbase}"
RELEASES_DIR="$INSTALL_DIR/releases"
HISTORY_FILE="$RELEASES_DIR/.history"
ACTIVE_LINK="$INSTALL_DIR/cli.js"
SYSTEMD_UNIT="${THREADBASE_SYSTEMD_UNIT:-threadbase.service}"
HEALTH_URL="${THREADBASE_HEALTH_URL:-http://localhost:8766/healthz}"
KEEP_RELEASES=5

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

SCANNER_DIR="$REPO_ROOT/vendor/scanner"

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

  local need_build=0
  if [[ ! -d "$SCANNER_DIR/dist" ]]; then
    need_build=1
  else
    local newest_src
    newest_src="$(find "$SCANNER_DIR/src" -type f -newer "$SCANNER_DIR/dist" -print -quit 2>/dev/null || true)"
    [[ -n "$newest_src" ]] && need_build=1
  fi

  if (( need_build )); then
    log "building scanner submodule"
    ( cd "$SCANNER_DIR" && npm install --silent && npm run build )
  fi
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
  if ! systemctl --user list-unit-files "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    warn "systemd unit '$SYSTEMD_UNIT' not found; the local-deploy skill installs it on fresh setup"
    return 0
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$SYSTEMD_UNIT"
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
    printf '  %s -> %s\n' "$ACTIVE_LINK" "$(readlink "$ACTIVE_LINK")"
  elif [[ -e "$ACTIVE_LINK" ]]; then
    printf '  %s (regular file)\n' "$ACTIVE_LINK"
  else
    printf '  (none)\n'
  fi

  printf '\n\033[1mService:\033[0m\n'
  systemctl --user status "$SYSTEMD_UNIT" --no-pager 2>&1 | head -n 10 | sed 's/^/  /' || true

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
  local current_target=""
  [[ -L "$ACTIVE_LINK" ]] && current_target="$(readlink "$ACTIVE_LINK")"
  local prev
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

  log "restarting $SYSTEMD_UNIT"
  cmd_kickstart

  cmd_healthcheck

  log "garbage-collecting old releases (keeping last $KEEP_RELEASES)"
  ls -t "$RELEASES_DIR"/cli.*.cjs 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f || true

  ok "deploy complete: $rel_filename"
}

case "${1:-deploy}" in
  deploy)       shift; cmd_deploy "$@" ;;
  --force|--update-scanner)  cmd_deploy "$@" ;;
  "")           cmd_deploy ;;
  rollback)     cmd_rollback ;;
  status)       cmd_status ;;
  healthcheck)  cmd_healthcheck ;;
  *)
    err "unknown command: $1"
    echo "usage: $0 [deploy [--force] [--update-scanner] | rollback | status | healthcheck]" >&2
    exit 2
    ;;
esac
