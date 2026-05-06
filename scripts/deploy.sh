#!/usr/bin/env bash
# Deploy/rollback/status helper for the local launchd-managed threadbase-streamer.
#
# Usage:
#   scripts/deploy.sh                   # build + deploy current HEAD (uses pinned scanner submodule)
#   scripts/deploy.sh --force           # deploy even if working tree is dirty / not on main
#   scripts/deploy.sh --update-scanner  # bump vendor/scanner to its remote main, then deploy
#   scripts/deploy.sh setup             # first-time: write launchd plist + ask about auto-startup
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
PORT="${THREADBASE_PORT:-8766}"
HEALTH_URL="${THREADBASE_HEALTH_URL:-http://localhost:$PORT/healthz}"
KEEP_RELEASES=5

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

SCANNER_DIR="$REPO_ROOT/vendor/scanner"
MENUBAR_DIR="$REPO_ROOT/vendor/menubar"

MENUBAR_SIGNING_ENV="$INSTALL_DIR/menubar-signing.env"
MENUBAR_INSTALLED_SHA_FILE="$INSTALL_DIR/menubar-installed-sha"
MENUBAR_RELEASES_DIR="$INSTALL_DIR/releases/menubar"
MENUBAR_KEEP_DMGS=5

# Build a signed-or-ad-hoc .dmg of vendor/menubar via electron-builder, install
# the .app to /Applications/Threadbase Menubar.app, archive the .dmg under
# ~/.threadbase/releases/menubar/, and launch the installed app. Idempotent —
# compares ~/.threadbase/menubar-installed-sha against the pinned submodule HEAD
# and skips the whole flow when up-to-date.
#
# Sources ~/.threadbase/menubar-signing.env if present (sets APPLE_TEAM_ID +
# App Store Connect API key vars), which switches electron-builder into the
# Developer ID + notarisation path. Absent → ad-hoc local build.
ensure_menubar_deployed() {
  if [[ ! -f "$MENUBAR_DIR/package.json" ]]; then
    log "initializing vendor/menubar submodule"
    git submodule update --init --recursive vendor/menubar
  fi

  local current_sha
  current_sha="$(cd "$MENUBAR_DIR" && git rev-parse HEAD)"

  local installed_sha=""
  [[ -f "$MENUBAR_INSTALLED_SHA_FILE" ]] && installed_sha="$(cat "$MENUBAR_INSTALLED_SHA_FILE")"

  local installed_app="/Applications/Threadbase Menubar.app"
  if [[ "$current_sha" == "$installed_sha" ]] && [[ -d "$installed_app" ]]; then
    log "menubar is up-to-date ($current_sha)"
    if ! pgrep -f "Threadbase Menubar" >/dev/null 2>&1; then
      log "launching installed menubar"
      open -a "Threadbase Menubar" 2>/dev/null || open "$installed_app" \
        || warn "could not launch menubar"
    else
      ok "menubar already running"
    fi
    return
  fi

  log "menubar needs rebuild (installed: ${installed_sha:-none}, current: ${current_sha})"

  # Source signing config if present. Absent is fine — electron-builder falls
  # back to ad-hoc signing and the notarize.cjs hook no-ops.
  if [[ -f "$MENUBAR_SIGNING_ENV" ]]; then
    log "sourcing menubar signing config from $MENUBAR_SIGNING_ENV"
    set -a
    # shellcheck disable=SC1090
    source "$MENUBAR_SIGNING_ENV"
    set +a
  else
    warn "no signing config at $MENUBAR_SIGNING_ENV — building ad-hoc (local-only)"
  fi

  # Stop any running instance before we overwrite /Applications/.
  if pgrep -f "Threadbase Menubar" >/dev/null 2>&1; then
    log "stopping running menubar"
    pkill -f "Threadbase Menubar" 2>/dev/null || true
    sleep 0.5
  fi

  log "building menubar .dmg (this takes 1–3 minutes; longer first time)"
  ( cd "$MENUBAR_DIR" && npm ci --silent && npm run package:mac )

  # Locate the produced .dmg. electron-builder's artifactName template is
  # "${productName}-${version}-${arch}.${ext}" → "Threadbase Menubar-X.Y.Z-universal.dmg".
  local dmg
  dmg="$(ls -t "$MENUBAR_DIR/release/"*.dmg 2>/dev/null | head -1 || true)"
  if [[ -z "$dmg" ]]; then
    err "electron-builder produced no .dmg"
    return 1
  fi
  ok "menubar built: $dmg"

  # Install the .app from the .dmg to /Applications/ (or ~/Applications/ as
  # fallback if the system path is read-only).
  local install_root="/Applications"
  if [[ ! -w "$install_root" ]]; then
    install_root="$HOME/Applications"
    mkdir -p "$install_root"
    warn "/Applications not writable — installing to $install_root"
  fi
  local target="$install_root/Threadbase Menubar.app"

  log "mounting $dmg"
  local mount_output mount_point
  mount_output="$(hdiutil attach -nobrowse -readonly "$dmg" 2>&1)"
  mount_point="$(printf '%s\n' "$mount_output" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
  if [[ -z "$mount_point" ]] || [[ ! -d "$mount_point/Threadbase Menubar.app" ]]; then
    err "could not locate Threadbase Menubar.app inside $dmg"
    printf '%s\n' "$mount_output" >&2
    return 1
  fi

  log "installing to $target"
  rm -rf "$target"
  cp -R "$mount_point/Threadbase Menubar.app" "$target"
  hdiutil detach "$mount_point" -quiet || warn "hdiutil detach $mount_point failed"

  # Archive the .dmg under ~/.threadbase/releases/menubar/ for offline reinstall.
  mkdir -p "$MENUBAR_RELEASES_DIR"
  local short_sha archived
  short_sha="${current_sha:0:7}"
  archived="$MENUBAR_RELEASES_DIR/Threadbase-Menubar-${short_sha}.dmg"
  cp "$dmg" "$archived"
  ok "archived $archived"

  printf '%s' "$current_sha" > "$MENUBAR_INSTALLED_SHA_FILE"

  log "launching $target"
  # Prefer `open -a` (uses LaunchServices), fall back to direct path if the
  # registry hasn't picked up the new .app yet.
  open -a "Threadbase Menubar" 2>/dev/null || open "$target" || warn "could not launch menubar"

  # Garbage-collect old archived .dmgs.
  ls -t "$MENUBAR_RELEASES_DIR"/Threadbase-Menubar-*.dmg 2>/dev/null \
    | tail -n +$((MENUBAR_KEEP_DMGS + 1)) | xargs -r rm -f || true

  ok "menubar deployed: $current_sha"
}

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

# Shared plist writer. Always emits an EnvironmentVariables block with PATH +
# HOME — without it, launchd inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin and
# node-pty's execvp("claude", …) fails with ENOENT. See troubleshooting.md
# entry "Mobile app shows session as Idle 0s 0 prompts immediately after
# start/resume" for the symptom.
write_plist() {
  local plist_path="$1" node_bin="$2" run_at_load="$3"
  local logs_dir="$INSTALL_DIR/logs"
  local node_bin_dir
  node_bin_dir="$(dirname "$node_bin")"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$ACTIVE_LINK</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--verbose</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$node_bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <$run_at_load/>
  <key>KeepAlive</key>
  <$run_at_load/>
  <key>StandardOutPath</key>
  <string>$logs_dir/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$logs_dir/stderr.log</string>
</dict>
</plist>
PLIST
}

cmd_setup() {
  local plist_path="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  local logs_dir="$INSTALL_DIR/logs"
  local node_bin
  node_bin="$(command -v node)" || { err "node not found in PATH"; exit 1; }

  mkdir -p "$logs_dir" "$(dirname "$plist_path")"

  local run_at_load="true"
  if [[ -t 0 ]]; then
    printf '\n  Launch server automatically at login? [Y/n] '
    local yn; read -r yn
    [[ "${yn,,}" == "n" ]] && run_at_load="false"
  fi

  log "writing launchd plist → $plist_path"
  write_plist "$plist_path" "$node_bin" "$run_at_load"

  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"

  if [[ "$run_at_load" == "true" ]]; then
    ok "auto-startup at login: enabled"
  else
    ok "auto-startup at login: disabled — run 'launchctl start $LAUNCHD_LABEL' to start manually"
  fi
}

# Self-heal: existing plists from before the EnvironmentVariables fix are
# missing PATH, so claude isn't on the launchd-inherited PATH and every
# session-start dies with ENOENT in milliseconds. Rewrite + re-bootstrap in
# place when we detect the stale shape.
ensure_plist_healthy() {
  local plist_path="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  [[ -f "$plist_path" ]] || return 0
  if grep -q "EnvironmentVariables" "$plist_path"; then
    return 0
  fi

  warn "plist is missing EnvironmentVariables block — claude won't be on launchd's PATH"
  warn "rewriting $plist_path and re-bootstrapping"

  local node_bin
  node_bin="$(command -v node)" || { err "node not found in PATH"; exit 1; }

  # Preserve the existing RunAtLoad value if we can detect it.
  local run_at_load="true"
  if grep -q "<key>RunAtLoad</key>" "$plist_path" \
     && awk '/<key>RunAtLoad<\/key>/{getline; print}' "$plist_path" | grep -q "<false/>"; then
    run_at_load="false"
  fi

  cp "$plist_path" "$plist_path.bak.$(date +%s)" 2>/dev/null || true
  write_plist "$plist_path" "$node_bin" "$run_at_load"
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  ok "plist healed (backup at $plist_path.bak.*)"
}

# Best-effort: warn if launchd's cached plist path differs from the canonical
# ~/Library/LaunchAgents path, which means a stale bootstrap is in effect and
# any plist edits will be silently ignored until the next bootout/bootstrap.
check_launchd_path_drift() {
  local canonical="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  local cached
  cached="$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null \
            | awk -F' = ' '/^[[:space:]]*path =/ {print $2; exit}')"
  if [[ -n "$cached" ]] && [[ "$cached" != "$canonical" ]]; then
    warn "launchd cached plist path differs from canonical:"
    warn "  cached    = $cached"
    warn "  canonical = $canonical"
    warn "  fix: launchctl bootout gui/$(id -u)/$LAUNCHD_LABEL && \\"
    warn "       launchctl bootstrap gui/$(id -u) $canonical"
  fi
}

# Best-effort: report PID + start time for the currently-loaded service so the
# user can verify that the post-kickstart process is actually fresh.
print_service_pid_info() {
  local label="$1" prefix="${2:-}"
  local pid
  pid="$(launchctl list 2>/dev/null | awk -v l="$LAUNCHD_LABEL" '$3==l {print $1}')"
  if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
    local started
    started="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')"
    printf '  %s pid=%s started=%s\n' "$prefix" "$pid" "${started:-?}"
  fi
}

cmd_kickstart() {
  if ! launchctl list "$LAUNCHD_LABEL" >/dev/null 2>&1; then
    warn "$LAUNCHD_LABEL not loaded — run 'scripts/deploy.sh setup' to initialize the service"
    return 0
  fi
  check_launchd_path_drift
  print_service_pid_info "$LAUNCHD_LABEL" "before kickstart:"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

# Locate the streamer's stderr log. The plist writes to $INSTALL_DIR/logs/stderr.log;
# /tmp/threadbase.err is a legacy fallback for older plist layouts.
streamer_stderr_log() {
  local primary="$INSTALL_DIR/logs/stderr.log"
  if [[ -s "$primary" ]]; then
    printf '%s' "$primary"
  elif [[ -s /tmp/threadbase.err ]]; then
    printf '%s' /tmp/threadbase.err
  else
    printf '%s' "$primary"
  fi
}

# Surface non-fatal startup warnings the server logs but doesn't propagate to /healthz.
# Currently checks for the better-sqlite3 ABI mismatch that disables ConversationCache
# silently after a Node major upgrade.
report_startup_warnings() {
  local stderr_log
  stderr_log="$(streamer_stderr_log)"
  [[ -s "$stderr_log" ]] || return 0
  if tail -n 200 "$stderr_log" 2>/dev/null | grep -q "ERR_DLOPEN_FAILED"; then
    warn "ConversationCache native module ABI mismatch detected in $stderr_log"
    warn "  cache disabled — server runs fine, mobile session list is unaccelerated"
    warn "  fix: cd $RELEASES_DIR && npm rebuild better-sqlite3 && \\"
    warn "       launchctl kickstart -k gui/$(id -u)/$LAUNCHD_LABEL"
  fi
}

cmd_healthcheck() {
  local deadline=$((SECONDS + 15))
  local last_status=""
  while (( SECONDS < deadline )); do
    if last_status="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
      ok "healthcheck passed: $last_status"
      print_service_pid_info "$LAUNCHD_LABEL" "after kickstart: "
      report_startup_warnings
      return 0
    fi
    sleep 0.5
  done
  err "healthcheck failed after 15s ($HEALTH_URL)"
  warn "last 20 lines of stderr log:"
  tail -n 20 "$(streamer_stderr_log)" 2>/dev/null || true
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
  # Copy migrations alongside the CLI so __dirname resolution works at runtime.
  # - migrations/    — SQLite (ConversationCache.open(); always required)
  # - pg-migrations/ — Postgres (loaded when THREADBASE_DATABASE_URL is set, but the
  #                   migration runner reads the dir at startup and crashes if absent)
  cp -r dist/migrations "$RELEASES_DIR/migrations"
  [ -d dist/pg-migrations ] && cp -r dist/pg-migrations "$RELEASES_DIR/pg-migrations"

  # Native addons are external to the tsup bundle. Copy them and their transitive
  # deps so the deployed cli.js can resolve them without a full node_modules tree.
  mkdir -p "$RELEASES_DIR/node_modules"
  for mod in node-pty better-sqlite3 bindings file-uri-to-path; do
    if [[ -d "node_modules/$mod" ]]; then
      cp -r "node_modules/$mod" "$RELEASES_DIR/node_modules/$mod"
    fi
  done

  log "activating symlink"
  activate_release "$rel_path"

  if ! launchctl list "$LAUNCHD_LABEL" >/dev/null 2>&1; then
    log "service not registered — running first-time setup"
    cmd_setup
  else
    ensure_plist_healthy
  fi

  log "kickstarting $LAUNCHD_LABEL"
  cmd_kickstart

  cmd_healthcheck

  log "garbage-collecting old releases (keeping last $KEEP_RELEASES)"
  ls -t "$RELEASES_DIR"/cli.*.cjs 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f || true

  ensure_menubar_deployed

  ok "deploy complete: $rel_filename"
}

case "${1:-deploy}" in
  setup)  cmd_setup ;;
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
