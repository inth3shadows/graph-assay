# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Scoring rules are versioned separately in
[SPEC.md](SPEC.md).

## [Unreleased]

### Added
- Fixture `issue-3271` for colbymchenry/codegraph#3271: an import of a package that `package.json`
  doesn't list but `node_modules` holds links to an unrelated project export of the same name.
- A fixture whose bug depends on installed packages keeps them in `node_modules.fixture/`. Every copy
  a subject indexes (replay, metamorphic, `builds`, `modes`, `shadow`, labeller qualification,
  tag-fixtures) puts it in place as `node_modules`, so ignore files and copy filters that drop
  `node_modules` leave it alone. The labeller's own copy still hides installed packages.
- Type checking of `lib/` as JavaScript (`tsc --noEmit` with `allowJs` + `checkJs`), run by
  `graph-assay check`, which now needs `npm ci --ignore-scripts` first and fails without it. Dev
  dependencies only, pinned: `typescript` 6.0.3 (Apache-2.0) and `@types/node` 22.20.5 (MIT); the
  runtime still has no npm dependencies. First phase of the TypeScript migration (#14). The type
  check runs last and prints every diagnostic, then one verdict line: it counts type and config errors
  separately and says when tsc failed with no diagnostics or was cut short. It refuses a missing or
  stale install, or an unreadable lockfile, with a FAIL line. It passes `--noEmit` on the command line,
  so even an unparseable `tsconfig.json` writes no `.js`. `npm run typecheck` runs the same check,
  install guards included, and passes extra arguments on to tsc.
- `check` step labels print flags as given, also when `check` runs from another directory. A failing
  step shows its last 40 lines, not 8, and says how many earlier lines it left out.

### Changed
- `lib/` is TypeScript: every `lib/**/*.mjs` is now `.ts`, run by Node's type stripping with no build
  step, so the Node floor is 22.18 (`engines.node`: `>=22.18.0 <25`). `lib/types.ts` types the
  snapshot and expectation schemas once, and the scorers and adapters import it. Callers outside
  `lib/` stay `.mjs` and import the `.ts` paths. Behaviour is unchanged: fixture replay gives the same
  per-site results, and the adapter goldens are byte-identical. Second phase of #14.
- `adapterSha256` changes for both adapters, because the hashed files are renamed to `.ts` and
  retyped. Results recorded before this change carry the old hashes.
- The type check asks tsc itself for the chain of configs `tsconfig.json` extends: relative, absolute
  and package `extends`, JSONC, and past a recoverable syntax error. Errors in any of those configs
  count as config errors, not type errors. It looks up the chain only when tsc fails (#26).
- When the type check crashes on a module that does not parse, the crash line names that file and
  line, not a Node-internal frame. `check` sets the exit code instead of calling `process.exit()`, so
  piped output is not cut off (#26).
- `adapterSha256` for the codegraph adapter changes: a JSDoc annotation in
  `lib/subjects/codegraph.mjs` changes the hashed bytes, not the behaviour. Fixture replay output is
  identical apart from the hash.

### Fixed
- Fixture replay no longer scores a fixed route-caller fixture `CHANGED` (#29). The check that a
  fixture's caller is in the graph compared the last part of `from` with node names only, and a
  codegraph route node is named `GET /api/...`; only its qualified name is the fixture's `from`. A
  caller now also counts when a node that is not a file has exactly `from` as its qualified name (its
  name when it has none), in `fromFile` when the fixture names one. The older name check is
  unchanged; its gaps are tracked in #34. On a codegraph build with the #2975 fix
  (colbymchenry/codegraph#3140), `issue-2975` now scores `FIXED`; no other fixture verdict changes on
  that build or on f72c9d2e.

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
