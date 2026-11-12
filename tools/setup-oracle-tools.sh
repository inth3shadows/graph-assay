#!/usr/bin/env bash
# Install the oracle's pinned SCIP tools into ORACLE_TOOLS (idempotent):
#   scip-typescript 0.5.2 and scip-python 0.6.8 (npm), and the scip CLI v0.10.0
#   (sourcegraph/scip release, sha256-checked) as $ORACLE_TOOLS/scip, and scip-go v0.2.8
#   (go install, when `go` is on PATH) as $ORACLE_TOOLS/scip-go. scip-java runs from its Docker image.
# Usage: tools/setup-oracle-tools.sh      Env: ORACLE_TOOLS (default: lib/config.mjs tools)
set -euo pipefail
qa=$(cd "$(dirname "$0")/.." && pwd)
tools=$(node "$qa/lib/config.mjs" tools)
# The same pins the Docker reproduction uses (docker/package-lock.json, Dockerfile checksums).
SCIP_LINUX_AMD64_SHA256=eeb28ebbff443c01609fb1691809958f3f0c7a8651af689a5bc8560061cd8ab0
TS=0.5.2 PY=0.6.8 SCIP=v0.10.0 GO=v0.2.8
mkdir -p "$tools"; cd "$tools"
[ -f package.json ] || echo '{"name":"graph-assay-oracle-tools","private":true}' > package.json
have() { node -p "try{require('./node_modules/@sourcegraph/$1/package.json').version}catch{''}"; }
if [ "$(have scip-typescript)" != "$TS" ] || [ "$(have scip-python)" != "$PY" ]; then
  # The locked tree, not whatever the registry resolves today: local scores match the reproduction's.
  cp "$qa/docker/package.json" "$qa/docker/package-lock.json" "$tools/"
  npm ci --ignore-scripts --no-audit --no-fund
fi
# Version checks read the output into a variable: `cmd | grep -q` under pipefail can fail on SIGPIPE.
if [[ "$(./scip --version 2>/dev/null || true)" != *"$SCIP"* ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) asset=scip-darwin-arm64 ;; Darwin-x86_64) asset=scip-darwin-amd64 ;;
    Linux-x86_64) asset=scip-linux-amd64 ;; Linux-aarch64) asset=scip-linux-arm64 ;;
    *) echo "no scip release for $(uname -sm)" >&2; exit 1 ;;
  esac
  tmp=$(mktemp -d -p "${TMPDIR:-/tmp}" scip-dl.XXXXXX); trap 'rm -rf "${tmp:?}"' EXIT
  base=https://github.com/sourcegraph/scip/releases/download/$SCIP
  curl -fsSL --retry 3 --max-time 300 -o "$tmp/$asset.tar.gz" "$base/$asset.tar.gz"
  if [ "$asset" = scip-linux-amd64 ]; then want=$SCIP_LINUX_AMD64_SHA256
  else
    # No pinned checksum for this platform: the release's own .sha256 only proves the download is intact.
    echo "setup-oracle-tools: no pinned checksum for $asset; verifying against the release's .sha256" >&2
    curl -fsSL --retry 3 --max-time 60 -o "$tmp/sum" "$base/$asset.tar.gz.sha256"
    want=$(awk '{print $1}' "$tmp/sum")
  fi
  got=$( (command -v sha256sum >/dev/null && sha256sum "$tmp/$asset.tar.gz" || shasum -a 256 "$tmp/$asset.tar.gz") | awk '{print $1}')
  [ "$want" = "$got" ] || { echo "scip checksum mismatch: $got != $want" >&2; exit 1; }
  tar -xzf "$tmp/$asset.tar.gz" -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name scip | head -1)" "$tools/scip"
fi
if command -v go >/dev/null && [[ "$(./scip-go --version 2>/dev/null || true)" != *"${GO#v}"* ]]; then
  GOBIN=$tools GOFLAGS=-mod=mod go install "github.com/scip-code/scip-go/cmd/scip-go@$GO"
fi
go_ver=$( [ -x ./scip-go ] && ./scip-go --version 2>&1 | head -1 || echo 'scip-go: not installed (no go)')
echo "tools ok: scip-typescript $(have scip-typescript), scip-python $(have scip-python), $(./scip --version | head -1), $go_ver"
