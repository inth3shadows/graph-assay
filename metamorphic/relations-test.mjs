#!/usr/bin/env node
// Hermetic tests of the metamorphic relations' source transforms (part of `graph-assay check`).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyRelation, DECOY_DIR, SHIFT, shiftFiles } from './relations.mjs';

let n = 0;
const check = (name, fn) => { n++; try { fn(); } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-relations-test-'));
const repo = (files) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
};
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

try {
  check('shift moves every line down by SHIFT', () => {
    const dir = repo({ 'a.py': 'def f():\n    g()\n' }); shiftFiles(dir);
    assert.equal(read(dir, 'a.py').split('\n').indexOf('def f():'), SHIFT);
  });
  check('shift keeps a shebang and a Python coding line in place', () => {
    const dir = repo({ 'a.py': '#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nx = 1\n' }); shiftFiles(dir);
    const lines = read(dir, 'a.py').split('\n');
    assert.equal(lines[0], '#!/usr/bin/env python'); assert.equal(lines[1], '# -*- coding: utf-8 -*-');
    assert.equal(lines.indexOf('x = 1'), 2 + SHIFT);
  });
  check('shift keeps a byte-order mark first', () => {
    const dir = repo({ 'a.ts': '﻿export const x = 1;\n' }); shiftFiles(dir);
    const text = read(dir, 'a.ts');
    assert(text.startsWith('﻿\n'), 'BOM must stay the first character');
    assert.equal(text.slice(1).split('\n').indexOf('export const x = 1;'), SHIFT);
  });
  check('decoys name the source\'s callees and live in their own directory', () => {
    const dir = repo({ 'a.ts': 'export function helper() {}\nhelper();\nnew Widget();\n' });
    const r = applyRelation(dir, 'decoy');
    const decoys = fs.readdirSync(path.join(dir, DECOY_DIR)).map((f) => read(path.join(dir, DECOY_DIR), f)).join('\n');
    assert(r.decoys); assert.match(decoys, /helper/); assert.match(decoys, /Widget/);
    assert.equal(read(dir, 'a.ts'), 'export function helper() {}\nhelper();\nnew Widget();\n', 'the original source is untouched');
  });
  check('the challenge hash is deterministic and depends on the transform', () => {
    const a = applyRelation(repo({ 'a.py': 'f()\n' }), 'shift'); const b = applyRelation(repo({ 'a.py': 'f()\n' }), 'shift');
    const c = applyRelation(repo({ 'a.py': 'f()\n' }), 'decoy');
    assert.equal(a.challengeSha256, b.challengeSha256); assert.notEqual(a.challengeSha256, c.challengeSha256);
  });
  check('an unknown relation is an error', () => assert.throws(() => applyRelation(repo({ 'a.py': '' }), 'rename')));
  check('a repo with nothing to shift is not applicable, not a pass', () => {
    assert.equal(applyRelation(repo({ 'README.md': 'x' }), 'shift').notApplicable, true);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (!process.exitCode) console.log(`${n}/${n} relation checks`);
