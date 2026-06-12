#!/usr/bin/env bash
# Set Fly.io secrets for tb-streamer apps.
#
# Usage:
#   scripts/fly-secrets.sh KEY=VALUE [KEY2=VALUE2 …]          # demo (default)
#   scripts/fly-secrets.sh --prod KEY=VALUE [KEY2=VALUE2 …]   # prod
#   scripts/fly-secrets.sh --prod --demo KEY=VALUE            # both apps
#   scripts/fly-secrets.sh --file .env                        # import from file (demo)
#   scripts/fly-secrets.sh --list                             # list names (demo)
#   scripts/fly-secrets.sh --prod --list                      # list names (prod)
#   scripts/fly-secrets.sh --unset KEY                        # remove a secret (demo)
#
# Values are never printed. The --file flag reads KEY=VALUE lines from a file
# (blank lines and # comments are stripped before piping to `fly secrets import`).
#
# Requires: fly CLI authenticated (`fly auth whoami`).
set -euo pipefail

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

declare -A APPS=(
  [demo]="threadbase-demo"
  [prod]="threadbase"
)

# ── arg parsing ──────────────────────────────────────────────────────────────

TARGETS=()
PAIRS=()
ENV_FILE=""
UNSET_KEY=""
MODE="set"  # set | file | list | unset

while [[ $# -gt 0 ]]; do
  case "$1" in
    --demo)
      TARGETS+=(demo); shift ;;
    --prod)
      TARGETS+=(prod); shift ;;
    --list)
      MODE="list"; shift ;;
    --file)
      [[ -z "${2:-}" ]] && { err "--file requires a path"; exit 1; }
      MODE="file"; ENV_FILE="$2"; shift 2 ;;
    --unset)
      [[ -z "${2:-}" ]] && { err "--unset requires a key name"; exit 1; }
      MODE="unset"; UNSET_KEY="$2"; shift 2 ;;
    *=*)
      PAIRS+=("$1"); shift ;;
    *)
      err "unknown argument: $1"
      echo "Usage: $0 [--prod] [--demo] KEY=VALUE …" >&2
      echo "       $0 [--prod] [--demo] --file <path>" >&2
      echo "       $0 [--prod] [--demo] --list" >&2
      echo "       $0 [--prod] [--demo] --unset KEY" >&2
      exit 1 ;;
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

if [[ "$MODE" == "set" && ${#PAIRS[@]} -eq 0 ]]; then
  err "no KEY=VALUE pairs provided"
  exit 1
fi

if [[ "$MODE" == "file" ]]; then
  [[ ! -f "$ENV_FILE" ]] && { err "file not found: $ENV_FILE"; exit 1; }
fi

# ── execute per target ───────────────────────────────────────────────────────

for target in "${TARGETS[@]}"; do
  app="${APPS[$target]}"

  case "$MODE" in
    list)
      log "secrets on $target ($app)"
      fly secrets list --app "$app"
      ;;

    set)
      # Print key names only — never values
      keys=()
      for pair in "${PAIRS[@]}"; do keys+=("${pair%%=*}"); done
      log "setting [${keys[*]}] on $target ($app)"
      fly secrets set --app "$app" --stage "${PAIRS[@]}"
      ok "$target — staged (will apply on next deploy)"
      ;;

    file)
      log "importing secrets from $ENV_FILE on $target ($app)"
      # Strip blank lines and comments before piping
      grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' \
        | fly secrets import --app "$app" --stage
      ok "$target — staged (will apply on next deploy)"
      ;;

    unset)
      log "unsetting $UNSET_KEY on $target ($app)"
      fly secrets unset --app "$app" "$UNSET_KEY"
      ok "$target — $UNSET_KEY removed"
      ;;
  esac
done
