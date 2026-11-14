# linux/amd64 only: the wheel lock and SCIP release checksums target that platform.
# Pins and provenance: TECHNICAL.md, "Docker reproduction".
FROM --platform=linux/amd64 python:3.12.12-bookworm@sha256:c0abd0758831ad99b7a29e0c1a875da9c4abb9a2e3f21e2eeb585dbcadfb6cd0 AS python
FROM --platform=linux/amd64 golang:1.25.4-bookworm@sha256:e17419604b6d1f9bc245694425f0ec9b1b53685c80850900a376fb10cb0f70cb AS go
FROM --platform=linux/amd64 node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844

# A dated Debian archive pins the complete apt dependency closure.
RUN rm -f /etc/apt/sources.list.d/* && \
    printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20251118T000000Z bookworm main\n' > /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends rsync time util-linux && \
    rm -rf /var/lib/apt/lists/*
COPY --from=python /usr/local/ /usr/local/
COPY --from=go /usr/local/go/ /usr/local/go/
ENV PATH="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin" \
    CODEGRAPH_BUILD=/opt/codegraph/dist/bin/codegraph.js \
    CODEGRAPH_KERNEL=0 CODEGRAPH_NO_TELEMETRY=1 DO_NOT_TRACK=1 NODE_NO_WARNINGS=1 \
    ORACLE_TOOLS=/opt/oracle-tools SCIP_BIN=/opt/oracle-tools/scip \
    CGQA_SUBJECTS=/opt/subjects GOTOOLCHAIN=local

COPY docker/package*.json /opt/oracle-tools/
RUN cd /opt/oracle-tools && npm ci --ignore-scripts --no-audit --no-fund
RUN curl -fsSL https://github.com/scip-code/scip-go/releases/download/v0.2.8/scip-go-linux-amd64.tar.gz -o /tmp/scip-go.tgz && \
    echo '22d6d55b85341c650e92fc278a62cc4c57dc5800c386e199c2b999f8605dd32a  /tmp/scip-go.tgz' | sha256sum -c - && \
    tar -xzf /tmp/scip-go.tgz -C /opt/oracle-tools scip-go && \
    curl -fsSL https://github.com/scip-code/scip/releases/download/v0.10.0/scip-linux-amd64.tar.gz -o /tmp/scip.tgz && \
    echo 'eeb28ebbff443c01609fb1691809958f3f0c7a8651af689a5bc8560061cd8ab0  /tmp/scip.tgz' | sha256sum -c - && \
    tar -xzf /tmp/scip.tgz -C /opt/oracle-tools scip && rm /tmp/scip*.tgz
COPY docker/requirements.lock /opt/requirements.lock
RUN python3 -m venv /opt/subjects/cgr/venv && \
    /opt/subjects/cgr/venv/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r /opt/requirements.lock

RUN git init -q /opt/codegraph && \
    git -C /opt/codegraph fetch -q --depth 1 https://github.com/colbymchenry/codegraph.git f72c9d2efb14454ff4f9fd7b8460abd82f19a287 && \
    git -C /opt/codegraph checkout -q --detach FETCH_HEAD && \
    cd /opt/codegraph && npm ci --no-audit --no-fund && npm run build

WORKDIR /opt/graph-assay
COPY . .
ENTRYPOINT ["node", "tools/repro.ts"]
