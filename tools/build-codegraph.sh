#!/usr/bin/env bash
# Build upstream codegraph at a commit (wasm path; no kernel) into <dir>.
# Usage: tools/build-codegraph.sh <sha> <dir>     Prints the codegraph.js path last.
# Needs Node 20-24 on PATH (codegraph refuses Node 25+). Env: CODEGRAPH_REPO (clone URL).
set -euo pipefail
[ $# -eq 2 ] || { sed -n '3p' "$0"; exit 2; }
sha=$1 dir=$2
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] && [ "$major" -lt 25 ] || { echo "node $(node --version) on PATH; codegraph needs 20-24" >&2; exit 1; }
[ -d "$dir/.git" ] || git clone -q --filter=blob:none "${CODEGRAPH_REPO:-https://github.com/colbymchenry/codegraph.git}" "$dir"
# Fetch the commit itself, not just branches, so a commit only a PR (or a fork PR) holds resolves.
git -C "$dir" fetch -q origin "$sha" 2>/dev/null || git -C "$dir" fetch -q origin
git -C "$dir" checkout -q --detach "$sha"
if [ "$(cat "$dir/.built-sha" 2>/dev/null)" != "$(git -C "$dir" rev-parse HEAD)" ]; then
  (cd "$dir" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  git -C "$dir" rev-parse HEAD > "$dir/.built-sha"
fi
echo "$dir/dist/bin/codegraph.js"
