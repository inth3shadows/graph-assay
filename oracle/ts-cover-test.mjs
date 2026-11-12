#!/usr/bin/env node
// Hermetic check for oracle/ts-cover.mjs (SPEC §7 oracle coverage): the covering project lists every
// tracked TS/JS file, including those the repo's own tsconfig leaves out, and nothing untracked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { coverPath, coverTsconfig } from './ts-cover.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-ts-cover-'));
try {
  const put = (f, t = '') => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), t); };
  put('tsconfig.json', JSON.stringify({ include: ['source'] }));
  for (const f of ['source/index.ts', 'test/main.ts', 'test-d/types.ts', 'scripts/build.mjs', 'README.md']) put(f);
  const git = (...a) => assert.equal(spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' }).status, 0, `git ${a.join(' ')}`);
  git('init', '-q'); git('add', '.');
  put('untracked.ts');
  const cfg = coverTsconfig(tmp);
  // F3 (review 2026-11-12): the project sits at the repo root, so TypeScript resolves `types` and
  // `@types` from the repo as the repo's own tsconfig does; outside it they were lost (TS2688).
  assert.equal(path.dirname(coverPath(tmp)), tmp);
  assert.equal(cfg.extends, './tsconfig.json');
  assert.deepEqual(cfg.include, []);
  assert.deepEqual(cfg.compilerOptions, { allowJs: true, noEmit: true });
  assert.deepEqual(cfg.files, ['scripts/build.mjs', 'source/index.ts', 'test-d/types.ts', 'test/main.ts'].map((f) => `./${f}`));
  console.log('ok    ts-cover: every tracked TS/JS file, outside the tsconfig include too; untracked and non-TS/JS left out');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
