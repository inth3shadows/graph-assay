# Technical Reference: graph-assay

## Architecture

```
            ┌──────────────── a checkout of some repo ───────────────┐
            │                                                        │
   subject tool (lib/subjects/<tool>.ts)                    SCIP indexer (tsc, pyright, go, javac)
            │                                                        │
   snapshot v1 (schema/snapshot.v1.json)                        index.scip
            │                                                        │
            └──────────── oracle.ts: join per call site ────────────┘
                                         │
                        buckets + samples (out.json)  →  minimal repro  →  upstream issue
```

The differentials follow the same shape without a compiler: one tool's graph against itself under a change that must not matter (execution mode, a decoy file, shifted lines), or build A against build B on the same tree.

The rule throughout is that a tool is never scored against itself, only compared with itself.

Design decisions:
- **Scorers read snapshots, never a tool's store.** `lib/subjects/codegraph.ts` is the only code
  that knows codegraph's SQLite schema: it indexes in a sandboxed HOME and exports a snapshot v1
  (nodes, files, edges with site line/column and the reference as written, unresolved references,
  capabilities). A second tool needs one more adapter, not changes to the scorers:
  `lib/subjects/code-graph-rag.ts` is that adapter for code-graph-rag 0.5.0 (`cgr start
  --update-graph -o`, offline under `unshare -rn`, sandboxed HOME; its `exact` / `heuristic` /
  `overload` resolution becomes `resolvedBy`, and anything but `exact` becomes provenance; Module
  nodes become file nodes; nodes without a path in the repo are dropped).
  `lib/subjects/codebase-memory-mcp.ts` does the same for codebase-memory-mcp 0.12.1 (`cli
  index_repository`, HOME and `CBM_CACHE_DIR` in a temp dir, `CBM_ALLOWED_ROOT` = the repo, network
  unshared where possible; its store's `nodes` and `edges` are copied to `.graph-assay/cbm.db`).
  Its `strategy` becomes `resolvedBy`, and the strategies cbm itself calls weak name-only matches
  (`unique_name`, `suffix_match`, `field_type_hint`, `fuzzy`) become provenance. cbm keeps one edge
  per caller and callee with one site's line, so it declares no site lines and is scored on the
  function-pair track (SPEC §3). `lib/subjects/index.ts`
  is the registry scorers take `--subject` from. `SPEC.md` says
  what the scorers compare. `bin/graph-assay conformance <build>` checks that the adapter exports the store
  faithfully (counts, site lines, endpoints) and reports how the subject handles the awkward cases;
  for codegraph f72c9d2e, columns are UTF-16 code units in TS and Python, and two calls of one
  callee on a line are two edges.
- **Join by call site, not by symbol.** A codegraph edge carries the call's line and column. SCIP
  carries every reference occurrence with its range. Joining on file, line and called name, at the
  nearest column, ties each edge to the compiler's answer for that exact call. A symbol-level join
  would blur overloads and same-named methods.
- **Bucket, don't count.** The oracle sorts each disagreement into a cause bucket. Most
  disagreements are codegraph conventions, not bugs, so a raw mismatch count is useless.
- **Index Python from a copy.** `scip-python.sh` indexes a copy of the tracked files with a
  `pyrightconfig.json` that puts `src/` on the path and points at the repo's `.venv`. Without it, a
  src-layout package's imports resolve to nothing and every project call looks unresolved.

## Adding a subject

A tool under test is one module in `lib/subjects/`, registered in `lib/subjects/index.ts`. It exports:

| Export | Contract |
|---|---|
| `name` | The subject name scorers take with `--subject` |
| `defaultBuild()` | The build used when a command is given `default` (a path under the configured `subjects` dir) |
| `index(dir, build, opts)` | Index `dir` in a sandbox (temp HOME, no network where the tool allows it); returns `{ok, status, signal, output, stdout, ms}` |
| `snapshot(dir, {build})` | Export the graph as snapshot v1 (`schema/snapshot.v1.json`, typed as `Snapshot` in `lib/types.ts`): nodes, files, edges with the call site's line and column and the reference as written, unresolved references, capabilities. Guessed edges carry `provenance` (SPEC §4) |
| `version(build)` | The tool's version string, recorded in every manifest |

Then replay the fixtures with `--subject <name>`, run the oracle with `CGQA_SUBJECT=<name>`, and check
that the adapter's hash appears in results (`lib/provenance.ts`). The adapter conformance check
(`lib/conformance.ts`) is written against the codegraph adapter only; a new subject needs its own
counts-and-sites comparison there.

## File Descriptions

| File | What it does |
|---|---|
| `oracle/oracle.ts` | Reads `scip print --json` output and codegraph's DB (non-heuristic `calls`/`instantiates` edges). It joins them per call site and prints bucket counts, with every disagreement (grouped by cause) in an optional JSON file. The file is the command line only: it turns argv and `ORACLE_*` into options and runs one of the tracks below (#7). |
| `oracle/context.ts` | `optionsFromEnv` (argv and `ORACLE_*` as typed options) and `createContext`: loads the SCIP index and the subject's snapshot and holds what every track shares (definitions and references, source lines, the `on(rule)` switch, skip counts, the coverage waterfall). Nothing runs at import time. |
| `oracle/forward.ts`, `oracle/missing.ts` | The forward check (verdicts and refinements, per subject edge) and the missing check (`ORACLE_MODE=missing`, per SCIP call-site reference). Each returns a tally for `report.ts`; `missing.ts` also runs the function-pair track. |
| `oracle/pairs.ts`, `oracle/braces.ts` | The SPEC §3 function-pair track, and the brace matching that gives it caller ranges where SCIP records no `enclosing_range` (Go/JVM methods, TS/JS `function` expressions). |
| `oracle/report.ts`, `oracle/symbols.ts` | `out.json` and stdout from a tally (grouping, `ORACLE_REDACT`, `ORACLE_SHOW`), and the pure SCIP symbol helpers (`scipKind`, `defName`, `rangeOf`, ...). |
| `oracle/tracks-test.ts` | Drives self-test cases through `createContext` and the tracks in-process, with no child process, and switches a rule off through the options. Part of `graph-assay check`. |
| `oracle/scip-python.sh` | Indexes a Python repo with scip-python (see above). Needs `--project-version`, without which scip-python crashes on some modules. |
| `oracle/oracle.ts` (`ORACLE_MODE=missing`) | The inverse check: every SCIP reference at a call site (`name(`, `new name`) to a project symbol needs a `calls`/`instantiates` edge from that line to a node holding the definition. Buckets are `missing\|cause\|language\|SCIP kind[@decl][>target node kind]`; see "Missing-edge causes". |
| `oracle/site.ts` (`graph-assay site`) | `<name \| work dir> <file:line> [called name] [--subject s\|all] [--no-scip]`: one call site from a finished work dir (`ORACLE_ALLSITES=1`), per subject: the forward and missing records with each bucket's meaning (`MEANING`), the subject's `calls`/`instantiates` edges on the line, SCIP's definition(s) with their source lines (from the cached index), the skip counts when there is no record, and the `run.sh` command that re-runs the repo. Runs nothing. `oracle/site-test.ts` pins the core (part of `graph-assay check`). |
| `package.json`, `package-lock.json`, `tsconfig.json` | Development tooling only (the runtime has no npm dependencies): `typescript` and `@types/node`, pinned exactly. `tsconfig.json` type-checks the TypeScript scripts: `lib/**/*.ts`, oracle/'s own (`oracle/*.ts`, `oracle/test/*.ts`; never a case's sources), `bench/`, `metamorphic/`, `benchmarks/`, `differential/`, `labels/`, `tools/` (with `tools/triage/`) and `fixtures/replay.mts` (`noEmit`, not yet `strict`; `erasableSyntaxOnly`, so nothing Node's type stripping cannot run, such as `enum`; `verbatimModuleSyntax`, so type-only imports say `import type`). `graph-assay check` runs it through `lib/typecheck.ts` and fails when `node_modules` is missing or does not match the lockfile. Not part of the Docker context. `lib/`, `oracle/`, `bench/`, `metamorphic/`, `benchmarks/`, `differential/`, `labels/` and `tools/` run as TypeScript with no build step: Node strips the types (#14), and a `package.json` in each marks it as ES modules. `fixtures/replay.mts` takes the `.mts` extension instead, so no marker sits over the fixture sources. |
| `lib/types.ts`, `lib/package.json` | The snapshot and expectation contracts (`schema/snapshot.v1.json`, `schema/expect.v1.json`) as TypeScript types, written once; `lib/snapshot.ts`, `lib/expect.ts` and both adapters import them, and the validators check the same shapes at runtime. `lib/package.json` marks `lib/` as ES modules for Node and tsc, scoped to `lib/` so `.js` test sources elsewhere keep their module type. |
| `lib/typecheck.ts`, `lib/typecheck-test.ts` | The type check `check` runs last: refuses a missing or stale install (versions against `package-lock.json`), runs `tsc -p . --noEmit` and prints every diagnostic, then one verdict line (type and config errors counted apart; a failure with no diagnostics, or a run cut short, says so). `npm run typecheck` runs it alone, guards included. |
| `lib/main.ts` | `isMain(import.meta.url)`: the main-module check every CLI uses, robust to spaces, `%` and symlinks in the checkout path. |
| `lib/adapter-test.ts`, `lib/test/adapters/` | Adapter mapping against frozen indexes (a codegraph DB, a code-graph-rag export and a codebase-memory-mcp nodes-and-edges extract of one small Python file) and committed golden snapshots (`--update` rewrites them after a deliberate change), plus sandbox probes for codegraph and codebase-memory-mcp: an index process sees no caller variables, a private HOME (and, for cbm, a private cache and a root confined to the repo) and, where `unshare` works, no network interface. |
| `lib/snapshot-test.ts`, `benchmarks/pycg-test.ts` | The validator enforces every field the snapshot schema requires (mutation: delete each, expect a problem); the PyCG scorer against fabricated snippets and a stub subject (hits, guess-only, extras, failed index). |
| `lib/cli-test.ts`, `metamorphic/relations-test.ts`, `labels/data-scan-test.ts` | CLI regressions (spaced paths, exit codes on bad input, empty-graph verdicts, the gate's `incomplete` flag, the labelling gate); the relations' source transforms; and the leak scan of committed labelling files. `check` runs every tracked `*-test.mjs` and every `*-test.ts` among the TypeScript scripts (`tsconfig.json`'s `include`: `lib/`, oracle/'s own, `bench/`, `metamorphic/`, `benchmarks/`, `differential/`, `labels/`, `tools/` with `tools/triage/`; elsewhere a `.ts` is an indexed test source, not a script). |
| `oracle/baseline.ts` | `save` collects one build's results (oracle forward + missing buckets and group signatures per repo, fixture verdicts, PyCG, metamorphic) into `baseline.json`; `diff` prints every change and an effect-size verdict (SPEC §9). `--fail-on-regression` exits 1 for regression, 2 on diff errors; `--fail-on-incomplete` also exits 1 when something measured on the old build errored or is missing on the new one (`incomplete` in the gate result); `--json gate.json` saves the gate result. |
| `lib/scores.ts`, `lib/scores-test.ts` | Shared T2 bucket counts and pure `gate(old, next)`; hermetic threshold and baseline CLI tests in `graph-assay check`. |
| `lib/provenance.ts` | `adapterHash` hashes adapter/shared implementation bytes without Git or installation paths. `recordedAdapterHash` preserves legacy unknown provenance. Snapshots, measurement JSON and manifests carry `adapterSha256`; baseline/table inputs retain their original hashes. |
| `lib/fixture-install.ts`, `lib/fixture-install-test.ts` | A fixture whose bug depends on installed packages commits them as `node_modules.fixture/` at its root (no ignore file or copy filter drops that name). `copySeed` is how every script copies a fixture or seed for a subject to index: for a fixture (a dir holding `expect.json`) it skips a stray `node_modules/` and renames `node_modules.fixture/` to `node_modules/`; any other tree is copied as it is. The labeller's copy (`labels/questions.ts`) hides both, as `labels/protocol.json` says. The test fails if a script (any `.mjs`, and the TypeScript scripts in `tsconfig.json`'s `include` apart from `fixtures/`) copies with `fs.cpSync` outside a short exempt list. |
| `lib/fixture.ts`, `lib/anti-gaming-test.ts` | Isolated source copies, unchanged fixture scoring and marker-leak detection. Replay `--canary` repeats under an anonymous directory with appended marker comments; `canaries` records PASS/FAIL/ERROR separately. Hermetic hash, isolation, CLI and propagation checks run in `graph-assay check` (SPEC §11). |
| `oracle/test/run.ts` | Oracle self-tests: each case under `oracle/test/` holds sources, `case.json` (per-site expected bucket, or `absent` for a skipped site; `pairs` / `pairCounts` for the function-pair track) and frozen inputs (`snapshot.json` = the subject's graph as snapshot v1, `index.scip.json` = decoded SCIP), so the tests pin the oracle rather than codegraph's current behavior. `--mutate` disables each `on('<rule>')` in the modules `oracle.ts` imports (found by `oracle/test/rules.ts`) in turn and fails if any rule's removal breaks no test; `--dump` prints every site's bucket. `ORACLE_DISABLE` and `ORACLE_ALLSITES=1` are the oracle switches it uses. |
| `oracle/ts-cover.ts` | Writes the TS/JS oracle's covering project for a repo with a root `tsconfig.json`: it sits at the repo root (so the repo's `types` resolve), extends that tsconfig and lists every tracked TS/JS file, so the oracle indexes test folders the repo's include leaves out (SPEC §7). `oracle/ts-cover-test.ts` pins it. |
| `oracle/test/regen.ts` | Rebuilds a case's `snapshot.json` and `index.scip.json` from its sources with a given codegraph build and the SCIP tools. Run it after editing a case, then re-check the expectations. |
| `metamorphic/run.ts`, `metamorphic/relations.ts` | Runs shared source-derived `decoy`, `shift` and full-snapshot `repeat` checks for either subject; every result records a challenge fingerprint and validated applicability. Decoy/shift compare edge multisets by spans; repeat uses modes' canonical graph and raw payload hash. Exit 1 on differences, 2 on execution errors. `fixtures` selects every oracle-candidate seed; `META_SHOW=N` limits details. |
| `differential/modes.ts` | Copies each dir once per mode (skipping `.codegraph/` and `node_modules/`; a fixture's `node_modules.fixture/` is put in place), indexes it through the adapter with that mode's switches, and compares the snapshot with `base` (WASM, codegraph defaults): `IDENTICAL` (same bytes, ids and row order included), `SAME-GRAPH` (same multisets of files, nodes by kind, file and span, node names, edges keyed by their endpoints' spans with every other column, and unresolved refs, so a rename is one `names` difference rather than moved edges, SPEC §2; ids or order differ), `DIFFER` (prints up to 5 differing entries per category), `FAILED` (the run failed; a failure, never missing data). Modes: `repeat`, `native` (`CODEGRAPH_KERNEL=1`), `parse1`/`parse4` (`CODEGRAPH_PARSE_WORKERS`), `resolve-pool` (`CODEGRAPH_PARALLEL_RESOLVE_MIN=0`, `CODEGRAPH_RESOLVE_WORKERS=4`; below 150k refs the pool is otherwise off, so `no-parallel-resolve` equals `base` on small repos), `no-parallel-resolve`, `no-store-worker`, `no-fast-init`, `reindex` (`init` then `index`), `sync-from-empty` (`init` an empty dir, copy the files in, `sync`). `--modes a,b` picks some; `--json out` keeps every result. Exit 1 on any `DIFFER` or `FAILED`. |
| `differential/builds.ts` | `--fetch <dest> [corpus] [split]` clones the corpus (`corpus/v1.txt`, dev split unless `all`) at its pins (shallow, reused when already there). Otherwise indexes each dir with two builds and compares them the way `modes.ts` does (canonical multisets): `SAME`, `DIFFER` (−/+ counts per category, `--show N` entries each), `FAILED`. `--md` writes the summary table; `--json` keeps everything. It counts repeated edges and compares every column. Exit 1 on any `DIFFER` or `FAILED`. |
| `.github/workflows/edgediff.yml` | `workflow_dispatch` with a `repo` (default `colbymchenry/codegraph`) and a PR number there (merge base vs head), or two full commits. Builds both with `tools/build-codegraph.sh` (cached per commit), runs `builds.ts` on the pinned repos, appends the table to the job summary and uploads `edgediff.md` / `.json`. `DIFFER` passes; a repo that failed to index fails the job. A PR touching this pipeline runs it once on 60b0d7a9 → f72c9d2e as a self-test. A PR whose head lives in another fork is not fetched (`build-codegraph.sh` fetches origin's branches only). |
| `differential/shadow.ts` | For each repo in `questions.json` (a name in the targets file, `ORACLE_TARGETS` or `oracle/targets.txt`, or a path under the repo root), indexes one fresh copy per build and runs every question twice on each (`CODEGRAPH_NO_DAEMON=1`, `NO_COLOR=1`; the work dir in an answer becomes `<ROOT>`). `SAME`, `CHANGED` (line diff with 2 lines of context; `--show N` lines, default 40), `UNSTABLE` (the two asks on one build differ; never diffed), `FAILED`. Exit 0 only when every answer is `SAME`. |
| `differential/test.ts` | Hermetic: a frozen self-test snapshot compares equal to itself renumbered and reordered, and each single-field mutation (edge line, duplicate, target, drop, provenance; node span; unresolved; file language) shows up in the right category; `shadow.ts`'s line diff reproduces both texts. Part of `graph-assay check`. |
| `labels/labellers.ts` | The labellers and their isolation. `opus`: `claude -p --model claude-opus-5-5 --effort high --tools Read,Grep,Glob` with HOME an empty temp dir (no CLAUDE.md, hooks, plugins, MCP; needs `CLAUDE_CODE_OAUTH_TOKEN`). `sol`: `codex exec -m gpt-6.1-sol` reasoning high, `-s read-only`, every MCP server in `~/.codex/config.toml` disabled per run (`mcp_servers.<name>.enabled=false`; `mcp_servers={}` does not strip them), apps / web search / image generation off, AGENTS.md not loaded. `kimi-k3`, `glm-5.3`: the harness runtime (`labels/harness_label.py`, `roles.call` with `read_only_repo_tools`) on the LiteLLM gateway, `expect_deployment` pinned to the Synthetic deployment so a fallback is an error. `probe()` asks for the tool list and refuses a labeller with anything else. |
| `labels/questions.ts` | Builds the question: the site line, a candidate list shuffled per item (sha256 of id and candidate) with no attribution, plus W (a repo definition not listed), X (outside the repo), Y (local binding), Z (cannot tell). The labeller's repo copy drops `expect.json`, subject outputs and agent configs (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, ...). `unstub` reads a Python `@overload` stub as its implementation (SPEC §4). |
| `labels/run.ts` | `<items.jsonl> <out dir> --labellers a,b [--jobs N] [--tiebreak a,b]`: probes each labeller, then asks every item not yet answered (resumable). `--tiebreak` asks only where two labellers both answered and disagree. Pace `--jobs` to the plans: 6 parallel tool loops spent a ChatGPT plan's and a Synthetic subscription's limits within ~20 minutes. |
| `labels/protocol.ts`, `labels/protocol.json`, `labels/qualification/` | The pinned labelling protocol (SPEC §9): each labeller's model, effort, runtime and role, the labelling dates (answer files' UTC write times; answers carry no timestamp), the consensus and blinding rules, the prompt template's sha256 (the prompt rendered for a fixed item, so it moves only with the template) and the sha256 of every committed labelling file: the qualification set (54 known-answer items, answers from all five labellers) and each sample under `labels/data/`. The protocol's identity is the sha256 of `protocol.json`. `node labels/protocol.ts` verifies it; `--update` rewrites the hashes after a deliberate change, which makes a new protocol. `noise.ts --protocol` fails on any mismatch or unpinned sample file and records the hash and qualification accuracies; the tables print both, and canonical tables refuse a noise file without it. `labels/test.ts` checks the committed protocol in `graph-assay check`. |
| `labels/qualify-items.ts` | Known-answer items from the fixtures: `right` edges are truth, `wrong` targets and same-named definitions the distractors; a fixture with `right: []` gives a `reject:` truth (anything but the wrong targets). |
| `labels/sample.ts`, `labels/noise.ts`, `labels/score.ts` | The stratified sample from the oracle's per-site results (candidates canonicalized to the innermost definition span); the 2-of-3 consensus (v1: opus and sol, astra only where they disagree) and how often SCIP and each subject match it, per stratum, with Wilson intervals; labeller accuracy on known-answer items. |
| `labels/export.ts`, `labels/data/` | `export.ts <sample.jsonl> <answers dir> <dest>` freezes a labelled sample: `items.jsonl` with `repo` relative to the oracle work dir and `stubs` (each Python `@overload` stub answer mapped to its implementation, so `unstub` needs no checkout), plus the last ok answer per item for each labeller. `labels/data/v1` (Python, Go), `labels/data/v2-tsjs` (TypeScript ky, JavaScript express) and `labels/data/v3-js` (express after `skip-module-member-alias`; its `meta.json` retires v2's JavaScript items) are committed; `noise.ts` takes any number of `<items.jsonl> <dir>` pairs and pools them. |
| `bench/triage.ts` (`graph-assay triage`) | Bug triage from finished oracle work dirs (no model, runs nothing). For each subject, every strict non-match bucket is a shape, clustered across repositories and ranked by headline points at stake: the macro strict precision or recall gain if every unit of the shape were right (an upper bound). Shapes sharing at least half their call sites are linked as the same calls, since one cause shows once per direction. Noise verdicts are counted, not ranked. Each top shape lists its largest groups (subject target vs compiler definition, code, a `oracle/site.ts` command), and `--t3` adds decoy captures. With `fixtures/known-shapes.json` (default `--known`), each codegraph shape lists the filed fixtures whose bug produces it in the same language, with their replay verdict from `--t1`: a candidate match, since one shape key can hold several bugs. `bench/triage-test.ts` pins it. |
| `tools/triage/tag-fixtures.ts`, `fixtures/known-shapes.json` | `tag-fixtures.ts <codegraph.js>` indexes every oracle-candidate fixture with that build and its SCIP indexer, runs the oracle in both directions, and records the fixture's strict non-match shapes in `fixtures/known-shapes.json`. Re-run it when fixtures are added or the reference build moves. A fixture that fails to tag leaves the file unchanged and exits 1, unless `--allow-failures` records it untagged. Java, Kotlin and PHP fixtures are listed untagged. At f72c9d2e, 30 fixtures produce shapes and 6 produce none (fixed at that build, or outside what the oracle sees). |
| `bench/tables.ts`, `bench/robustness.ts` | Tables v1 from oracle work dirs (T2 call-site and function-pair tracks side by side), T1 (`--t1`), noise (`--noise`) and T3 (`--t3`: meta-cg.json/meta-cgr.json). T3 counts errors in eligible denominators; excludes N/A and unverified legacy rows; missing data is NOT RUN. Canonical T3 requires complete shared challenge evidence. `bench/robustness-test.ts` pins accounting and actual runner/table integration. |
| `corpus/v1.txt` | The preregistered corpus: name, clone URL, pinned SHA, language, license, split (dev / heldout), category, setup (`npm` = `npm install --ignore-scripts`). `differential/builds.ts` and the edgediff workflow read its dev split. |
| `corpus/v2.txt` | v1's rows unchanged plus a `regression` split (effect, vscode at pinned commits): large TypeScript code bases for build-vs-build graph diffs only (`builds.ts --fetch <dest> corpus/v2.txt regression`). Never in the tables: they break v1's size rule and would dominate a micro average. |
| `benchmarks/pycg.ts` | Indexes each PyCG micro-benchmark snippet and reports per-category recall (expected project edges present) and extra edges. `--subject` picks the tool; names map through definition spans, not qname format. Guessed edges (any provenance) never count as hits or extras; expected edges only a guess would satisfy are counted per category as `guessOnly` (SPEC §4). `PYCG_VERBOSE=1` also lists passing snippets. |
| `tools/fetch-benchmarks.sh` | Clones the third-party benchmarks at pinned commits into `~/.cache/graph-assay/oracle/bench/`. |

### Oracle buckets

| Bucket | Meaning | Usually |
|---|---|---|
| `ok` | SCIP's definition lies inside codegraph's target | agreement |
| `wrong-target` | SCIP resolves to a different project definition | **bug candidate** |
| `external` | SCIP resolves outside the project (a library, `lib.d.ts`, the stdlib), but codegraph linked a project node | **bug candidate** (fabricated edge) |
| `local-shadow` | SCIP says the name is a local binding, but codegraph linked a project global | **bug candidate** |
| `receiver-fallback` | codegraph linked the receiver object for a member it couldn't find (`db.insert()` → `db`) | codegraph convention |
| `local-module-alias` | a local bound from `import()` or `require()`; codegraph followed it into the module | fine |
| `scip-local-undefined` | SCIP has a local with no definition (usually an indexing gap) | check the indexing |
| `no-scip-ref` | no SCIP reference with that name on that line | alignment gap |
| `outside-scip` | the source file isn't in the SCIP index (outside the tsconfig `include`) | excluded |
| `cross-file-unimported` | Python: a bare-name call linked into another file that the caller never imports (checked by import text, including function-local imports and packages) | **bug candidate**; the shape of #3230–#3232 and #2958 |
| `ok-other-column` | the name appears twice on the line and the other occurrence agrees | agreement (column alignment) |
| `ok-overload-set` | Python: every SCIP definition of the symbol is an `@overload` stub above the target, same file and name (scip-python defines at the first stub; code-graph-rag keeps only the implementation) | agreement (SPEC §4 overload set) |
| `noise:pytest-fixture-param` | Python: SCIP sees a parameter, codegraph links the `@pytest.fixture` it receives | deliberate (`isFixtureInReach`) |
| `noise:scip-unresolved-module` | SCIP points at a module symbol (`pkg.mod/__init__:`) because pyright couldn't resolve the import | SCIP gap |
| `noise:scip-shorthand-property` | SCIP defines the name at an object literal's shorthand property (`return { buildMember }`); codegraph links the function itself | SCIP artifact |
| `noise:scip-builtin-shadowed` | Python: SCIP says builtin, but the caller's own file defines the name at module level (`class ReferenceError(ValueError)`) and codegraph links that | SCIP gap |
| `noise:external-target-outside-scip` | SCIP says external, but it never indexed codegraph's target file (`.mjs`, allowJs) | SCIP gap |

Two alignment rules apply before any verdict: a same-named SCIP definition up to two lines above
codegraph's target start counts as the target (codegraph starts `const x =\n  (…) =>` at the arrow),
and a member call whose member SCIP left unresolved is `no-scip-ref`, never compared against a
same-named argument. A receiver fallback through an aliased import (`x as y`, then `y.forEach()`)
counts as `receiver-fallback`.

A disagreement's bucket key is `verdict|kind|resolvedBy|<codegraph target kind>><SCIP symbol kind>`.
`out.json` keeps every disagreement under `samples`, and under `groups` the same edges grouped by
(codegraph target, SCIP definition), largest first; one group is usually one cause. `ORACLE_SHOW=N`
prints the top N groups per candidate bucket. `skipped` counts what never reached a bucket, by
reason (`guessed:<provenance>`, `no-site-line`, and each `skip-*` rule), for the coverage waterfall
(SPEC §7). Only edges with no provenance are bucketed: codegraph `heuristic` and code-graph-rag
`heuristic` / `overload` edges are guesses (SPEC §4). code-graph-rag links a call to the anonymous
callback passed at that site (`main().catch((err) => ...)` -> `anonymous_21_13`); those edges land in
`skipped.skip-framework-self-site`. Python edges to `__init__` (code-graph-rag
links `Foo()` there, codegraph to the class) are compared at the class name against the enclosing
class's span (rule `ctor-init`, SPEC §4 constructor). `oracle/test/py-overload` is frozen from
code-graph-rag (`"subject"` in its case.json; `regen.ts` honours it).

An edge counts for a call only when its target node is named like the callee (the last descriptor of
the SCIP symbol), not merely when the node's span contains the definition: an `instantiates` edge to
class `Req` on `pkg.Req().prepare()` does not carry `prepare` (rule `callee-name`, SPEC §2; a
constructor node stands for its class). In missing-edge mode each edge carries at most one call site:
same-line edges are assigned first in SCIP document order, then edges within 3 lines, nearest first
(rule `one-edge-per-unit`, SPEC §6), so `r.name("a").name("b")` with one edge has one `found` site.
`oracle/test/py-multiplicity` pins both.

### Missing-edge causes

| Cause | Meaning | Usually |
|---|---|---|
| `found` | a non-heuristic edge carries the call | agreement |
| `found-heuristic-only` / `found-other-line` | only a synthesized edge, or an edge within 3 lines (a call written over several lines) | fine |
| `receiver-fallback` / `wrong-edge` | a same-line edge links the receiver, or goes to another definition | the forward oracle's domain |
| `unresolved-ref` | codegraph kept an unresolved reference for that name on that line | **bug candidate** (missing edge) |
| `no-ref` | codegraph extracted nothing for the call | **bug candidate** (extraction gap) |
| `target-not-a-node` | codegraph has no node of that name at the definition (instance attributes, nested type literals) | usually by design |
| `file-not-indexed` / `target-file-not-indexed` | codegraph has no nodes for one side's file | a miss (SPEC §5: the denominator never depends on the subject) |

`@decl` marks a definition with no body (a `.d.ts` file, a type literal or interface member). Those
are calls through an interface-typed receiver; they count in the headline and are also shown alone (the
tables' `@decl found` column). Decorator sites (`@d`, `@d(...)`) never enter the buckets: rule
`decorator-column` scores them into `decorators` in `out-missing.json`, matched by a same-line call
edge or a `decorates` edge from either end (SPEC §4), and the tables show `decorators found`. Skipped
before counting: an object literal's method shorthand (`register(on) {`), and (TS) a type used
without `new`.

### Function-pair track

Missing-edge mode also scores the function-pair track (SPEC §3) into `pairs` in `out-missing.json`.
A unit is a (caller, callee) pair, counted once however many calls carry it.

- **Callee** `D`: the call site's SCIP symbol; a constructor (`X#__init__().`, TS `` `<constructor>` ``)
  stands for its class on both sides.
- **Caller** `C`: the innermost oracle definition around the site (a SCIP function, class, method or
  function-valued variable or property), else the file. A definition's range is its SCIP
  `enclosing_range`, starting at the definition's own line, because decorators run in the enclosing
  scope (scip-python's range includes them). Where the indexer writes no range, in brace languages
  only, the body is found by brace matching from the definition's name: a Go/Java method followed by
  `(` or `[`, or a TS/JS variable or property assigned a `function` or `=>` with a block body.
  `callerRanges` records how many ranges came from each source. Measured on the recorded indexes:
  scip-python 0.6.8 writes ranges for every function and class; scip-typescript 0.5.2 for functions,
  classes, methods and function-valued variables, but not property functions
  (`View.prototype.lookup = function lookup`); scip-go 0.2.8 none. SCIP locals are never callers, so a
  call in a nested local function belongs to the function around it. A call in an anonymous callback
  belongs to the innermost named definition, else the file (`unitsAtFileLevel`; express has 286 of 291).
- **Subject pairs**: every non-guessed call or instantiation edge, with or without a site line. The
  source node maps to the caller definition it holds (same name; span as SPEC §2), else to the one
  around its start, else the file. The target node maps to the definition it holds, the one nearest
  its start. An edge with an endpoint the oracle never indexed is counted in `unmappedEdges`.
- **Scoring**: recall = matched ÷ oracle pairs. A subject pair the oracle lacks is judged only where
  the oracle answers for it: some SCIP reference named like the callee lies inside the caller (a
  project, library or defined local symbol). Otherwise the pair is `oracleSilent`, unaligned, like a
  call-site edge with no SCIP reference. Precision = matched ÷ (matched + `oracleDisagrees`).
  A pair only decorator sites carry goes to `decorators`; a pair only skipped call sites carry is
  `skipped`; a pair only guessed edges carry, and the subject lacks, is `guessOnly`. Neither variant
  of the call-site track's noise and line-window rules applies, so the track has one score.

Self-test cases may reuse another case's inputs (`"inputs"`), drop every site line (`"dropLines"`) and
patch the frozen snapshot (`"patch"`: drop, retarget or add a call edge) to give the oracle a subject
error no real subject makes on the case. `py-pairs`, `py-pairs-nolines`, `py-pairs-cgr` and `js-pairs`
pin the track.

### Metamorphic relations

| Relation | Change | Must hold | Diffs |
|---|---|---|---|
| `decoy` | `zz_cg_decoy/` defines names from a lexical source call/class inventory as unimported functions, classes and methods for Python/TS/JS; both subjects receive identical bytes | nothing links into decoys; no original edge is lost; zero names is N/A | `CAPTURED`, `LOST`, `GAINED` |
| `shift` | 3 blank lines at the top of every Python / TS / JS file (after a shebang or coding line) | the same edges, lines +3 | `MOVED`, `LOST` (a line-based rule changed its answer) |

Known noise on the candidate buckets, which you should rule out before filing:
- module-level aliases (`_mac = _linux`);
- a name defined twice in one scope (codegraph takes the later definition, which is what runs);
- parameters whose default is the module function;
- untyped parameters, where codegraph's name-based guess is deliberate.

## API Integrations

None. Everything runs locally; code-graph-rag indexes with the network unshared, as do codegraph and codebase-memory-mcp where `unshare` works. `gh` is used by hand, outside these scripts, to file issues.

## Configuration

| Variable | Read by | Purpose | Default |
|---|---|---|---|
| (all paths) | `lib/config.ts` | Every path below resolves there: environment variable, then `~/.config/graph-assay/config.json` (same key names as `bin/graph-assay config` prints), then the defaults below | |
| `CGQA_SUBJECT` | `oracle/run.sh` | Subject to index with (`code-graph-rag` uses work dir `w-<name>-code-graph-rag` and hands the oracle a snapshot; SCIP indexes are shared) | `codegraph` |
| `ORACLE_SNAPSHOT` | `oracle/oracle.ts` | Read the subject's graph from this snapshot file instead of exporting one from `<repo>/.codegraph` | unset |
| `ORACLE_ALLSITES=1` | `oracle/oracle.ts` | List every compared site, with its bucket and target, in `out.json` (`run.sh` sets it; baselines keep them) | unset |
| `ORACLE_DISABLE` | `oracle/oracle.ts` | Comma-separated rule names (`on('<rule>')`) to switch off; the self-test `--mutate` pass uses it | unset |
| `SCIP_BIN` | `oracle/oracle.ts` | Path to the `scip` CLI (a decoded `.json` index needs none) | `~/.local/share/graph-assay/tools/scip` |
| `ORACLE_LANG` | `oracle/oracle.ts` | Source languages to check: `python`, `jvm` (Java and Kotlin), or unset for TS/JS | TS/JS |
| `CODEGRAPH_BUILD` | `oracle/run.sh` | The codegraph.js to test | `~/.cache/graph-assay/subjects/codegraph/dist/bin/codegraph.js` (build one with `tools/build-codegraph.sh`) |
| `ORACLE_WORK`, `ORACLE_SCIP_CACHE` | `oracle/run.sh` | Work dirs (`w-<name>/`); cached SCIP indexes, keyed by repo HEAD sha, language, project dirs, SCIP tool version and the TS coverage mode | `~/.cache/graph-assay/oracle/{work,scip}` |
| `ORACLE_TOOLS` | `oracle/run.sh` | The scip-typescript / scip-python / scip-go install (`tools/setup-oracle-tools.sh`) | `~/.local/share/graph-assay/tools` |
| `ORACLE_SHOW` | `oracle/oracle.ts` | Top groups to print per candidate bucket (`run.sh` sets 3) | 0 |
| `ORACLE_EXCLUDE` | `oracle/oracle.ts` | Comma-separated path prefixes of vendored or generated code (the corpus `exclude` column; `tools/repro.ts` passes it): calls from or to them are skipped as `corpus-exclude`, and `waterfall.excluded` counts their files (SPEC §1, §7) | unset |
| `ORACLE_SUBJECT_FAILED` | `oracle/oracle.ts` | Set by `run.sh` when the subject timed out, crashed, exited non-zero or wrote an invalid snapshot; the oracle then runs against an empty snapshot (every SCIP site a miss) and records `subjectFailed` in both outputs, which the tables score as misses and list (SPEC §8) | unset |
| `ORACLE_TARGETS` | `differential/shadow.ts` | Targets file for repo names in `questions.json` | `oracle/targets.txt` (git-ignored; see `oracle/targets.example.txt`) |
| `GRAPH_ASSAY_LABEL_SANDBOX=1` | `labels/run.ts` | Declares that labellers run in a container or VM; without it (or `--unsafe-host`) the run refuses to start (SECURITY.md) | unset |
| `CGQA_HARNESS` | `labels/labellers.ts` | Checkout of the harness runtime the `kimi-k3` / `glm-5.3` labellers run in; only labelling needs it | unset |
| `CODEGRAPH_KERNEL=0` | codegraph itself | Force the WASM extraction path; also check the native kernel before filing | native when present |

## Deployment

Nothing deploys. The oracle tools live outside the repo: `tools/setup-oracle-tools.sh` installs the pinned SCIP indexers, the Docker reproduction pins all of them, and scip-java runs as the `sourcegraph/scip-java` Docker image.

## Docker reproduction

`Dockerfile` and `tools/repro.ts` reproduce the v1 **dev** call-site tables with
the existing oracle, replay, PyCG and `bench/tables.ts`. The image supports
Linux amd64; Python wheel hashes and SCIP binary checksums deliberately target
that platform. No new harness runtime dependencies are added. `rsync` is needed by
the Python oracle wrapper, GNU `time` supplies resource columns, and `util-linux`
supplies the adapter's existing `unshare` isolation.

| Component | Pin | Source / rationale |
|---|---|---|
| Node | `22.23.2-bookworm`, digest `sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844` | Version matches `.github/workflows/ci.yml` for `node:sqlite`; digest queried from Docker Hub Registry v2 for `library/node`. npm is fixed by this image. |
| Python | `3.12.12-bookworm`, digest `sha256:c0abd0758831ad99b7a29e0c1a875da9c4abb9a2e3f21e2eeb585dbcadfb6cd0` | Docker Hub `library/python`; 3.12 matches the benchmark subject venv. pip is fixed by this image. |
| Go | `1.25.4-bookworm`, digest `sha256:e17419604b6d1f9bc245694425f0ec9b1b53685c80850900a376fb10cb0f70cb` | Docker Hub `library/golang`; explicit Go runtime for scip-go and mux. `GOTOOLCHAIN=local` prevents automatic toolchain upgrades. |
| Debian additions | `20251118T000000Z`, bookworm/main | [Debian snapshot](https://snapshot.debian.org/archive/debian/20251118T000000Z/) freezes the apt index and complete dependency resolution; other OS files are fixed by image digests. |
| scip-python / scip-typescript | `0.6.8` / `0.5.2` | Versions and transitive tree from the machine's existing oracle npm lock; `docker/package-lock.json` retains registry integrity hashes, with exact root versions in `docker/package.json`. Installed with `npm ci --ignore-scripts`. |
| scip-go | `0.2.8`; archive SHA256 `22d6d55b85341c650e92fc278a62cc4c57dc5800c386e199c2b999f8605dd32a` | Existing benchmark version; checksum from the [public release asset API](https://api.github.com/repos/scip-code/scip-go/releases/tags/v0.2.8), verified before extraction. |
| SCIP decoder | `0.10.0`; archive SHA256 `eeb28ebbff443c01609fb1691809958f3f0c7a8651af689a5bc8560061cd8ab0` | Existing machine's `scip --version`; checksum from the [public release asset API](https://api.github.com/repos/scip-code/scip/releases/tags/v0.10.0). Required by `lib/scip.ts` for `scip print --json`. |
| codegraph | upstream commit `f72c9d2efb14454ff4f9fd7b8460abd82f19a287` | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph/commit/f72c9d2efb14454ff4f9fd7b8460abd82f19a287), CI's known build pair. `npm ci` uses that commit's lock, then `npm run build`; WASM extraction (`CODEGRAPH_KERNEL=0`). |
| code-graph-rag | `0.5.0`, `treesitter-full` | [PyPI release](https://pypi.org/project/code-graph-rag/0.5.0/), matching SPEC's subject spike. `docker/requirements.lock` freezes the existing benchmark venv's transitive versions and PyPI wheel SHA256s (pip report, CPython 3.12/amd64). `--require-hashes --only-binary=:all:` rejects drift and source builds. Provider SDKs are upstream dependencies; the runner invokes no model. |
| codebase-memory-mcp | `0.12.1`; archive SHA256 `8453015145f072c1b9b019cbdd02cea8cc6f18cc5e116036dd20992631c638c7` | [Release v0.12.1](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1) linux-amd64 asset; checksum from the release's `checksums.txt`. `tools/setup.sh` checks it before extraction (`--no-cbm` skips; other platforms are not pinned). Not in the Docker reproduction yet. |
| Corpus | SHAs in `corpus/v1.txt` | Preregistered inputs, unchanged. Ky's upstream has no lock: `docker/ky-package-lock.json` freezes the dev benchmark's installed tree (npm's hidden lock plus the pinned repo's root package metadata). Installed with `npm ci --ignore-scripts`; no corpus build scripts run. Other dev entries need no setup. |
| PyCG | `8d5dc40837803beef1d8d379fbf2cdad6cd94641` | Same public source pin as `tools/fetch-benchmarks.sh`; snippets are input data. |
| Bootstrap | seed `1`, 2000 resamples | Existing `bench/tables.ts` defaults; the runner passes the seed explicitly. |

All three image digests were resolved from Docker Hub on 2026-11-06. Immutable
digests, release checksums and committed dependency locks govern rebuilds; tags
and version ranges alone do not. npm/PyPI registries, GitHub and the Debian archive
must remain reachable. The build context is allowlisted by `.dockerignore` and
excludes host Git metadata, configuration and caches.

The runner configures `/opt` tools and `/results` outputs through existing config
environment overrides. It requires a fresh output directory, stops on an indexing
failure, and retains logs and a failed manifest instead of emitting a success
table. A subset run writes a selected corpus so the table does not claim to cover
the whole dev split. The manifest hashes scorer/input files directly because the
image has no harness `.git` directory. Scoring rules and historical results remain
unchanged. Time, memory and generated dates are observations, not reproducible
constants; the host kernel also remains visible in the platform record.

T3 provenance also includes `differential/modes.ts`, the repeat comparator, and `differential/package.json`, which makes it load as an ES module; the manifest also hashes `tools/package.json`, the marker for the entry point `tools/repro.ts`. `tools/repro-test.ts`
checks runtime imports against the Docker allowlist and runs the real canonical orchestrator/table
code with offline subject shims, including expected differences and failed-index manifests.

Oracle noise is recomputed from the committed labels snapshot (`labels/data/`,
every sample pooled) with `labels/noise.ts`; no labeller or credentials belong in
this path. It covers the whole labelled sample whatever `--repo` selects. Heldout and JVM targets are outside this entry point's scope.

Run it from a clean clone (Linux amd64):

```sh
docker build --platform linux/amd64 -t graph-assay-repro .
mkdir -p repro-results
docker run --rm --security-opt seccomp=unconfined \
  -v "$PWD/repro-results:/results" graph-assay-repro --split dev
```

Add `--repo mux` (or `--repo requests`) for a smoke run: T1 replay, PyCG and T3 still run in full;
T2 covers only that repo. Each run needs an empty output directory. Results land under `/results`:
`tables.md`, `tables.json`, `t1/`, `t3/`, the oracle `work/`, `logs/` and `manifest.json`.
code-graph-rag's adapter isolates indexing with `unshare -rn`, which Docker's default seccomp
policy blocks; hence `seccomp=unconfined`. No host credentials or Docker socket are mounted.

## Maintenance Commands

- Type check: `npm ci --ignore-scripts` once per checkout (dev dependencies only), then `node bin/graph-assay check` includes `tsc -p .` over the TypeScript scripts (`tsconfig.json`'s `include`); `npm run typecheck` runs it alone. Keep both at zero errors; fix with TypeScript annotations that leave runtime behaviour unchanged (erasable syntax only: Node strips the types, it does not compile them). `node --check` parses a `.ts` file as plain JavaScript, so `check` syntax-checks `.mjs` files with it and leaves the `.ts` scripts to tsc.
- Oracle on every repo in a targets file (copy `oracle/targets.example.txt` to `oracle/targets.txt`; clone, subject index, cached SCIP index, oracle):
  `CODEGRAPH_BUILD=<codegraph.js> oracle/run-all.sh [targets file]`; one repo: `oracle/run.sh <name> <src> <ts|python|go|jvm> [ts project dirs...]`. `go` runs scip-go at the repo root (needs `go.mod` there and `go` on PATH); `jvm` runs `oracle/scip-java.sh`, which builds the project with Maven/Gradle inside Docker.
- Filed-bug fixtures against a build: `node fixtures/replay.mts <codegraph.js>`; another subject: `node fixtures/replay.mts --subject code-graph-rag default` (`default` = the subject's configured build). Endpoints match tool-neutrally (`lib/expect.ts` `present`): same last name, and container chains equal after dropping, from the longer one, leading segments that name no definition in that file (so `p::App::run` matches `App::run`, but `a::helper` never matches a top-level `helper`). `GUESSED` = a wrong edge is present only as edges the subject marks guessed (SPEC §4).
  Add `CODEGRAPH_KERNEL=1` to replay on the native kernel.
  Add `--canary --json replay.json` to compare each fixture with an anonymous copy carrying fresh
  marker comments; exit nonzero on changed verdicts, graph-identifier leaks or index errors.
  The Docker reproduction enables this for codegraph; peers can opt in explicitly.
  code-graph-rag's own findings are a separate set: `--root fixtures/cgr-candidates`; codebase-memory-mcp's:
  `--subject codebase-memory-mcp --root fixtures/cbm-candidates`.
- Native kernel without cargo: `tools/build-kernel-docker.sh <codegraph checkout>` (Docker, about 2 minutes;
  stages `codegraph-kernel/prebuilds/linux-x64/codegraph-kernel.node` and checks it loads).
- Oracle on a TS repo by hand:
  `scip-typescript index --output x.scip`, then `node oracle/oracle.ts <repo> x.scip out.json`.
- Oracle on a Python repo:
  `oracle/scip-python.sh <repo> x.scip`, then `ORACLE_LANG=python node oracle/oracle.ts <repo> x.scip out.json`.
Indexing large repos is memory-hungry. Run one index at a time; `oracle/run.sh` already runs SCIP under `nice -n 10`.

## Known Limitations

- **scip-typescript only indexes what a tsconfig `include`s.** `oracle/run.sh` therefore indexes a repo
  with a root `tsconfig.json` through `oracle/ts-cover.ts`'s project, which extends it and lists every
  tracked TS/JS file (`allowJs`, `noEmit`). The project is written at the repo root
  (`tsconfig.graph-assay-oracle.json`, untracked, removed after indexing), because TypeScript resolves `types`
  and `@types` from the top config's directory. Files the repo's own config leaves out, such as ky's `test/`
  and `test-d/`, are compiled with the root config's options. A repo without a root tsconfig still
  needs its nested tsconfigs passed in, and project dirs given on the command line are indexed as given.
- **f-string and template-literal calls often land in `no-scip-ref`,** because the columns don't line up.
- **Adapter conformance covers codegraph only.** `lib/conformance.ts` imports the codegraph adapter directly.
- **`scip-java` builds the project.** That runs the project's own build plugins, so it only runs inside
  the pinned container.

## Scoring operations and history (moved from SPEC v0)

SPEC v1 keeps only scoring semantics. These operational details and history notes were in SPEC v0 and are kept here verbatim; section references inside them are to SPEC v0.

### T3 mechanics

**T3 robustness:** `bench/tables.ts --t3 <dir>` reads `meta-cg.json` and `meta-cgr.json` independently
of T1/T2 accuracy. The unit is one seed/relation run: `clean / eligible`, changed graphs, execution
errors, not-applicable transformations and unverified legacy evidence are reported separately.
Errors remain in the eligible denominator; N/A and unverified rows are excluded. Missing evidence
is `NOT RUN`, never a passing rate. Fixture seeds are a selected defect corpus, not a representative
sample of all projects or a general tool ranking.

`metamorphic/relations.ts` constructs identical decoy bytes from a deterministic lexical source
call/class-token inventory, not a subject's extracted nodes or unresolved names. Comments/strings
may contribute candidates; this is not a semantic parser. Valid ASCII identifiers and language-specific reserved-word/type-name
filters keep generated Python/TS/JS definitions syntactically usable. Empty inventories and
unsupported shift languages are N/A. Each run records `challengeSha256` over supported source bytes,
transformed bytes and the transformation implementation, independent of installation path.

The default relations are `decoy`, `shift`, `repeat`. Decoy/shift retain span-based edge multiset
comparison; repeat compares the full canonical graph using the execution-mode comparator. A repeat
may be graph-stable while raw ids or row order differ: `byteIdentical` hashes the capabilities/files/
nodes/edges/unresolved payload, excluding run metadata, and is reported separately. Setup failures
produce errors for every requested relation. A legacy run without a challenge fingerprint is
unverified; an empty legacy decoy challenge is N/A.

Tables preserve input adapter/challenge hashes and compare paired fingerprints. `--canonical` requires T3 inputs even if `--t3` was omitted. Canonical T3
requires a complete seed-by-relation matrix for both subjects, no execution errors or unverified
rows, and no unknown, mismatched or unpaired challenges. Canonical reproduction runs T3 for both
subjects: metamorphic exit 1 is recorded graph differences, while exit 2 fails reproduction with
logs and a failed manifest. These measurements do not change T1/T2 scores or effect-size thresholds.

### Build-vs-build effect-size gate

**Build-vs-build effect-size gate** (`oracle/baseline.ts diff`, codegraph only):

| Metric | Material drop (REGRESSION); gains use the same thresholds |
|---|---|
| T2 strict precision or recall, per repo | At least 1.0 percentage point **and** at least 3 sites |
| T2 strict precision or recall, micro over comparable repos | At least 0.5 percentage point |
| T1 fixture verdict | Any `FIXED` -> `BROKEN`, `CHANGED` or `GUESSED`; the reverse is an improvement |
| T1 PyCG micro recall | At least 0.5 percentage point |

Thresholds are inclusive. For precision, whose denominator can change with the subject, the
site count for a drop is the larger of lost matches and added mismatches (reversed for a gain).
This counts a match becoming a mismatch once and also catches newly added wrong edges. Recall's
denominator is fixed by SCIP, so its site count is simply the change in `found`.

A repo whose missing-mode total changed is `INCOMPARABLE` and excluded from both micro pools
and per-repo gating: its oracle inputs changed. Missing repos or modes are also incomparable;
an undefined rate (zero denominator) is left out of that metric on both sides. Missing or errored
fixtures, absent PyCG runs, and changed PyCG expected totals are reported as incomparable too.

Overall: `REGRESSION` if any drop triggers, otherwise `IMPROVEMENT` if any gain triggers,
otherwise `NO MATERIAL CHANGE`. Every raw change is still printed. `--fail-on-regression` exits
1 only for a regression (diff errors exit 2); `--json gate.json` saves the verdict, triggers and
incomparables. a caller can use the flag and record the result in its manifest
under `gate`, separately from `stages`; a completed diff has stage status 0 even on a regression.
Without an earlier baseline the manifest gate is `NOT COMPARED`.

These are owner-selected alert sizes, not statistical significance: codegraph's repeat runs were
identical (P1b), so the floor controls materiality rather than sampling noise. The per-repo rule
keeps a small repo's break visible when large repos dominate micro averages; three sites suppress
single-site per-repo alerts. The micro rule catches smaller shifts spread across repos. Inputs
are assumed pinned as in the upstream loop; full corpus/scorer identity gating and peer-subject
gating are deferred. `lib/scores-test.ts` pins the boundaries and CLI behavior in `graph-assay check`.

### Oracle-noise labelling and history

**Oracle noise (§5, measured):** a stratified sample of call sites (agree, disagree, SCIP-only,
subject-only) is labelled blind by two models from different families (Claude Opus, GPT Sol), each
with read-only access to the repository and a shuffled, unattributed multiple choice (`labels/`).
Where both answer and disagree, a third model (GPT Astra) is asked; truth is a 2-of-3 consensus
(`cannot tell` never counts), and a site with none is `no-consensus`, reported with its rate and
never imputed. Astra shares Sol's family, so the tables report how often it sides with each.
Labellers are qualified first on known-answer fixture items, and their accuracies are published with
the noise rates (including the two candidates not used, Kimi and GLM).

**Diagnostic languages:** a language whose oracle is too noisy to score against is diagnostic: its
repos are shown per repo, marked, and left out of the T2 averages. The rule is mechanical: the 95%
Wilson lower bound of "SCIP right where it answers" in the labelled sample is under 80%
(`labels/score.ts` `diagnosticLanguages`). A rule change that lifts a language back needs a fresh
sample, never the one that found the noise: the new sample's `meta.json` retires that language's
items from the earlier one when samples are pooled.

History: on samples v1+v2 JavaScript was diagnostic (28/47, lower bound 45%): in missing-edge mode
SCIP stops at CommonJS member aliases (`Router = express.Router`, `var basename = path.basename`),
where no subject should link. The oracle now skips those sites in missing-edge mode only
(`skip-module-member-alias`; forward mode still scores them, since a subject linking such a call to
an unrelated same-named function is a real error). Fresh sample v3 (express, seed 2, no v2 site):
SCIP right 25/25 where it answers, lower bound 87%, so JavaScript is scored again. Those 25 are all
`agree` sites: the sample has no JavaScript site where SCIP answers and a subject disagrees, so it
says little about SCIP on wrong-target sites. Python 89%, Go 92%, TypeScript 86%.

### Adapter provenance, canonical runs and determinism

**Adapter provenance:** fresh snapshots record `subject.adapterSha256`; fixture, PyCG, metamorphic,
oracle and differential JSON results record `adapterSha256`. `lib/provenance.ts` hashes the subject
adapter and shared registry, configuration implementation, snapshot implementation/schema and hash
helper, using relative paths and file bytes. The hash is independent of installation path and Git
metadata; a local edit changes it. It identifies adapter code, not the subject build or runtime
configuration, which remain separate inputs. Run/reproduction manifests record it too.

The oracle preserves the loaded snapshot's hash; baseline summaries and tables preserve their
inputs' hashes. Legacy inputs have unknown provenance (`null`), never today's hash. Tables retain
both forward/missing hashes and show mixed/unknown inputs; T1 hashes are recorded separately.
Frozen snapshot v1 inputs without the optional field remain valid.

**Canonical tables** come only from `tools/repro.ts` in the Docker image (`bench/tables.ts
--canonical`); any other run is a development run and says so. Measured 2026-11-07 on the dev split,
host vs image: T1 and oracle noise identical, codegraph identical except one click site where
scip-python 0.6.8 resolves a standard-library call on the host and not in the image (the Python
environment is an input), and code-graph-rag within its own run-to-run variation.

**Determinism:** code-graph-rag 0.5.0's guessed edges vary between runs of one build in one
environment (three fresh indexes: ky 72,050 / 72,043 / 72,042 edges, requests 156 / 156 / 155
guessed). Guessed edges are not scored, but one can move a site in or out of guess-only; the effect
is about 0.1 point, under the tables' precision, so a single run is reported and the variation is
noted. codegraph's repeat runs were identical in the P1b execution-mode differential (`graph-assay modes`).

### Canary mechanics

Fixture replay reads expectations outside the indexed copy. Copies exclude `expect.json`, stale
subject outputs, Git and agent-control files; symlinks are rejected rather than allowed to expose
evaluation answers. Ordinary fixture verdict and guessed-edge rules are unchanged.

`fixtures/replay.mts --canary` also indexes an anonymous directory copy with a fresh marker in
comments appended to supported source files. Existing source coordinates, filenames and symbol
names stay intact. It compares the original and canary fixture verdicts and checks that the marker
does not appear in graph node names/qualified names, edge references or unresolved names. JSON
records `canaries` separately from fixture verdicts: `PASS`, `FAIL` (changed verdict or marker leak),
or `ERROR` (including indexing failure or no supported source files). Any failed/errored canary or
empty fixture selection makes replay exit nonzero, even when the original fixture is `FIXED`.
PHP supports a single open block or a trailing closing tag (a fresh block holds the marker);
ambiguous mixed PHP/HTML templates fail explicitly rather than guessing the comment's lexical state.

Canonical reproduction runs codegraph canaries.
Peer canaries remain opt-in because code-graph-rag's guessed edges vary between runs. Baselines
retain canary results, and a `PASS` -> `FAIL`/`ERROR` transition regresses (the reverse improves);
a missing canary run is incomparable. Fresh markers and anonymous directory names probe accidental
leakage and fixture-directory dependence; they do not prove freedom from benchmark memorization.
Held-out rotation and source-file/symbol renaming remain future work.

### Decided 2026-11-04 (SPEC v0)

1. Decorator applications count as calls in v0 (PyCG does too).
2. Columns stay in each oracle's own position encoding; the encoding is recorded per run.
3. Calls in test code are scored with the rest and also reported as a separate slice.
4. The 3-line tolerance is provisional until measured on the corpus (P3).

### P0 subject spike (SPEC v0 Appendix A)

GO. Installed with `code-graph-rag[treesitter-full]==0.5.0` (without `treesitter-full`, TS and Go
files become File nodes with no definitions). Indexed offline (`unshare -rn`, empty environment),
about 0.3 s per fixture; export via `cgr export -o g.json --repo-path <repo>`.

- Every CALLS / INSTANTIATES edge carries `line`, `col`, `end_line`, `end_col` (col = the callee
  name token, matching §2) and a `resolution` of `exact` or `heuristic`; both endpoints carry
  `path` and `start_line`. 12/12 edges across three fixtures; all map to {file, line, qname}.
- Python fixture: 9/9 edges agree with scip-python, including two codegraph misses
  (upstream codegraph 3240).
- TS fixture: links `parseInt(...)` and `new Response(...)` to an unimported export, as codegraph
  does (upstream 3238), but marks both `heuristic`: §4's synthesized-edge rule keeps them out of
  the main tables, so the rule must map each subject's own provenance flag.
- Go fixture: no edge for `new(Route).Host()`; `r := new(Route); r.Host()` links `Router.Host`
  (`heuristic`). The two subjects fail differently, which is what a benchmark needs.

<!-- docvet:anchors
--canary -> fixtures/replay.mts
--root -> fixtures/replay.mts
--t3 -> bench/tables.ts
CGQA_HARNESS -> labels/labellers.ts
CODEGRAPH_BUILD -> oracle/run.sh
ORACLE_LANG -> oracle/context.ts
ORACLE_SCIP_CACHE -> oracle/run.sh
ORACLE_SHOW -> oracle/context.ts
ORACLE_TARGETS -> differential/shadow.ts
SCIP_BIN -> lib/config.ts
adapterSha256 -> lib/provenance.ts
challengeSha256 -> metamorphic/relations.ts
outside-scip -> oracle/forward.ts
receiver-fallback -> oracle/forward.ts
-->
