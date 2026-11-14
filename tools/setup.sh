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

# Every platform gate runs before the first install, so an unsupported part fails fast instead of
# after the other parts have installed.
locked=0
if [ "$do_cgr" = 1 ]; then
  [ "$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')" = 3.12 ] && [ "$(uname -m)" = x86_64 ] && locked=1
  if [ "$locked" != 1 ] && [ "$unlocked" != 1 ]; then
    echo "setup: the hash-locked code-graph-rag install needs Python 3.12 on x86_64; pass --unlocked to install $CGR_VERSION with floating dependencies, or --no-cgr" >&2
    exit 1
  fi
fi
if [ "$do_cbm" = 1 ] && [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
  echo "setup: codebase-memory-mcp is pinned for linux-amd64 only; pass --no-cbm on $(uname -s)-$(uname -m)" >&2
  exit 1
fi
# code-review-graph's lock was resolved for Python 3.11+ (3.10 also needs tomli, which it does not
# list) and holds no Windows-only dependencies.
if [ "$do_crg" = 1 ]; then
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || ! case $(uname -s) in Linux|Darwin) true;; *) false;; esac; then
    echo "setup: the hash-locked code-review-graph install needs Python 3.11+ on Linux or macOS; pass --no-crg" >&2
    exit 1
  fi
fi

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
  # code-review-graph 2.4.0, core only; the lock pins every dependency with all of its wheel hashes.
  # Each lock gets its own fresh venv (installing over an old one would keep packages the lock does
  # not list), and `venv` is switched to it only after pip succeeds, so a failed install keeps the
  # working one. A venv cannot be renamed (its scripts name their interpreter by path), hence the link.
  crg=$subjects/code-review-graph
  if command -v sha256sum >/dev/null; then lockid=$(sha256sum "$qa/docker/crg-requirements.lock" | cut -c1-12)
  else lockid=$(shasum -a 256 "$qa/docker/crg-requirements.lock" | cut -c1-12); fi
  target=$crg/venv-$lockid
  step "code-review-graph 2.4.0 -> $crg/venv (-> venv-$lockid)"
  if [ "$(readlink "$crg/venv" 2>/dev/null)" = "venv-$lockid" ] && "$target/bin/code-review-graph" --version >/dev/null 2>&1; then
    echo "  already installed from this lock"
  else
    run rm -rf "$target"
    run mkdir -p "$crg"
    run python3 -m venv "$target"
    run "$target/bin/pip" install -q --only-binary=:all: --require-hashes -r "$qa/docker/crg-requirements.lock"
    # an older install may be a plain directory; replace it only now that the new one works
    if [ -d "$crg/venv" ] && [ ! -L "$crg/venv" ]; then run rm -rf "$crg/venv"; fi
    run ln -sfn "venv-$lockid" "$crg/venv"
  fi
fi
step "done; check with: node $qa/bin/graph-assay config"
