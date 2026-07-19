#!/usr/bin/env bash
# Deploy/rollback/status helper for the Linux (systemd-user) threadbase-streamer.
# Mirrors scripts/deploy.sh; the only differences are the service-restart
# mechanism (systemctl --user) and the absence of macOS-specific bits.
#
# Usage:
#   scripts/deploy-linux.sh                   # build + deploy current HEAD
#   scripts/deploy-linux.sh --force           # skip lint/test gates and dirty-tree check
#   scripts/deploy-linux.sh --install-shim=<m>  # m = standard|user-local|custom|skip; non-interactive choice
#                                             #   for the global `threadbase-streamer` shim. Default: prompt.
#   scripts/deploy-linux.sh --path-update=<m>   # m = print|auto|skip; how to handle PATH not containing the
#                                             #   install dir. Default: prompt.
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

# --- logging -----------------------------------------------------------------
# Leveled, timestamped logging. Every line carries an ISO-8601 local timestamp
# and a level word so redirected prod logs (launchd/systemd/Task Scheduler) are
# self-describing and line up with ~/.threadbase/update.log. LOG_LEVEL=debug
# surfaces debug lines (default: info). Colors are suppressed when stdout is not
# a TTY (logs captured to a file) or when NO_COLOR is set, so redirected logs
# stay free of escape codes.
LOG_LEVEL="${LOG_LEVEL:-info}"
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then _log_color=1; else _log_color=0; fi
_log_ts()   { date '+%Y-%m-%dT%H:%M:%S%z'; }
_log_emit() { # <level> <ansi> <symbol> <stream:1|2> <msg...>
  local level="$1" ansi="$2" symbol="$3" stream="$4"; shift 4
  local prefix="" suffix=""
  if [ "$_log_color" = 1 ]; then prefix="\033[${ansi}m"; suffix="\033[0m"; fi
  local line
  line="$(printf '%b%s %-5s %s%b %s' "$prefix" "$(_log_ts)" "$level" "$symbol" "$suffix" "$*")"
  if [ "$stream" = 2 ]; then printf '%s\n' "$line" >&2; else printf '%s\n' "$line"; fi
}
debug() { [ "$LOG_LEVEL" = debug ] && _log_emit DEBUG '1;90' '·' 2 "$@"; return 0; }
info()  { _log_emit INFO  '1;34' '▶' 1 "$@"; }
log()   { info "$@"; }                       # backward-compatible alias
ok()    { _log_emit INFO  '1;32' '✓' 1 "$@"; }
warn()  { _log_emit WARN  '1;33' '!' 2 "$@"; }
err()   { _log_emit ERROR '1;31' '✗' 2 "$@"; }

# Global-shim installer (creates `threadbase-streamer` on PATH).
# shellcheck source=lib/install-shim.sh
. "$REPO_ROOT/scripts/lib/install-shim.sh"

# Read a single scalar key from server.yaml (returns empty if unset/missing).
read_yaml_key() {
  local key="$1" yaml="$INSTALL_DIR/server.yaml"
  [[ -f "$yaml" ]] || return 0
  grep -E "^${key}:" "$yaml" \
    | sed "s/^${key}:[[:space:]]*//" | sed 's/[[:space:]]*$//' | head -1
}

# Upsert a single scalar key in server.yaml (replace in place, else append).
write_yaml_key() {
  local key="$1" value="$2" yaml="$INSTALL_DIR/server.yaml" tmp
  tmp="$(mktemp)"
  if [[ -f "$yaml" ]] && grep -q "^${key}:" "$yaml"; then
    awk -v k="$key" -v v="$value" '$0 ~ "^"k":" {print k": "v; next} {print}' "$yaml" > "$tmp"
    mv "$tmp" "$yaml"
  elif [[ -f "$yaml" ]]; then
    printf '%s: %s\n' "$key" "$value" >> "$yaml"
    rm -f "$tmp"
  else
    mkdir -p "$INSTALL_DIR"
    printf '%s: %s\n' "$key" "$value" > "$yaml"
    chmod 600 "$yaml"
    rm -f "$tmp"
  fi
}

# Before deploying, warn if the published npm release of @threadbase-sh/streamer
# is NEWER than the local package.json (i.e. this checkout is behind the
# registry). Offers to `git pull origin main` and redeploy the newer tree.
#
# Skipped silently when:
#   - stdin is not a TTY (systemd/CI — never block on input)
#   - the npm registry is unreachable (offline / npm down)
#   - local is equal-to or ahead-of the published version
#
# A persisted decision in server.yaml (`deploy_version_prompt: always_yes` /
# `always_no`) auto-answers the prompt without asking.
cmd_version_check() {
  [[ -t 0 ]] || return 0                         # non-interactive → skip
  command -v npm >/dev/null 2>&1 || return 0

  local local_ver published_ver
  local_ver="$(node -p 'require("'"$REPO_ROOT"'/package.json").version' 2>/dev/null)" || return 0
  [[ -n "$local_ver" ]] || return 0

  published_ver="$(npm view @threadbase-sh/streamer version --registry https://registry.npmjs.org/ 2>/dev/null)" || return 0
  [[ -n "$published_ver" ]] || return 0

  local behind
  behind="$(node -e '
    try {
      const semver = require("'"$REPO_ROOT"'/node_modules/semver");
      process.stdout.write(semver.gt(process.argv[2], process.argv[1]) ? "1" : "0");
    } catch { process.stdout.write("0"); }
  ' "$local_ver" "$published_ver" 2>/dev/null)" || return 0
  [[ "$behind" == "1" ]] || return 0

  warn "a newer streamer is published on npm: $published_ver (local: $local_ver)"

  local saved decision=""
  saved="$(read_yaml_key deploy_version_prompt)"
  case "$saved" in
    always_yes) decision="y"; log "deploy_version_prompt=always_yes — updating" ;;
    always_no)  decision="n"; log "deploy_version_prompt=always_no — deploying local as-is" ;;
  esac

  if [[ -z "$decision" ]]; then
    printf '  Update to the published version before deploying? [(y)es / (n)o / (A)lways yes / (N)ever] '
    local ans; read -r ans
    case "$ans" in
      y|Y|yes)   decision="y" ;;
      A)         decision="y"; write_yaml_key deploy_version_prompt always_yes; ok "saved: always update" ;;
      N)         decision="n"; write_yaml_key deploy_version_prompt always_no;  ok "saved: never update" ;;
      *)         decision="n" ;;
    esac
  fi

  [[ "$decision" == "y" ]] || { log "deploying local version as-is"; return 0; }

  printf '  git pull origin main and update automatically, or abort this deploy? [(p)ull / (a)bort] '
  local act; read -r act
  case "$act" in
    p|P|pull)
      log "pulling origin main"
      ( cd "$REPO_ROOT" && git pull origin main ) || { err "git pull failed — aborting deploy"; exit 1; }
      ok "pulled; continuing deploy on updated tree"
      ;;
    *)
      err "aborting deploy at user request"
      exit 1
      ;;
  esac
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
  local sidecar="$INSTALL_DIR/${rel_path}.version"
  if [[ -f "$sidecar" ]]; then
    cp "$sidecar" "$INSTALL_DIR/version.txt"
  else
    # Rolling back to a pre-stamping release. See deploy.sh for context.
    printf 'unknown+%s\n' "${rel_path##*/}" > "$INSTALL_DIR/version.txt"
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rel_path" >> "$HISTORY_FILE"
}

cmd_deploy() {
  local force=""
  for arg in "$@"; do
    case "$arg" in
      --force)              force="--force" ;;
      --install-shim=*)     export TB_INSTALL_SHIM="${arg#--install-shim=}" ;;
      --path-update=*)      export TB_PATH_UPDATE="${arg#--path-update=}" ;;
      *) err "unknown deploy flag: $arg"; exit 2 ;;
    esac
  done

  cmd_version_check
  cmd_predeploy_check "$force"
  cmd_check_browse_root

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

  # version.txt sidecar; activate_release copies it to $INSTALL_DIR/version.txt.
  local pkg_version
  pkg_version="$(node -p 'require("./package.json").version')"
  printf '%s+%s\n' "$pkg_version" "$sha" > "$RELEASES_DIR/${rel_filename}.version"

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

  # Install (or refresh) the global `threadbase-streamer` shim. Non-fatal.
  install_global_shim "$ACTIVE_LINK" || warn "global shim install failed (deploy itself is OK)"

  ok "deploy complete: $rel_filename"
}

case "${1:-deploy}" in
  setup)        cmd_setup ;;
  deploy)       shift; cmd_deploy "$@" ;;
  --force|--install-shim=*|--path-update=*) cmd_deploy "$@" ;;
  "")           cmd_deploy ;;
  rollback)     cmd_rollback ;;
  status)       cmd_status ;;
  healthcheck)  cmd_healthcheck ;;
  *)
    err "unknown command: $1"
    echo "usage: $0 [deploy [--force] | rollback | status | healthcheck]" >&2
    exit 2
    ;;
esac
