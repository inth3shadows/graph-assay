# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Scoring rules are versioned separately in
[SPEC.md](SPEC.md).

## [Unreleased]

### Added
- Nine fixtures for open colbymchenry/codegraph PRs that fix a wrong or missing edge, so the PR watch reports
  them: each is the PR's own test case (or its issue's repro), BROKEN on upstream main 73c6cff6 and FIXED on
  the PR's head. With an issue: `issue-3429` (#3438, a value call linked to a class's static method),
  `issue-3430` (#3435, a locally shadowed Python function value linked to an import), `issue-3470` (#3480,
  import roots declared in `pyproject.toml`), `issue-3473` (#3479, Express routes on a custom receiver
  name) and `issue-3422` (#3427, a partial fix: a call on a local set from an instance method's result). Named by PR: `pr-2754-import-forwarded-namesake`, `pr-3132-kotlin-overload-arity`,
  `pr-3206-swift-static-type-call` and `pr-3262-csharp-multiline-member-call`. `known-shapes.json` adds the nine at f72c9d2e; every existing entry is
  unchanged.
- Six fixtures for colbymchenry/codegraph issues filed 2026-11-21, each the issue's own repro, all BROKEN
  on 461a5d87 (v1.6.4): `issue-3443` (a parameter typed only by its callback type links another class's
  method), `issue-3444` (a canvas context held in a local still takes the one-method guess), `issue-3445`
  (Python loop variables and decorated functions typed by their name), `issue-3446` (a Python `with`
  tuple target or loop variable holding a stdlib object links the only project method), `issue-3447` (a Go
  local initialized by a chain starting with `new(T)` is typed `T`) and `issue-3448` (a Go local takes a
  same-named closure parameter's type). Where the issue names the right target (`issue-3443`, `issue-3447`),
  `right` pins it; a variant with the bug removed scores FIXED. The Go fixtures keep `Router` and `Route` in
  separate files: with both in one file, the oracle before SPEC v6.0 read the wrong `Route.Path` edge as
  `ok`, because `Router.Path` is declared on the line above (see the SPEC v6.0 entry below). `known-shapes.json` adds the six, tagged at f72c9d2e like the
  rest; every existing entry is unchanged.
- `.runechoguardignore` lists the DOM types `CanvasRenderingContext2D` and `HTMLCanvasElement`, so the
  runecho-guard pre-commit check doesn't flag them as unresolved in fixtures.
- `bench/triage.ts --tables <tables.json>` (#6): triage ranks shapes over the rows the tables average on the
  call-site track (repos every subject ran, no diagnostic language, site lines), so points at stake agree
  with the headline; each subject lists what it left out and why. Results under another SPEC version stay
  in, as the tables average them (they refuse them only when canonical). On the canonical held-out
  run it leaves out got (TypeScript is diagnostic under SPEC v5.0). Without it triage ranks every work dir,
  and its report says so. `bench/tables.ts` is unchanged.
- Adapter conformance for every subject (#11): `bin/graph-assay conformance --subject <name> <build>`
  runs the generic checks (valid snapshot, site lines when claimed, the declared column encoding, a
  definition in every corpus file) for any adapter, counts against the subject's own output for codegraph
  (its SQLite store) and code-graph-rag (its JSON export), and compares code-graph-rag's edges with its
  export by endpoints, line and column. A subject with no count check says so in its verdict. Reports now list the corpus definitions each subject extracted.
  code-graph-rag 0.7.1 is conformant; its columns are UTF-8 bytes (its adapter declares `unknown`, so the
  oracle uses them only on ASCII lines; declaring `utf8` would change scores). `lib/conformance.ts` is a
  scorer file, so `manifest.scorers.sha256` changes.
- `tools/repro.ts --split heldout --publish`: the reproduction image can run the held-out split, which it
  refuses without `--publish` (SPEC §9), and refuses `--publish` on dev; the manifest records the split and
  the flag. `docker/got-package-lock.json` freezes got's install; an `npm` corpus entry without a lock fails
  before anything is fetched.
- Subject isolation where unprivileged user namespaces are blocked (Ubuntu 24.04's AppArmor default):
  `lib/sandbox.ts` runs every adapter's index process under `unshare -rn` where it works, else in a
  throwaway container (`docker/sandbox.Dockerfile`, built by `tools/setup.sh`; `--no-sandbox` skips)
  with no network, no capabilities, no new privileges, a read-only root, a lifetime bounded inside
  the container, and only the indexed dir, the sandbox HOME and the tool's install mounted; the host
  then refuses the tool's output if it holds anything but plain files and directories. The image's packages come from
  snapshot.ubuntu.com at one date. `GRAPH_ASSAY_ISOLATION` picks the backend, `GRAPH_ASSAY_SANDBOX_RO` adds read-only mounts.
  code-graph-rag still refuses to run unisolated. `tools/setup.sh` makes the Python venvs from
  `/usr/bin/python3.12` where it exists, so they run in the container; the code-review-graph venv is
  keyed by its interpreter as well as its lock. `lib/sandbox.ts` is part of every adapter hash.
- Tables, triage and the site inspector read every registered subject, not just codegraph and
  code-graph-rag. `lib/subjects/names.ts` is the data-only subject list the scorers use (work-dir
  suffix `-<subject>`, T1/T3 tags `cg`/`cgr`/`cbm`/`crg`); `names-test.ts` checks it against the
  adapter registry. `bench/tables.ts` and `bench/triage.ts` take `--subjects a,b`, defaulting to every
  subject with a work dir (canonical tables: codegraph and code-graph-rag); averages still cover only
  the repos every chosen subject ran (SPEC §8), and a default selection that narrows them warns. T3
  compares the challenge fingerprints of every subject with a T3 run against the first such subject's.
- A fourth subject, code-review-graph 2.4.0 (`lib/subjects/code-review-graph.ts`): builds in a
  sandboxed HOME and data dir with Jedi enrichment off, and maps the graph's nodes and edges (paths
  made relative) to a snapshot v1 with site lines and unresolved calls; an ambiguous call becomes a
  guessed edge to each of crg's candidates. The repo root is pinned to the indexed dir. Members take
  their containers from crg's symbols (`Router.Host`, `Main.N.b`), and a definition nested deeper
  under that owner (by crg's spans) holds them more tightly; a bare name takes its innermost span. `tools/setup.sh` installs
  it from `docker/crg-requirements.lock` with `--require-hashes` into a fresh per-lock venv that
  replaces the old one only once installed (Python 3.11+, Linux or macOS; `--no-crg` skips). Setup
  now checks every part's platform before installing anything. `lib/adapter-test.ts` gains a golden mapping test, a sandbox
  probe, and hermetic checks of path stripping and container chains.
- A third subject, codebase-memory-mcp 0.12.1 (`lib/subjects/codebase-memory-mcp.ts`): indexes in a
  sandboxed HOME and cache with the repo as the allowed root, and maps the graph's nodes and edges to
  a snapshot v1. It declares no site lines (cbm keeps one edge per caller and callee), so it is
  scored on the function-pair track. Edges resolved by a strategy cbm itself calls a weak name-only
  match are guessed. `tools/setup.sh` installs the linux-amd64 release, sha256-pinned (`--no-cbm`
  skips). A golden mapping test and a sandbox probe join `lib/adapter-test.ts`.
- `fixtures/cbm-candidates/`, two unfiled codebase-memory-mcp repros, both BROKEN on 0.12.1:
  `cbm1-js-ts-same-stem` (`client.js` next to `client.ts`: a function defined in both becomes one node, and the TS file's call lands on the JS one)
  and `cbm2-py-nested-call-lifted` (a call inside a nested function is recorded on the module).
- Five fixtures for forms next to colbymchenry/codegraph#2976 and #2975 that neither issue lists and
  that no open fix covers (all BROKEN on f72c9d2e and on PRs #3138, #3139 and #3140):
  `java-fq-static-receiver` (`com.x.b.Util.log(...)` in a file that imports `com.x.a.*`, so only
  honouring the qualifier gives `com.x.b`), `java-typed-var-wildcard` (`Util u = new Util(); u.run();`
  under `import com.x.b.*`; `right` also pins the `new` to `com.x.b`), and three Laravel route forms
  that still link the top-level controller: `laravel-route-group-use`, `laravel-route-namespace-use`
  and `laravel-route-fq-class`. Their sources copy the parent fixture (`issue-2976` or `issue-2975`)
  except the caller file; each `expect.json` names the upstream issue it was filed as (#3290,
  #3291, and #3292 for the three Laravel forms), a note, and only the edges of its own form.
  `known-shapes.json` lists them untagged (no oracle indexer for Java or PHP).
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
- SPEC v6.0 (#78): the `DEF_SLACK` exception (a node may start up to 2 lines below the definition, for
  `const x =\n (…) =>`) no longer applies when another subject node of the callee's name and a definition
  kind holds the definition: it starts there, or spans it from a decorator above (rule
  `def-slack-own-node`, on the call-site and function-pair tracks). Before, a wrong edge to a one-line
  method declared right below a same-named one scored `ok` forward and `found` missing, in any language.
  A value node (`const W = wrap(\n function W…)`'s constant) does not count, nor does a node that
  encloses the target, so those stay `ok`. A type alias does not count either, and on
  the pair track a caller whose only nearby same-named definitions belong to other nodes is left
  unmapped. Self-tests `go-def-slack`, `go-def-slack-missing`, `go-def-slack-pairs`,
  `go-def-slack-caller` and `py-def-slack-decorated` fail with the rule off; `ts-def-slack-arrow`,
  `ts-def-slack-wrapper`, `ts-def-slack-enclosing`, `ts-def-slack-value` and `ts-def-slack-type` keep
  the slack's cases `ok`. `oracle/test/run.ts` patches can pick a node by `start`, and move, retype or
  rename one with a validated `span` op. On the dev split it changes no verdict and no function pair: no site flips in 58 comparisons and
  identical pair sets in all 29 runs (23 cached work dirs across the four subjects, plus codegraph
  461a5d87's runs of mux, ky, express, click, requests and excalidraw; the two cached mux dirs predate
  the current oracle and were skipped).
- The reproduction measures current builds: codegraph `147fe290` (upstream `main` on 2026-11-17, was
  `f72c9d2e`) and code-graph-rag 0.7.1 (was 0.5.0), in `Dockerfile` and `tools/setup.sh`.
  `docker/requirements.lock` is re-resolved for 0.7.1 in the image's Python (wheels only, PyPI
  SHA256s). The code-graph-rag adapter's logic needed no change: 0.7.1 takes the same `cgr start`
  flags, its export has the same shape, and the adapter test's source maps to the same snapshot; its
  install comment names 0.7.1 now, so its `adapterSha256` changes. Each tool's verdicts on its own
  fixture set are unchanged (`fixtures/cgr-candidates/README.md` gains a 0.7.1 column); on codegraph's
  set, code-graph-rag 0.7.1 moves `n4-py-builtin` from GUESSED to FIXED. 0.7.1 is
  still not deterministic on ky; the tables' note carries its numbers (TECHNICAL, Determinism). Edgediff's
  self-test pair stays `60b0d7a9 -> f72c9d2e`.
- **SPEC v5.0** (major: it moves published numbers). The diagnostic-language gate (§9) weights the
  labelled sample's strata by their share of the tabled run's sites where SCIP answers instead of
  pooling the sample, whose quotas over-represent disagreements by design; the bound is a stratified
  Agresti-Coull interval, and a stratum carrying at least 5% of the weight with fewer than 20
  labelled answers makes the language diagnostic. The strata are counted over both canonical
  subjects (where one failed on a repo, over the other alone, an approximation; a language is left
  ungated only when every tabled subject failed on all its repos, where recall is 0 and precision
  undefined); tables without per-site results or missing a codegraph or a code-graph-rag run are
  refused. TypeScript becomes diagnostic
  on both splits: 2 labelled disagreements and 9 labelled oracle-only sites stand for about a quarter
  of the sites each; JavaScript stays scored by one site (TECHNICAL.md). The strata rule moves to `labels/strata.ts`, shared by the sampler and the
  tables, which report each language's weights, weighted rate and bound. Issue #2.
- **SPEC v4.0** (major: it moves a published number). `skip-composite-literal` reads every signature
  from the file's own source (from a declaration's or func literal's `func` to its body's `{`, the
  whole file lexed: comments, strings, raw strings), whatever its layout and never from the subject's
  caller, instead of matching line shapes. So a signature over several lines, a closure's, and one
  taking `interface{}` are signatures, and a literal after a leading `)` or after a multi-line raw
  string holding a brace is a literal. A function-local type (in a `type (` group too) and any type in
  a literal's type expression (`map[T]V{}`, `map[T]struct{}{}`, `[]func() T{}`,
  `map[string]func(T) error{}`) count; a conversion `T(x)` before a block's `{` does not. On the corpus only
  code-graph-rag's held-out cobra changes: eight literals of a function-local struct type are skipped.
  Follow-ups from the #57 review.
- **SPEC v3.0** (major: it moves published numbers). New rule `skip-composite-literal` (Go, call-site
  and function-pair tracks): a composite literal `T{...}`, `&T{...}`, `pkg.T{...}` or `G[int]{...}` is not a call, as a
  Go conversion `T(x)` is not. codegraph links the literal's type with an `instantiates` edge; the
  call-site track scored it `ok` (SCIP resolves the type name), while the function-pair track, which
  builds oracle units from call sites only, had no oracle pair for it and counted the subject's pair
  as an oracle disagreement. Now the edge is skipped forward (counted in the waterfall) and makes no
  pair. The edge must be an `instantiates` edge to a type and sit on the literal itself, so a
  same-named method call on the line (`s.Options(Options{})`) and a function's result type stay
  scored. Prompted by the held-out run (cobra); on dev only the Go repository mux changes, and every
  unit that leaves is a literal. Self-tests
  `go-composite-literal`, `go-composite-literal-pairs`. Results under v2.0 and v1.0 keep their labels.
- **SPEC v2.0** (major: it moves published numbers). New rule `scip-name-mismatch` (Python, both
  directions): where scip-python's symbol for a function, method or class the project defines names
  another definition than the identifier it sits on (and no `import A as B` rename explains it), the
  oracle has no answer there. Forward the site is unaligned, missing it is
  skipped (counted in the waterfall), and on the function-pair track the reference no longer makes a
  subject pair an oracle disagreement. scip-python 0.6.8 resolves names a package re-exports with
  `from ._m import *` to another definition of the module: in held-out httpx `httpx.Response` ->
  `Request#`, `httpx.MockTransport` -> `ASGITransport#` (595 call sites), which v1.0 scored as the
  subjects' wrong targets. Prompted by the first held-out run; on dev it touches no scored unit (the
  57 mismatches in requests and click are standard-library targets). Self-tests `py-star-import`,
  `py-star-import-missing`. Results under v1.0 keep that label.
- `replay` prints `unfiled` for a fixture with no upstream issue (`issue` null or 0), as `bench/triage.ts`
  does, and sizes the name column to the longest fixture name. `fixtures/replay.mts` is a scorer file, so
  this changed `manifest.scorers.sha256`.
- `lib/` is TypeScript: every `lib/**/*.mjs` is now `.ts`, run by Node's type stripping with no build
  step, so the Node floor is 22.18 (`engines.node`: `>=22.18.0 <25`). `lib/types.ts` types the
  snapshot and expectation schemas once, and the scorers and adapters import it. Callers outside
  `lib/` stay `.mjs` and import the `.ts` paths. Behaviour is unchanged: fixture replay gives the same
  per-site results, and the adapter goldens are byte-identical. Second phase of #14.
- `adapterSha256` changes for both adapters, because the hashed files are renamed to `.ts` and
  retyped. Results recorded before this change carry the old hashes.
- `oracle/` is TypeScript too. Its scripts (`oracle/*.ts`, `oracle/test/run.ts`, `regen.ts`) run
  through Node's type stripping, and `tsc` checks them along with `lib/`. `oracle/package.json` marks
  them as ES modules. Self-test cases are copied to a temp dir before anything indexes them, so the
  marker never reaches a case's sources. Oracle output is byte-identical: the same results on every
  self-test case, with each rule disabled in turn, and on a cached excalidraw run in both modes. Third
  phase of #14.
- `oracle/oracle.ts` is now only the command line (#7). The work moves to modules that do nothing at
  import time:
  - `context.ts`: options and loading;
  - `forward.ts`, `missing.ts`, `pairs.ts`: the checks;
  - `braces.ts`: caller ranges;
  - `report.ts`: output;
  - `symbols.ts`: shared helpers.

  `oracle/tracks-test.ts` drives them in-process. `--mutate` finds rules in every module that
  `oracle.ts` imports. `createContext` refuses an unknown `ORACLE_LANG`, as the command line does. Output is
  byte-identical, with one exception: missing mode no longer calls `process.exit(0)`, so Node's SQLite
  warning now reaches stderr, as it already did in forward mode.
- The scorer manifest (`manifest.scorers`) hashes oracle/'s `.ts` scripts and `oracle/package.json`,
  so its `sha256` changes. It no longer hashes `oracle/test/ts-forward/helper.mjs`, a self-test case
  source that git's `oracle/*.mjs` pathspec matched across directories.
- `bench/`, `metamorphic/`, `benchmarks/` and `differential/` are TypeScript too. Each has a
  `package.json` marking its scripts as ES modules, and `tsc` checks them. The replay script is
  `fixtures/replay.mts`: the `.mts` extension makes it an ES module without a `fixtures/package.json`,
  which would also cover the fixture sources there. Type fixes are annotations only. The bench tables
  and triage give byte-identical JSON on the cached oracle runs. Their Markdown differs only in the
  script name they print. The scripts that need a codegraph build were checked through their hermetic
  tests and their usage paths. The scorer manifest `sha256` changes again, for the renamed paths and
  the `package.json` markers it now hashes: `differential/package.json` by name, and the `metamorphic/` and `benchmarks/` ones through their directories. `corpus/v2.txt` is preregistered and keeps its comment
  naming `differential/builds.mjs`. Third phase of #14, second PR.
- `labels/` is TypeScript too: its scripts are `.ts`, and `labels/package.json` marks them as ES
  modules. Type fixes are annotations only. `labels/protocol.json` is unchanged, so the labelling
  protocol keeps its identity: `node labels/protocol.ts` prints the same sha256, and the noise tables
  and qualification scores are byte-identical. The protocol still names the old `.mjs` files in three
  places: `prompt.source` (`labels/questions.mjs`), `probe` (`labels/run.mjs`) and
  `qualification.items` (`labels/qualify-items.mjs`). Changing them would make a new protocol, so the
  next deliberate `--update` should fix all three. Third phase of #14,
  third PR.
- `tools/` is TypeScript too: `tools/repro.ts` (the Docker image's entry point, now
  `ENTRYPOINT ["node", "tools/repro.ts"]`), `tools/repro-test.ts` and `tools/triage/tag-fixtures.ts`.
  `tools/package.json` marks them as ES modules, and the repro manifest hashes it. Type fixes are
  annotations only. Every script outside `bin/` now runs as TypeScript. `bin/graph-assay` stays an
  extensionless JavaScript entry point. Third phase of #14, last PR.
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
- `tag-fixtures` no longer sends a fixture with no TS/JS, Python or Go source (C#, Swift) to the TypeScript
  indexer, which failed it; such a fixture is listed untagged, like a Java one.
- `bin/graph-assay` refuses a Node without unflagged type stripping, or 25+, with a message, instead of
  every TypeScript script failing with `ERR_UNKNOWN_FILE_EXTENSION` (#28). The range, also `engines`, is
  now `>=22.18.0 <23 || >=23.6.0 <25`: 23.0 to 23.5 had type stripping behind a flag. Every step and
  forwarded command, shell scripts included, runs with the CLI's node first on PATH. CI runs `check` on
  Node 22.18.0, 22.23.2 and 24.22.1.
- The type check takes only strictness options (and `--pretty false`) as extra tsc flags, matched
  case-insensitively as tsc does; anything else (`--help`, `--init`, `--watch`, `--listFilesOnly`,
  `--noCheck`, `--noEmit false`, a response file, ...) is refused, where it read as `0 errors`, hung or
  wrote files. A malformed root lockfile entry is named `(root project)` (#26).
- Replay and fixture follow-ups from the #31 review (#36): a fixture whose `expect.json` is unreadable or
  invalid prints `-` for its issue (was `unfiled`) and has no `issue` in `--json`; the issue column sizes itself; replay and `bench/triage.ts`
  share `issueLabel` (`lib/expect.ts`); `java-typed-var-wildcard` also lists the wrong `new` target
  (`instantiates -> com.x.a::Util`), so a graph with both targets and the fixed call no longer scores
  FIXED. Replayed on codegraph f72c9d2e and 147fe290, code-graph-rag 0.7.1, codebase-memory-mcp and
  code-review-graph: its verdicts are unchanged. `fixtures/replay.mts` and `lib/expect.ts` are scorer files,
  so `manifest.scorers.sha256` changes (fixture expectations themselves are not hashed there).
- Replay's caller guard (#34): one rule decides whether a fixture's caller is in the graph. It honours
  `fromFile` and matches the caller's name as an edge source would (`chainMatch`), with one stricter
  rule: a path segment (a file, a route pattern) keeps its parentheses and drops only when it is the
  node's own file. A file caller counts only when its file produced a definition or an edge, so a
  root-level file with nothing parsed no longer reads as FIXED and a nested file caller (`lib/hooks.js`)
  can. `chainMatch` takes the guard's `file` option; edge matching is unchanged. Replayed on codegraph f72c9d2e and 147fe290, code-graph-rag 0.7.1,
  codebase-memory-mcp and code-review-graph: one verdict moves, code-review-graph's issue-2966 FIXED ->
  CHANGED (its caller is named `Model.init`; the old tail match found `Cast::init` in another file).
  `lib/fixture.ts` is a scorer file, so `manifest.scorers.sha256` changes.
- README's fixture counts (#63): 45 codegraph repros, 44 naming the upstream issue or PR they reproduce
  (42 distinct). `lib/readme-counts-test.ts` keeps them matched to `fixtures/`.
- The differs (`differential/builds.ts`, `shadow.ts`, `modes.ts`) keep a repo's `node_modules/` when they
  copy it to index (#15), through one `copyRepo` in `lib/fixture-install.ts`. codegraph resolves imports
  against installed packages (since upstream df20853 an installed but undeclared package is the package's),
  so a diff of a local dir with an install missed any change that depends on one. Links are copied as
  written, so an install's relative links lead into the copy, which is all the container sandbox mounts.
  Corpus repos from `--fetch` (and the edgediff workflow) are not installed, so nothing changes there.
  A failed copy is a `FAILED` row in all three (and a failed snapshot read in `builds.ts`), never an
  aborted run; `builds.ts` cleans up with `sandbox.remove`, and `modes.ts` removes a failed mode's copy.
  A repo named through a link is copied from the dir it names.
- Provenance gaps (#41): `scorers()` now hashes the tables and T3 (`bench/tables.ts`,
  `bench/robustness.ts`, `bench/package.json`), `differential/builds.ts`, the labels scorers with
  `labels/package.json`, and the oracle's shell steps (`oracle/*.sh`); the repro manifest hashes
  `differential/builds.ts`. A test walks every scoring entry point's literal imports (and each file's
  nearest `package.json`), so a new scorer file reached that way cannot go unhashed; a file loaded by
  path or by a computed import must still be listed by hand. Data inputs (corpus,
  labels, fixtures) stay with the repro manifest, which hashes them by directory. The edgediff
  workflow's path filter covers every file the build differ loads, pinned the same way. The
  Docker-context check reads `.dockerignore` as Docker does for the pattern forms the file uses, and
  refuses any other form (it left out 166 of the 479 files a real build sends and kept 10 Docker drops;
  it now matches all 479) and requires `docker/package*.json` and a fixture under
  `fixtures/oracle-candidates/`. The ENTRYPOINT check requires the final stage to end with
  `WORKDIR /opt/graph-assay`, `COPY . .` and the ENTRYPOINT, and rejects a `..` script path. The cpSync
  scan reads `fixtures/replay.mts`.
- The docker sandbox mounts the indexed copy read-only, `.git` included (#51). Only the sandbox HOME
  and the tool's own output dir (codegraph `.codegraph`, code-graph-rag `.graph-assay`, code-review-graph's
  `.code-review-graph` marker) are writable,
  so an exploited tool can no longer plant a git setting such as `core.fsmonitor`, or a link, in the
  copy where the host later runs `git` and the oracle. A link or file the repository itself tracks at
  an output dir is removed before the run, never followed into a read-write mount, and a committed
  code-graph-rag export is never taken for the tool's. `docker run --pull never` never fetches a
  missing image by name. An output tree the host cannot read (too deep, or made unreadable) is a
  failed index instead of a crash, and a missing index no longer reads as "leads outside".
- The codebase-memory-mcp adapter dropped every definition in a file cbm writes without a `Module`
  node: Go and Java files, and a file whose extensionless path another file's Module took
  (`client.ts` next to `client.js`). The File node of such a code file (a known extension) is now
  the file; its definitions keep cbm's bare names. cbm's DEFINES edges that cross files (a File node
  "defining" another file's functions) are dropped. On corpus v1's dev split, gorilla/mux goes from
  0 to 17 Go files and from no function pairs to 624 subject pairs (469 of the oracle's 620 matched);
  click gains 6 files and 23 nodes, requests 1 file. Every node and edge the adapter produced before
  is unchanged, and the other repos' pair counts are the same.
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
