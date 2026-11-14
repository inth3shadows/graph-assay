#!/usr/bin/env bash
# One-command setup: the oracle's SCIP tools and a build of each subject, where lib/config.ts looks.
# Usage: tools/setup.sh [--codegraph <commit>] [--no-codegraph] [--no-cgr] [--no-cbm] [--no-crg] [--no-scip] [--unlocked] [--dry-run]
#   --codegraph  codegraph commit to build (default: the Docker reproduction's pin)
#   --no-*       skip that part; --dry-run prints the steps and changes nothing
#   --unlocked   allow code-graph-rag without the hash lock (any Python but 3.12 on x86_64): its
#                dependencies then float, so scores may differ from the reproduction's
# Needs node 20-24 and git; python3 (3.12 for the hash-locked code-graph-rag install); go for scip-go.
set -euo pipefail
qa=$(cd "$(dirname "$0")/.." && pwd)
CG_PIN=f72c9d2efb14454ff4f9fd7b8460abd82f19a287 CGR_VERSION=0.5.0
# codebase-memory-mcp release binary (linux-amd64 only); sha256 from the release's checksums.txt
CBM_VERSION=0.12.1 CBM_SHA256=8453015145f072c1b9b019cbdd02cea8cc6f18cc5e116036dd20992631c638c7
cg=$CG_PIN do_cg=1 do_cgr=1 do_cbm=1 do_crg=1 do_scip=1 dry=0 unlocked=0
while [ $# -gt 0 ]; do
  case $1 in
    --codegraph) [ $# -ge 2 ] || { sed -n '3,7p' "$0"; exit 2; }; cg=$2; shift 2;;
    --no-codegraph) do_cg=0; shift;;
    --no-cgr) do_cgr=0; shift;;
    --no-cbm) do_cbm=0; shift;;
    --no-crg) do_crg=0; shift;;
    --no-scip) do_scip=0; shift;;
    --dry-run) dry=1; shift;;
    --unlocked) unlocked=1; shift;;
    *) sed -n '3,7p' "$0"; exit 2;;
  esac
done
subjects=$(node "$qa/lib/config.ts" subjects)
step() { echo "setup: $*"; }
run() { if [ "$dry" = 1 ]; then echo "  would run: $*"; else "$@"; fi; }

if [ "$do_scip" = 1 ]; then
  step "SCIP tools -> $(node "$qa/lib/config.ts" tools)"
  run "$qa/tools/setup-oracle-tools.sh"
fi
if [ "$do_cg" = 1 ]; then
  step "codegraph $cg -> $subjects/codegraph"
  run "$qa/tools/build-codegraph.sh" "$cg" "$subjects/codegraph"
fi
if [ "$do_cgr" = 1 ]; then
  venv=$subjects/cgr/venv
  locked=0
  [ "$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')" = 3.12 ] && [ "$(uname -m)" = x86_64 ] && locked=1
  if [ "$locked" != 1 ] && [ "$unlocked" != 1 ]; then
    echo "setup: the hash-locked code-graph-rag install needs Python 3.12 on x86_64; pass --unlocked to install $CGR_VERSION with floating dependencies, or --no-cgr" >&2
    exit 1
  fi
  step "code-graph-rag $CGR_VERSION -> $venv"
  run python3 -m venv "$venv"
  if [ "$locked" = 1 ]; then
    run "$venv/bin/pip" install -q --only-binary=:all: --require-hashes -r "$qa/docker/requirements.lock"
  else
    echo "setup: --unlocked: installing code-graph-rag $CGR_VERSION with floating dependencies" >&2
    run "$venv/bin/pip" install -q "code-graph-rag[treesitter-full]==$CGR_VERSION"
  fi
fi
if [ "$do_cbm" = 1 ]; then
  if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
    echo "setup: codebase-memory-mcp is pinned for linux-amd64 only; pass --no-cbm on $(uname -s)-$(uname -m)" >&2
    exit 1
  fi
  dest=$subjects/codebase-memory-mcp
  step "codebase-memory-mcp $CBM_VERSION -> $dest"
  if [ "$dry" = 1 ]; then
    echo "  would run: download v$CBM_VERSION linux-amd64, check sha256 $CBM_SHA256, extract the binary"
  else
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    curl -fsSL --retry 3 --max-time 300 -o "$tmp/cbm.tar.gz" \
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v$CBM_VERSION/codebase-memory-mcp-linux-amd64.tar.gz"
    got=$(sha256sum "$tmp/cbm.tar.gz" | awk '{print $1}')
    [ "$got" = "$CBM_SHA256" ] || { echo "setup: codebase-memory-mcp checksum mismatch: got $got" >&2; exit 1; }
    mkdir -p "$dest"
    tar xzf "$tmp/cbm.tar.gz" -C "$dest" codebase-memory-mcp LICENSE
  fi
fi
if [ "$do_crg" = 1 ]; then
  # code-review-graph 2.4.0, core only; the lock pins every dependency with all of its wheel hashes
  venv=$subjects/code-review-graph/venv
  step "code-review-graph 2.4.0 -> $venv"
  run python3 -m venv "$venv"
  run "$venv/bin/pip" install -q --only-binary=:all: --require-hashes -r "$qa/docker/crg-requirements.lock"
fi
step "done; check with: node $qa/bin/graph-assay config"
