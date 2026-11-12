# Notes for coding agents

Read [README.md](README.md) for what graph-assay is and [TECHNICAL.md](TECHNICAL.md) for every file.
[SPEC.md](SPEC.md) defines what is scored; code follows the spec, not the other way round.

## Verify

- `node bin/graph-assay check` is what CI runs (after `npm ci --ignore-scripts`): syntax checks, `tsc` over `lib/`, fixture validation, oracle self-tests
  with the rule-mutation pass, and every hermetic test. It needs no tool build. Run it before
  every commit and quote its last line.
- A change to an oracle rule needs a self-test case under `oracle/test/` that fails without it.
  `--mutate` fails the check if any rule can be removed without breaking a test.

## Do not change without a deliberate version step

- `SPEC.md` semantics: bump `SPEC_VERSION` in `lib/spec.mjs` and SPEC.md together (`lib/spec-test.mjs`).
- `corpus/v1.txt`, `corpus/v2.txt`: preregistered; their sha256 is recorded in reproduction manifests.
- `labels/protocol.json` and the files it pins: `node labels/protocol.mjs` must exit 0; `--update` makes
  a new protocol.
- `schema/*.json`: the snapshot and expectation contracts every scorer and adapter relies on.

## Conventions

- Scorers read snapshots only. Tool-specific code lives in one adapter per tool (`lib/subjects/`);
  adding a tool never changes a scorer.
- A fixture is a directory with sources and an `expect.json` (`schema/expect.v1.json`):
  `wrong` edges the bug produces, `right` edges a fix should produce. Validate with
  `node bin/graph-assay expect`. codegraph fixtures go in `fixtures/oracle-candidates/`; other tools'
  in their own set (`fixtures/cgr-candidates/`).
- Every path comes from `lib/config.mjs`; no hard-coded home paths.
- Indexing runs in a sandbox (temp HOME, telemetry off); see [SECURITY.md](SECURITY.md) before
  running anything on an untrusted repository.
