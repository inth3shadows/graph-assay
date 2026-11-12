#!/usr/bin/env bash
# Run oracle/run.sh for every line of a targets file, one repo at a time.
# Usage: oracle/run-all.sh [targets file]   (default oracle/targets.txt; see oracle/targets.example.txt)
# Line format: <name> <src repo> <ts|python|go|jvm> [ts project dirs...]; `~` expands; `#` comments.
# A repo whose oracle (SCIP) fails is reported and skipped; exit 1 if any did, 2 on a bad targets file.
# A subject failure is not one: run.sh scores it as misses (SPEC §8) and exits 0.
# ORACLE_LOG_DIR=<dir>: each repo's output goes to <dir>/<name>.txt instead of stdout.
here=$(cd "$(dirname "$0")" && pwd)
targets=${1:-$here/targets.txt}
[ -r "$targets" ] || { echo "run-all: no readable targets file: $targets (copy oracle/targets.example.txt)" >&2; exit 2; }
fail=0
# `|| [ -n "$name" ]` keeps a last line that has no trailing newline.
while read -r name src lang rest || [ -n "$name" ]; do
  case $name in ''|\#*) continue;; esac
  src=${src/#\~/$HOME}
  echo "== $name $(date -u +%T)"
  # shellcheck disable=SC2086 # project dirs are word-split on purpose
  if [ -n "${ORACLE_LOG_DIR:-}" ]; then
    # shellcheck disable=SC2086
    "$here/run.sh" "$name" "$src" "$lang" $rest < /dev/null > "$ORACLE_LOG_DIR/$name.txt" 2>&1 || { fail=$((fail + 1)); echo "$name: FAILED (see its log)"; }
  else
    "$here/run.sh" "$name" "$src" "$lang" $rest < /dev/null || fail=$((fail + 1))
  fi
done < "$targets"
echo "DONE, $fail failed"
[ "$fail" -gt 0 ] && exit 1
exit 0
