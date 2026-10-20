#!/usr/bin/env bash
# Let a browser web app (default: https://app.threadbase.sh) talk to this streamer
# by adding its origin to `browser_cors:` in ~/.threadbase/server.yaml.
#
#   bash scripts/allow-web-app.sh                         # https://app.threadbase.sh
#   bash scripts/allow-web-app.sh https://web.example.com # another origin
#
# Idempotent. Keeps any origins already listed, backs the file up first, and does
# NOT restart the streamer (a restart ends live sessions — you choose when).
# Guide: docs/guides/web-app-access.md
set -euo pipefail

ORIGIN="${1:-https://app.threadbase.sh}"
FILE="${THREADBASE_CONFIG_DIR:-$HOME/.threadbase}/server.yaml"

# An origin is scheme://host[:port] — no path, no trailing slash, no commas.
if ! [[ "$ORIGIN" =~ ^https?://[^/[:space:],]+$ ]]; then
  echo "error: '$ORIGIN' is not an origin (expected e.g. https://app.threadbase.sh, no trailing slash)" >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "error: $FILE not found — start the streamer once so it creates its config, then re-run" >&2
  exit 1
fi

current="$(sed -n 's/^browser_cors:[[:space:]]*//p' "$FILE" | head -1 | sed 's/[[:space:]]*$//')"

# The streamer reads the FIRST `browser_cors:` it finds anywhere in the file, comments included.
if grep -n 'browser_cors:' "$FILE" | grep -v ':browser_cors:' >/dev/null; then
  echo "warning: $FILE has an indented or commented 'browser_cors:' line; the streamer may read that one instead of this script's edit" >&2
fi

case "$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]')" in
  ""|0|false|no|off|1|true|yes|on) new="$ORIGIN" ;;   # off, or "defaults only": an explicit list replaces it
  *)
    if [[ ",$current," == *",$ORIGIN,"* ]]; then
      echo "already allowed: $ORIGIN (browser_cors: $current) — nothing to change"
      exit 0
    fi
    new="$current,$ORIGIN"
    ;;
esac

backup="$FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$FILE" "$backup"   # the file holds the API key, so the copy keeps its permissions

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if grep -q '^browser_cors:' "$FILE"; then
  awk -v new="browser_cors: $new" '!done && /^browser_cors:/ { print new; done=1; next } { print }' "$FILE" > "$tmp"
else
  { cat "$FILE"; [[ -n "$(tail -c1 "$FILE")" ]] && echo; echo "browser_cors: $new"; } > "$tmp"
fi
cat "$tmp" > "$FILE"   # write in place: keeps the file's mode and inode

echo "updated $FILE"
echo "  browser_cors: $new"
echo "  backup: $backup"
echo
echo "Restart the streamer to apply it (this ends live sessions, so pick a quiet moment):"
echo "  tb-streamer service restart"
