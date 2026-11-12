#!/usr/bin/env node
// The type check's reporting (lib/typecheck.mjs): error counts, config errors, failures with no
// diagnostics, stale installs and lockfiles, that an unparseable tsconfig.json emits nothing, and
// that tsconfig.json keeps browser globals out of lib/.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, staleInstall, runTsc, typecheck, joinOutput, extendsChain } from './typecheck.mjs';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let n = 0; let failed = 0; let skipped = 0;
// fn returns 'skip' when it cannot run here (no node_modules); a skip is not a pass.
const check = (name, fn) => { n++; try { if (fn() === 'skip') skipped++; } catch (e) { failed++; console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const fail = { status: 2 };
const haveTsc = fs.existsSync(path.join(qa, 'node_modules/typescript/bin/tsc'));
/** A temp project using this checkout's node_modules; `files` maps relative path -> contents. */
const project = (files, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-typecheck-'));
  try {
    fs.symlinkSync(path.join(qa, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
    fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

check('a clean run passes', () => assert.deepEqual(summarize('', { status: 0 }), { ok: true, summary: 'tsc -p . (0 errors)' }));
check('one diagnostic per error line; continuation lines and quoted codes do not count', () => {
  const out = [
    "lib/a.mjs(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "lib/b.mjs(4,3): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.",
    "  Type 'X' is missing the following properties: error TS9999: quoted",
  ].join('\n');
  assert.equal(summarize(out, fail).summary, '2 type errors (tsc -p .)');
});
check('config errors: no location, a tsconfig*.json, or a file the config extends; other .json files are not', () => {
  const out = ["tsconfig.json(1,21): error TS5023: Unknown compiler option 'nope'.", 'error TS18003: No inputs were found.',
    "tsconfig.base.json(2,3): error TS5023: Unknown compiler option 'x'.", "cfg/base.json(1,21): error TS5023: Unknown compiler option 'y'.",
    'lib/a.mjs(1,7): error TS2322: x', 'schema/x.json(3,1): error TS1005: x'].join('\n');
  assert.equal(summarize(out, fail, ['cfg/base.json']).summary, '2 type errors, 4 config errors (tsc -p .)');
  assert.equal(summarize(out, fail).summary, '3 type errors, 3 config errors (tsc -p .)');
});
check('a failure with no diagnostics says so instead of "0 type errors"', () => {
  assert.equal(summarize('Error: boom\n    at x.js:1', { status: 1 }).summary, 'tsc failed (exit 1) with no diagnostics');
  assert.equal(summarize('', { status: null, signal: 'SIGKILL' }).summary, 'tsc failed (killed by SIGKILL) with no diagnostics');
  assert.equal(summarize('', { status: null, error: new Error('spawnSync node ENOBUFS') }).ok, false);
});
check('a run cut short keeps its cause next to a partial count', () => {
  const out = 'lib/a.mjs(1,7): error TS2322: x';
  assert.equal(summarize(out, { status: null, signal: 'SIGKILL' }).summary, '1 type error (tsc -p .; cut short: killed by SIGKILL)');
  assert.equal(summarize(out, { status: null, error: new Error('spawnSync node ENOBUFS') }).summary, '1 type error (tsc -p .; cut short: spawnSync node ENOBUFS)');
});
check('a crash after some diagnostics is cut short, not a complete count', () => {
  const out = 'lib/a.mjs(1,7): error TS2322: x\n  Type elaboration line\nError: Debug Failure.\n    at Object.f (tsc.js:1:1)';
  assert.equal(summarize(out, { status: 1 }).summary, '1 type error (tsc -p .; cut short: crashed, exit 1)');
  assert.equal(summarize('lib/a.mjs(1,7): error TS2322: x', { status: 134 }).summary, '1 type error (tsc -p .; cut short: exit 134)');
  assert.equal(summarize('lib/a.mjs(1,7): error TS2322: x\n  elaboration', { status: 2 }).summary, '1 type error (tsc -p .)');
});
check('a message spanning lines is not a cut-short run', () => {
  const out = "lib/a.mjs(1,15): error TS2307: Cannot find module 'a\nb' or its corresponding type declarations.";
  assert.equal(summarize(out, { status: 2 }).summary, '1 type error (tsc -p .)');
});
check('the extends chain is read from tsconfig.json, relative to each config', () => {
  project({ 'tsconfig.json': '{ "extends": "./cfg/base.json" }', 'cfg/base.json': '{ "extends": ["./more.json", "@pkg/cfg"] }', 'cfg/more.json': '{}' }, (dir) => {
    assert.deepEqual(extendsChain(dir), ['cfg/base.json', 'cfg/more.json']);
  });
  project({ 'tsconfig.json': '{ bad' }, (dir) => assert.deepEqual(extendsChain(dir), []));
});
check('stdout and stderr are joined on a line boundary', () => {
  assert.equal(joinOutput({ stdout: 'lib/a.mjs(1,7): error TS2322: x', stderr: 'error TS5083: Cannot read file.' }),
    'lib/a.mjs(1,7): error TS2322: x\nerror TS5083: Cannot read file.');
  assert.equal(joinOutput({ stdout: null, stderr: '' }), '');
});
check('a lockfile that is not an object, or has non-object packages or entries, is refused without throwing', () => {
  assert.deepEqual(staleInstall(null, () => null), ['package-lock.json is not a JSON object']);
  assert.deepEqual(staleInstall([], () => null), ['package-lock.json is not a JSON object']);
  for (const packages of ['abc', [1, 2], true]) assert.deepEqual(staleInstall({ packages }, () => null), ['package-lock.json "packages" is not an object']);
  assert.deepEqual(staleInstall({ packages: { 'node_modules/typescript': '6.0.3', 'node_modules/x': null } }, () => null),
    ['typescript: lockfile entry is not an object', 'x: lockfile entry is not an object']);
});
check('stale install: mismatched or missing packages are reported; optional, devOptional and versionless entries are not', () => {
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/typescript': { version: '6.0.3' }, 'node_modules/@types/node': { version: '22.20.5' },
    'node_modules/fsevents': { version: '2.3.3', optional: true }, 'node_modules/dev-only': { version: '1.0.0', devOptional: true },
    'node_modules/linked': { resolved: 'packages/linked', link: true } } };
  const have = { 'node_modules/typescript': '6.0.2', 'node_modules/linked': '1.0.0' };
  assert.deepEqual(staleInstall(lock, (d) => have[d] ?? null), ['typescript 6.0.2 (lockfile 6.0.3)', '@types/node missing (lockfile 22.20.5)']);
});
check('a lockfile without a packages map is refused', () => {
  assert.deepEqual(staleInstall({ lockfileVersion: 1, dependencies: {} }, () => null), ['package-lock.json has no "packages" (lockfileVersion 1)']);
});
check('a missing or unparseable package-lock.json is a FAIL line, not a crash', () => {
  if (!haveTsc) return 'skip';
  project({ 'tsconfig.json': '{}' }, (dir) => {
    assert.match(typecheck(dir).lines.at(-1), /^FAIL {2}typecheck: cannot read package-lock\.json .*npm ci --ignore-scripts/);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{ bad');
    assert.match(typecheck(dir).lines.at(-1), /^FAIL {2}typecheck: cannot read package-lock\.json /);
  });
});
check('an unparseable tsconfig.json fails and writes no .js', () => {
  if (!haveTsc) return 'skip';
  project({ 'tsconfig.json': '{ bad', 'a.ts': 'export const a: number = 1;\n' }, (dir) => {
    const r = runTsc(dir);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1), /^FAIL {2}typecheck: .*config error/);
    assert.ok(!fs.existsSync(path.join(dir, 'a.js')), 'tsc emitted a.js');
  });
});
check('tsconfig.json keeps browser globals out of lib/ (no DOM lib)', () => {
  if (!haveTsc) return 'skip';
  project({ 'tsconfig.json': fs.readFileSync(path.join(qa, 'tsconfig.json'), 'utf8'), 'lib/a.mjs': 'export const t = document.title;\n' }, (dir) => {
    const r = runTsc(dir);
    assert.equal(r.ok, false, 'document type-checked');
    assert.match(r.lines.join('\n'), /Cannot find name 'document'/);
  });
});
console.log(`${n - failed - skipped}/${n} typecheck checks${skipped ? ` (${skipped} skipped: no node_modules; run npm ci --ignore-scripts)` : ''}`);
