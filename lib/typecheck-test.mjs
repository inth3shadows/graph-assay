#!/usr/bin/env node
// The type check's reporting (lib/typecheck.mjs): error counts, config errors, failures with no
// diagnostics, stale installs, and that an unparseable tsconfig.json emits nothing.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, staleInstall, typecheck } from './typecheck.mjs';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let n = 0;
const check = (name, fn) => { n++; try { fn(); } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const fail = { status: 2 };

check('a clean run passes', () => assert.deepEqual(summarize('', { status: 0 }), { ok: true, summary: 'tsc -p . (0 errors)' }));
check('one diagnostic per error line; continuation lines and quoted codes do not count', () => {
  const out = [
    "lib/a.mjs(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "lib/b.mjs(4,3): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.",
    "  Type 'X' is missing the following properties: error TS9999: quoted",
  ].join('\n');
  assert.equal(summarize(out, fail).summary, '2 type errors (tsc -p .)');
});
check('tsconfig.json and location-less diagnostics are config errors', () => {
  const out = "tsconfig.json(1,21): error TS5023: Unknown compiler option 'nope'.\nerror TS18003: No inputs were found.\nlib/a.mjs(1,7): error TS2322: x";
  assert.equal(summarize(out, fail).summary, '1 type error, 2 config errors (tsc -p .)');
});
check('a failure with no diagnostics says so instead of "0 type errors"', () => {
  assert.equal(summarize('Error: boom\n    at x.js:1', { status: 1 }).summary, 'tsc failed (exit 1) with no diagnostics');
  assert.equal(summarize('', { status: null, signal: 'SIGKILL' }).summary, 'tsc failed (killed by SIGKILL) with no diagnostics');
  assert.equal(summarize('', { status: null, error: new Error('spawnSync node ENOBUFS') }).ok, false);
});
check('stale install: a version mismatch or a missing package is reported, optional absences are not', () => {
  const lock = { packages: { '': {}, 'node_modules/typescript': { version: '6.0.3' }, 'node_modules/@types/node': { version: '22.20.5' },
    'node_modules/fsevents': { version: '2.3.3', optional: true } } };
  const have = { 'node_modules/typescript': '6.0.2' };
  assert.deepEqual(staleInstall(lock, (d) => have[d] ?? null), ['typescript 6.0.2 (lockfile 6.0.3)', '@types/node missing (lockfile 22.20.5)']);
  assert.deepEqual(staleInstall(lock, (d) => ({ 'node_modules/typescript': '6.0.3', 'node_modules/@types/node': '22.20.5' })[d] ?? null), []);
});
check('this checkout: the install matches the lockfile', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(qa, 'package-lock.json'), 'utf8'));
  if (!fs.existsSync(path.join(qa, 'node_modules'))) return; // check itself reports the missing install
  assert.deepEqual(staleInstall(lock, (d) => { try { return JSON.parse(fs.readFileSync(path.join(qa, d, 'package.json'), 'utf8')).version; } catch { return null; } }), []);
});
check('an unparseable tsconfig.json fails and writes no .js', () => {
  if (!fs.existsSync(path.join(qa, 'node_modules/typescript/bin/tsc'))) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-typecheck-'));
  try {
    fs.symlinkSync(path.join(qa, 'node_modules'), path.join(dir, 'node_modules'));
    fs.copyFileSync(path.join(qa, 'package-lock.json'), path.join(dir, 'package-lock.json'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ bad');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a: number = 1;\n');
    const r = typecheck(dir);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /^FAIL {2}typecheck: .*config error/);
    assert.ok(!fs.existsSync(path.join(dir, 'a.js')), 'tsc emitted a.js');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
console.log(`${n}/${n} typecheck checks`);
