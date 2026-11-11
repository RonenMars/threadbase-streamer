#!/usr/bin/env bash
# Decide whether CI can skip, from the diff alone. Usage: ci-skip-gate.sh <base-sha>
# Writes skip=true|false to $GITHUB_OUTPUT. Run from the repo root.
#
# skip=true only when every file changed since <base> matches a pattern in
# .github/ci-skip-paths.txt. Any doubt (no base, failed diff, empty diff,
# missing or empty skip-list) runs CI: a wrong skip puts untested code on main,
# a wrong run costs one CI cycle.
#
# No text in a commit message or PR title is consulted. A tag in prose skipped
# the tests of a code PR once (#522/#563); the diff cannot be talked into that.
set -uo pipefail # no -e: every failure has to reach run_ci, not abort

out="${GITHUB_OUTPUT:-/dev/stdout}"
run_ci() { echo "skip=false" >>"$out"; echo "::notice title=CI runs::$1"; exit 0; }

base="${1:-}"
case "$base" in '' | 0000000000000000000000000000000000000000) run_ci "no base commit to diff against" ;; esac

files="$(git diff --name-only "$base" HEAD)" || run_ci "git diff against $base failed"
[ -n "$files" ] || run_ci "empty diff"

# Strip comments and blanks first: a blank pattern would match every path.
patterns="$(grep -vE '^[[:space:]]*(#|$)' .github/ci-skip-paths.txt 2>/dev/null)" || run_ci "skip-list missing or empty"

significant="$(printf '%s\n' "$files" | grep -vEf <(printf '%s\n' "$patterns"))"
case $? in
  1) echo "skip=true" >>"$out"; echo "::notice title=CI skipped::every changed file matches .github/ci-skip-paths.txt" ;;
  0) run_ci "CI-significant change: $(printf '%s' "$significant" | head -n 3 | tr '\n' ' ')" ;;
  *) run_ci "skip-list match failed" ;;
esac
