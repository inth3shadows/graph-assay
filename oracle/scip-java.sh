#!/usr/bin/env bash
# SCIP-index a Java/Kotlin repo with scip-java, inside the pinned Docker image.
# scip-java BUILDS the project (Maven/Gradle), which runs the project's own
# build plugins: keep it in the container, as your uid, with only the repo
# mounted. Usage: scip-java.sh <repo dir>   (writes <repo>/index.scip)
set -euo pipefail
repo=$(cd "$1" && pwd)
image=sourcegraph/scip-java:0.12.3
nice -n 10 docker run --rm -v "$repo":/sources -w /sources --user "$(id -u):$(id -g)" -e HOME=/tmp \
  "$image" scip-java index --output /sources/index.scip
