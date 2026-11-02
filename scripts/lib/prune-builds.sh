# shellcheck shell=bash
# Prune the install dir's builds (issue #900). Sourced by deploy.sh and
# deploy-linux.sh, which provide log/debug/warn/err. Windows has its own port
# in prune-builds.ps1.
#
# One owner per machine: on a machine deployed with deploy.sh, the updater's
# staging trees are dead weight. This removes them and keeps KEEP builds
# (the active one plus rollback targets), except any build a live pty-host
# still runs, because a detached pty-host survives streamer restarts and loads
# node-pty lazily from its own build's node_modules.
#
# Deletes ONLY these, each through _pb_rm:
#   <install>/current
#   <install>/releases/cli.*            deploy builds (dir, or flat .cjs + .cjs.version)
#   <install>/releases/<semver>         updater trees
#   <install>/releases/.tmp/*.tgz       updater downloads
# Never cache.db, runtime.db, server.yaml, logs, the install's node_modules,
# .history (rollback needs it) or releases/menubar.

# Roots that must never be an install dir, whatever the caller computed.
_pb_root_ok() {
  local p="${1%/}"
  [[ -n "$p" && "$p" == /* && "$p" != *..* ]] || return 1
  [[ "$p" == "${HOME%/}" ]] && return 1
  case "$p" in
    /tmp|/var|/var/tmp|/usr|/usr/*|/etc|/etc/*|/bin|/sbin|/lib|/lib/*|/boot|/dev|/proc|/sys|/opt|/home|/root|/private|/private/tmp|/private/var|/Users|/Library|/System|/System/*|/Applications|/Volumes) return 1 ;;
  esac
  # Two components at least: "/x" is never an install.
  [[ "${p#/}" == */* ]]
}

# The only deletion primitive. $1 install (validated), $2 the target.
_pb_rm() {
  local install="$1" target="$2" rel name
  [[ -n "$install" && "$install" == /* && -n "$target" ]] || return 1
  rel="${target#"$install"/}"
  [[ "$rel" != "$target" ]] || return 1
  case "$rel" in
    current) rm -rf -- "$target"; return 0 ;;
    releases/.tmp/*)
      name="${rel#releases/.tmp/}"
      [[ "$name" == *.tgz ]] || return 1 ;;
    releases/*)
      name="${rel#releases/}"
      [[ "$name" == cli.* || "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]] || return 1 ;;
    *) return 1 ;;
  esac
  [[ -n "$name" && "$name" != */* && "$name" != . && "$name" != .. ]] || return 1
  rm -rf -- "$target"
}

# Name of the build cli.js points at: the first component under releases/, or
# "current". Empty when it cannot be read.
_pb_active_build() {
  local t
  t="$(readlink "$1/cli.js" 2>/dev/null)" || return 0
  t="${t#"$1"/}"
  case "$t" in
    releases/*) t="${t#releases/}"; printf '%s\n' "${t%%/*}" ;;
    current/*) printf 'current\n' ;;
  esac
}

# Name of the releases/ tree that `current` points at (empty for a real dir).
_pb_current_tree() {
  local t
  t="$(readlink "$1/current" 2>/dev/null)" || return 0
  t="${t#"$1"/releases/}"; t="${t#releases/}"
  [[ "$t" != /* && -n "$t" ]] && printf '%s\n' "${t%%/*}"
  return 0
}

_pb_has() { printf '%s\n' "$1" | grep -Fxq -- "$2"; }

_pb_epoch() {
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null
}

_pb_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# Every file a process has open or mapped.
_pb_host_files() {
  local pid="$1"
  if [[ -d "/proc/$pid/fd" ]]; then
    { readlink "/proc/$pid/fd/"* 2>/dev/null || true
      awk '$6 ~ /^\// {print $6}' "/proc/$pid/maps" 2>/dev/null || true; }
  else
    lsof -nP -w -Fn -p "$pid" 2>/dev/null | sed -n 's/^n//p' || true
  fi
}

# Epoch the process started, from ps' elapsed time ([[dd-]hh:]mm:ss).
_pb_host_started() {
  local et
  et="$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ')" || return 1
  [[ -n "$et" ]] || return 1
  awk -v now="$(date +%s)" -v e="$et" 'BEGIN {
    d = 0; if (index(e, "-")) { split(e, a, "-"); d = a[1]; e = a[2] }
    n = split(e, t, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + t[i]
    print now - (d * 86400 + s) }'
}

# Pids of running pty-hosts. The bracket keeps awk from matching its own argv.
_pb_host_lines() {
  ps -axo pid=,command= 2>/dev/null | awk -v self="$$" '/pty-host --socke[t]/ && $1 != self'
}

# Protect every build a live pty-host of this install runs. Adds to `protected`
# and sets `unattributable` when a host cannot be tied to a build. Uses the
# caller's locals (install, given, releases, protected, unattributable).
_pb_protect_hosts() {
  local line pid files hit started events winner name rel f
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pid="${line%%[[:space:]]*}"; pid="${pid#"${pid%%[![:space:]]*}"}"
    files="$(_pb_host_files "$pid")"
    local ours=0
    if [[ "$line" == *"$install/"* || "$line" == *"$given/"* ]] || grep -Fq -- "$install/" <<<"$files"; then ours=1; fi
    [[ $ours -eq 1 ]] || { debug "pty-host $pid is not from $install, ignored"; continue; }
    hit=0
    while IFS= read -r f; do
      case "$f" in
        "$install/releases/"*) rel="${f#"$install"/releases/}"; name="${rel%%/*}" ;;
        "$install/current/"*) name="current" ;;
        *) continue ;;
      esac
      [[ "$name" == .* ]] && continue
      protected="$protected"$'\n'"$name"; hit=1
      if [[ "$name" == current ]]; then
        rel="$(_pb_current_tree "$install")"; [[ -n "$rel" ]] && protected="$protected"$'\n'"$rel"
      fi
      log "pty-host $pid still runs $name: keeping it"
    done <<<"$files"
    [[ $hit -eq 1 ]] && continue
    # Nothing of ours is open (node-pty not loaded yet): the build is the one
    # cli.js pointed at when the host started, read off the activation timeline.
    started="$(_pb_host_started "$pid")" || started=""
    events=""
    if [[ -n "$started" ]]; then
      if [[ -f "$releases/.history" ]]; then
        while read -r ts rel _; do
          rel="${rel#releases/}"; name="${rel%%/*}"
          [[ -n "$ts" && -n "$name" ]] || continue
          f="$(_pb_epoch "$ts")" || continue
          events="$events$f $name"$'\n'
        done < "$releases/.history"
      fi
      for f in "$releases"/[0-9]*.[0-9]*.[0-9]*; do
        [[ -d "$f" ]] || continue
        events="$events$(_pb_mtime "$f") ${f##*/}"$'\n'
      done
      winner="$(printf '%s' "$events" | awk -v s="$started" 'NF == 2 && $1 <= s { if ($1 > best || names == "") { best = $1; names = $2 } else if ($1 == best) names = names " " $2 } END { print names }')"
    fi
    if [[ -z "${winner:-}" ]]; then
      unattributable=1
      warn "pty-host $pid: cannot tell which build it runs, so no build is pruned"
      continue
    fi
    for name in $winner; do
      protected="$protected"$'\n'"$name"
      log "pty-host $pid started while $name was active: keeping it"
    done
    winner=""
  done < <(_pb_host_lines)
}

# prune_builds <install dir> <keep>
prune_builds() {
  local given="${1:-}" keep="${2:-2}"
  if [[ ! "$keep" =~ ^[0-9]+$ || "$keep" -lt 1 ]]; then
    err "refusing to prune: bad keep count '$keep'"; return 2
  fi
  if ! _pb_root_ok "$given"; then
    err "refusing to prune: '$given' is not a usable install dir"; return 2
  fi
  if [[ -e "$given" && ! -d "$given" ]]; then
    err "refusing to prune: '$given' is not a directory"; return 2
  fi
  [[ -d "$given" ]] || return 0
  local install releases
  install="$(cd "$given" && pwd -P)" || return 2
  _pb_root_ok "$install" || { err "refusing to prune: '$install' is not a usable install dir"; return 2; }
  releases="$install/releases"
  [[ -d "$releases" ]] || return 0

  local active
  active="$(_pb_active_build "$install")"
  if [[ -z "$active" ]]; then
    warn "cannot read the active build from $install/cli.js, so no build is pruned"
    return 0
  fi

  # Active + (keep - 1) rollback targets: newest history entries that are not
  # the active build (what `deploy:rollback` picks), then newest by mtime.
  local protected="$active" unattributable=0 n=0 b e
  if [[ "$active" == current ]]; then
    b="$(_pb_current_tree "$install")"; [[ -n "$b" ]] && protected="$protected"$'\n'"$b"
  fi
  if [[ -f "$releases/.history" ]]; then
    while IFS= read -r b; do
      [[ $n -lt $((keep - 1)) ]] || break
      b="${b#releases/}"; b="${b%%/*}"
      [[ "$b" == cli.* && -e "$releases/$b" ]] && ! _pb_has "$protected" "$b" || continue
      protected="$protected"$'\n'"$b"; n=$((n + 1))
    done < <(awk 'NF >= 2 { a[NR] = $2 } END { for (i = NR; i >= 1; i--) print a[i] }' "$releases/.history")
  fi
  while IFS= read -r b; do
    [[ $n -lt $((keep - 1)) ]] || break
    [[ "$b" == cli.* && "$b" != *.version ]] && ! _pb_has "$protected" "$b" || continue
    protected="$protected"$'\n'"$b"; n=$((n + 1))
  done < <(ls -t "$releases" 2>/dev/null)

  _pb_protect_hosts
  if [[ $unattributable -eq 1 ]]; then
    return 0
  fi

  for e in "$releases"/cli.*; do
    [[ -e "$e" || -L "$e" ]] || continue
    b="${e##*/}"
    [[ "$b" == *.version ]] && continue
    _pb_has "$protected" "$b" && continue
    _pb_rm "$install" "$e" && _pb_rm "$install" "$e.version" || true
    debug "pruned build $b"
  done
  for e in "$releases"/[0-9]*.[0-9]*.[0-9]*; do
    [[ -e "$e" || -L "$e" ]] || continue
    b="${e##*/}"
    _pb_has "$protected" "$b" && continue
    _pb_rm "$install" "$e" || true
    debug "pruned updater tree $b"
  done
  for e in "$releases"/.tmp/*.tgz; do
    [[ -e "$e" ]] && { _pb_rm "$install" "$e" || true; }
  done
  if [[ -e "$install/current" || -L "$install/current" ]]; then
    b="$(_pb_current_tree "$install")"
    if ! _pb_has "$protected" current && { [[ -z "$b" ]] || ! _pb_has "$protected" "$b"; }; then
      _pb_rm "$install" "$install/current" || true
      debug "pruned $install/current"
    fi
  fi
  return 0
}

# Warn once when update.yaml still lets the updater own this machine.
warn_if_auto_update_enabled() {
  local f="$1/update.yaml"
  [[ -f "$f" ]] || return 0
  if grep -Eq '^[[:space:]]*auto_update:[[:space:]]*true([[:space:]]|#|$)' "$f"; then
    warn "auto_update is true in $f, but deploy.sh owns this machine: set auto_update: false there, or the updater and the deploy script will fight over the install"
  fi
  return 0
}
