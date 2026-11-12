#!/usr/bin/env bash
# Build codegraph's native extraction kernel (codegraph-kernel, Rust + napi) in
# Docker, for a machine with no cargo, and stage it where the loader looks:
#   <checkout>/codegraph-kernel/prebuilds/linux-x64/codegraph-kernel.node
# Then confirm it loads, so an issue can say "reproduced with the native kernel".
#
# Usage: tools/build-kernel-docker.sh <codegraph checkout with dist/ built>
# Env:   KERNEL_IMAGE  build image (default rust:1.90-slim-bookworm; glibc 2.36, so the
#                      .so also loads on newer hosts)
#        KERNEL_CACHE  cargo registry cache (default ~/.cache/graph-assay/oracle/cargo)
# Build output (target/) stays in the crate dir, which the kernel's .gitignore ignores.
set -euo pipefail
[ $# -eq 1 ] || { sed -n '7p' "$0"; exit 2; }
co=$(cd "$1" && pwd)
crate=$co/codegraph-kernel
[ -f "$crate/Cargo.toml" ] || { echo "no codegraph-kernel/ in $co" >&2; exit 1; }
[ -f "$co/dist/bin/codegraph.js" ] || { echo "build $co first (npm run build)" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "only linux-x64 is wired up" >&2; exit 1; }
image=${KERNEL_IMAGE:-rust:1.90-slim-bookworm}
cache=${KERNEL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/graph-assay/oracle/cargo}
mkdir -p "$cache"

echo "[kernel] cargo build --release in $image"
docker run --rm --init -u "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cargo -v "$cache:/cargo" -v "$crate:/src" -w /src \
  "$image" cargo build --release --locked

dest=$crate/prebuilds/linux-x64
mkdir -p "$dest"
rm -f "$dest/codegraph-kernel.node"
cp "$crate/target/release/libcodegraph_kernel.so" "$dest/codegraph-kernel.node"
echo "[kernel] staged $dest/codegraph-kernel.node ($(du -h "$dest/codegraph-kernel.node" | cut -f1))"

# Load check: index a two-file TS project with the kernel debug log on.
probe=$(mktemp -d -p "${TMPDIR:-/tmp}" kernel-probe.XXXXXX)
trap 'rm -rf "${probe:?}"' EXIT
mkdir -p "$probe/home" "$probe/p"
printf 'export function f() { return g(); }\nexport function g() { return 1; }\n' > "$probe/p/a.ts"
log=$(cd "$probe/p" && HOME=$probe/home CODEGRAPH_NO_TELEMETRY=1 CODEGRAPH_KERNEL_DEBUG=1 \
  node "$co/dist/bin/codegraph.js" init -y 2>&1) || { echo "$log" | tail -5; exit 1; }
echo "$log" | grep '\[codegraph-kernel\]' | head -5
if echo "$log" | grep -q '\[codegraph-kernel\].*\(loaded\|using\)'; then
  echo "[kernel] OK: the kernel loaded"
else
  echo "[kernel] the kernel did NOT load; see the debug lines above" >&2; exit 1
fi
