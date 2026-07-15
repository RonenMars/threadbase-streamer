#!/usr/bin/env bash
# Deploy/rollback/status helper for the local launchd-managed threadbase-streamer.
#
# Usage:
#   scripts/deploy.sh                       # build + deploy current HEAD
#   scripts/deploy.sh --force               # deploy even if working tree is dirty / not on main
#   scripts/deploy.sh --clear-logs          # clear stdout/stderr logs after deploy (default: preserve)
#   scripts/deploy.sh --publish-menubar     # also upload the menubar .dmg to GitHub Releases
#                                           #   (requires ~/.threadbase/menubar-signing.env + gh auth)
#   scripts/deploy.sh --install-shim=<m>    # m = standard|user-local|custom|skip; non-interactive choice
#                                           #   for the global `threadbase-streamer` shim. Default: prompt.
#   scripts/deploy.sh --path-update=<m>     # m = print|auto|skip; how to handle PATH not containing the
#                                           #   install dir. Default: prompt.
#   scripts/deploy.sh setup                 # first-time: write launchd plist + ask about auto-startup
#   scripts/deploy.sh rollback              # repoint cli.js to the previous release
#   scripts/deploy.sh status                # show current release, PID, and recent releases
#   scripts/deploy.sh healthcheck           # probe /healthz on the running server
#   scripts/deploy.sh restart               # kickstart + healthcheck (auto-clears EADDRINUSE once)
#   scripts/deploy.sh free-port             # kill stale threadbase listener on $PORT
#   scripts/deploy.sh menubar [--publish]   # build + install the menubar .app only
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
NIGHTLY_RESTART_LABEL="com.ronen.threadbase-nightly-restart"
PORT="${THREADBASE_PORT:-8766}"
HEALTH_URL="${THREADBASE_HEALTH_URL:-http://localhost:$PORT/healthz}"
KEEP_RELEASES=5

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# Global-shim installer (creates `threadbase-streamer` on PATH).
# shellcheck source=lib/install-shim.sh
. "$REPO_ROOT/scripts/lib/install-shim.sh"

# Menubar release fetcher (downloads pre-built artifacts from
# RonenMars/threadbase-menubar by submodule commit SHA).
# shellcheck source=lib/fetch-menubar.sh
. "$REPO_ROOT/scripts/lib/fetch-menubar.sh"

MENUBAR_DIR="$REPO_ROOT/vendor/menubar"

MENUBAR_SIGNING_ENV="$INSTALL_DIR/menubar-signing.env"
MENUBAR_INSTALLED_SHA_FILE="$INSTALL_DIR/menubar-installed-sha"
MENUBAR_RELEASES_DIR="$INSTALL_DIR/releases/menubar"
MENUBAR_FETCH_LOG="$INSTALL_DIR/logs/menubar-fetch.log"
MENUBAR_KEEP_DMGS=5

# Install the pre-built menubar .app to /Applications/Threadbase Menubar.app,
# archive the .dmg under ~/.threadbase/releases/menubar/, and launch the
# installed app. Idempotent — compares ~/.threadbase/menubar-installed-sha
# against the pinned submodule HEAD and skips when up-to-date.
#
# Default flow: download the matching artifact from RonenMars/threadbase-menubar
# GitHub Releases (matched by submodule commit SHA). On miss or fetch error,
# falls back to a local electron-builder build.
#
# Local-build fallback sources ~/.threadbase/menubar-signing.env if present
# (sets APPLE_TEAM_ID + App Store Connect API key vars), switching
# electron-builder into the Developer ID + notarisation path. Absent → ad-hoc.
ensure_menubar_deployed() {
  # When called with `force_build`, skip the GitHub release download path and
  # always build locally. Used by --publish-menubar so we produce a fresh
  # signed artifact to upload (a downloaded .dmg has nothing new to publish).
  local force_build=0
  [[ "${1:-}" == "force_build" ]] && force_build=1

  if [[ ! -f "$MENUBAR_DIR/package.json" ]]; then
    log "initializing vendor/menubar submodule"
    git submodule update --init --recursive vendor/menubar
  fi

  local current_sha
  current_sha="$(cd "$MENUBAR_DIR" && git rev-parse HEAD)"

  local installed_sha=""
  [[ -f "$MENUBAR_INSTALLED_SHA_FILE" ]] && installed_sha="$(cat "$MENUBAR_INSTALLED_SHA_FILE")"

  local installed_app="/Applications/Threadbase Menubar.app"
  [[ ! -d "$installed_app" ]] && installed_app="$HOME/Applications/Threadbase Menubar.app"
  if [[ "$current_sha" == "$installed_sha" ]] && [[ -d "$installed_app" ]]; then
    log "menubar is up-to-date ($current_sha)"
    if ! pgrep -f "Threadbase Menubar" >/dev/null 2>&1; then
      log "launching installed menubar"
      open "$installed_app" || warn "could not launch menubar"
    else
      ok "menubar already running"
    fi
    return
  fi

  log "menubar needs install (installed: ${installed_sha:-none}, current: ${current_sha})"

  # Stop any running instance before we overwrite /Applications/.
  if pgrep -f "Threadbase Menubar" >/dev/null 2>&1; then
    log "stopping running menubar"
    pkill -f "Threadbase Menubar" 2>/dev/null || true
    sleep 0.5
  fi

  # Try fetching a pre-built signed .dmg from GitHub Releases first, unless
  # the caller explicitly asked for a local build (e.g. --publish-menubar).
  mkdir -p "$(dirname "$MENUBAR_FETCH_LOG")"
  : > "$MENUBAR_FETCH_LOG"

  local dmg=""
  local rc=99
  if (( ! force_build )); then
    log "fetching menubar release for $current_sha from GitHub"
    local fetched
    fetched="$(fetch_menubar_asset "$current_sha" "*-universal.dmg" \
      "$MENUBAR_DIR/release" "$MENUBAR_FETCH_LOG")" && rc=0 || rc=$?

    if [[ $rc -eq 0 ]] && [[ -n "$fetched" ]]; then
      dmg="$fetched"
      ok "menubar release downloaded: $dmg"
    fi
  else
    log "force_build requested — skipping release download"
  fi

  if [[ -z "$dmg" ]]; then
    if (( force_build )); then
      :  # caller requested local build; no fallback messaging needed
    elif [[ $rc -eq 2 ]]; then
      log "no matching menubar release for $current_sha — building locally"
    else
      warn "menubar release fetch failed — see $MENUBAR_FETCH_LOG"
      menubar_print_fetch_error "$MENUBAR_FETCH_LOG"
      warn "falling back to local build…"
    fi

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

    log "building menubar .dmg (this takes 1–3 minutes; longer first time)"
    ( cd "$MENUBAR_DIR" && npm ci --silent && npm run package:mac )

    # Locate the produced .dmg.
    dmg="$(ls -t "$MENUBAR_DIR/release/"*.dmg 2>/dev/null | head -1 || true)"
    if [[ -z "$dmg" ]]; then
      err "electron-builder produced no .dmg"
      return 1
    fi
    ok "menubar built: $dmg"
  fi

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

  # Force LaunchServices to forget any stale registry entries pointing at old
  # .app locations (e.g. a developer's release/mac-arm64/) and pick up the
  # newly-installed bundle. Without this, `open -a "Threadbase Menubar"` may
  # silently launch the wrong copy.
  local lsregister="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
  [[ -x "$lsregister" ]] && "$lsregister" -f "$target" >/dev/null 2>&1 || true

  # Archive the .dmg under ~/.threadbase/releases/menubar/ for offline reinstall.
  mkdir -p "$MENUBAR_RELEASES_DIR"
  local short_sha archived
  short_sha="${current_sha:0:7}"
  archived="$MENUBAR_RELEASES_DIR/Threadbase-Menubar-${short_sha}.dmg"
  cp "$dmg" "$archived"
  ok "archived $archived"

  printf '%s' "$current_sha" > "$MENUBAR_INSTALLED_SHA_FILE"

  log "launching $target"
  # Use direct path so we definitely launch the freshly-installed copy, not
  # whatever LaunchServices has cached for "Threadbase Menubar".
  open "$target" || warn "could not launch menubar"

  # Garbage-collect old archived .dmgs.
  ls -t "$MENUBAR_RELEASES_DIR"/Threadbase-Menubar-*.dmg 2>/dev/null \
    | tail -n +$((MENUBAR_KEEP_DMGS + 1)) | xargs -r rm -f || true

  ok "menubar deployed: $current_sha"
}

# Upload the most recently archived menubar .dmg to a GitHub Release on the
# threadbase-menubar repo. Tag format: v<package version>+<short submodule sha>,
# marked --prerelease to signal "tip-of-main build", not a tagged release.
#
# Refuses to upload unsigned builds — detected via APPLE_TEAM_ID env, which is
# only set when ~/.threadbase/menubar-signing.env was sourced. Idempotent: if
# the tag already exists with the .dmg asset, skips. If the tag exists without
# the asset (previous upload failed), uploads it.
publish_menubar() {
  if ! command -v gh >/dev/null 2>&1; then
    err "gh CLI not installed — cannot publish (brew install gh)"
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    err "gh CLI not authenticated — run 'gh auth login' first"
    return 1
  fi
  if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
    err "refusing to publish unsigned build — source $MENUBAR_SIGNING_ENV first"
    return 1
  fi

  local current_sha short_sha pkg_version dmg tag
  current_sha="$(cd "$MENUBAR_DIR" && git rev-parse HEAD)"
  short_sha="${current_sha:0:7}"
  pkg_version="$(cd "$MENUBAR_DIR" && node -p "require('./package.json').version")"
  dmg="$MENUBAR_RELEASES_DIR/Threadbase-Menubar-${short_sha}.dmg"
  tag="v${pkg_version}+${short_sha}"

  if [[ ! -f "$dmg" ]]; then
    err "expected $dmg to exist — run ensure_menubar_deployed first"
    return 1
  fi

  log "publishing $tag to threadbase-menubar GitHub Releases"

  # Check whether the release already exists.
  if gh release view "$tag" --repo RonenMars/threadbase-menubar >/dev/null 2>&1; then
    # If the .dmg asset is already attached, nothing to do.
    if gh release view "$tag" --repo RonenMars/threadbase-menubar --json assets \
         --jq '.assets[].name' 2>/dev/null | grep -qx "$(basename "$dmg")"; then
      ok "release $tag already has $(basename "$dmg") attached — skipping"
      return 0
    fi
    log "release $tag exists but asset missing — uploading"
    gh release upload "$tag" "$dmg" --repo RonenMars/threadbase-menubar --clobber
  else
    log "creating release $tag"
    gh release create "$tag" "$dmg" \
      --repo RonenMars/threadbase-menubar \
      --prerelease \
      --title "$tag" \
      --notes "Auto-published by tb-streamer/scripts/deploy.sh from submodule SHA $current_sha"
  fi

  ok "published $tag"
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

# Realign better-sqlite3's prebuilt native binary with whatever Node `bash`
# resolves to at deploy time. Necessary because `bash scripts/deploy.sh` runs
# in a sub-shell that doesn't load nvm's lazy-init function — `node` falls
# through PATH to (e.g.) homebrew node, which can be a different major than
# the Node that last ran `npm install`. The ABI mismatch only surfaces inside
# vitest worker forks, so the deploy's `npm test` gate fails while standalone
# `npm test` from an interactive shell passes — confusing the diagnosis.
#
# Detection: instantiate a Database under the active Node. `require()` alone
# only loads JS — the binding (and its NODE_MODULE_VERSION check) doesn't
# resolve until something actually constructs a Database. If that throws,
# rebuild.
# `prebuild-install` will fetch a binary matching the active Node's ABI.
# `config.gypi`'s `node_module_version` is NOT a reliable signal — it reflects
# the last from-source `node-gyp rebuild`, not the currently-installed
# prebuild, so a fresh prebuild leaves it stale.
# Cheap when already aligned (~0.5s); ~10s when an actual rebuild happens.
ensure_native_modules_match_node() {
  [[ ! -d "$REPO_ROOT/node_modules/better-sqlite3" ]] && return 0  # deps not installed; lint/test will surface that
  if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
    log "better-sqlite3 native binary does not load under active Node — rebuilding"
    npm rebuild better-sqlite3 --silent
    if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
      err "better-sqlite3 still fails to load after rebuild — manual fix needed (try: rm -rf node_modules && npm install)"
      exit 1
    fi
  fi
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
    check_active_sessions "$force"
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
  check_active_sessions "$force"
}

# Refuse to redeploy while users have live PTY sessions: a restart kills every
# Claude child mid-turn, leaving JSONLs truncated and mobile clients holding
# stale cached state. Probes the running streamer's session list and counts
# entries with `ptyAttached: true` (managed/live PTYs only — ignores discovered
# processes and idle JSONL stubs). Unreachable server → proceed-OK (no live
# PTYs to harm).
check_active_sessions() {
  local force="${1:-}"
  local yaml="$INSTALL_DIR/server.yaml"
  [[ -f "$yaml" ]] || return 0

  local api_key
  api_key="$(awk '/^api_key:/ {print $2; exit}' "$yaml" 2>/dev/null)"
  [[ -n "$api_key" ]] || return 0

  local sessions_json count
  sessions_json="$(curl -fsS --max-time 2 \
    -H "Authorization: Bearer $api_key" \
    "http://localhost:$PORT/api/sessions" 2>/dev/null || true)"
  [[ -n "$sessions_json" ]] || return 0

  # Count occurrences of `"ptyAttached":true`. Whitespace in JSON is variable
  # but the streamer's serializer emits no spaces around the colon. `|| true`
  # swallows grep's exit 1 when there are no matches (pipefail would otherwise
  # propagate it and `set -e` would abort the script).
  count="$(printf '%s' "$sessions_json" | { grep -o '"ptyAttached":true' || true; } | wc -l | tr -d ' ')"
  [[ "$count" =~ ^[0-9]+$ ]] || return 0
  # Plain `(( count == 0 ))` returns exit 1 under set -e when the comparison is
  # false. The `if` form contains the non-zero exit.
  if (( count == 0 )); then
    return 0
  fi

  if [[ "$force" == "--force" ]]; then
    warn "$count active PTY session(s) will be killed by restart, forcing"
    return 0
  fi
  err "$count active PTY session(s) in flight — redeploying now will kill them mid-turn."
  err "Wait for them to finish, ask the client to hold them, or re-run with --force to override."
  exit 1
}

# Write the nightly restart job plist. Runs `launchctl kickstart -k` at 4 AM
# daily to reclaim V8 heap (Node never voluntarily shrinks — after days of
# running sessions, Threadbase can grow from ~150 MB to ~900 MB+).
write_nightly_restart_plist() {
  local plist_path="$1"
  local logs_dir="$INSTALL_DIR/logs"
  local user_id
  user_id="$(id -u)"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$NIGHTLY_RESTART_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>kickstart</string>
    <string>-k</string>
    <string>gui/$user_id/$LAUNCHD_LABEL</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$logs_dir/nightly-restart-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$logs_dir/nightly-restart-stderr.log</string>
</dict>
</plist>
PLIST
}

install_nightly_restart_job() {
  local plist_path="$HOME/Library/LaunchAgents/$NIGHTLY_RESTART_LABEL.plist"
  local logs_dir="$INSTALL_DIR/logs"
  mkdir -p "$logs_dir" "$(dirname "$plist_path")"

  log "writing nightly restart plist → $plist_path"
  write_nightly_restart_plist "$plist_path"

  launchctl bootout "gui/$(id -u)/$NIGHTLY_RESTART_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"

  ok "nightly restart job installed (runs daily at 4 AM)"
}

uninstall_nightly_restart_job() {
  local plist_path="$HOME/Library/LaunchAgents/$NIGHTLY_RESTART_LABEL.plist"
  if [[ -f "$plist_path" ]]; then
    log "removing nightly restart job"
    launchctl bootout "gui/$(id -u)/$NIGHTLY_RESTART_LABEL" 2>/dev/null || true
    rm -f "$plist_path"
    ok "nightly restart job removed"
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
  local shim_path="$INSTALL_DIR/launchd-entry.cjs"
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
    <string>$shim_path</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--verbose</string>
    <string>--prod</string>
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
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
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

  uninstall_nightly_restart_job
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

  local needs_rewrite="false"

  if ! grep -q "EnvironmentVariables" "$plist_path"; then
    warn "plist is missing EnvironmentVariables block — claude won't be on launchd's PATH"
    needs_rewrite="true"
  fi

  # New: detect old layout that points at cli.js directly (no shim).
  if grep -q "<string>$ACTIVE_LINK</string>" "$plist_path"; then
    warn "plist still points at cli.js directly (no shim) — rewriting to use launchd-entry.cjs"
    needs_rewrite="true"
  fi

  # New: detect bare-bool KeepAlive (pre-shim era).
  if awk '/<key>KeepAlive<\/key>/{getline; print}' "$plist_path" | grep -q "<true/>\|<false/>"; then
    warn "plist uses bare-bool KeepAlive — rewriting to dict form (SuccessfulExit=false)"
    needs_rewrite="true"
  fi

  [[ "$needs_rewrite" != "true" ]] && return 0

  warn "rewriting $plist_path and re-bootstrapping"
  local node_bin
  node_bin="$(command -v node)" || { err "node not found in PATH"; exit 1; }

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

# PIDs currently listening on $PORT (space-separated), or empty.
port_listener_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

# True when $1 looks like a threadbase streamer / launchd-entry process.
is_threadbase_listener() {
  local pid="$1"
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -z "$cmd" ]] && return 1
  [[ "$cmd" == *"$INSTALL_DIR"* ]] \
    || [[ "$cmd" == *"threadbase"* ]] \
    || [[ "$cmd" == *"/cli."*".cjs"* ]] \
    || [[ "$cmd" == *"launchd-entry"* ]]
}

# Kill threadbase listeners holding $PORT (orphans from a raced kickstart).
# Returns 0 if the port is free (or was freed); 1 if a non-threadbase process holds it.
cmd_free_stale_port() {
  local pids pid cmd waited=0
  pids="$(port_listener_pids)"
  [[ -n "$pids" ]] || return 0

  for pid in $pids; do
    if ! is_threadbase_listener "$pid"; then
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || echo "?")"
      warn "port $PORT held by non-threadbase pid=$pid ($cmd) — not killing"
      return 1
    fi
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || echo "?")"
    warn "port $PORT held by stale threadbase pid=$pid — killing"
    warn "  $cmd"
    kill "$pid" 2>/dev/null || true
  done

  # Wait briefly for the kernel to release the socket.
  while (( waited < 20 )); do
    pids="$(port_listener_pids)"
    [[ -z "$pids" ]] && return 0
    # Re-signal anything still alive.
    for pid in $pids; do
      if is_threadbase_listener "$pid"; then
        kill -9 "$pid" 2>/dev/null || true
      else
        return 1
      fi
    done
    sleep 0.25
    waited=$((waited + 1))
  done

  pids="$(port_listener_pids)"
  [[ -z "$pids" ]]
}

stderr_shows_eaddrinuse() {
  local stderr_log
  stderr_log="$(streamer_stderr_log)"
  [[ -s "$stderr_log" ]] || return 1
  tail -n 40 "$stderr_log" 2>/dev/null | grep -q "EADDRINUSE"
}

# Kickstart + healthcheck, with one automatic recovery when a raced/orphaned
# streamer still holds $PORT (EADDRINUSE). Matches the manual recovery:
#   kill <listener>; launchctl kickstart -k ...; curl /healthz
cmd_kickstart_and_healthcheck() {
  cmd_kickstart
  if cmd_healthcheck; then
    return 0
  fi

  if ! stderr_shows_eaddrinuse; then
    return 1
  fi

  warn "detected EADDRINUSE on port $PORT — clearing stale listener and retrying once"
  if ! cmd_free_stale_port; then
    err "could not free port $PORT; resolve the listener manually and re-run deploy"
    return 1
  fi
  sleep 0.5
  cmd_kickstart
  cmd_healthcheck
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
  log "kickstarting $LAUNCHD_LABEL"
  cmd_kickstart_and_healthcheck
}

# Atomically replace $ACTIVE_LINK with a symlink to $1 (relative to $INSTALL_DIR).
# Also installs the matching version.txt next to the symlink so the running
# CLI's getVersion() reports the activated build (not the previously activated
# one). The sidecar is written per-release by cmd_deploy below.
activate_release() {
  local rel_path="$1"
  ( cd "$INSTALL_DIR" && ln -sf "$rel_path" cli.js.new && mv -f cli.js.new cli.js )
  local sidecar="$INSTALL_DIR/${rel_path}.version"
  if [[ -f "$sidecar" ]]; then
    cp "$sidecar" "$INSTALL_DIR/version.txt"
  else
    # Rolling back to a release that pre-dates version.txt stamping. Drop a
    # placeholder so the CLI doesn't fall back to package.json (which may now
    # report a newer version after a subsequent deploy bumped it).
    printf 'unknown+%s\n' "${rel_path##*/}" > "$INSTALL_DIR/version.txt"
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rel_path" >> "$HISTORY_FILE"
}

cmd_deploy() {
  local force="" publish_menubar_flag=0 clear_logs_flag=0
  for arg in "$@"; do
    case "$arg" in
      --force)                 force="--force" ;;
      --clear-logs)            clear_logs_flag=1 ;;
      --publish-menubar)       publish_menubar_flag=1 ;;
      --install-shim=*)        export TB_INSTALL_SHIM="${arg#--install-shim=}" ;;
      --path-update=*)         export TB_PATH_UPDATE="${arg#--path-update=}" ;;
      *) err "unknown deploy flag: $arg"; exit 2 ;;
    esac
  done

  # If publishing was requested, fail fast before any expensive work if the
  # signing config or gh CLI are missing — otherwise the user spends 5 minutes
  # building a .dmg only to hit the publish-time refusal.
  if (( publish_menubar_flag )); then
    if [[ ! -f "$MENUBAR_SIGNING_ENV" ]]; then
      err "--publish-menubar requires $MENUBAR_SIGNING_ENV (Developer ID + ASC API key)"
      exit 1
    fi
    if ! command -v gh >/dev/null 2>&1; then
      err "--publish-menubar requires gh CLI (brew install gh)"
      exit 1
    fi
    if ! gh auth status >/dev/null 2>&1; then
      err "--publish-menubar requires gh auth — run 'gh auth login' first"
      exit 1
    fi
  fi

  cmd_predeploy_check "$force"
  cmd_check_browse_root

  cd "$REPO_ROOT"
  ensure_native_modules_match_node
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

  # Sidecar that activate_release will copy to $INSTALL_DIR/version.txt. We write
  # it now (alongside the per-release cli.<sha>.cjs) rather than in
  # activate_release so rollbacks can use the historical version string instead
  # of the current package.json + sha.
  local pkg_version
  pkg_version="$(node -p 'require("./package.json").version')"
  printf '%s+%s\n' "$pkg_version" "$sha" > "$RELEASES_DIR/${rel_filename}.version"

  # Copy the launchd shim alongside the active cli.js. The plist always
  # references $INSTALL_DIR/launchd-entry.cjs (no per-release versioning —
  # the shim is small and only ever forwards to whatever cli.js the symlink
  # points at).
  log "installing launchd shim → $INSTALL_DIR/launchd-entry.cjs"
  cp "$REPO_ROOT/dist/launchd-entry.cjs" "$INSTALL_DIR/launchd-entry.cjs"
  chmod +x "$INSTALL_DIR/launchd-entry.cjs"
  # Copy migrations alongside the CLI so __dirname resolution works at runtime.
  # - migrations/    — SQLite (ConversationCache.open(); always required)
  # - pg-migrations/ — Postgres (loaded when THREADBASE_DATABASE_URL is set, but the
  #                   migration runner reads the dir at startup and crashes if absent)
  # Remove existing dirs first: `cp -r src dst` nests as `dst/src` when dst exists,
  # which previously fed the SQLite loader a stale set of pg-flavored files.
  rm -rf "$RELEASES_DIR/migrations" "$RELEASES_DIR/pg-migrations"
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

  # Truncate logs in place only when --clear-logs is passed (opt-in — logs
  # are preserved by default so history isn't silently lost on every deploy).
  # Truncating (not unlinking) preserves the inode launchd already has open
  # via the plist's StandardOut/ErrorPath.
  if (( clear_logs_flag )); then
    log "clearing logs (--clear-logs)"
    : > "$INSTALL_DIR/logs/stdout.log" 2>/dev/null || true
    : > "$INSTALL_DIR/logs/stderr.log" 2>/dev/null || true
  fi

  log "kickstarting $LAUNCHD_LABEL"
  cmd_kickstart_and_healthcheck

  # Prompt to install the nightly restart job on first deploy only, and only
  # in interactive shells. Re-deploys skip silently.
  local nightly_plist="$HOME/Library/LaunchAgents/$NIGHTLY_RESTART_LABEL.plist"
  if [[ ! -f "$nightly_plist" ]] && [[ -t 0 ]]; then
    printf '\n  Add a nightly restart job? Restarts Threadbase at 4 AM daily to reclaim memory (keeps it at ~150 MB instead of ~900 MB after days of use). [y/N] '
    read -r yn
    [[ "${yn,,}" == "y" ]] && install_nightly_restart_job
  fi

  log "garbage-collecting old releases (keeping last $KEEP_RELEASES)"
  ls -t "$RELEASES_DIR"/cli.*.cjs 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f || true

  if (( publish_menubar_flag )); then
    ensure_menubar_deployed force_build
    publish_menubar
  else
    ensure_menubar_deployed
  fi

  # Install (or refresh) the global `threadbase-streamer` shim. Non-fatal:
  # deploy is already healthy at this point; only the convenience shim is at stake.
  install_global_shim "$ACTIVE_LINK" || warn "global shim install failed (deploy itself is OK)"

  ok "deploy complete: $rel_filename"
}

case "${1:-deploy}" in
  setup)  cmd_setup ;;
  deploy)
    shift
    cmd_deploy "$@"
    ;;
  --force|--publish-menubar|--install-shim=*|--path-update=*)
    cmd_deploy "$@"
    ;;
  "")
    cmd_deploy
    ;;
  rollback)     cmd_rollback ;;
  status)       cmd_status ;;
  healthcheck)  cmd_healthcheck ;;
  free-port)    cmd_free_stale_port ;;
  restart)      cmd_kickstart_and_healthcheck ;;
  nightly-install)   install_nightly_restart_job ;;
  nightly-uninstall) uninstall_nightly_restart_job ;;
  menubar)
    shift
    mb_publish=0
    for arg in "$@"; do
      case "$arg" in
        --publish-menubar|--publish) mb_publish=1 ;;
        *) err "unknown menubar flag: $arg"; exit 2 ;;
      esac
    done
    if (( mb_publish )); then
      ensure_menubar_deployed force_build
      publish_menubar
    else
      ensure_menubar_deployed
    fi
    ;;
  *)
    err "unknown command: $1"
    echo "usage: $0 [deploy [--force] [--publish-menubar] | menubar [--publish] | rollback | status | healthcheck | restart | free-port | nightly-install | nightly-uninstall]" >&2
    exit 2
    ;;
esac
