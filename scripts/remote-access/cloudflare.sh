#!/usr/bin/env bash
# scripts/remote-access/cloudflare.sh
#
# Cloudflare quick-tunnel onboarding for @threadbase-sh/streamer.
#
# 1. Verify cloudflared is installed; if not, print platform-correct install
#    hint and exit non-zero.
# 2. Start a throwaway HTTP server on a free port serving success.html.
# 3. Start `cloudflared tunnel --url http://127.0.0.1:<that-port>`.
# 4. Parse the *.trycloudflare.com URL out of cloudflared's stderr.
# 5. Print it big, prompt the user to open it on their phone.
# 6. On confirmation (or Ctrl-C), tear down tunnel + HTTP server cleanly.
#
# Emits a line-prefixed protocol on stdout so the Go TUI wrapper can render
# progress without parsing free-form text:
#   STATUS: <human-readable step>
#   URL:    <trycloudflare URL>
#   PROMPT: <yes/no question>      (script reads y/n from stdin)
#   DONE:   <ok|aborted|error>
#
# Plain humans see those same lines — they're meant to be readable both ways.

set -euo pipefail

# ---------------------------------------------------------------------------
# Protocol helpers
# ---------------------------------------------------------------------------

emit_status() { printf 'STATUS: %s\n' "$1"; }
emit_url()    { printf 'URL: %s\n' "$1"; }
emit_prompt() { printf 'PROMPT: %s\n' "$1"; }
emit_done()   { printf 'DONE: %s\n' "$1"; }
emit_err()    { printf 'STATUS: ERROR: %s\n' "$1" >&2; }

# ---------------------------------------------------------------------------
# Cleanup — trapped on EXIT so it runs on success, Ctrl-C, and errors alike
# ---------------------------------------------------------------------------

TUNNEL_PID=""
HTTP_PID=""
TUNNEL_LOG=""

cleanup() {
  local exit_code=$?
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    emit_status "stopping cloudflared (pid $TUNNEL_PID)"
    kill "$TUNNEL_PID" 2>/dev/null || true
    # cloudflared usually exits in <1s on SIGTERM; give it a moment
    for _ in 1 2 3 4 5; do
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$HTTP_PID" ]] && kill -0 "$HTTP_PID" 2>/dev/null; then
    emit_status "stopping success-page server (pid $HTTP_PID)"
    kill "$HTTP_PID" 2>/dev/null || true
    kill -9 "$HTTP_PID" 2>/dev/null || true
  fi
  if [[ -n "$TUNNEL_LOG" && -f "$TUNNEL_LOG" ]]; then
    rm -f "$TUNNEL_LOG"
  fi
  return "$exit_code"
}
trap cleanup EXIT
trap 'emit_done aborted; exit 130' INT TERM

# ---------------------------------------------------------------------------
# 1. Dependency check
# ---------------------------------------------------------------------------

emit_status "checking cloudflared is installed"

if ! command -v cloudflared >/dev/null 2>&1; then
  emit_err "cloudflared not found on PATH"
  cat >&2 <<'EOF'

cloudflared is the Cloudflare Tunnel client. Install it, then re-run this script.

  macOS:     brew install cloudflared
  Linux:     see https://pkg.cloudflare.com/cloudflared/ (apt/dnf repos)
  Windows:   winget install --id Cloudflare.cloudflared
             (or use the .ps1 sibling: pwsh ./cloudflare.ps1)

EOF
  emit_done error
  exit 1
fi

emit_status "cloudflared found: $(cloudflared --version 2>&1 | head -n1)"

# ---------------------------------------------------------------------------
# 2. Pick a free local port for the success-page server
# ---------------------------------------------------------------------------

# Try a small range above the streamer's default port to keep things tidy.
pick_free_port() {
  local p
  for p in 8767 8768 8769 8770 8771 8772 8773 8774 8775 8776; do
    if ! { exec 3<>"/dev/tcp/127.0.0.1/$p"; } 2>/dev/null; then
      echo "$p"; return 0
    fi
    exec 3>&- 2>/dev/null || true
  done
  # Fallback: ask the kernel for any free port via python.
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])' 2>/dev/null && return 0
  return 1
}

HTTP_PORT="$(pick_free_port || true)"
if [[ -z "$HTTP_PORT" ]]; then
  emit_err "couldn't find a free local port in 8767-8776 (and python3 fallback failed)"
  emit_done error
  exit 1
fi
emit_status "success page will be served on http://127.0.0.1:$HTTP_PORT"

# ---------------------------------------------------------------------------
# 3. Start the success-page HTTP server
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUCCESS_HTML="$SCRIPT_DIR/success.html"

if [[ ! -f "$SUCCESS_HTML" ]]; then
  emit_err "success.html missing at $SUCCESS_HTML"
  emit_done error
  exit 1
fi

start_http_server() {
  # Preferred: python3's http.server (cwd = script dir so success.html resolves)
  if command -v python3 >/dev/null 2>&1; then
    (cd "$SCRIPT_DIR" && python3 -m http.server "$HTTP_PORT" --bind 127.0.0.1) \
      >/dev/null 2>&1 &
    HTTP_PID=$!
    return 0
  fi
  # Fallback: a tiny bash-only HTTP server (handles `/` and `/success.html`).
  serve_inline_loop &
  HTTP_PID=$!
}

# Minimal fallback HTTP server using only bash + ncat-or-nc.
# Loops accepting one connection at a time. Good enough for an onboarding flow.
serve_inline_loop() {
  local body content_length
  body="$(cat "$SUCCESS_HTML")"
  content_length=${#body}
  local response
  printf -v response 'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
    "$content_length" "$body"
  while true; do
    if command -v ncat >/dev/null 2>&1; then
      printf '%s' "$response" | ncat -l 127.0.0.1 "$HTTP_PORT" >/dev/null 2>&1 || true
    elif command -v nc >/dev/null 2>&1; then
      # macOS nc and BSD nc differ on -l semantics; this works on both.
      printf '%s' "$response" | nc -l 127.0.0.1 "$HTTP_PORT" >/dev/null 2>&1 || true
    else
      sleep 1
    fi
  done
}

emit_status "starting success-page server"
start_http_server

# Verify it's actually accepting connections
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:$HTTP_PORT/success.html" -o /dev/null 2>/dev/null \
     || curl -sf "http://127.0.0.1:$HTTP_PORT/" -o /dev/null 2>/dev/null; then
    break
  fi
  if [[ $i -eq 10 ]]; then
    emit_err "success-page server failed to start on port $HTTP_PORT"
    emit_done error
    exit 1
  fi
  sleep 0.3
done

# ---------------------------------------------------------------------------
# 4. Launch cloudflared quick-tunnel pointed at the success-page server
# ---------------------------------------------------------------------------

TUNNEL_LOG="$(mktemp -t threadbase-cloudflared.XXXXXX)"
emit_status "starting cloudflared quick-tunnel (logs: $TUNNEL_LOG)"

# cloudflared writes the URL to stderr; combine and let us tail it.
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$HTTP_PORT" \
  >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# ---------------------------------------------------------------------------
# 5. Wait for the trycloudflare URL to appear in the logs
# ---------------------------------------------------------------------------

TUNNEL_URL=""
for i in $(seq 1 60); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    emit_err "cloudflared exited early — last log lines:"
    tail -n 20 "$TUNNEL_LOG" >&2 || true
    emit_done error
    exit 1
  fi
  if grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" \
       | head -n1 > /tmp/.threadbase-tunnel-url.$$; then
    TUNNEL_URL="$(cat /tmp/.threadbase-tunnel-url.$$ || true)"
    rm -f /tmp/.threadbase-tunnel-url.$$
    if [[ -n "$TUNNEL_URL" ]]; then break; fi
  fi
  sleep 0.5
done

if [[ -z "$TUNNEL_URL" ]]; then
  emit_err "cloudflared did not print a trycloudflare URL within 30s"
  tail -n 20 "$TUNNEL_LOG" >&2 || true
  emit_done error
  exit 1
fi

emit_url "$TUNNEL_URL"
emit_status "tunnel is up"

# ---------------------------------------------------------------------------
# 6. Banner + prompt
# ---------------------------------------------------------------------------

cat <<EOF

╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🎉  YOUR QUICK-TUNNEL IS LIVE                                ║
║                                                                ║
║   $TUNNEL_URL
║                                                                ║
║   Open that URL on your phone (any browser).                   ║
║   You should see a green "You made it!" page.                  ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝

EOF

emit_prompt "Did the success page load on your phone? [y/N]"
read -r answer || answer=""

case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
  y|yes)
    emit_status "round-trip confirmed — tearing down"
    emit_done ok
    ;;
  *)
    emit_status "round-trip not confirmed — tearing down anyway"
    emit_done aborted
    ;;
esac
