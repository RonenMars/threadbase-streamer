#!/bin/sh
# install-tb.sh — symlink the `tb` shim into a directory on PATH.
#
# DEPRECATED. Prefer the auto-installed global commands.
# `npm run deploy` (or `scripts/deploy.sh`) now installs `tb-streamer` and
# `threadbase-streamer` on PATH automatically — no separate installer needed.
# See CLAUDE.md → "Global `threadbase-streamer` / `tb-streamer` command".
# This script keeps working for users who want `tb` specifically, or who
# rely on the THREADBASE_CLI env-var override in bin/tb.
#
# Default install dir: ~/.local/bin (override with TB_INSTALL_DIR).
# Re-run any time; the symlink is replaced atomically.
set -e

# POSIX-safe timestamped, leveled logging (this script is #!/bin/sh). Every line
# carries an ISO-8601 local timestamp and a level word.
_log_ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
info() { printf '%s %-5s [install-tb] %s\n' "$(_log_ts)" INFO  "$*"; }
warn() { printf '%s %-5s [install-tb] %s\n' "$(_log_ts)" WARN  "$*" >&2; }
err()  { printf '%s %-5s [install-tb] %s\n' "$(_log_ts)" ERROR "$*" >&2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHIM_SRC="$REPO_ROOT/bin/tb"
INSTALL_DIR="${TB_INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_PATH="$INSTALL_DIR/tb"

if [ ! -f "$SHIM_SRC" ]; then
  err "shim source missing at $SHIM_SRC"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod +x "$SHIM_SRC"
ln -sf "$SHIM_SRC" "$INSTALL_PATH"

info "installed: $INSTALL_PATH -> $SHIM_SRC"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    warn "$INSTALL_DIR is not on your PATH."
    warn "add this to your shell rc (~/.zshrc, ~/.bashrc):"
    warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
