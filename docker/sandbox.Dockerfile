# The docker isolation backend of lib/sandbox.ts: an empty Ubuntu 24.04 userland for running a subject's
# host install (mounted read-only at its host path) with no network. Ubuntu 24.04 because the subjects
# are built on it: codebase-memory-mcp's release binary needs glibc 2.38, and the Python venvs that
# tools/setup.sh makes point at /usr/bin/python3.12. git: code-review-graph and code-graph-rag call it.
# Build: tools/setup.sh (or docker build -t graph-assay-sandbox:1 -f docker/sandbox.Dockerfile docker).
FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5
RUN apt-get update && apt-get install -y --no-install-recommends python3.12 git \
  && rm -rf /var/lib/apt/lists/*
