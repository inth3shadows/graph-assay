#!/usr/bin/env node
// #41: lib/manifest.ts scorers() fingerprints every file a scorer runs. Its file list is written out by
// hand, so this test walks the local imports of every scoring entry point and requires each file, and
// the package.json that makes its directory's .ts load as ES modules, to be in the fingerprint.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCORING_ENTRIES, importClosure, scorers } from './manifest.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`ok    ${name}`); };

check('scorers() fingerprints every file a scoring entry point loads, and its package.json', () => {
  const hashed = scorers().files;
  const missing = importClosure(SCORING_ENTRIES).filter((f) => !(f in hashed));
  assert.deepEqual(missing, [], `scorers() leaves out: ${missing.join(', ')}`);
});
check('the import walk follows relative imports and package.json markers', () => {
  const c = importClosure(['bench/tables.ts']);
  for (const f of ['bench/tables.ts', 'bench/package.json', 'bench/robustness.ts', 'labels/score.ts', 'labels/strata.ts', 'differential/builds.ts', 'lib/spec.ts']) assert.ok(c.includes(f), f);
});
check('the edgediff workflow runs on a change to any file the build differ loads (#41)', () => {
  // Its pull_request path filter is a hand list; a PR touching an unlisted import would skip the self-test.
  const wf = fs.readFileSync(path.join(qa, '.github/workflows/edgediff.yml'), 'utf8');
  const block = /\n {2}pull_request:\n {4}paths:\n((?: {6}(?:- .*|#.*)\n)+)/.exec(wf);
  assert.ok(block, 'edgediff.yml has no pull_request paths block');
  const paths = new Set([...block[1].matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1]));
  const missing = importClosure(['differential/builds.ts']).filter((f) => !paths.has(f));
  assert.deepEqual(missing, [], `edgediff.yml's path filter leaves out: ${missing.join(', ')}`);
});
console.log(`${n}/${n} manifest checks`);
