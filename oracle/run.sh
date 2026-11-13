#!/usr/bin/env bash
# Index one repo with codegraph and with SCIP, then run the oracle on the pair.
# Usage: oracle/run.sh <name> <src repo> <ts|python|go|jvm> [ts project dirs...]
#   go:  scip-go at the repo root (needs go.mod there and `go` on PATH)
#   jvm: scip-java in Docker (oracle/scip-java.sh); it BUILDS the project (Maven/Gradle)
#
# The repo is cloned at its HEAD commit (uncommitted changes are not seen).
# SCIP indexes are cached by (name, HEAD sha, language, project dirs, SCIP tool
# version), so a re-run against a new codegraph build only re-indexes codegraph.
#
# Env:
#   CGQA_SUBJECT       subject to test: codegraph (default) or code-graph-rag; work dir w-<name>[-<subject>]
#   CODEGRAPH_BUILD    codegraph.js to test   (default: lib/config.ts codegraphBuild)
#   CGQA_BUILD         a non-codegraph subject's build (default: the subject's own)
#   ORACLE_WORK        work dirs, w-<name>/   (default ${XDG_CACHE_HOME:-~/.cache}/graph-assay/oracle/work)
#   ORACLE_SCIP_CACHE  cached .scip files     (default ${XDG_CACHE_HOME:-~/.cache}/graph-assay/oracle/scip)
#   ORACLE_TOOLS       scip-typescript/python/go install (default: lib/config.ts tools)
#   ORACLE_SHOW        top groups to print per candidate bucket (default 3)
#   ORACLE_REDACT=1    for code that must not leave this machine: the oracle prints only
#                      bucket counts, and a failure names its log instead of printing it
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,3p' "$0"; exit 2; }
name=$1 src=$(cd "$2" && pwd) lang=$3; shift 3
qa=$(cd "$(dirname "$0")/.." && pwd)
cfg() { node "$qa/lib/config.ts" "$1"; }
subject=${CGQA_SUBJECT:-codegraph}
if [ "$subject" = codegraph ]; then build=$(cfg codegraphBuild); w=$(cfg work)/w-$name
else build=${CGQA_BUILD:-$(node "$qa/lib/subjects/index.ts" "$subject" default-build)}; w=$(cfg work)/w-$name-$subject; fi
tools=$(cfg tools)
scip_cache=$(cfg scipCache)
[ -f "$build" ] || { echo "$name: no build at $build" >&2; exit 1; }
case $lang in ts|python|go|jvm) ;; *) echo "$name: language must be ts, python, go or jvm" >&2; exit 2;; esac
export CODEGRAPH_KERNEL=${CODEGRAPH_KERNEL:-0} CODEGRAPH_NO_TELEMETRY=1 NODE_NO_WARNINGS=1
logtail() { if [ "${ORACLE_REDACT:-}" = 1 ]; then echo "  (log withheld: $1)"; else tail -5 "$1"; fi; }

rm -rf "$w"; mkdir -p "$w/home" "$scip_cache"
git clone -q --no-hardlinks "$src" "$w/repo"
sha=$(git -C "$w/repo" rev-parse HEAD)
cd "$w/repo"
# scip-typescript needs the dependencies' types; borrow the source checkout's node_modules.
for d in . "$@"; do
  if [ -d "$src/$d/node_modules" ] && [ ! -e "$d/node_modules" ]; then ln -s "$src/$d/node_modules" "$d/node_modules"; fi
done

# index.time: wall seconds and peak RSS (KB) of the subject's index, for the resource columns (SPEC §7)
# GNU time only (BSD time, as on macOS, rejects -f, which would fail every index).
timer=(); /usr/bin/time -f '' true 2>/dev/null && timer=(/usr/bin/time -f '%e %M' -o "$w/index.time")
# SPEC §8: a subject that times out, crashes, exits non-zero or writes an invalid snapshot fails this
# repository. That is a result, not a harness error: the oracle still runs, against an empty snapshot,
# so every SCIP call site is a miss with the oracle's own denominator, and both outputs record
# `subjectFailed`. Only an oracle (SCIP) failure stops the run.
failed=""
CGQA_NICE=1 ${timer[@]+"${timer[@]}"} node "$qa/lib/subjects/index.ts" "$subject" index . "$build" > "$w/init.log" 2>&1 || failed="index exited $?"
# The oracle exports codegraph's store itself; any other subject hands it a snapshot
# (writeSnapshot refuses an invalid one).
if [ -z "$failed" ] && [ "$subject" != codegraph ]; then
  node "$qa/lib/subjects/index.ts" "$subject" snapshot . "$w/snapshot.json" "$build" > "$w/snapshot.log" 2>&1 || failed="snapshot failed"
fi
if [ -n "$failed" ]; then
  echo "$name: $subject FAILED ($failed); scored as misses (SPEC §8)"; logtail "$w/init.log"
  node --input-type=module -e "import { writeSnapshot, SNAPSHOT_SCHEMA } from '$qa/lib/snapshot.ts';
    writeSnapshot(process.argv[1], { schema: SNAPSHOT_SCHEMA, subject: { name: process.argv[2] },
      capabilities: { siteLines: true, siteColumns: false, unresolved: true, provenance: true }, files: [], nodes: [], edges: [], unresolved: [] });" \
    "$w/snapshot.json" "$subject"
  export ORACLE_SUBJECT_FAILED=$failed
fi
if [ -n "$failed" ] || [ "$subject" != codegraph ]; then export ORACLE_SNAPSHOT=$w/snapshot.json; fi

case $lang in
  ts) tool_ver=$(node -p "require('$tools/node_modules/@sourcegraph/scip-typescript/package.json').version");;
  python) tool_ver=$(node -p "require('$tools/node_modules/@sourcegraph/scip-python/package.json').version");;
  go) tool_ver=$("$tools/scip-go" --version 2>&1 | head -1);;
  jvm) tool_ver=$(grep -o 'scip-java:[0-9.]*' "$qa/oracle/scip-java.sh");;
esac
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# SPEC §7: the oracle covers every tracked TS/JS file, not only those a tsconfig includes. A repo with
# a root tsconfig.json is indexed through oracle/ts-cover.ts's project (at the repo root, untracked,
# extending that tsconfig, listing every tracked TS/JS file; removed after indexing). Project dirs given
# on the command line are indexed as given.
projects=("$@"); cover=
if [ "$lang" = ts ] && [ $# -eq 0 ] && [ -f tsconfig.json ]; then
  cover=tracked-files-2
  projects=("$(node "$qa/oracle/ts-cover.ts" . 2> "$w/ts-cover.log")")
fi
key=$(printf '%s\n' "$name" "$sha" "$lang" "$*" "$tool_ver" "$(sha256 "$qa/oracle/scip-python.sh" | cut -c1-12)" $cover | sha256 | cut -c1-16)
scip=$scip_cache/$name-${sha:0:12}-$key.scip
if [ -s "$scip" ]; then
  echo "$name: SCIP cache hit (${sha:0:12}, $lang $tool_ver)"
elif [ "$lang" = ts ]; then
  # a plain-JS project (no tsconfig / jsconfig, e.g. express) gets an inferred one
  infer=(); for d in "${@:-.}"; do [ -f "$d/tsconfig.json" ] || [ -f "$d/jsconfig.json" ] || infer=(--infer-tsconfig); done
  nice -n 10 node --max-old-space-size=6000 "$tools/node_modules/.bin/scip-typescript" index ${projects[@]+"${projects[@]}"} ${infer[@]+"${infer[@]}"} --output "$scip.tmp" > "$w/scip.log" 2>&1 \
    || { echo "$name: scip-typescript FAILED"; logtail "$w/scip.log"; rm -f "$scip.tmp"; exit 1; }
  mv "$scip.tmp" "$scip"
elif [ "$lang" = go ]; then
  nice -n 10 "$tools/scip-go" --output "$scip.tmp" > "$w/scip.log" 2>&1 \
    || { echo "$name: scip-go FAILED"; logtail "$w/scip.log"; rm -f "$scip.tmp"; exit 1; }
  mv "$scip.tmp" "$scip"
elif [ "$lang" = jvm ]; then
  # scip-java writes <repo>/index.scip; index a throwaway copy so the build's output stays out of $w/repo.
  rm -rf "$w/jvm-build"; cp -a "$w/repo" "$w/jvm-build"; rm -rf "$w/jvm-build/.codegraph"
  bash "$qa/oracle/scip-java.sh" "$w/jvm-build" > "$w/scip.log" 2>&1 \
    || { echo "$name: scip-java FAILED"; logtail "$w/scip.log"; exit 1; }
  mv "$w/jvm-build/index.scip" "$scip"; rm -rf "$w/jvm-build"
else
  bash "$qa/oracle/scip-python.sh" "$w/repo" "$scip.tmp" > "$w/scip.log" 2>&1 \
    || { echo "$name: scip-python FAILED"; logtail "$w/scip.log"; rm -f "$scip.tmp"; exit 1; }
  mv "$scip.tmp" "$scip"
fi
# The covering project is untracked scaffolding: take it out of the checkout before scoring.
[ -z "$cover" ] || rm -f "${projects[0]}"

case $lang in python|go|jvm) export ORACLE_LANG=$lang;; esac
ORACLE_ALLSITES=1 ORACLE_SHOW=${ORACLE_SHOW:-3} node "$qa/oracle/oracle.ts" "$w/repo" "$scip" "$w/out.json"
# The inverse check, quietly: its buckets go to out-missing.json (and into baselines).
ORACLE_ALLSITES=1 ORACLE_MODE=missing ORACLE_SHOW=0 node "$qa/oracle/oracle.ts" "$w/repo" "$scip" "$w/out-missing.json" > "$w/missing.txt"
echo "$name: full results in $w/out.json, missing-edge buckets in $w/out-missing.json"
