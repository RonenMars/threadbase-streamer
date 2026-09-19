#!/usr/bin/env bash
# Smoke-test the BUILT CLI (dist/cli.cjs) in a throwaway HOME on a spare port,
# so it cannot touch the real ~/.threadbase, ~/.claude, or a running prod.
#
# Run `npm run build` first. Nothing here runs the vitest suite — this is the
# one check that boots the bundled artifact, which is what deploys.
#
# Usage:
#   scripts/smoke-isolated.sh
#
# Environment:
#   SMOKE_PORT   port to bind (default 8799; never use the prod port 8766)
#
# Checks: /healthz answers, an unauthenticated API call is 401, a fixture
# transcript is scanned into the cache and listed, and its detail returns 200.
# Then it stops the server, scans the log for errors, and deletes the HOME.
#
# Exit: 0 pass, 1 a check failed, 2 could not run (not built / port busy).
#
# HOME is redirected because os.homedir() follows $HOME, which moves the config
# dir, runtime.db, cache and the ~/.claude scanner root together. The temp dir is
# under /tmp, not $TMPDIR, to keep unix socket paths under macOS's 104-byte cap.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-8799}"
FIXTURE=__tests__/fixtures/providers/claude-code/2.1.214/conversation.jsonl

[ -f dist/cli.cjs ] || { echo "SMOKE ABORT: dist/cli.cjs missing — run npm run build"; exit 2; }
[ -f "$FIXTURE" ] || { echo "SMOKE ABORT: fixture $FIXTURE missing"; exit 2; }
# bash's /dev/tcp: a successful connect means something already holds the port.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "SMOKE ABORT: port $PORT is already in use"; exit 2
fi

# The id the scanner reports comes from the transcript's own sessionId.
ID=$(grep -m1 -o '"sessionId": *"[^"]*"' "$FIXTURE" | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$ID" ] || { echo "SMOKE ABORT: no sessionId in $FIXTURE"; exit 2; }

S=$(mktemp -d /tmp/tbs.XXXXXX)
KEY="tb_$(openssl rand -hex 16)"
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; fi
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$S/.threadbase" "$S/.claude/projects/-tmp-smoke"
chmod 700 "$S/.threadbase"
printf 'api_key: %s\nbrowse_root: %s\n' "$KEY" "$S" > "$S/.threadbase/server.yaml"
chmod 600 "$S/.threadbase/server.yaml"
cp "$FIXTURE" "$S/.claude/projects/-tmp-smoke/$ID.jsonl"

# No --prod and no --replace-prod: with the port free, serve never touches launchd.
HOME="$S" "$(command -v node)" dist/cli.cjs serve --port "$PORT" --verbose > "$S/out.log" 2>&1 &
PID=$!

fail=0
check() { # check <label> <ok: 0|1>
  if [ "$2" = 0 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi
}
api() { curl -s -m 5 -H "Authorization: Bearer $KEY" "$@"; }

for _ in $(seq 1 30); do curl -fs -m 2 "localhost:$PORT/healthz" > /dev/null 2>&1 && break; sleep 1; done
HEALTH=$(curl -s -m 5 "localhost:$PORT/healthz")
echo "$HEALTH" | grep -q '"ok":true'; check "healthz answers ($HEALTH)" $?

CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "localhost:$PORT/api/conversations")
[ "$CODE" = 401 ]; check "no-auth /api/conversations is 401 (got $CODE)" $?

sleep 3 # let the watcher scan the fixture into the cache
api "localhost:$PORT/api/conversations" | grep -q "\"id\":\"$ID\""; check "fixture $ID is listed" $?

CODE=$(api -o /dev/null -w '%{http_code}' "localhost:$PORT/api/conversations/$ID")
[ "$CODE" = 200 ]; check "conversation detail is 200 (got $CODE)" $?

kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""
ERRS=$(grep -aiE "error|ENOENT|unhandled|cannot find" "$S/out.log" | head -5)
[ -z "$ERRS" ]; check "no errors in server log" $?
[ -z "$ERRS" ] || echo "$ERRS" | sed 's/^/       /'
# The log lives in the temp HOME that is deleted on exit, so surface it now.
# JSON lines only: the boot banner above them prints a pairing URL and token.
[ "$fail" = 0 ] || { echo "--- last server log lines:"; grep -a '^{' "$S/out.log" | tail -n 15 | cut -c1-200; }

if [ "$fail" = 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL"; fi
exit "$fail"
