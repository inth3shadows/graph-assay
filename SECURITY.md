# Security

## Threat model

graph-assay indexes source code it did not write: the public corpus, fixtures, and any repository
you point the oracle at. Treat every indexed repository as untrusted input. What runs against it:

- **The tools under test.** Both index in a temporary HOME, with telemetry off, without network
  (`unshare -rn`, on Linux with unprivileged user namespaces) and with an allowlisted environment:
  codegraph sees only paths, locale, `NODE_OPTIONS` and its own `CODEGRAPH_*` switches;
  code-graph-rag sees only PATH, locale and its sandbox HOME. A malicious repository that exploits a bug in
  either tool still runs with your user's file permissions. Where `unshare` is unavailable (macOS),
  codegraph runs with network access.
- **The SCIP indexers.** scip-typescript, scip-python and scip-go type-check the code without running
  it. **scip-java builds the project**, which runs that project's build plugins. It therefore runs
  only inside its Docker image, as your uid, with the repository mounted.
- **Corpus setup.** Dependencies install with `npm ci --ignore-scripts` / `npm install --ignore-scripts`,
  so package install scripts do not run.
- **Labelling** (`labels/`, optional) sends call-site snippets and repository excerpts to the model
  providers you configure (third-party model APIs). Never label a repository whose code may not leave your machine. The
  labellers' file tools are not confined to the repository copy, so a prompt injection in a corpus
  file could steer one to read other local files. `labels/run.mjs` therefore refuses to start unless
  `GRAPH_ASSAY_LABEL_SANDBOX=1` says it runs in a container or VM, or `--unsafe-host` accepts the
  risk. Labeller processes get a minimal environment, and `graph-assay check` fails if any committed
  labelling file contains a home path or a credential pattern (`labels/data-scan-test.mjs`).

Run graph-assay on code you are allowed to share with those tools, in an account without
credentials you would not hand to that code. The Docker reproduction (`Dockerfile`) is the
isolated path: no host credentials, tool installs or Docker socket are mounted.

## Reporting a vulnerability

Report it privately through GitHub's "Report a vulnerability" form on this repository (Security →
Advisories), not in a public issue. Include the affected command, the input that triggers it, and
what it lets an attacker do. Expect an acknowledgement within a week.

## Out of scope

- Bugs in the tools under test or in the SCIP indexers: report those upstream. graph-assay's
  fixtures are the usual way to show them.
- Wrong or missing edges found by graph-assay. These are its output, not vulnerabilities.
- Anything that requires an attacker to already control your shell, config files or the
  `CGQA_*` / `ORACLE_*` environment.
