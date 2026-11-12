# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Scoring rules are versioned separately in
[SPEC.md](SPEC.md).

## [Unreleased]

### Added
- Fixtures `issue-3271` (an import of a package the manifest doesn't list but `node_modules` holds,
  linked to an unrelated project export) and `issue-3271-copied-sibling` (its control: a sibling
  package copied into `node_modules` keeps its edge). Both carry their own `node_modules`, which
  `.gitignore` now lets these two fixtures commit.
- Type checking of `lib/` as JavaScript (`tsc --noEmit` with `allowJs` + `checkJs`), run by
  `graph-assay check`, which now needs `npm ci --ignore-scripts` first and fails without it. Dev
  dependencies only, pinned: `typescript` 6.0.3 (Apache-2.0) and `@types/node` 22.20.5 (MIT); the
  runtime still has no npm dependencies. First phase of the TypeScript migration (#14).

### Changed
- `adapterSha256` for the codegraph adapter changes: a JSDoc annotation in
  `lib/subjects/codegraph.mjs` changes the hashed bytes, not the behaviour. Fixture replay output is
  identical apart from the hash.

## [0.1.0] - 2026-11-12

First public release of graph-assay, previously developed privately as codegraph-qa.

### Added
- Compiler oracle (forward and missing-edge modes) for TypeScript/JavaScript, Python, Go and the
  JVM, with self-tests and a rule-mutation pass.
- Subject adapters for codegraph and code-graph-rag behind the snapshot v1 contract.
- Fixture corpora of confirmed bugs (`fixtures/oracle-candidates`, `fixtures/cgr-candidates`) and
  their replay, with anonymous canary repeats.
- Metamorphic checks (decoy, line shift, repeat), execution-mode and build-vs-build differentials,
  and the agent-facing answer diff.
- SPEC v1.0 scoring: call-site and function-pair tracks, the PyCG micro-benchmark, robustness (T3),
  oracle-noise labelling protocol, tables and triage.
- Pinned Docker reproduction of the dev tables.
- `graph-assay setup`: the SCIP tools and a pinned build of each subject in one command (`--dry-run` to preview). The npm tools install from the reproduction's lockfile; code-graph-rag needs the hash-locked install unless `--unlocked` is passed.
- `baseline diff --fail-on-incomplete`; hermetic adapter, CLI, relation and labelling-leak tests; shellcheck in `check`.
- `SECURITY.md` (threat model for indexing untrusted code), `AGENTS.md` and `llms.txt`.

### Security
- codegraph indexes with an allowlisted environment and, where `unshare -rn` works, without network,
  as code-graph-rag already did.
- Labellers refuse to run outside a declared sandbox (`GRAPH_ASSAY_LABEL_SANDBOX=1` or
  `--unsafe-host`), get a minimal environment, and `check` scans committed labelling files for home
  paths and credentials.
- CI actions are pinned to commit SHAs, with checkout credentials not persisted.

### Fixed
- Every CLI works from a checkout path with spaces or symlinks (it used to exit 0 doing nothing).
- A fixture whose caller is missing from the graph reads CHANGED, not FIXED.
- code-graph-rag's adapter wrote its export to the wrong place when given a relative directory.
- `oracle/run-all.sh` exits 2 on a missing targets file and runs a last line without a newline.
- `replay` and `tag-fixtures` reject unknown fixture names; `tag-fixtures` no longer overwrites good
  tags with failed ones; `check` refuses to run outside a git checkout instead of skipping checks.
- Unknown `ORACLE_LANG` values, missing option values and malformed `config.json` are reported,
  not silently ignored. Spawn failures name their cause.
- The metamorphic line shift keeps a byte-order mark first; the oracle escapes names it puts in
  regular expressions (a `$`-prefixed member such as `$http` can now match its noise rule).
- Bootstrap intervals ignore draws without a rate; `modes` reports dangling edges and failed
  snapshots per mode instead of crashing.

### Changed
- Renamed from codegraph-qa: the command is `graph-assay` (`cgqa` remains as a deprecated alias),
  schema ids are `graph-assay/*@1`, and caches and config live under `graph-assay`.
- The build-diff workflow builds from `colbymchenry/codegraph` by default, with the repository as
  an input.

[Unreleased]: https://github.com/inth3shadows/graph-assay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/inth3shadows/graph-assay/releases/tag/v0.1.0
