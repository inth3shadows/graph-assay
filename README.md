# graph-assay

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![Node 22.13–24](https://img.shields.io/badge/node-22.13%E2%80%9324-339933.svg) [![ci](https://github.com/inth3shadows/graph-assay/actions/workflows/ci.yml/badge.svg)](https://github.com/inth3shadows/graph-assay/actions/workflows/ci.yml)

Accuracy testing for the code graphs AI agents query. graph-assay finds wrong and missing edges in a
code-graph tool by checking its graph against the compiler, helps turn each confirmed finding into a
minimal repro for an upstream issue (minimizing is a manual step today), and scores tools on a
published spec ([SPEC.md](SPEC.md)).

A code-graph tool (an MCP server or CLI that answers "who calls this?", "what breaks if I change
this?") is only as good as its edges. A call linked to the wrong definition makes every answer
built on it confidently wrong, and these defects rarely show up in the tool's own test suite.

**Status.** SPEC v1.0 is frozen. Two tools are measured:
[codegraph](https://github.com/colbymchenry/codegraph) and
[code-graph-rag](https://github.com/vitali87/code-graph-rag). The compiler oracle covers
TypeScript/JavaScript, Python, Go and the JVM (Java and Kotlin). The fixture corpus holds 42 codegraph
repros, 38 of which reproduce an issue filed upstream, plus 4 for code-graph-rag. Benchmark tables
are not published yet: each tool's maintainers see their results first.

**Intent.** graph-assay is built for tool maintainers first. Run it on a pull request, replay the
fixtures before a release, and file what it finds. The tables are the reporting layer, not the
product. It stays neutral: no tool is scored against itself, every subject goes through the same
adapter contract, and the scoring rules are versioned.

## How It Works

Every check compares a tool's graph with something independent and reports where they disagree:

- **Compiler oracle** (`oracle/`): the tool's call edges against a SCIP index of the same checkout,
  produced by the language's real type checker (scip-typescript, scip-python, scip-go, scip-java).
  Each disagreement is joined at the exact call site and sorted by cause, for example "linked a
  project method where the compiler resolves a library method". Missing-edge mode runs it the
  other way: calls the compiler resolves that the tool never links.
- **Fixtures** (`fixtures/`): minimal repros of confirmed bugs, each with an `expect.json` naming the
  wrong edge and the right one. Replaying them against a build says which bugs it still has.
- **Metamorphic checks** (`metamorphic/`): change a repo in a way that must not change its graph
  (add decoy files nothing imports, shift every line down, index twice) and diff the graphs.
- **Differentials** (`differential/`): the same source under each execution mode a tool documents
  as equivalent (native vs WASM, worker counts, incremental sync), two builds of a tool on a pinned
  corpus, and the agent-facing answers (`callers`, `explore`) of two builds.
- **Benchmarks and tables** (`benchmarks/`, `bench/`): the PyCG micro-benchmark, plus tables that
  score call sites and (caller, callee) pairs with confidence intervals and an oracle-noise
  estimate from a blind-labelled sample (`labels/`).
- **Triage** (`bench/triage.mjs`): ranks a tool's bug shapes by how many headline points they
  cost, and matches them to fixtures already filed.

Tools plug in through one adapter per subject (`lib/subjects/`). The adapter indexes a directory in
a sandbox and exports a graph snapshot (`schema/snapshot.v1.json`). The scorers read only
snapshots, so a new tool needs a new adapter, not new scorers.

## Prerequisites

- Node 22.13 to 24 (the codegraph adapter uses `node:sqlite`; codegraph does not build on Node 25+) and `git`.
- Python 3 for code-graph-rag (3.12 on x86_64 gets the hash-locked install), Go on PATH for Go repos,
  Docker for `scip-java`. `node bin/graph-assay setup` installs the rest.
- Docker, for the pinned end-to-end reproduction (`Dockerfile`, `tools/repro.mjs`).

## Quick Start

Everything runs through `bin/graph-assay` (`bin/graph-assay help` lists the commands; `bin/cgqa` is a
deprecated alias).

1. Check graph-assay itself (what CI runs; no tool build needed): `npm ci --ignore-scripts` (the type checker, a dev dependency), then `node bin/graph-assay check`.
2. Install the SCIP indexers and build both tools at their pinned versions, where graph-assay looks
   for them: `node bin/graph-assay setup` (`--dry-run` shows the steps; `--codegraph <commit>` builds
   another commit; `--no-cgr` and friends skip parts).
3. Replay the fixtures: `node bin/graph-assay replay default`. Each fixture prints
   BROKEN, FIXED, GUESSED or CHANGED next to its upstream issue number.
4. Run the oracle on any repo you have checked out:
   `node bin/graph-assay oracle <name> <path to repo> <ts|python|go|jvm>`. Add
   `CGQA_SUBJECT=code-graph-rag` to measure the other tool (environment variables keep the prefix
   from the project's old name, codegraph-qa).
5. Rank what it found: `node bin/graph-assay triage`. To explain one call site, use
   `node bin/graph-assay site <name> <file:line>`.

`node bin/graph-assay config` prints every resolved path. Each can be overridden by an environment
variable or `~/.config/graph-assay/config.json`.

## Project Structure

| Path | Purpose |
|---|---|
| `bin/graph-assay` | The command-line entry point |
| `SPEC.md` | Scoring semantics: units, tracks, equivalences, verdicts, failure policy |
| `lib/` | Shared code: paths (`config.mjs`), the snapshot contract, one adapter per tool (`subjects/`), SCIP reading, fixture expectations, run manifests, adapter conformance |
| `schema/` | JSON Schemas for snapshots and fixture expectations |
| `oracle/` | The compiler oracle, per-language SCIP wrappers, and self-tests with a mutation pass (`oracle/test/`) |
| `fixtures/` | Bug repros: `oracle-candidates/` (codegraph), `cgr-candidates/` (code-graph-rag) |
| `metamorphic/`, `differential/` | Graph-must-not-change checks, execution-mode and build-vs-build diffs |
| `corpus/` | The preregistered public corpus: pinned commits, licenses, dev / held-out split |
| `benchmarks/`, `bench/` | Third-party benchmark scorers, tables, robustness and triage |
| `labels/` | Blind labelling of call sites for the oracle-noise estimate |
| `conformance/` | Awkward-case sources for the adapter conformance check |
| `docker/`, `Dockerfile`, `tools/` | Pinned reproduction, and build/setup scripts |

## Related Documentation

- [Usage Guide](USAGE.md): what each workflow is for and how to read the results
- [Technical Reference](TECHNICAL.md): architecture, every file, configuration, reproduction, limits
- [SPEC.md](SPEC.md): what is scored and how
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md) (graph-assay indexes untrusted code; read before running it on a repo), [AGENTS.md](AGENTS.md) (for coding agents)

<!-- docvet:anchors
CGQA_SUBJECT -> oracle/run.sh
--dry-run -> tools/setup.sh
cgr-candidates -> fixtures/replay.mjs
node:sqlite -> lib/subjects/codegraph.mjs
-->
