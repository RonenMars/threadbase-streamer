#!/usr/bin/env bash
# install-shim.sh — install a global `threadbase-streamer` command that wraps
# the deployed CLI at $1 (typically ~/.threadbase/cli.js).
#
# Sourced from scripts/deploy.sh and scripts/deploy-linux.sh. Exposes:
#   install_global_shim <cli_path>
#
# Non-interactive overrides:
#   TB_INSTALL_SHIM = standard | user-local | custom | skip
#   TB_PATH_UPDATE  = print | auto | skip
#   TB_CUSTOM_INSTALL_DIR = <abs path>     (used when TB_INSTALL_SHIM=custom)
#
# Persisted state:
#   ~/.threadbase/shim.conf  (KEY=value, shell-sourceable)
#     TB_INSTALL_SHIM=...           — the choice from the first interactive run
#     TB_CUSTOM_INSTALL_DIR=...     — only when TB_INSTALL_SHIM=custom
#   On subsequent deploys this file is sourced and the prompt is skipped.
#   Delete the file to be re-prompted.
#
# Behavior:
#   1. Load ~/.threadbase/shim.conf if present (acts like the env overrides).
#   2. Idempotency fallback: if no config but a 'threadbase-streamer' symlink
#      already exists on $PATH pointing at $cli_path, log + return 0.
#   3. Pick install dir (interactive prompt or env/config override).
#      - standard:  /opt/homebrew/bin on Apple Silicon, /usr/local/bin elsewhere.
#      - user-local: $HOME/.local/bin
#      - custom:    user-supplied path (or $TB_CUSTOM_INSTALL_DIR)
#      - skip:      do nothing (persisted, so future deploys stay silent)
#   4. Try to write the symlink. If standard dir isn't writable, try `sudo`;
#      if sudo isn't viable, fall back to user-local and warn.
#   5. If chosen dir isn't on $PATH, either print the export line or (with
#      user opt-in) append it to ~/.zshrc / ~/.bashrc.
#   6. Persist the resolved choice back to shim.conf for next run.
#
# Soft-fail: never `exit` from this file — return non-zero so the caller can
# decide whether to abort. Deploy callers treat shim failure as non-fatal.

# Re-declare logging helpers if not already defined by the parent script,
# so this file is usable standalone (e.g. for manual re-runs / tests).
if ! declare -F log >/dev/null 2>&1; then
  log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
fi
if ! declare -F warn >/dev/null 2>&1; then
  warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fi
if ! declare -F err >/dev/null 2>&1; then
  err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
fi
if ! declare -F ok >/dev/null 2>&1; then
  ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fi

# Path to the persisted choice file. Honors $THREADBASE_INSTALL_DIR.
_shim_config_file() {
  local base="${THREADBASE_INSTALL_DIR:-$HOME/.threadbase}"
  printf '%s/shim.conf\n' "$base"
}

# Load persisted choice from shim.conf into TB_INSTALL_SHIM / TB_CUSTOM_INSTALL_DIR.
# Caller env wins: a value already set in the environment is NOT overwritten.
_shim_load_config() {
  local cfg
  cfg="$(_shim_config_file)"
  [[ -f "$cfg" ]] || return 0
  local saved_choice="" saved_dir=""
  # Tolerate `KEY=value` with optional surrounding whitespace and comments.
  saved_choice="$(awk -F= '
    /^[[:space:]]*#/   {next}
    /^[[:space:]]*$/   {next}
    /TB_INSTALL_SHIM/  {gsub(/[[:space:]]/,"",$2); print $2; exit}
  ' "$cfg" 2>/dev/null)"
  saved_dir="$(awk -F= '
    /^[[:space:]]*#/         {next}
    /^[[:space:]]*$/         {next}
    /TB_CUSTOM_INSTALL_DIR/  {gsub(/[[:space:]]/,"",$2); print $2; exit}
  ' "$cfg" 2>/dev/null)"
  : "${TB_INSTALL_SHIM:=${saved_choice}}"
  : "${TB_CUSTOM_INSTALL_DIR:=${saved_dir}}"
  export TB_INSTALL_SHIM TB_CUSTOM_INSTALL_DIR
}

# Persist resolved choice + (when relevant) the custom dir back to shim.conf.
# Soft-fail: never aborts the caller.
_shim_persist_config() {
  local choice="$1" install_dir="$2"
  local cfg
  cfg="$(_shim_config_file)"
  local parent
  parent="$(dirname "$cfg")"
  mkdir -p "$parent" 2>/dev/null || return 0
  {
    printf '# threadbase-streamer shim install choice — auto-written by scripts/lib/install-shim.sh\n'
    printf '# Delete this file to be re-prompted on the next deploy.\n'
    printf 'TB_INSTALL_SHIM=%s\n' "$choice"
    if [[ "$choice" == "custom" ]] && [[ -n "$install_dir" ]]; then
      printf 'TB_CUSTOM_INSTALL_DIR=%s\n' "$install_dir"
    fi
  } > "$cfg" 2>/dev/null || return 0
  chmod 600 "$cfg" 2>/dev/null || true
}

# Command names installed by this script. Both point at the same cli.js.
# `threadbase-streamer` is the entrenched name used across docs, the auto-
# update scripts, and existing user installs. `tb-streamer` is the short
# alias matching the npm package + repo name. We install both so existing
# muscle memory keeps working and the shorter form is also available.
_shim_command_names() {
  printf 'threadbase-streamer\n'
  printf 'tb-streamer\n'
}

# Idempotency check — true when at least one of the installed names already
# exists on PATH and resolves to $1. Used as a fallback when no config file
# is present so older installs / manual setups stay quiet across redeploys.
_shim_existing_symlink_matches() {
  local cli_path="$1" name existing resolved
  for name in $(_shim_command_names); do
    existing="$(command -v "$name" 2>/dev/null)" || continue
    [[ -n "$existing" ]] || continue
    if [[ -L "$existing" ]]; then
      resolved="$(readlink "$existing")"
      case "$resolved" in
        /*) : ;;
        *)  resolved="$(cd "$(dirname "$existing")" && cd "$(dirname "$resolved")" && pwd)/$(basename "$resolved")" ;;
      esac
    else
      resolved="$existing"
    fi
    if [[ "$resolved" == "$cli_path" ]]; then
      printf '%s\n' "$existing"
      return 0
    fi
  done
  return 1
}

# Resolve the "standard" install dir for this host.
_shim_standard_dir() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  if [[ "$uname_s" == "Darwin" ]]; then
    # Apple Silicon ships /opt/homebrew/bin; Intel uses /usr/local/bin.
    if [[ "$(uname -m 2>/dev/null)" == "arm64" ]]; then
      printf '/opt/homebrew/bin\n'
    else
      printf '/usr/local/bin\n'
    fi
  else
    printf '/usr/local/bin\n'
  fi
}

_shim_user_local_dir() { printf '%s\n' "$HOME/.local/bin"; }

# Is `$1` already on $PATH (as an exact directory entry)?
_shim_path_contains() {
  local needle="$1"
  case ":$PATH:" in
    *":$needle:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Pick the user's rc file. Honors $SHELL; falls back to ~/.bashrc.
_shim_pick_rc_file() {
  local shell_basename
  shell_basename="$(basename "${SHELL:-bash}")"
  case "$shell_basename" in
    zsh)  printf '%s\n' "$HOME/.zshrc" ;;
    bash) printf '%s\n' "$HOME/.bashrc" ;;
    *)    printf '%s\n' "$HOME/.bashrc" ;;
  esac
}

# Prompt the user and echo the chosen mode. Honors $TB_INSTALL_SHIM.
_shim_prompt_choice() {
  if [[ -n "${TB_INSTALL_SHIM:-}" ]]; then
    printf '%s\n' "$TB_INSTALL_SHIM"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    # No TTY (CI / piped). Default to standard with auto fallback.
    printf 'standard\n'
    return 0
  fi
  local standard_dir user_dir
  standard_dir="$(_shim_standard_dir)"
  user_dir="$(_shim_user_local_dir)"
  printf '\n' >&2
  log "Install a global 'threadbase-streamer' command on PATH?" >&2
  printf '  1) standard      → %s   [default]\n' "$standard_dir" >&2
  printf '  2) user-local    → %s   (no sudo)\n' "$user_dir" >&2
  printf '  3) custom        → you pick a directory\n' >&2
  printf '  4) skip          → do not install\n' >&2
  local ans
  read -r -p "  Choice [1-4]: " ans </dev/tty || ans=""
  case "${ans:-1}" in
    1|"") printf 'standard\n' ;;
    2)    printf 'user-local\n' ;;
    3)    printf 'custom\n' ;;
    4)    printf 'skip\n' ;;
    *)    printf 'standard\n' ;;
  esac
}

# Prompt for a custom directory path. Honors $TB_CUSTOM_INSTALL_DIR.
_shim_prompt_custom_dir() {
  if [[ -n "${TB_CUSTOM_INSTALL_DIR:-}" ]]; then
    printf '%s\n' "$TB_CUSTOM_INSTALL_DIR"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    return 1
  fi
  local raw
  read -r -p "  Install dir: " raw </dev/tty || raw=""
  # Expand leading ~ manually (read doesn't tilde-expand).
  if [[ "$raw" == "~"* ]]; then
    raw="$HOME${raw:1}"
  fi
  if [[ -z "$raw" ]]; then
    return 1
  fi
  printf '%s\n' "$raw"
}

# Write the symlink atomically. Returns 0 on success, 1 on failure.
# Uses sudo if needed (and TTY is available + user agrees).
_shim_write_symlink() {
  local target="$1" link_path="$2" tmp
  tmp="${link_path}.tmp.$$"

  if ln -sf "$target" "$tmp" 2>/dev/null && mv -f "$tmp" "$link_path" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true

  # Direct write failed — try sudo if we have a TTY and sudo is available.
  if [[ -t 0 ]] && command -v sudo >/dev/null 2>&1; then
    warn "Cannot write to $(dirname "$link_path") without elevation."
    local yn
    read -r -p "  Retry with sudo? [Y/n]: " yn </dev/tty || yn=""
    case "${yn:-Y}" in
      n|N) return 1 ;;
    esac
    if sudo ln -sfn "$target" "$link_path"; then
      return 0
    fi
  fi
  return 1
}

# Append a PATH-export line to the user's shell rc file, idempotently.
_shim_append_to_rc() {
  local dir="$1" rc_file
  rc_file="$(_shim_pick_rc_file)"
  local marker="# threadbase-streamer PATH"
  local line="export PATH=\"$dir:\$PATH\"  $marker"

  if [[ -f "$rc_file" ]] && grep -Fq "$marker" "$rc_file" 2>/dev/null; then
    log "PATH entry already present in $rc_file"
    return 0
  fi
  {
    printf '\n%s\n' "$line"
  } >> "$rc_file"
  ok "Appended PATH entry to $rc_file"
  log "Open a new shell or run: source $rc_file"
}

# Handle PATH not containing the install dir.
_shim_handle_missing_path() {
  local dir="$1" mode
  mode="${TB_PATH_UPDATE:-}"

  local export_line="export PATH=\"$dir:\$PATH\""
  warn "$dir is not on your PATH."
  printf '  Add this to your shell rc to make \033[1mthreadbase-streamer\033[0m / \033[1mtb-streamer\033[0m available:\n' >&2
  printf '    %s\n' "$export_line" >&2

  if [[ -z "$mode" ]]; then
    if [[ ! -t 0 ]]; then
      mode="print"
    else
      local yn
      read -r -p "  Append this line to $(_shim_pick_rc_file) now? [y/N]: " yn </dev/tty || yn=""
      case "${yn:-N}" in
        y|Y) mode="auto" ;;
        *)   mode="print" ;;
      esac
    fi
  fi

  case "$mode" in
    auto) _shim_append_to_rc "$dir" ;;
    skip|print|*) : ;;
  esac
}

# Main entry point. Caller passes the absolute path to the deployed cli.js.
install_global_shim() {
  local cli_path="${1:-}"
  if [[ -z "$cli_path" ]]; then
    err "install_global_shim: missing cli_path argument"
    return 1
  fi
  if [[ ! -e "$cli_path" ]]; then
    warn "install_global_shim: $cli_path does not exist yet; skipping shim install"
    return 0
  fi

  # Load persisted choice (file values fill in any TB_* envs the caller didn't
  # set). Has to happen before the prompt and before the idempotency check —
  # both use TB_INSTALL_SHIM to decide what to do.
  _shim_load_config

  # Idempotency check: if a working shim already points at this cli_path on
  # PATH, the install would be a no-op rewrite of the same symlink. Skip.
  # Catches every redeploy where nothing about the install layout has changed
  # — both the persisted-config case and the manual-symlink case. Either
  # `threadbase-streamer` or `tb-streamer` being correct is sufficient to skip.
  # Honor an explicit TB_INSTALL_SHIM=skip though: a user who chose 'skip' may
  # have a stale symlink they wanted removed; don't quietly keep using it.
  if [[ "${TB_INSTALL_SHIM:-}" != "skip" ]]; then
    local existing_match
    if existing_match="$(_shim_existing_symlink_matches "$cli_path")"; then
      ok "Global shim already installed: $existing_match → $cli_path"
      return 0
    fi
  fi

  local choice
  choice="$(_shim_prompt_choice)"

  if [[ "$choice" == "skip" ]]; then
    log "Skipping global shim install (delete $(_shim_config_file) to re-enable the prompt)"
    _shim_persist_config "skip" ""
    return 0
  fi

  local install_dir
  case "$choice" in
    standard)   install_dir="$(_shim_standard_dir)" ;;
    user-local) install_dir="$(_shim_user_local_dir)" ;;
    custom)
      if ! install_dir="$(_shim_prompt_custom_dir)"; then
        warn "No custom path provided — skipping shim install."
        return 0
      fi
      ;;
    *)
      warn "Unknown TB_INSTALL_SHIM value '$choice'; skipping shim install."
      return 0
      ;;
  esac

  # Ensure the dir exists (try sudo for system dirs if needed).
  if [[ ! -d "$install_dir" ]]; then
    if ! mkdir -p "$install_dir" 2>/dev/null; then
      if [[ -t 0 ]] && command -v sudo >/dev/null 2>&1; then
        warn "Creating $install_dir requires elevation."
        if ! sudo mkdir -p "$install_dir"; then
          warn "Could not create $install_dir — falling back to user-local."
          install_dir="$(_shim_user_local_dir)"
          mkdir -p "$install_dir"
        fi
      else
        warn "Could not create $install_dir — falling back to user-local."
        install_dir="$(_shim_user_local_dir)"
        mkdir -p "$install_dir"
      fi
    fi
  fi

  # Try to write the first name; on failure (e.g. unwritable system dir),
  # fall back to user-local and retry. Once we have a working dir, write the
  # second name into it too — no separate retry needed since the dir is
  # already proven writable.
  local first_name
  first_name="$(_shim_command_names | head -n1)"
  local link_path="$install_dir/$first_name"

  log "Installing shim: $link_path → $cli_path"
  if ! _shim_write_symlink "$cli_path" "$link_path"; then
    warn "Could not write $link_path — falling back to user-local."
    install_dir="$(_shim_user_local_dir)"
    mkdir -p "$install_dir"
    link_path="$install_dir/$first_name"
    if ! _shim_write_symlink "$cli_path" "$link_path"; then
      err "Failed to install shim at $link_path. Run manually: ln -sf $cli_path $link_path"
      return 1
    fi
  fi

  # cli.js is a node script with a shebang; ensure exec bit is on the target.
  chmod +x "$cli_path" 2>/dev/null || true

  ok "Installed $first_name → $link_path"

  # Now write any additional aliases into the same (working) dir. Soft-fail:
  # the primary shim is already in place; a missing alias is a warning at most.
  local alias_name alias_path
  for alias_name in $(_shim_command_names | tail -n +2); do
    alias_path="$install_dir/$alias_name"
    if _shim_write_symlink "$cli_path" "$alias_path"; then
      ok "Installed $alias_name → $alias_path"
    else
      warn "Could not write alias $alias_path (primary shim is fine)"
    fi
  done

  # Persist the resolved choice so future deploys don't re-prompt. We persist
  # even when the install_dir was a sudo / fallback path — the saved 'choice'
  # captures the user's *intent*; the next deploy will re-derive the directory
  # from that intent.
  _shim_persist_config "$choice" "$install_dir"

  if _shim_path_contains "$install_dir"; then
    log "$install_dir is on PATH — 'threadbase-streamer' and 'tb-streamer' should work in a new shell."
  else
    _shim_handle_missing_path "$install_dir"
  fi

  return 0
}

# When executed directly (not sourced), run install_global_shim with the
# default install dir for convenience: `bash scripts/lib/install-shim.sh`.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cli_path="${THREADBASE_INSTALL_DIR:-$HOME/.threadbase}/cli.js"
  install_global_shim "$cli_path"
fi
