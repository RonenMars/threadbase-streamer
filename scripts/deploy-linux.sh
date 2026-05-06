#!/usr/bin/env bash
# Deploy/rollback/status helper for the Linux (systemd-user) threadbase-streamer.
# Mirrors scripts/deploy.sh; the only differences are the service-restart
# mechanism (systemctl --user) and the absence of macOS-specific bits.
#
# Usage:
#   scripts/deploy-linux.sh                   # build + deploy current HEAD
#   scripts/deploy-linux.sh --force           # skip lint/test gates and dirty-tree check
#   scripts/deploy-linux.sh --update-scanner  # bump vendor/scanner pin first
#   scripts/deploy-linux.sh setup             # first-time: write systemd unit + ask about auto-startup
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
PORT="${THREADBASE_PORT:-8766}"
HEALTH_URL="${THREADBASE_HEALTH_URL:-http://localhost:$PORT/healthz}"
KEEP_RELEASES=5

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

SCANNER_DIR="$REPO_ROOT/vendor/scanner"
MENUBAR_DIR="$REPO_ROOT/vendor/menubar"

ensure_menubar_deployed() {
  if [[ ! -f "$MENUBAR_DIR/package.json" ]]; then
    log "initializing vendor/menubar submodule"
    git submodule update --init --recursive vendor/menubar
  fi

  local current_sha
  current_sha="$(cd "$MENUBAR_DIR" && git rev-parse HEAD)"

  local built_sha=""
  [[ -f "$MENUBAR_DIR/dist/.build-sha" ]] && built_sha="$(cat "$MENUBAR_DIR/dist/.build-sha")"

  if [[ "$current_sha" == "$built_sha" ]]; then
    log "menubar is up-to-date ($current_sha)"
  else
    log "menubar needs rebuild (built: ${built_sha:-none}, current: ${current_sha})"
    ( cd "$MENUBAR_DIR" && npm install --silent && npm run build )
    printf '%s' "$current_sha" > "$MENUBAR_DIR/dist/.build-sha"
    ok "menubar built: $current_sha"
  fi

  local running_pid=""
  running_pid="$(pgrep -f "vendor/menubar" 2>/dev/null | head -1 || true)"

  if [[ -n "$running_pid" ]] && [[ "$current_sha" != "$built_sha" ]]; then
    log "stopping stale menubar (pid $running_pid)"
    pkill -f "vendor/menubar" 2>/dev/null || true
    sleep 0.5
    running_pid=""
  fi

  if [[ -z "$running_pid" ]]; then
    log "launching menubar"
    ( cd "$MENUBAR_DIR" && nohup npx electron . </dev/null >>/tmp/threadbase-menubar.log 2>&1 & disown )
    sleep 1
    if pgrep -f "vendor/menubar" >/dev/null 2>&1; then
      ok "menubar running"
    else
      warn "menubar exited immediately — check /tmp/threadbase-menubar.log"
    fi
  else
    ok "menubar already running (pid $running_pid)"
  fi
}

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
    printf '  Set it to any directory you want to expose (e.g. ~/dev).\n'
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
  [[ -n "$(git diff --name-only HEAD)" ]] && dirty="dirty"

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

cmd_setup() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit_file="$unit_dir/$SYSTEMD_UNIT"
  local logs_dir="$INSTALL_DIR/logs"
  local node_bin
  node_bin="$(command -v node)" || { err "node not found in PATH"; exit 1; }

  mkdir -p "$unit_dir" "$logs_dir"

  local enable_autostart="y"
  if [[ -t 0 ]]; then
    printf '\n  Launch server automatically at login? [Y/n] '
    local yn; read -r yn
    [[ "${yn,,}" == "n" ]] && enable_autostart="n"
  fi

  log "writing systemd unit → $unit_file"
  cat > "$unit_file" <<UNIT
[Unit]
Description=Threadbase Streamer
After=network.target

[Service]
ExecStart=$node_bin $ACTIVE_LINK serve --port $PORT --verbose
Restart=on-failure
StandardOutput=append:$logs_dir/stdout.log
StandardError=append:$logs_dir/stderr.log

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user start "$SYSTEMD_UNIT"

  if [[ "$enable_autostart" == "y" ]]; then
    systemctl --user enable "$SYSTEMD_UNIT"
    ok "auto-startup at login: enabled"
  else
    ok "auto-startup at login: disabled — run 'systemctl --user start $SYSTEMD_UNIT' to start manually"
  fi
}

cmd_kickstart() {
  if ! systemctl --user list-unit-files "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    warn "systemd unit '$SYSTEMD_UNIT' not found — run 'scripts/deploy-linux.sh setup' to initialize"
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
  # Copy migrations alongside CLI so __dirname resolution works at runtime.
  # - migrations/    — SQLite (ConversationCache.open(); always required)
  # - pg-migrations/ — Postgres (loaded when THREADBASE_DATABASE_URL is set, but the
  #                   migration runner reads the dir at startup and crashes if absent)
  [ -d dist/migrations ] && cp -r dist/migrations "$RELEASES_DIR/migrations"
  [ -d dist/pg-migrations ] && cp -r dist/pg-migrations "$RELEASES_DIR/pg-migrations"

  # node-pty is external to the tsup bundle (native addon). Copy it from source
  # node_modules so the deployed cli.js can resolve it without a full node_modules tree.
  if [ -d "node_modules/node-pty" ]; then
    mkdir -p "$RELEASES_DIR/node_modules"
    cp -r node_modules/node-pty "$RELEASES_DIR/node_modules/node-pty"
  fi
  # better-sqlite3 is external to the tsup bundle (native addon). Copy it and its
  # transitive deps (bindings, file-uri-to-path) alongside the cli.
  for mod in better-sqlite3 bindings file-uri-to-path; do
    if [ -d "node_modules/$mod" ]; then
      mkdir -p "$RELEASES_DIR/node_modules"
      cp -r "node_modules/$mod" "$RELEASES_DIR/node_modules/$mod"
    fi
  done

  log "activating symlink"
  activate_release "$rel_path"

  if ! systemctl --user list-unit-files "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    log "service not registered — running first-time setup"
    cmd_setup
  fi

  log "restarting $SYSTEMD_UNIT"
  cmd_kickstart

  cmd_healthcheck

  log "garbage-collecting old releases (keeping last $KEEP_RELEASES)"
  ls -t "$RELEASES_DIR"/cli.*.cjs 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f || true

  ensure_menubar_deployed

  ok "deploy complete: $rel_filename"
}

case "${1:-deploy}" in
  setup)        cmd_setup ;;
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
