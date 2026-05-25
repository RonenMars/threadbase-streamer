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

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHIM_SRC="$REPO_ROOT/bin/tb"
INSTALL_DIR="${TB_INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_PATH="$INSTALL_DIR/tb"

if [ ! -f "$SHIM_SRC" ]; then
  echo "install-tb: shim source missing at $SHIM_SRC" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod +x "$SHIM_SRC"
ln -sf "$SHIM_SRC" "$INSTALL_PATH"

echo "Installed: $INSTALL_PATH -> $SHIM_SRC"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    echo
    echo "warning: $INSTALL_DIR is not on your PATH."
    echo "Add this to your shell rc (~/.zshrc, ~/.bashrc):"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
