#!/usr/bin/env bash
# Read-only probe: for every running agent CLI (Claude Code, Codex, Cursor,
# Copilot), print what the process exposes that could map its PID to a
# session id. Used to design the PID → session-id lookups in
# src/services/sessions/processSessionIds.ts.
#
#   bash scripts/probe-agent-sessions.sh > probe.txt
#
# It changes nothing. Environment VALUES are printed only for variables whose
# name looks like a session/conversation/chat id; every other variable is
# listed by name alone, so API keys and tokens never reach the output. Review
# the file before sharing it anyway: it contains local paths.
set -u

HOME_DIR="${HOME}"
STATE_DIRS=("$HOME_DIR/.claude" "$HOME_DIR/.codex" "$HOME_DIR/.cursor" "$HOME_DIR/.copilot")
ID_VARS='SESSION|CONVERSATION|CHAT|THREAD'
AGENT_EXES='claude|codex|cursor-agent|agent|copilot'
# JS runtimes hosting an agent's published entry point (npm installs).
AGENT_SCRIPTS='claude-code/(cli|index)\.|@github/copilot|cursor-agent'

have() { command -v "$1" >/dev/null 2>&1; }

section() { printf '\n==== %s ====\n' "$*"; }

env_of() {
  # Linux: /proc. macOS: `ps -E` shows the environment of your own processes.
  local pid=$1
  if [[ -r "/proc/$pid/environ" ]]; then
    tr '\0' '\n' <"/proc/$pid/environ"
  elif [[ "$(uname)" == "Darwin" ]]; then
    ps -E -ww -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | grep -E '^[A-Z_][A-Z0-9_]*='
  fi
}

print_env() {
  local pid=$1 label=$2
  local vars
  vars=$(env_of "$pid" | grep -E '^[A-Z_][A-Z0-9_]*=' || true)
  [[ -z "$vars" ]] && { echo "  $label env: (not readable)"; return; }
  echo "  $label env, agent-related names:"
  echo "$vars" | cut -d= -f1 | grep -E 'CLAUDE|CODEX|CURSOR|COPILOT|GITHUB|GH_' | sort -u | sed 's/^/    /'
  echo "  $label env, id-like values:"
  echo "$vars" | grep -E "^[A-Z0-9_]*(${ID_VARS})[A-Z0-9_]*=" | grep -vE 'TOKEN|KEY|SECRET|PASSWORD' | sed 's/^/    /'
}

section "system"
uname -a
date -u +"%Y-%m-%dT%H:%M:%SZ"
for bin in claude codex cursor-agent agent copilot; do
  if have "$bin"; then printf '%-13s %s  (%s)\n' "$bin" "$(command -v "$bin")" "$("$bin" --version 2>/dev/null | head -1)"; fi
done

section "agent processes"
# Match on the executable (argv[0]), never on any mention in the arguments.
PIDS=()
while read -r pid exe rest; do
  base=${exe##*/}
  if [[ "$base" =~ ^(${AGENT_EXES})$ ]] ||
    { [[ "$base" =~ ^(node|bun|deno)$ ]] && [[ "$rest" =~ ${AGENT_SCRIPTS} ]]; }; then
    PIDS+=("$pid")
  fi
done < <(ps -eo pid=,args=)
if [[ ${#PIDS[@]} -eq 0 ]]; then echo "none running — start the agents you want probed, then re-run"; fi

for pid in "${PIDS[@]}"; do
  section "pid $pid"
  echo "  args:    $(ps -o args= -p "$pid" 2>/dev/null | cut -c1-300)"
  echo "  started: $(ps -o lstart= -p "$pid" 2>/dev/null)"
  if have lsof; then
    echo "  cwd:     $(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    echo "  open files under agent state dirs:"
    lsof -a -p "$pid" -Fn -w 2>/dev/null | sed -n 's/^n//p' | grep -E '/\.(claude|codex|cursor|copilot)/' | sort -u | sed 's/^/    /'
  fi
  print_env "$pid" "own"
  # Child processes (shells, MCP servers, hooks) can carry the id the parent exports.
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    echo "  child $child: $(ps -o args= -p "$child" 2>/dev/null | cut -c1-120)"
    print_env "$child" "child $child"
  done
  reg="$HOME_DIR/.claude/sessions/$pid.json"
  if [[ -f "$reg" ]]; then echo "  claude registry ($reg):"; sed 's/^/    /' "$reg"; echo; fi
done

section "claude registry entries (~/.claude/sessions) and liveness"
for f in "$HOME_DIR"/.claude/sessions/*.json; do
  [[ -f "$f" ]] || continue
  pid=$(basename "$f" .json)
  if kill -0 "$pid" 2>/dev/null; then state=alive; else state=dead; fi
  echo "  $state  $f"
  sed 's/^/      /' "$f"; echo
done

section "recently written files in agent state dirs (last 15 minutes)"
for d in "${STATE_DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  echo "  $d:"
  find "$d" -type f -mmin -15 -not -path '*/node_modules/*' 2>/dev/null | head -40 | sed 's/^/    /'
done

section "state dir layout (top two levels)"
for d in "$HOME_DIR/.cursor" "$HOME_DIR/.copilot"; do
  [[ -d "$d" ]] || continue
  echo "  $d:"
  find "$d" -maxdepth 2 -not -path '*/node_modules/*' 2>/dev/null | head -60 | sed 's/^/    /'
done
