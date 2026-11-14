# Code-graph accuracy: scoring semantics (SPEC v1.0)

This document defines the unit being compared, when a subject and the reference agree, how
failures count, and how scores are aggregated and versioned. Every scorer must follow it: the
SCIP oracle, fixture replay, PyCG, the metamorphic relations and the tables. Every adapter must
emit what it requires.

**Status: in force** from 2026-11-11. Results produced under it record `SPEC v1.0`; results from
before it stay labelled SPEC v0 (§12).

"Must" marks a requirement. A result conforms to v1 only if every "must" holds for it. Operational
details (command-line flags, file names, exit codes, the build-vs-build gate, history) are in
TECHNICAL.md and are not part of this specification.

## Terms

- **Subject:** the code-graph tool being scored (for example codegraph, code-graph-rag).
- **Oracle:** the reference a subject is compared with: a SCIP index (T2), hand-verified fixtures
  or PyCG expectations (T1).
- **Definition:** a function, method, class or other callable the project defines.
- **Call edge:** a subject edge of kind `calls` or `instantiates`. Other kinds (`imports`,
  `references`, `contains`, `decorates`, inheritance) are not call edges, except where §4 says so.
- **Guessed edge:** a call edge with any non-null `provenance` in the snapshot (codegraph
  `heuristic`; code-graph-rag `heuristic`, `overload`). A subject's own marking decides this.
- **Unit:** one thing that is counted (§3).
- **Strict / tolerant:** two variants of every T2 score (§5). Strict is the headline.
- **Unaligned:** a unit that has no oracle answer. It is never scored, and is always shown.

## 1. What is scored

- **In scope:** call relations between definitions in the project. These are a function or method
  call, a constructor call (`new X()`, Python `X()`), and a call through a member (`a.b.m()`).
- **Reported separately, not in the headline:** decorator applications (`@d`) (§4) and guessed
  edges (§4). Edges to bodiless declarations (`@decl`, §4) count in the headline and are also
  reported in their own column.
- **Out of scope for v1** (reported, not scored): imports, type references, `contains`,
  inheritance, and calls into libraries or the standard library. An edge to a library can still be
  *wrong* (§5, `external`).
- **Project** means the files of the repository at the pinned commit, minus the vendored and
  generated paths listed in its corpus entry (§7).

## 2. Units and coordinates

- **Lines** are 1-based. A node's span `[start, end]` is inclusive at both ends.
- **Site `S`**: the file and line of the callee's name token at the call (`m` in `a.b.m(1)`, `X`
  in `new X()`). For a subject edge, the site is the edge's own `line`.
- **Column**: 0-based, in the oracle's position encoding (scip-typescript and scip-python use
  UTF-16 code units, scip-go UTF-8 bytes; each run records the encodings). Columns only tell apart
  several calls on one line (§6). Columns in different encodings are never compared: when the
  subject's encoding differs from the oracle's or is unknown, columns are used only on a line of
  ASCII text, where every encoding agrees, and otherwise the oracle's document order decides.
- **Callee `D`**: the definition the call reaches, given by its file, the line of its name token and
  its oracle symbol.
- **Target match.** A subject's target node holds `D` when both of these are true:
  1. **Span:** the node's file is `D`'s file and the node's span contains `D`'s line. There is one
     exception. A node named like the callee may start up to `DEF_SLACK` = 2 lines *below* `D`'s
     line, because a subject may start `const x =\n (…) =>` at the arrow while the oracle starts at
     the declaration.
  2. **Name:** the node's name equals either the definition's name (the last descriptor of the
     oracle symbol, so an aliased import `import { a as b }` still matches `a`) or the name called
     at the site (which covers suffixed or decorated symbol names such as scip-typescript's
     `attendance0:`, `<get>x` or Java's `<init>`). §4's constructor rule also counts as a name
     match.

  A node that only *contains* `D` does not hold it. A class edge on `Req().prepare()` does not
  carry `prepare`.
- **Caller `C`**: the innermost oracle definition whose range contains `S`: a function, method,
  class, or a variable or property whose value is a function. Locals are never callers. A range
  starts at the definition's own line, because decorators and default values above it run in the
  enclosing scope. For module-level code, and for code inside an anonymous function with no named
  definition around it, `C` is the file itself, including a top-level variable whose initializer
  makes the call. Where the oracle writes no range for a definition, a brace language's range is
  the body found by brace matching from the definition's name. Each run records how many ranges came
  from each source.
- **Node identity across runs** (metamorphic relations, build and mode diffs): file, kind and line
  span, never a qualified or simple name. Subjects encode position in names (code-graph-rag 0.5.0
  calls a second `setup` in a file `setup@26`), so a diff keyed on names would report a renamed
  node as a moved edge.

## 3. Tracks

| Track | Unit | Needs from the subject |
|---|---|---|
| **Call-site** | `(S, D)` | the site line of every call edge |
| **Function-pair** | `(C, D)`, deduplicated by caller and callee identity | caller and callee only |

- Both tracks are part of v1. They are reported side by side and never combined.
- A subject without site lines is scored on the function-pair track only. On the call-site track
  its edges are `skipped: no-site-line`.
- A subject pair comes from a non-guessed call edge whose endpoints map to oracle definitions. The
  source node maps to the caller definition it holds (§2), else to the one around its start, else
  the file. The target node maps to the definition it holds.
- Function-pair precision is the number of subject pairs that match an oracle pair, divided by that
  number plus the subject pairs the oracle answers for but does not have. The oracle answers for a
  pair when an oracle reference named like the callee lies inside `C` (anywhere in the file when
  `C` is the file). Where it does not (dynamic
  dispatch, an unresolved import, a local it never defines), the pair is unaligned, as a call-site
  edge with no oracle reference is (§5), and it is shown but never scored.
- Function-pair recall is the number of oracle pairs that some non-guessed subject edge maps to
  (source mapped to `C`, target holding `D`), divided by the number of oracle pairs.
- An edge recorded at its target's own declaration (`skip-framework-self-site`) forms no pair, as
  on the call-site track. Edges with an endpoint the oracle never indexed form no pair. Both are
  counted and shown.
- Pairs carried only by decorator sites go to the decorators column (§4), pairs carried only by
  skipped sites are skipped (§7), and oracle pairs that only guessed edges carry are counted as
  guess-only.
- The track has one variant. Noise rules and the line window `W` are call-site rules, so there is
  no tolerant function-pair score.
- T1 fixtures and PyCG are function-pair by construction: their expectations name a caller and a
  callee, with no site.

## 4. Equivalences (applied before comparison)

| Case | Rule |
|---|---|
| Constructor | An edge to class `X` carries a constructor call `X()` / `new X()`. A node named `constructor`, `__init__` or `__new__` satisfies the §2 name condition for any definition its span holds, and a class node satisfies it for its own constructor. In precision, a Python edge to `__init__` is compared at the class name against the class's span (rule `ctor-init`), unless the site calls `__init__` by name (`super().__init__()`); whether a call is qualified is read from the site's text, never from the subject's reference. On the function-pair track a constructor stands for its class. Inherited constructors are not in v1 for the oracle (§13); PyCG's matching is in §9. |
| Overloads | When the oracle defines a callee at several places (TypeScript overload signatures, Python `@overload` stubs), an edge to any of them, or to the implementation, matches (`ok-overload-set` for the Python stub case). |
| Declaration target | An edge that resolves to a bodiless declaration (a `.d.ts` file, a type-literal or interface member) is tagged `@decl`. It counts in the headline and is also reported in its own column. |
| Decorator | A decorator application `@d` matches an edge from `C` (the definition or file enclosing the decorator line) to `d`, or a `decorates` edge in either direction between `d` and the decorated definition. Decorator sites are scored only in their own **decorators** column, never in the headline. |
| Multi-line call | Strict: the site line must match. Tolerant: in recall, a subject edge to `D` within `W` = 3 lines of `S` matches (`found-other-line`). In precision, another occurrence of the callee on the same line agrees (`ok-other-column`). |
| Receiver fallback | An edge to the receiver (`db.insert()` → `db`) is **not** a match. It is its own verdict (§5). |
| Guessed edges | Guessed edges never count toward a headline score in any tier. They are reported in their own **guessed** column: how many there are, the units found only by a guess (`found-heuristic-only`), and for T1 the expectations satisfied only by a guess. |

## 5. Verdicts per unit

Each unit receives exactly one verdict. An implementation that produces a verdict not in these
tables is in error, and must fail the run rather than leave the unit out.

**Precedence.** Where several verdicts could apply, the first in this order wins.
- Forward: `ok`, `receiver-fallback`, then `scip-local-undefined` or `external` (no oracle
  definition), `local-module-alias` or `local-shadow` (an oracle local), `wrong-target`. A
  disagreement other than `receiver-fallback`, `local-module-alias` or `scip-local-undefined` is
  then refined by the first that applies of `ok-other-column`, `ok-overload-set`, the noise rules
  in table order, and `cross-file-unimported`.
- Missing: `found`, `found-heuristic-only`, `found-other-line`, `receiver-fallback`,
  `wrong-edge`, `file-not-indexed`, `target-file-not-indexed`, `target-not-a-node`,
  `unresolved-ref`, `no-ref`. A guessed edge on the site's own line therefore makes the unit
  `found-heuristic-only` even when a non-guessed edge lies within `W` lines.

**Forward direction (precision)**, one verdict per non-guessed subject call edge with a site line:

| Verdict | Meaning | Strict | Tolerant |
|---|---|---|---|
| `ok`, `ok-overload-set` | the edge holds the oracle's callee (§2, §4) | match | match |
| `ok-other-column` | another occurrence of the callee on the line agrees | non-match | match |
| `local-module-alias` | the oracle stops at a local binding of a dynamic import or require | non-match | match |
| `wrong-target` | the oracle resolves to another project definition | non-match | non-match |
| `external` | the oracle resolves to a library: the subject fabricated a project edge | non-match | non-match |
| `local-shadow` | the oracle resolves to a local binding that shadows the name | non-match | non-match |
| `cross-file-unimported` | Python: an unqualified call linked to a file the caller never imports | non-match | non-match |
| `receiver-fallback` | the edge links the receiver, not the member | non-match | non-match |
| `noise:<rule>` | a documented oracle artifact (rule table below) | non-match | excluded |
| `no-scip-ref`, `outside-scip`, `scip-local-undefined` | no oracle answer at the site | unaligned | unaligned |

Precision = match ÷ (match + non-match). Unaligned units, guessed edges and `skipped` edges are never
in either count, but are always shown.

**Missing direction (recall)**, one verdict per oracle call site (§1), with the denominator fixed by
the oracle:

| Verdict | Meaning | Strict | Tolerant |
|---|---|---|---|
| `found` | a non-guessed edge at the site holds `D` | carried | carried |
| `found-other-line` | such an edge within `W` lines | miss | carried |
| `found-heuristic-only` | only a guessed edge holds `D` | miss (guessed column) | miss (guessed column) |
| `receiver-fallback` | a same-line edge links the receiver | miss | miss |
| `wrong-edge` | a same-line edge for that name goes elsewhere | miss | miss |
| `unresolved-ref` | the subject kept an unresolved reference for the name | miss | miss |
| `no-ref` | the subject extracted nothing for the call | miss | miss |
| `target-not-a-node` | the subject has no node of that name at the definition | miss | miss |
| `file-not-indexed`, `target-file-not-indexed` | the subject has no nodes for the caller's or the definition's file | miss | miss |

Recall = carried ÷ oracle call sites. A unit in a file the subject did not index is a miss: the
denominator never comes from what the subject happened to emit.

**Rules.** Each rule is named, has a self-test that fails when the rule is removed, and belongs to
the spec version. Adding, removing or changing a rule is a major change (§12).

| Rule | Mode | Effect |
|---|---|---|
| `callee-name` | both | §2 name condition |
| `one-edge-per-unit` | missing | §6 assignment |
| `ctor-init` | forward | §4 constructor: a Python `__init__` target is compared as its class |
| `ok-overload-set`, `ok-other-column`, `local-module-alias`, `cross-file-unimported`, `found-other-line`, `decl-tag` | as in the verdict tables | produce the verdict or tag of the same name |
| `receiver-fallback` | forward | produces the forward verdict; the missing-direction cause of that name is a plain verdict, not a rule |
| `corpus-exclude` | both | a unit from or to a path the corpus entry excludes (§1) is skipped |
| `noise:scip-shorthand-property` | forward | the oracle defines the name at an object literal's shorthand property |
| `noise:scip-builtin-shadowed` | forward, Python | the oracle says builtin, but the caller's own file defines the name at module level |
| `noise:pytest-fixture-param` | forward, Python | the oracle sees a parameter, and the subject links the `@pytest.fixture` it receives |
| `noise:scip-unresolved-module` | forward | the oracle points at a module symbol because it could not resolve the import |
| `noise:external-target-outside-scip` | forward | the oracle says external, but never indexed the subject's target file |
| `skip-framework-self-site` | forward | an edge recorded at its target's own declaration (a framework route) is skipped |
| `skip-type-without-new` | missing, not Python | a type followed by `(` without `new` is not a call (a TS type position, a Go conversion `T(x)`) |
| `skip-method-shorthand` | missing, not Python | an object literal's method shorthand opening is not a call (the pattern occurs only in TS/JS) |
| `skip-external-module-binding` | missing, not Python | the definition is a binding of an installed package's `require` (TS/JS only in practice) |
| `skip-module-member-alias` | missing, not Python | the definition is a binding to a member of a required module, where the oracle stops (TS/JS only in practice) |
| `decorator-column` | missing | decorator sites are scored in the decorators column (§4), out of the headline |

Skip rules remove a unit from both variants and are counted in the waterfall (§7). Noise rules apply
only to the tolerant variant. The labelled oracle-noise sample (§9) measures how often each is right.

## 6. Multiplicity

- Units are multisets. Two calls to the same callee on one line are two units if the oracle's
  columns separate them, and one unit otherwise.
- A subject edge can satisfy at most one oracle unit. Same-line edges are assigned first, in the
  oracle's document order, then edges within `W` lines, nearest first. The assignment is greedy,
  not a maximum matching.
- Guessed edges are never assigned. One guessed edge can therefore mark several units
  `found-heuristic-only`.
- In the forward direction each subject edge is already one unit.
- Function-pair units are sets: a pair is counted once, however many edges or sites carry it.

## 7. Coverage waterfall (published with every score)

Per subject and repository, the count at each step and the reason every unit dropped:

`files in corpus` (after the corpus entry's vendored/generated exclusions) → `in a supported
language` → `indexed by the subject` → `indexed by the oracle` → `units aligned` → `units scored`

Each step must also be published:
- Forward: call edges, `skipped` by reason (`guessed:<provenance>`, `no-site-line`,
  `corpus-exclude`, each `skip-*` rule) and unaligned edges.
- Missing: oracle call sites by verdict, skipped sites by rule, and decorator sites.
- Function pairs: oracle and subject pairs, matched, disagreeing, silent, skipped, decorator-only and
  guess-only pairs, and the edges that formed no pair (unmapped or skipped).
- Index wall time and peak memory sit beside them.

A unit lost at any step must be named in the waterfall, never silently dropped from a denominator.

The oracle indexes every tracked file in a supported language, not only those a build
configuration includes. A repository whose TypeScript config leaves files out, such as test
folders, is indexed through an extra project that extends that config and lists every tracked file.

## 8. Failure policy

- **A subject failure fails that repository.** A subject fails when it times out (600 s wall clock
  per repository by default; the effective value is recorded), crashes, exits non-zero, or writes a
  snapshot that fails schema validation. On a failed repository:
  - recall is 0 on both tracks;
  - precision is undefined and left out of precision averages;
  - the repository stays in the recall averages at 0;
  - the failure is listed with the averages it affects.
- **An oracle failure stops that repository's run.** No subject is scored on it, it is listed as
  not run, and every subject's averages leave it out, so subjects are always averaged over the same
  repositories. A canonical table with an oracle failure is invalid, as for any run not made.
- **Not run is not the same as failed.** A missing run that was never attempted makes a canonical
  table invalid. It is never scored as a pass or as zero.
- **One run per subject and repository is scored.** Run-to-run stability is measured by the T3
  `repeat` relation, not by re-running and choosing a run.

## 9. Tiers, aggregation and lead

| Tier | Evidence | Tracks | Headline |
|---|---|---|---|
| T1 ground truth | hand-verified fixtures; PyCG | function-pair | PyCG recall; fixture pass/fail |
| T2 compiler agreement | SCIP, strict and tolerant | both | strict precision and recall |
| T3 robustness | metamorphic relations, repeat runs | both | clean ÷ eligible per relation |

**T1.**
- Fixture expectations name `wrong` edges, which must be absent, and `right` edges, which must be
  present. Each fixture gets one verdict:
  - `BROKEN`: a `wrong` edge is asserted by a non-guessed edge. A fixture with no `wrong` edges is
    also `BROKEN` while any `right` edge is missing.
  - `GUESSED`: a `wrong` edge is present only as a guessed edge.
  - `CHANGED`: a `right` edge is missing.
  - `FIXED`: none of the above.
  - `ERROR`: the fixture could not be indexed. It is listed, and is never a pass.
  The first that applies wins, in the order listed: a fixture with a guessed `wrong` edge and a
  missing `right` edge is `GUESSED`.
- Regression fixtures (one per upstream issue) are a selected defect corpus. They are reported as
  pass/fail per fixture, never as a recall rate.
- PyCG recall is the number of expected project edges hit by a non-guessed edge, divided by the
  number of expected project edges. The expected set comes from PyCG's call graphs alone. Builtins,
  externals and lambdas are left out, and an expected edge into a module the subject did not index
  is a miss, never dropped.
- A PyCG snippet whose indexing failed counts all its expected edges as misses and is listed.
- PyCG's expectations include decorator calls and constructor runs, so a PyCG hit is a `calls` or
  `instantiates` edge, or a `decorates` edge in either direction for an expected decorator call. An
  expected `A.__init__` is also hit by an edge to `A` or to a class that inherits from it (PyCG
  records `B()` as running the inherited `A.__init__`).

**T2.**
- Precision and recall per §5, on both tracks, strict and tolerant.
- **Diagnostic languages.** A language whose oracle is too noisy is diagnostic: its repositories are
  shown and marked, and left out of the T2 averages. The rule is mechanical: the 95% Wilson lower
  bound of "oracle right where it answers", in the labelled oracle-noise sample, is under 80%.
- A rule change that brings a language back needs a fresh sample, never the sample that found the
  noise.

**Oracle-noise sample.**
- A stratified sample of call sites (agree, disagree, oracle-only, subject-only; the sample files
  call the oracle-only stratum `scip-only`) is labelled blind.
  Two labelling models from different families each get read-only repository access and a shuffled,
  unattributed multiple choice. A third model is asked only where the first two disagree.
- Truth is a 2-of-3 consensus. `cannot tell` never counts. A site with no consensus is reported
  with its rate and never imputed.
- The labelling protocol (model identifiers and dates, prompt hash, qualification items and each
  labeller's accuracy) is pinned in the published sample and identified by its hash in every table
  that uses it.

**T3.**
- The unit is one seed × relation run. It is reported as clean ÷ eligible, with changed graphs,
  execution errors, not-applicable transformations and unverified evidence shown separately.
- Errors stay in the eligible denominator. Not-applicable and unverified runs are excluded.
- Missing evidence is `NOT RUN`, never a passing rate.
- T3 is a **reference-implementation tier.** The transformations (`decoy`, `shift`, `repeat`) are
  defined by the pinned implementation, identified by its hash and by each run's challenge
  fingerprint (`challengeSha256`). T3 results are comparable only between runs with the same
  implementation hash.
- Fixture seeds are a selected defect corpus, not a sample of projects or a general tool ranking.

**Aggregation.**
- Per-repository rates come first.
- **The headline average is macro**: the unweighted mean of per-repository rates, so each
  repository (one user's codebase) weighs the same.
- The micro average (pooled units) is shown beside it.
- Each average carries a 95% repository-cluster bootstrap interval (2,000 resamples; the seed is
  recorded).
- A repository whose denominator is zero for a metric is left out of that metric's averages and
  listed.
- Rates are computed from exact counts and shown to one decimal place.

**Lead.**
- The published table leads with T2 strict, then T1, then T3.
- Tables never blend tiers or tracks into one score.

**Corpus.**
- A preregistered public corpus file pins each repository's commit, license, category and split
  (`dev`: rules, fixtures and samples may be tuned on it; `heldout`: indexed only for published
  tables).
- It must list each repository's vendored and generated path exclusions.
- A rule change prompted by a held-out result is re-validated on dev.

## 10. Run identity

Every result file must record the spec version, the subject's name and adapter hash, and, for an
oracle result, the subject's and the oracle's position encodings. Every reproduction must record,
in its manifest or its result files:
- the scorer's content hash, and the snapshot and expectation schema versions;
- the subject's name, version, configuration and adapter hash;
- the oracle tools and their versions;
- the corpus version and entry (repository and commit);
- the platform, the effective timeout, and the labelling-protocol hash where oracle noise is used.

Results without a field have unknown provenance (`null`), never a value filled in from today's code.

**Canonical tables** come only from the pinned reproduction image. Any other run is a development
run and must say so.

## 11. Evaluation isolation

- Expectations and answers are never visible to a subject. Fixture expectations live outside the
  indexed copy, and any path that could expose them, such as a symlink, is rejected.
- A canary replay indexes an anonymous copy marked with a fresh comment marker. It checks two
  things: the verdicts are unchanged, and the marker appears in no node, edge reference or
  unresolved name.
- Canaries probe accidental leakage and dependence on the fixture directory. They do not prove
  freedom from benchmark memorization.

## 12. Versioning and change control

- The spec is versioned **vN.M**.
  - **N, major:** bumps for any change that can move a published number. That includes units,
    matching, equivalences, verdict roles, the rule set, parameters (`W`, `DEF_SLACK`, timeout,
    diagnostic floor), denominators, aggregation, the failure policy, and the T3 reference
    implementation.
  - **M, minor:** bumps for editorial changes, clarifications, and new reported columns that
    leave existing numbers unchanged.
- Corpus versions are separate files. A table names the spec version and the corpus version.
  Results are compared only within one spec major and one corpus version.
- Results keep the version they were produced under. Results published under SPEC v0 stay labelled
  v0. They are never silently re-scored, and never mixed with v1 results in one table.
- The snapshot (`snapshot@1`) and expectation (`expect@1`) schemas are versioned on their own. v1
  reads `@1`, and a schema change that alters what a scorer can see requires a spec major.
- Section numbers §1–§13 are stable within a major. Other documents cite them.

## 13. Not in v1

These are not scored in v1 and carry no published numbers:
- **T0, question accuracy** (oracle-verified answers to flow and impact questions). It is
  experimental until an agent-centric study shows that edge accuracy tracks agent answers.
- Any-member matching for dispatch sets (`agree-in-set`): the SCIP oracle gives one symbol per
  site.
- Inherited constructors for the constructor equivalence.
- A separate slice for calls in test code.
- Held-out rotation and source-file/symbol renaming.

<!-- docvet:anchors
challengeSha256 -> metamorphic/relations.ts
-->
