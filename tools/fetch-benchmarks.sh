#!/usr/bin/env bash
# Fetch the third-party call-graph benchmarks at pinned commits (not vendored).
# Usage: tools/fetch-benchmarks.sh   -> ${XDG_CACHE_HOME:-~/.cache}/graph-assay/oracle/bench/<name>
#   pycg  PyCG micro-benchmark (Apache-2.0), scored by benchmarks/pycg.ts
# The checkouts are data: nothing in them is run.
set -euo pipefail
bench=${XDG_CACHE_HOME:-$HOME/.cache}/graph-assay/oracle/bench
mkdir -p "$bench"
fetch() { # name url sha
  local d=$bench/$1
  [ -d "$d/.git" ] || git clone -q --filter=blob:none "$2" "$d"
  git -C "$d" fetch -q origin "$3" 2>/dev/null || true
  git -C "$d" -c advice.detachedHead=false checkout -q "$3"
  echo "$1: $(git -C "$d" rev-parse --short HEAD) in $d"
}
fetch pycg https://github.com/vitsalis/PyCG.git 8d5dc40837803beef1d8d379fbf2cdad6cd94641
