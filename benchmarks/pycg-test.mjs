#!/usr/bin/env node
// Hermetic test of the PyCG scorer (part of `graph-assay check`): the real benchmarks/pycg.mjs runs
// in a scratch tree against fabricated snippets and a stub subject whose snapshots are fixed, so the
// mapping (dotted names -> definition spans), hits, guesses, extras and failed indexes are pinned.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_SHARED } from '../lib/provenance.mjs';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const check = (name, fn) => { n++; try { fn(); } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-pycg-test-'));
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); };

try {
  const fake = path.join(tmp, 'qa');
  for (const f of [...ADAPTER_SHARED, 'lib/spec.mjs', 'benchmarks/pycg.mjs']) write(path.join(fake, f), fs.readFileSync(path.join(qa, f), 'utf8'));
  write(path.join(fake, 'lib/subjects/codegraph.mjs'), '// stub\n');
  // main.py: f (lines 1-2) calls g (lines 3-4); the module calls f.
  const src = 'def f():\n    g()\ndef g():\n    pass\nf()\n';
  const node = (id, kind, name, start, end) => ({ id, kind, name, qname: name, file: 'main.py', language: 'python', start, end });
  const nodes = [node('m', 'file', 'main.py', 1, 5), node('f', 'function', 'f', 1, 2), node('g', 'function', 'g', 3, 4)];
  // Per snippet: what the stub subject reports.
  const snaps = {
    clean: [{ kind: 'calls', src: 'm', dst: 'f', line: 5 }, { kind: 'calls', src: 'f', dst: 'g', line: 2 }],
    guess: [{ kind: 'calls', src: 'm', dst: 'f', line: 5 }, { kind: 'calls', src: 'f', dst: 'g', line: 2, provenance: 'heuristic' }],
    extra: [{ kind: 'calls', src: 'm', dst: 'f', line: 5 }, { kind: 'calls', src: 'f', dst: 'g', line: 2 }, { kind: 'calls', src: 'g', dst: 'f', line: 4 }],
  };
  write(path.join(fake, 'lib/subjects/index.mjs'), `import * as path from 'node:path';
const SNAPS = ${JSON.stringify(snaps)}; const NODES = ${JSON.stringify(nodes)};
const which = (dir) => path.basename(dir).split('__').pop();
export const buildFor = (s, b) => b;
export const subject = () => ({ name: 'codegraph',
  index: (dir) => which(dir) === 'broken' ? { ok: false, status: 1, output: 'synthetic index failure' } : { ok: true, status: 0, output: '' },
  snapshot: (dir) => ({ nodes: NODES, files: [{ path: 'main.py' }], unresolved: [], edges: SNAPS[which(dir)].map((e) => ({ provenance: null, ...e })) }) });
`);
  const bench = path.join(tmp, 'bench');
  for (const s of ['clean', 'guess', 'extra', 'broken']) {
    write(path.join(bench, 'micro-benchmark/snippets/cat', s, 'main.py'), src);
    write(path.join(bench, 'micro-benchmark/snippets/cat', s, 'callgraph.json'), { main: ['main.f', '<builtin>.print'], 'main.f': ['main.g'], 'main.g': [] });
  }
  const build = path.join(tmp, 'build.js'); write(build, '');
  const out = path.join(tmp, 'pycg.json');
  const r = spawnSync(process.execPath, [path.join(fake, 'benchmarks/pycg.mjs'), build, '--json', out],
    { encoding: 'utf8', env: { ...process.env, PYCG_DIR: bench, NODE_NO_WARNINGS: '1' } });
  const res = Object.fromEntries((fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).results : []).map((x) => [x.name.split('/').pop(), x]));

  check('the scorer runs and writes results', () => assert.equal(Object.keys(res).length, 4, r.stdout + r.stderr));
  check('expected edges come from PyCG and the files on disk; builtins are left out', () => assert.equal(res.clean.expected, 2));
  check('a complete, exact graph hits every expected edge with no extras', () => {
    assert.equal(res.clean.hit, 2); assert.equal(res.clean.extra?.length ?? res.clean.extra, 0);
  });
  check('a guessed edge is never a hit; it is counted as guess-only', () => {
    assert.equal(res.guess.hit, 1); assert.equal(res.guess.guessOnly?.length ?? res.guess.guessOnly, 1);
  });
  check('an edge PyCG lacks between project nodes is an extra', () => assert.equal(res.extra.extra?.length ?? res.extra.extra, 1));
  check('a failed index scores every expected edge as a miss', () => {
    assert.equal(res.broken.hit, 0); assert.equal(res.broken.expected, 2); assert.match(res.broken.error ?? '', /synthetic index failure/);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (!process.exitCode) console.log(`${n}/${n} PyCG scorer checks`);
