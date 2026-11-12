#!/usr/bin/env bash
# SCIP-index a Python repo with its own packages resolvable: index a copy of
# the tracked files with a pyrightconfig.json adding `src/` (and the root) to
# extraPaths and pointing at the repo's .venv when it has one, so a src-layout
# package's imports resolve instead of becoming unresolved locals.
# Usage: scip-python.sh <repo dir> <out.scip>
set -euo pipefail
repo=$(cd "$1" && pwd)
out=$2
tools=$(node "$(cd "$(dirname "$0")/.." && pwd)/lib/config.mjs" tools)
work=$(mktemp -d -p "${TMPDIR:-/tmp}" scip-py.XXXXXX)
trap 'rm -rf "${work:?}"' EXIT
(cd "$repo" && git ls-files -z) | rsync -a --from0 --files-from=- "$repo/" "$work/"
venv_line=''
if [ -d "$repo/.venv" ]; then venv_line="\"venvPath\": \"$repo\", \"venv\": \".venv\","; fi
cat > "$work/pyrightconfig.json" <<EOF
{ $venv_line "extraPaths": ["src", "."] }
EOF
cd "$work"
nice -n 10 "$tools/node_modules/.bin/scip-python" index . --project-name "$(basename "$repo")" --project-version 0 --output "$out"
