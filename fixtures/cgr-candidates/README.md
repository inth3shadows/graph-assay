# code-graph-rag fixtures

Minimal repros of code-graph-rag's top `graph-assay triage` shapes and function-pair disagreements on a
SPEC v1.0 run over the dev corpus. They stay out of `fixtures/oracle-candidates/`, which is
codegraph's regression set and the input of the canonical replay.

    node fixtures/replay.mjs --subject code-graph-rag --root fixtures/cgr-candidates default

| fixture | triage shape | sites | 0.5.0 | main cbbef181 | upstream |
|---|---|---|---|---|---|
| `cgr1-ts-type-member-node` | #1 `missing\|target-not-a-node\|ts\|term@decl` (ky) | 881 | GUESSED | GUESSED | vitali87/code-graph-rag#3603 |
| `cgr2-ts-factory-const-by-name` | #2 `missing\|wrong-edge\|ts\|term` (ky) | 697 | GUESSED | GUESSED | vitali87/code-graph-rag#3604 |
| `../oracle-candidates/g1-go-new-receiver` | #3 `missing\|no-ref\|go\|method>method` (mux) | 232 | CHANGED | CHANGED | vitali87/code-graph-rag#2893 |
| `cgr3-py-nested-call-duplicated` | pair track: click `version_option -> echo` | - | BROKEN | BROKEN | vitali87/code-graph-rag#2688 |
| `cgr4-py-function-arg-as-call` | pair track: click `test_* -> cli` (184 pairs) | - | BROKEN | BROKEN | vitali87/code-graph-rag#2689 |

Most of ky's 697 #2 sites are the case where cgr's edge reaches the right body: `createInstance` returns an inner function that happens to be named `ky`. The fixture pins the case where the name match picks the wrong function.

#3 reuses the codegraph fixture, whose `right` edge code-graph-rag never produces (CHANGED).
GUESSED means the wrong edge is present, but only as an edge that code-graph-rag labels `heuristic`. The
canonical ky edges are heuristic as well.
