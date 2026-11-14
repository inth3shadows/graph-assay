#!/usr/bin/env node
// Diff codegraph's resolved call edges against a SCIP index (compiler-grade
// references) of the same checkout.
//
// Usage: [ORACLE_LANG=python] node oracle.ts <repo dir with .codegraph/> <index.scip> [out.json]
//
// For each non-heuristic `calls`/`instantiates` edge, find the SCIP reference
// at the call site (same file, same line, identifier text == the called name,
// nearest column) and compare where each says it goes:
//   ok             SCIP's definition sits inside the codegraph target's lines
//   wrong-target   SCIP defines it in the project, somewhere else
//   external       SCIP resolves it outside the project (a library / lib.d.ts),
//                  but codegraph linked a project node: a fabricated edge
//   scip-local     SCIP says it is a local binding (parameter, local const)
//   no-scip-ref    no SCIP reference with that name on that line (alignment gap)
// Refinements of a disagreement (checked in this order):
//   ok-other-column              the name appears twice on the line; the other occurrence agrees
//   noise:pytest-fixture-param   Python: SCIP sees a parameter, codegraph links the pytest
//                                fixture that parameter receives (deliberate, isFixtureInReach)
//   noise:scip-unresolved-module SCIP points at a module symbol (`pkg.mod`/__init__:): pyright
//                                could not resolve the import (sys.path tricks), so it has no answer
//   noise:scip-shorthand-property SCIP defines the name at an object literal's shorthand
//                                property (`{ buildMember, ... }`); codegraph links the function itself
//   noise:scip-builtin-shadowed  Python: SCIP says builtin, but the caller's own file defines the
//                                name at module level and codegraph links that (it is what runs)
//   noise:external-target-outside-scip
//                                SCIP says external but never indexed the target file
//                                (a .mjs / allowJs file outside the tsconfig)
//   cross-file-unimported        Python: a bare-name call linked into another file the caller
//                                never imports (no import names that module or a package of it)
// Bucket keys are verdict|kind|resolvedBy, plus |target kind>SCIP symbol kind for a disagreement.
// ORACLE_SHOW=N prints the top N groups (same codegraph target + same SCIP definition) per bucket.
// ORACLE_REDACT=1 is for code that must not leave its machine: stdout and out.json carry only
// bucket keys, counts and group sizes (no code, paths, names or SCIP symbols); ORACLE_SHOW is
// ignored, and an error prints only its kind.
// ORACLE_DISABLE=rule,rule switches named rules off (oracle/test/run.ts --mutate uses it to prove
// every rule is pinned by a test). Rule names are the strings passed to on() in any oracle module.
//
// This file is the command line only. The work is in modules a test can drive in-process:
// context.ts (options, SCIP and snapshot loading, shared state), forward.ts (this check), missing.ts
// (ORACLE_MODE=missing), pairs.ts (the SPEC §3 function-pair track), braces.ts (its brace-matched
// caller ranges), report.ts (out.json and stdout) and symbols.ts (SCIP symbol helpers).
import { createContext, langError, optionsFromEnv } from './context.ts';
import { forward } from './forward.ts';
import { missing } from './missing.ts';
import { report } from './report.ts';

const opts = optionsFromEnv(process.argv.slice(2), process.env);
if (opts.redact) {
  process.on('uncaughtException', (err) => {
    console.error(`oracle failed (${err?.name ?? 'Error'}); details withheld under ORACLE_REDACT`);
    process.exit(1);
  });
}
if (langError(opts.lang)) { console.error(langError(opts.lang)); process.exit(2); }
const ctx = createContext(opts);
report(ctx, opts.missing ? missing(ctx) : forward(ctx));
