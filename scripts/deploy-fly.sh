#!/usr/bin/env bash
# Deploy tb-streamer to Fly.io.
#
# Usage:
#   scripts/deploy-fly.sh                 # deploy demo (default)
#   scripts/deploy-fly.sh --prod          # deploy prod
#   scripts/deploy-fly.sh --prod --demo   # deploy both in parallel
#
#   --force    skip dirty-tree check
#   --verbose  stream fly deploy output in real time (single target only;
#              parallel deploys always buffer to avoid interleaved output)
#
# Requires: fly CLI authenticated (`fly auth whoami`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- logging -----------------------------------------------------------------
# Leveled, timestamped logging. Every line carries an ISO-8601 local timestamp
# and a level word so redirected logs are self-describing. LOG_LEVEL=debug
# surfaces debug lines (default: info). Colors are suppressed when stdout is not
# a TTY (logs captured to a file) or when NO_COLOR is set.
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

# ── arg parsing ──────────────────────────────────────────────────────────────

TARGETS=()
FORCE=0
VERBOSE=0

for arg in "$@"; do
  case "$arg" in
    --demo)    TARGETS+=(demo) ;;
    --prod)    TARGETS+=(prod) ;;
    --force)   FORCE=1 ;;
    --verbose) VERBOSE=1 ;;
    *) err "unknown argument: $arg"; echo "Usage: $0 [--prod] [--demo] [--force] [--verbose]" >&2; exit 1 ;;
  esac
done

# Default to demo when no target specified
[[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=(demo)

# ── preflight ────────────────────────────────────────────────────────────────

if ! command -v fly >/dev/null 2>&1; then
  err "fly CLI not found — install from https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
fi

if ! fly auth whoami >/dev/null 2>&1; then
  err "not logged in to Fly — run: fly auth login"
  exit 1
fi

if [[ $FORCE -eq 0 ]] && [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  err "working tree is dirty — commit your changes or pass --force"
  exit 1
fi

SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

# ── deploy ───────────────────────────────────────────────────────────────────

declare -A CONFIGS=(
  [demo]="fly.toml"
  [prod]="fly.prod.toml"
)
declare -A APPS=(
  [demo]="threadbase-demo"
  [prod]="threadbase"
)
declare -A URLS=(
  [demo]="https://threadbase-demo.fly.dev/healthz"
  [prod]="https://threadbase.fly.dev/healthz"
)

FAILED=()

# --verbose + single target: stream fly output directly to the terminal.
if [[ $VERBOSE -eq 1 && ${#TARGETS[@]} -eq 1 ]]; then
  target="${TARGETS[0]}"
  log "deploying $target (${APPS[$target]}) @ $SHA"
  if fly deploy \
      --config "$REPO_ROOT/${CONFIGS[$target]}" \
      --app "${APPS[$target]}" \
      --remote-only; then
    ok "$target deployed — ${APPS[$target]}"
  else
    err "$target deploy failed"
    exit 1
  fi
  exit 0
fi

# Default: buffer output per target (keeps output clean; avoids interleave in parallel).
LOG_DIR="$(mktemp -d)"
PIDS=()

for target in "${TARGETS[@]}"; do
  log "deploying $target (${APPS[$target]}) @ $SHA"
  fly deploy \
    --config "$REPO_ROOT/${CONFIGS[$target]}" \
    --app "${APPS[$target]}" \
    --remote-only \
    > "$LOG_DIR/$target.log" 2>&1 &
  PIDS+=("$!:$target")
done

# ── wait and report ──────────────────────────────────────────────────────────

for entry in "${PIDS[@]}"; do
  pid="${entry%%:*}"
  target="${entry##*:}"

  if wait "$pid"; then
    ok "$target deployed — ${APPS[$target]}"
  else
    err "$target deploy failed"
    FAILED+=("$target")
    cat "$LOG_DIR/$target.log" >&2
  fi
done

rm -rf "$LOG_DIR"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  err "failed: ${FAILED[*]}"
  exit 1
fi

ok "all targets deployed @ $SHA"
