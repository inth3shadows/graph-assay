# codebase-memory-mcp fixtures

Minimal repros of codebase-memory-mcp defects, found while building its adapter. They stay out of
`fixtures/oracle-candidates/`, codegraph's regression set and the input of the canonical replay.

    node fixtures/replay.mts --subject codebase-memory-mcp --root fixtures/cbm-candidates default

| fixture | defect | 0.12.1 | upstream |
|---|---|---|---|
| `cbm1-js-ts-same-stem` | `client.js` and `client.ts` in one directory get the same qualified names (the extension is dropped); every function and call of `client.ts` disappears. `client.py` next to `client.ts` loses `client.ts` the same way. | BROKEN | unfiled |
| `cbm2-py-nested-call-lifted` | A nested function (`version_option.callback`) is not a node, and a call inside it is recorded on the enclosing module. | BROKEN | unfiled |

Neither is filed yet: the maintainers see graph-assay's results first.
