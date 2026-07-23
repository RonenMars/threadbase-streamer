#!/usr/bin/env bash
# Installs a second scheduled job — separate from the streamer service itself —
# that runs `threadbase-streamer update` every poll_interval_minutes. Reads
# the interval from ~/.threadbase/update.yaml. Skips installation when
# update.yaml is missing or auto_update:false.
#
# Idempotent: rerun safely after `deploy.sh setup` to wire up auto-update on
# an already-deployed streamer.
#
# Usage:
#   scripts/install-auto-update.sh            # install or refresh
#   scripts/install-auto-update.sh uninstall  # remove the auto-update job only
set -euo pipefail

CMD="${1:-install}"

INSTALL_DIR="${INSTALL_DIR:-$HOME/.threadbase}"
ACTIVE_LINK="$INSTALL_DIR/current/dist/cli.cjs"
UPDATE_YAML="$INSTALL_DIR/update.yaml"

# Leveled, timestamped logging tagged [auto-update]. Every line carries an
# ISO-8601 local timestamp and a level word. LOG_LEVEL=debug surfaces debug
# lines (default: info). Colors are suppressed for non-TTY/NO_COLOR output.
LOG_LEVEL="${LOG_LEVEL:-info}"
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then _log_color=1; else _log_color=0; fi
_log_ts()   { date '+%Y-%m-%dT%H:%M:%S%z'; }
_log_emit() { # <level> <ansi> <stream:1|2> <msg...>
  local level="$1" ansi="$2" stream="$3"; shift 3
  local prefix="" suffix=""
  if [ "$_log_color" = 1 ]; then prefix="\033[${ansi}m"; suffix="\033[0m"; fi
  local line
  line="$(printf '%s %-5s %b[auto-update]%b %s' "$(_log_ts)" "$level" "$prefix" "$suffix" "$*")"
  if [ "$stream" = 2 ]; then printf '%s\n' "$line" >&2; else printf '%s\n' "$line"; fi
}
debug() { [ "$LOG_LEVEL" = debug ] && _log_emit DEBUG '1;90' 2 "$@"; return 0; }
info()  { _log_emit INFO  '1;34' 1 "$@"; }
log()   { info "$@"; }
warn()  { _log_emit WARN  '1;33' 2 "$@"; }
err()   { _log_emit ERROR '1;31' 2 "$@"; }

read_yaml_field() {
  local key="$1" default="${2:-}"
  [[ -f "$UPDATE_YAML" ]] || { printf '%s' "$default"; return; }
  local v
  v="$(grep -E "^${key}:[[:space:]]*" "$UPDATE_YAML" | sed -E "s/^${key}:[[:space:]]*//" | tr -d '\r"' | head -n1)"
  printf '%s' "${v:-$default}"
}

PLATFORM="$(uname -s)"

# macOS: launchd plist with StartInterval. Linux: systemd --user timer.
if [[ "$PLATFORM" == "Darwin" ]]; then
  LABEL="${LAUNCHD_LABEL:-com.ronen.threadbase}.updater"
  PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
elif [[ "$PLATFORM" == "Linux" ]]; then
  UNIT_NAME="${THREADBASE_UPDATER_UNIT:-threadbase-updater}"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  SERVICE_PATH="$SYSTEMD_DIR/$UNIT_NAME.service"
  TIMER_PATH="$SYSTEMD_DIR/$UNIT_NAME.timer"
else
  err "unsupported platform: $PLATFORM"
  exit 1
fi

uninstall_macos() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  log "auto-update job removed ($LABEL)"
}

uninstall_linux() {
  systemctl --user stop "$UNIT_NAME.timer" 2>/dev/null || true
  systemctl --user disable "$UNIT_NAME.timer" 2>/dev/null || true
  rm -f "$SERVICE_PATH" "$TIMER_PATH"
  systemctl --user daemon-reload 2>/dev/null || true
  log "auto-update job removed ($UNIT_NAME)"
}

if [[ "$CMD" == "uninstall" ]]; then
  if [[ "$PLATFORM" == "Darwin" ]]; then uninstall_macos; else uninstall_linux; fi
  exit 0
fi

if [[ ! -f "$UPDATE_YAML" ]]; then
  warn "no $UPDATE_YAML — create one with at least 'github_repo: owner/name' and 'auto_update: true' to enable auto-update"
  exit 0
fi

AUTO_UPDATE="$(read_yaml_field auto_update false)"
if [[ "$AUTO_UPDATE" != "true" ]]; then
  log "auto_update is not 'true' in $UPDATE_YAML; not installing the scheduled job"
  log "set 'auto_update: true' and rerun to enable"
  exit 0
fi

INTERVAL_MIN="$(read_yaml_field poll_interval_minutes 1440)"
if ! [[ "$INTERVAL_MIN" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_MIN" -lt 1 ]]; then
  err "invalid poll_interval_minutes: $INTERVAL_MIN"
  exit 1
fi
INTERVAL_SEC=$((INTERVAL_MIN * 60))

if [[ ! -x "$ACTIVE_LINK" && ! -f "$ACTIVE_LINK" ]]; then
  err "streamer not deployed at $ACTIVE_LINK — run scripts/deploy.sh setup first"
  exit 1
fi

NODE_BIN="$(command -v node)" || { err "node not found in PATH"; exit 1; }
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
LOG_DIR="$INSTALL_DIR/logs"
mkdir -p "$LOG_DIR"

if [[ "$PLATFORM" == "Darwin" ]]; then
  mkdir -p "$(dirname "$PLIST_PATH")"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ACTIVE_LINK</string>
    <string>update</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>StartInterval</key>
  <integer>$INTERVAL_SEC</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/updater.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/updater.err</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  log "installed launchd job $LABEL — fires every ${INTERVAL_MIN} min"
  exit 0
fi

# Linux (systemd --user)
mkdir -p "$SYSTEMD_DIR"
cat > "$SERVICE_PATH" <<UNIT
[Unit]
Description=Threadbase Streamer auto-update check

[Service]
Type=oneshot
ExecStart=$NODE_BIN $ACTIVE_LINK update
StandardOutput=append:$LOG_DIR/updater.log
StandardError=append:$LOG_DIR/updater.err
UNIT

cat > "$TIMER_PATH" <<UNIT
[Unit]
Description=Threadbase Streamer auto-update timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_MIN}min
Unit=$UNIT_NAME.service

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME.timer"
log "installed systemd timer $UNIT_NAME.timer — fires every ${INTERVAL_MIN} min"
