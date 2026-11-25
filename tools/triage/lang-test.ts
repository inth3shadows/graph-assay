#!/usr/bin/env node
// tools/triage/lang.ts: which oracle indexer a fixture goes to (#95). Hermetic; part of `graph-assay check`.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { langOf } from './lang.ts';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Oracle languages.
assert.equal(langOf(['m.go', 'go.mod']), 'go');
assert.equal(langOf(['pkg/a.py', 'pyproject.toml']), 'python');
assert.equal(langOf(['src/a.ts', 'b.tsx', 'package.json']), 'ts');
assert.equal(langOf(['a.mjs']), 'ts');
// No indexer wired here: untagged.
assert.equal(langOf(['A.java']), null);
assert.equal(langOf(['src/main/kotlin/K.kt']), null);
assert.equal(langOf(['Values.cs', 'Consumer.cs']), null);
assert.equal(langOf(['Sources/App/Use.swift']), null);
assert.equal(langOf(['README.md', 'expect.json']), null);
// #95: a stray script in a fixture of another language must not send it to the TS (or Python) indexer.
assert.equal(langOf(['Consumer.cs', 'wwwroot/site.js']), null);
assert.equal(langOf(['Package.swift', 'Sources/App/Use.swift', 'scripts/build.ts']), null);
assert.equal(langOf(['src/lib.rs', 'build.py']), null);
assert.equal(langOf(['app.php', 'public/app.js']), null);

// Every committed fixture keeps the language it had before #95 (no fixture ships a stray script today).
const before = (fs_: string[]) => (fs_.some((f) => /\.(java|kt|php)$/.test(f)) ? null : fs_.some((f) => f.endsWith('.go')) ? 'go'
  : fs_.some((f) => f.endsWith('.py')) ? 'python' : fs_.some((f) => /\.[cm]?[jt]sx?$/.test(f)) ? 'ts' : null);
const root = path.join(qa, 'fixtures', 'oracle-candidates');
const names = fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'expect.json')));
assert.ok(names.length > 50, `only ${names.length} fixtures found`);
for (const n of names) {
  const dir = path.join(root, n);
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  assert.equal(langOf(files), before(files), `${n}: language changed`);
}
console.log(`lang: ${names.length} fixtures unchanged, stray-script cases untagged`);
