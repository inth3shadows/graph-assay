#!/usr/bin/env node
// #41: lib/manifest.ts scorers() fingerprints every file a scorer runs. Its file list is written out by
// hand, so this test walks the local imports of every scoring entry point and requires each file, and
// the package.json that makes its directory's .ts load as ES modules, to be in the fingerprint.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
check('the walk reads every import form, takes the nearest package.json, and refuses a dangling import', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-closure-'));
  try {
    const w = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), s); };
    w('package.json', '{}'); w('a/package.json', '{}');
    w('a/entry.ts', "import {\n  x,\n} from './b.ts';\nimport './side.ts';\nexport { y } from '../c/d.ts';\nconst z = await import('../e/f.mts');\nconst t = await import(`./tpl.ts`);\nimport eq = require('./req.ts');\n");
    w('a/b.ts', ''); w('a/side.ts', ''); w('c/d.ts', ''); w('e/f.mts', ''); w('a/tpl.ts', ''); w('a/req.ts', '');
    const c = importClosure(['a/entry.ts'], tmp);
    assert.deepEqual(c, ['a/b.ts', 'a/entry.ts', 'a/package.json', 'a/req.ts', 'a/side.ts', 'a/tpl.ts', 'c/d.ts', 'e/f.mts', 'package.json']);
    w('a/bad.ts', "import { q } from './missing.ts';\n");
    assert.throws(() => importClosure(['a/bad.ts'], tmp), /a\/bad\.ts: import '\.\/missing\.ts' resolves to no file/);
    // Comments are not read; a computed template is not followed; a query is not part of the path; a .d.ts takes no marker.
    w('a/quiet.ts', "// see import './gone.ts'\n/* from './gone.ts' */\nconst m = await import(`./x/${'n'}.ts`);\nimport './b.ts?v=1';\nimport type { T } from '../types/t.d.ts';\n");
    w('types/t.d.ts', ''); w('types/package.json', '{}');
    assert.deepEqual(importClosure(['a/quiet.ts'], tmp), ['a/b.ts', 'a/package.json', 'a/quiet.ts', 'types/t.d.ts']);
    // A directory is not a file; a wrongly relative import is not rescued from the repo root.
    w('a/dir.ts', "import './sub';\n"); fs.mkdirSync(path.join(tmp, 'a/sub'));
    assert.throws(() => importClosure(['a/dir.ts'], tmp), /a\/dir\.ts: import '\.\/sub' resolves to no file/);
    w('util.ts', ''); w('a/rel.ts', "import './util.ts';\n");
    assert.throws(() => importClosure(['a/rel.ts'], tmp), /resolves to no file/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
check('scorers() hashes the oracle\'s shell steps, which no import reaches', () => {
  const hashed = scorers().files;
  // The tracked ones, as scorers() hashes only tracked files (an untracked scratch script is not provenance).
  const tracked = spawnSync('git', ['ls-files', ':(glob)oracle/*.sh'], { cwd: qa, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(tracked.includes('oracle/run.sh'), 'git ls-files lists oracle/run.sh');
  for (const f of tracked) assert.ok(f in hashed, f);
});
console.log(`${n}/${n} manifest checks`);
