#!/usr/bin/env bash
# Resume Threadbase conversations in tmux — one session per agent, one window
# per conversation — using native CLI resume commands.
#
# Reads ~/.threadbase/cache/cache.db (override with THREADBASE_CACHE_DB).
#
# Usage:
#   resume-sessions-tmux.sh <since> [options]
#
# <since> accepts anything Python can parse, plus bare epoch seconds / ms:
#   today | yesterday
#   09:00 | 9:30:00                 # today at that local time
#   2026-09-18
#   2026-09-18 09:00
#   2026-09-18T09:00:00+03:00
#   1789678800000          # epoch ms
#   1789678800             # epoch seconds
#
# Options:
#   --db PATH              cache.db path (default: ~/.threadbase/cache/cache.db)
#   --tz ZONE              timezone for naive datetimes / "today" (default: Asia/Jerusalem)
#   --provider NAME        only this provider (repeatable): claude-code|codex-cli|cursor
#   --include-subagents    include subagent conversations (hidden by default)
#   --project SUBSTR       only conversations whose project_path contains SUBSTR
#   --limit N              max conversations per provider (default: unlimited)
#   --dry-run              print the plan; do not create tmux sessions
#   --attach AGENT         after launch, attach to that tmux session
#                          (claude|codex|cursor|all — default: none)
#   --no-trust             omit `agent --trust` (Cursor only; default is --trust)
#   --kill-live            force-kill all live streamer PTYs before resuming
#                          (POST /api/sessions/:id/kill — SIGKILL, PR #919).
#                          Falls back to /stop (SIGINT) on older streamers.
#                          Still asks for approval unless -y / --yes.
#   -y, --yes              skip interactive approval prompts
#   --streamer-url URL     streamer base URL (default: http://127.0.0.1:8766,
#                          or THREADBASE_STREAMER_URL)
#   --api-key KEY          Bearer token (default: api_key from ~/.threadbase/server.yaml,
#                          or THREADBASE_API_KEY)
#   -h, --help             show this help
#
# Native resume commands (cwd = project_path when present):
#   claude-code  →  claude --resume <id>
#   codex-cli    →  codex resume <id> --cd <project> --no-alt-screen
#   cursor       →  agent --workspace <project> --trust --resume=<id>
#
# If the streamer already owns live PTYs, this script warns and asks what to do
# (kill them, continue anyway, or abort). A second native resume can collide
# (Codex refuses; Claude/Cursor may not).

set -euo pipefail

CACHE_DB="${THREADBASE_CACHE_DB:-${HOME}/.threadbase/cache/cache.db}"
TZ_NAME="${THREADBASE_RESUME_TZ:-Asia/Jerusalem}"
STREAMER_URL="${THREADBASE_STREAMER_URL:-http://127.0.0.1:8766}"
API_KEY="${THREADBASE_API_KEY:-}"
INCLUDE_SUBAGENTS=0
DRY_RUN=0
CURSOR_TRUST=1
KILL_LIVE=0
ASSUME_YES=0
LIMIT=""
ATTACH=""
PROJECT_FILTER=""
PROVIDERS=()

usage() {
  sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

confirm() {
  # Usage: confirm "prompt" — returns 0 on yes. --yes skips the prompt as yes.
  local prompt="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  local reply=""
  printf '%s [y/N] ' "$prompt" >&2
  if ! read -r reply; then
    printf '\n' >&2
    return 1
  fi
  case "${reply}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_api_key() {
  if [[ -n "$API_KEY" ]]; then
    printf '%s' "$API_KEY"
    return 0
  fi
  local yaml="${HOME}/.threadbase/server.yaml"
  [[ -f "$yaml" ]] || return 1
  python3 -c "
import sys
text = open(sys.argv[1]).read()
for line in text.splitlines():
    s = line.strip()
    if s.startswith('api_key:'):
        print(s.split(':', 1)[1].strip().strip('\"').strip(\"'\"))
        raise SystemExit(0)
raise SystemExit(1)
" "$yaml" 2>/dev/null
}

# Print live (non-idle) streamer sessions as: id<US>provider<US>status<US>name<US>project
# Exit 0 even when empty. Exit 2 if the streamer is unreachable / unauthorized.
fetch_live_sessions() {
  local key="$1"
  local url="${STREAMER_URL%/}/api/sessions"
  local body http
  body="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer ${key}" "$url" 2>/dev/null)" || return 2
  http="${body##*$'\n'}"
  body="${body%$'\n'*}"
  [[ "$http" == "200" ]] || return 2
  LIVE_JSON="$body" python3 - <<'PY'
import json, os
sessions = json.loads(os.environ["LIVE_JSON"])
if not isinstance(sessions, list):
    sessions = sessions.get("sessions") or sessions.get("items") or []
live_statuses = {"running", "waiting_input"}
for s in sessions:
    status = s.get("status") or ""
    if status not in live_statuses:
        continue
    sid = s.get("id") or s.get("sessionId") or ""
    provider = s.get("provider") or "?"
    name = s.get("sessionName") or s.get("name") or ""
    project = s.get("projectName") or s.get("project_name") or ""
    # unit separator — same as the conversation query
    print("\x1f".join([sid, provider, status, name, project]))
PY
}

# Tear down a live streamer PTY.
# Prefers POST /kill (SIGKILL, PR #919); falls back to POST /stop (SIGINT) when
# /kill is unavailable (older streamer) or returned a non-success status.
# Prints the endpoint used ("kill" | "stop") on stdout; status messages go to stderr.
kill_live_session() {
  local key="$1" sid="$2"
  local base="${STREAMER_URL%/}/api/sessions/${sid}"
  local http

  http="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer ${key}" "${base}/kill" 2>/dev/null)" || http="000"

  if [[ "$http" == "200" ]]; then
    printf 'kill'
    return 0
  fi

  # /kill missing (old build), session already gone, or transient failure → try /stop.
  http="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer ${key}" "${base}/stop" 2>/dev/null)" || http="000"

  if [[ "$http" == "200" || "$http" == "404" ]]; then
    printf 'stop'
    return 0
  fi

  return 1
}

# ─── args ────────────────────────────────────────────────────────────────────

SINCE_RAW=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --db) CACHE_DB="${2:?}"; shift 2 ;;
    --tz) TZ_NAME="${2:?}"; shift 2 ;;
    --provider) PROVIDERS+=("${2:?}"); shift 2 ;;
    --include-subagents) INCLUDE_SUBAGENTS=1; shift ;;
    --project) PROJECT_FILTER="${2:?}"; shift 2 ;;
    --limit) LIMIT="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --attach) ATTACH="${2:?}"; shift 2 ;;
    --no-trust) CURSOR_TRUST=0; shift ;;
    --kill-live) KILL_LIVE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --streamer-url) STREAMER_URL="${2:?}"; shift 2 ;;
    --api-key) API_KEY="${2:?}"; shift 2 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *)
      if [[ -z "$SINCE_RAW" ]]; then
        SINCE_RAW="$1"
        shift
      else
        # Allow multi-word dates without quoting: 2026-09-18 09:00
        SINCE_RAW+=" $1"
        shift
      fi
      ;;
  esac
done

[[ -n "$SINCE_RAW" ]] || die "missing <since> datetime (see --help)"
[[ -f "$CACHE_DB" ]] || die "cache db not found: $CACHE_DB"

require_cmd sqlite3
require_cmd python3
require_cmd tmux
require_cmd curl

if [[ -z "$API_KEY" ]]; then
  API_KEY="$(resolve_api_key || true)"
fi

# ─── parse since → epoch ms ──────────────────────────────────────────────────

SINCE_MS="$(
  SINCE_RAW="$SINCE_RAW" TZ_NAME="$TZ_NAME" python3 - <<'PY'
import os, re, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

raw = os.environ["SINCE_RAW"].strip()
tz = ZoneInfo(os.environ["TZ_NAME"])
now = datetime.now(tz)

# Bare epoch: 10-digit seconds or 13-digit ms (also tolerate 11–14).
if re.fullmatch(r"\d{10,14}", raw):
    n = int(raw)
    ms = n if n >= 10**12 else n * 1000
    print(ms)
    raise SystemExit(0)

lower = raw.lower()
if lower in ("today", "0:00", "midnight"):
    dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
    print(int(dt.timestamp() * 1000))
    raise SystemExit(0)
if lower == "yesterday":
    dt = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    print(int(dt.timestamp() * 1000))
    raise SystemExit(0)

# Time-only → today at that clock time in TZ_NAME.
m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", raw)
if m:
    h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    if not (0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59):
        print(f"invalid time-of-day: {raw!r}", file=sys.stderr)
        raise SystemExit(2)
    dt = now.replace(hour=h, minute=mi, second=s, microsecond=0)
    print(int(dt.timestamp() * 1000))
    raise SystemExit(0)

candidates = [raw]
# Space → T for ISO-ish strings
if " " in raw and "T" not in raw.upper():
    candidates.append(raw.replace(" ", "T", 1))

parsed = None
for c in candidates:
    try:
        parsed = datetime.fromisoformat(c)
        break
    except ValueError:
        pass

if parsed is None:
    # Last resort: dateutil if installed
    try:
        from dateutil import parser as dateutil_parser  # type: ignore
        parsed = dateutil_parser.parse(raw)
    except Exception as exc:
        print(f"cannot parse datetime: {raw!r} ({exc})", file=sys.stderr)
        raise SystemExit(2)

if parsed.tzinfo is None:
    parsed = parsed.replace(tzinfo=tz)
print(int(parsed.timestamp() * 1000))
PY
)" || die "failed to parse datetime: $SINCE_RAW"

SINCE_HUMAN="$(
  SINCE_MS="$SINCE_MS" TZ_NAME="$TZ_NAME" python3 - <<'PY'
import os
from datetime import datetime
from zoneinfo import ZoneInfo
ms = int(os.environ["SINCE_MS"])
tz = ZoneInfo(os.environ["TZ_NAME"])
print(datetime.fromtimestamp(ms / 1000, tz).isoformat())
PY
)"

# ─── query conversations ─────────────────────────────────────────────────────

PROVIDER_SQL=""
if [[ ${#PROVIDERS[@]} -gt 0 ]]; then
  # Build IN ('a','b') list; normalize cursor-cli → cursor
  in_list=""
  for p in "${PROVIDERS[@]}"; do
    case "$p" in
      cursor-cli) p=cursor ;;
      claude|claude-code) p=claude-code ;;
      codex|codex-cli) p=codex-cli ;;
      cursor) ;;
      *) die "unknown provider: $p (use claude-code|codex-cli|cursor)" ;;
    esac
    in_list+="'${p}',"
  done
  in_list="${in_list%,}"
  PROVIDER_SQL="AND provider IN (${in_list})"
fi

SUBAGENT_SQL="AND IFNULL(is_subagent, 0) = 0"
[[ "$INCLUDE_SUBAGENTS" -eq 1 ]] && SUBAGENT_SQL=""

PROJECT_SQL=""
if [[ -n "$PROJECT_FILTER" ]]; then
  # Escape single quotes for SQL
  esc="${PROJECT_FILTER//\'/\'\'}"
  PROJECT_SQL="AND IFNULL(project_path, '') LIKE '%${esc}%'"
fi

LIMIT_SQL=""
# Per-provider limit applied in awk/python after fetch; SQL limit would cut across providers.

# Unit-separator rows so titles/previews with tabs/newlines cannot break parsing.
QUERY_SQL="
SELECT
  COALESCE(provider, 'claude-code'),
  id,
  COALESCE(project_path, ''),
  COALESCE(project_name, ''),
  REPLACE(REPLACE(REPLACE(
    COALESCE(NULLIF(title, ''), NULLIF(preview, ''), id),
    char(10), ' '), char(13), ' '), char(9), ' '),
  CAST(last_activity AS TEXT),
  CAST(COALESCE(message_count, 0) AS TEXT)
FROM conversation_meta
WHERE last_activity IS NOT NULL
  AND last_activity >= ${SINCE_MS}
  ${PROVIDER_SQL}
  ${SUBAGENT_SQL}
  ${PROJECT_SQL}
ORDER BY provider, last_activity DESC;
"

ROWS="$(sqlite3 -separator $'\x1f' "$CACHE_DB" "$QUERY_SQL")" || die "sqlite query failed"

if [[ -z "${ROWS}" ]]; then
  printf 'No conversations with last_activity >= %s (%s)\n' "$SINCE_HUMAN" "$SINCE_MS"
  exit 0
fi

# Optional per-provider limit
if [[ -n "$LIMIT" ]]; then
  ROWS="$(
    printf '%s\n' "$ROWS" | LIMIT="$LIMIT" python3 -c '
import os, sys
from collections import defaultdict
limit = int(os.environ["LIMIT"])
counts = defaultdict(int)
out = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.strip():
        continue
    provider = line.split("\x1f", 1)[0]
    if counts[provider] >= limit:
        continue
    counts[provider] += 1
    out.append(line)
print("\n".join(out))
'
  )"
fi

# ─── agent → tmux session / resume command ───────────────────────────────────

tmux_session_for() {
  case "$1" in
    claude-code) echo "tb-claude" ;;
    codex-cli)   echo "tb-codex" ;;
    cursor|cursor-cli) echo "tb-cursor" ;;
    *) echo "tb-${1}" ;;
  esac
}

# Sanitize a string into a tmux window name (no dots/colons; length cap).
window_name() {
  local title="$1" id="$2"
  local base
  base="$(printf '%s' "$title" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-28)"
  [[ -n "$base" ]] || base="$(printf '%s' "$id" | cut -c1-8)"
  printf '%s' "$base"
}

# Build the shell command that will run inside the tmux window.
# Args: provider id project_path
resume_cmd() {
  local provider="$1" id="$2" project="$3"
  local qid qproj
  printf -v qid '%q' "$id"
  printf -v qproj '%q' "$project"

  case "$provider" in
    claude-code)
      if [[ -n "$project" ]]; then
        printf 'cd %s && exec claude --resume %s' "$qproj" "$qid"
      else
        printf 'exec claude --resume %s' "$qid"
      fi
      ;;
    codex-cli)
      if [[ -n "$project" ]]; then
        printf 'exec codex resume %s --cd %s --no-alt-screen' "$qid" "$qproj"
      else
        printf 'exec codex resume %s --no-alt-screen' "$qid"
      fi
      ;;
    cursor|cursor-cli)
      local trust_flag=""
      [[ "$CURSOR_TRUST" -eq 1 ]] && trust_flag=" --trust"
      if [[ -n "$project" ]]; then
        printf 'exec agent --workspace %s%s --resume=%s' "$qproj" "$trust_flag" "$qid"
      else
        printf 'exec agent%s --resume=%s' "$trust_flag" "$qid"
      fi
      ;;
    *)
      die "unsupported provider in resume_cmd: $provider"
      ;;
  esac
}

# ─── plan / execute ──────────────────────────────────────────────────────────

printf 'Filter: last_activity >= %s\n' "$SINCE_HUMAN"
printf 'Cache:  %s\n' "$CACHE_DB"
printf '\n'

TOTAL=0
SKIPPED=0
# Lines of conversations we will actually launch (provider\x1fid\x1fproject\x1ftitle)
LAUNCH_ROWS=""

while IFS=$'\x1f' read -r provider id project_path project_name title last_activity message_count; do
  [[ -n "${provider:-}" ]] || continue
  [[ -n "${last_activity:-}" ]] || continue
  TOTAL=$((TOTAL + 1))

  # Normalize legacy alias
  [[ "$provider" == "cursor-cli" ]] && provider=cursor

  sess="$(tmux_session_for "$provider")"
  wname="$(window_name "$title" "$id")"
  cmd="$(resume_cmd "$provider" "$id" "$project_path")"

  last_h="$(
    LAST_MS="$last_activity" TZ_NAME="$TZ_NAME" python3 - <<'PY'
import os
from datetime import datetime
from zoneinfo import ZoneInfo
raw = os.environ["LAST_MS"].strip()
ms = int(float(raw))
tz = ZoneInfo(os.environ["TZ_NAME"])
print(datetime.fromtimestamp(ms / 1000, tz).strftime("%H:%M:%S"))
PY
  )"

  printf '[%s] %s  msgs=%s  %s\n' "$last_h" "$provider" "$message_count" "$id"
  printf '      project: %s\n' "${project_path:-"(none)"}"
  printf '      title:   %s\n' "$title"
  printf '      tmux:    %s → window %s\n' "$sess" "$wname"
  printf '      cmd:     %s\n\n' "$cmd"

  if [[ -n "$project_path" && ! -d "$project_path" ]]; then
    printf '      SKIP: project path missing on disk\n\n' >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  LAUNCH_ROWS+="${provider}"$'\x1f'"${id}"$'\x1f'"${project_path}"$'\x1f'"${title}"$'\n'
done <<< "$ROWS"

printf 'Planned %d conversation(s)' "$TOTAL"
[[ "$SKIPPED" -gt 0 ]] && printf ' (%d skipped)' "$SKIPPED"
printf '.\n'

# ─── live streamer sessions ──────────────────────────────────────────────────

LIVE_ROWS=""
LIVE_FETCH_OK=0
if [[ -n "$API_KEY" ]]; then
  if LIVE_ROWS="$(fetch_live_sessions "$API_KEY")"; then
    LIVE_FETCH_OK=1
  else
    printf '\nWarning: could not list live sessions from %s (is the streamer up? auth ok?)\n' \
      "$STREAMER_URL" >&2
  fi
else
  printf '\nWarning: no API key found — skipping live-session check.\n' >&2
  printf '         Set THREADBASE_API_KEY or pass --api-key / ensure ~/.threadbase/server.yaml.\n' >&2
fi

LIVE_COUNT=0
if [[ -n "$LIVE_ROWS" ]]; then
  LIVE_COUNT="$(printf '%s\n' "$LIVE_ROWS" | grep -c . || true)"
fi

if [[ "$LIVE_COUNT" -gt 0 ]]; then
  printf '\nWARNING: %d live streamer session(s) detected at %s\n' "$LIVE_COUNT" "$STREAMER_URL" >&2
  printf 'Native CLI resume can collide with these PTYs (Codex refuses; Claude/Cursor may not).\n\n' >&2
  while IFS=$'\x1f' read -r sid provider status name project; do
    [[ -n "${sid:-}" ]] || continue
    printf '  [%s] %-14s %-12s %s\n' "$provider" "$status" "${name:-unnamed}" "$sid" >&2
    [[ -n "$project" ]] && printf '           project: %s\n' "$project" >&2
  done <<< "$LIVE_ROWS"
  printf '\n' >&2

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$KILL_LIVE" -eq 1 ]]; then
      printf '(dry-run) would force-kill via POST /api/sessions/:id/kill (SIGKILL; fallback /stop)\n' >&2
    else
      printf '(dry-run) re-run without --dry-run; pass --kill-live to kill them first.\n' >&2
    fi
  else
    if [[ "$KILL_LIVE" -eq 1 ]]; then
      if ! confirm "Force-kill ALL ${LIVE_COUNT} live session(s) (SIGKILL via /kill), then resume in tmux?"; then
        die "aborted — live sessions left running"
      fi
      printf '\nKilling live sessions...\n' >&2
      killed=0
      failed=0
      while IFS=$'\x1f' read -r sid provider status name project; do
        [[ -n "${sid:-}" ]] || continue
        how=""
        if how="$(kill_live_session "$API_KEY" "$sid")"; then
          printf '  %s %-4s %s (%s)\n' "ok" "$how" "$sid" "$provider" >&2
          killed=$((killed + 1))
        else
          printf '  FAILED     %s (%s)\n' "$sid" "$provider" >&2
          failed=$((failed + 1))
        fi
      done <<< "$LIVE_ROWS"
      printf 'Killed %d session(s)' "$killed" >&2
      [[ "$failed" -gt 0 ]] && printf ', %d failed' "$failed" >&2
      printf '.\n\n' >&2
      if [[ "$failed" -gt 0 ]]; then
        if ! confirm "Some kills failed. Continue launching tmux resumes anyway?"; then
          die "aborted after partial kill"
        fi
      fi
    else
      printf 'Pass --kill-live to force-kill them via the streamer (/kill, else /stop) before resuming.\n' >&2
      if ! confirm "Continue WITHOUT killing live sessions (collision risk)?"; then
        die "aborted — re-run with --kill-live to kill live sessions first"
      fi
      printf '\n' >&2
    fi
  fi
elif [[ "$LIVE_FETCH_OK" -eq 1 ]]; then
  printf '\nNo live streamer sessions.\n'
elif [[ "$KILL_LIVE" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
  die "--kill-live requested but live sessions could not be listed from ${STREAMER_URL}"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Dry run — no tmux sessions created.\n'
  exit 0
fi

if [[ -z "$LAUNCH_ROWS" ]]; then
  printf 'Nothing to launch.\n'
  exit 0
fi

declare -A SESSION_CREATED=()

while IFS=$'\x1f' read -r provider id project_path title; do
  [[ -n "${provider:-}" ]] || continue
  sess="$(tmux_session_for "$provider")"
  wname="$(window_name "$title" "$id")"
  cmd="$(resume_cmd "$provider" "$id" "$project_path")"

  if [[ -z "${SESSION_CREATED[$sess]:-}" ]]; then
    if tmux has-session -t "=$sess" 2>/dev/null; then
      SESSION_CREATED[$sess]=1
    else
      tmux new-session -d -s "$sess" -n "$wname" "$cmd"
      SESSION_CREATED[$sess]=1
      continue
    fi
  fi

  if tmux list-windows -t "=$sess" -F '#{window_name}' 2>/dev/null | grep -qx "$wname"; then
    wname="${wname}_$(printf '%s' "$id" | cut -c1-6)"
  fi

  tmux new-window -t "=$sess" -n "$wname" "$cmd"
done <<< "$LAUNCH_ROWS"

printf '\nTmux sessions:\n'
for sess in tb-claude tb-codex tb-cursor; do
  if tmux has-session -t "=$sess" 2>/dev/null; then
    n="$(tmux list-windows -t "=$sess" 2>/dev/null | wc -l | tr -d ' ')"
    printf '  %s  (%s window(s))  —  tmux attach -t %s\n' "$sess" "$n" "$sess"
  fi
done

case "$ATTACH" in
  "") ;;
  claude) tmux attach -t tb-claude ;;
  codex)  tmux attach -t tb-codex ;;
  cursor) tmux attach -t tb-cursor ;;
  all)
    for sess in tb-claude tb-codex tb-cursor; do
      if tmux has-session -t "=$sess" 2>/dev/null; then
        tmux attach -t "$sess"
        break
      fi
    done
    ;;
  *) die "--attach expects claude|codex|cursor|all" ;;
esac
