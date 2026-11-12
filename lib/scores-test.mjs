#!/usr/bin/env node
// Hermetic effect-size boundaries and CLI/loop integration; no subject builds or SCIP needed.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forward, missing, gate } from './scores.mjs';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const repo = (hit = 270, total = 300, fHit = hit, fTotal = total) => ({
  forward: { total: fTotal, buckets: { 'ok|calls': fHit, 'wrong-target|calls': fTotal - fHit }, groups: {} },
  missing: { total, buckets: { 'missing|found|ts': hit, 'missing|no-ref|ts': total - hit }, groups: {} },
});
const baseline = (r = repo()) => ({ repos: { small: r }, replay: null, pycg: null, meta: null });
const anchored = (r) => ({ ...baseline(r), repos: { small: r, anchor: repo(100000, 100000) } });
const perRepo = (result) => result.triggers.filter((t) => t.scope === 'small');
const old = anchored(repo());

check('shared mapping preserves strict, tolerant, unaligned, noise and skipped counts', () => {
  const f = forward({ buckets: { ok: 10, 'ok-overload-set|calls': 2, 'ok-other-column|calls': 3,
    'local-module-alias|calls': 4, 'wrong-target|calls': 5, 'external|calls': 6, 'local-shadow|calls': 7,
    'cross-file-unimported|calls': 8, 'receiver-fallback|calls': 9, 'noise:scip|calls': 10,
    'no-scip-ref|calls': 11, 'outside-scip': 12, 'scip-local-undefined|calls': 13 }, skipped: { guessed: 15 } });
  assert.deepEqual(f.strict, [12, 64]); assert.deepEqual(f.tolerant, [19, 54]);
  assert.equal(f.unaligned, 36); assert.equal(f.skipped, 15);
  assert.throws(() => forward({ buckets: { 'unknown|calls': 1 } }), /unknown forward verdict/);
  assert.throws(() => missing({ buckets: { 'missing|mystery|ts': 1 } }), /unknown missing-edge verdict/);
  const cols = missing({ buckets: { 'missing|found|ts|method@decl>method': 2, 'missing|no-ref|ts|method@decl': 1, 'missing|found|ts|method': 5 },
    decorators: { total: 4, causes: { found: 3, 'no-ref': 1 } } });
  assert.deepEqual(cols.decl, [2, 3]); assert.deepEqual(cols.decorators, [3, 4]); assert.deepEqual(cols.strict, [7, 8]);
  assert.equal(missing({ buckets: {} }).decorators, null);
  const m = missing({ buckets: { 'missing|found|ts': 10, 'missing|found-other-line|py': 2,
    'missing|found-heuristic-only|go': 3, 'missing|no-ref|ts': 5 } });
  assert.deepEqual(m.strict, [10, 20]); assert.deepEqual(m.tolerant, [12, 20]); assert.equal(m.guessOnly, 3);
});
check('one-site wobble is immaterial', () => assert.equal(gate(baseline(repo(900, 1000)), baseline(repo(899, 1000))).verdict, 'NO MATERIAL CHANGE'));
check('exactly 1 point and 3 sites triggers per repo, independently of micro', () => {
  const g = gate(old, anchored(repo(267)));
  assert.equal(g.verdict, 'REGRESSION'); assert.equal(g.triggers.length, 2);
  assert.deepEqual(perRepo(g).map((t) => [t.metric, t.sites]), [['precision', 3], ['recall', 3]]);
});
check('2 sites fails per-repo floor even with >1 point', () => {
  assert.equal(gate(anchored(repo(90, 100)), anchored(repo(88, 100))).verdict, 'NO MATERIAL CHANGE');
});
check('3 sites just under 1 point fails per-repo floor', () => {
  assert.equal(gate(anchored(repo(270, 301)), anchored(repo(267, 301))).verdict, 'NO MATERIAL CHANGE');
});
check('aggregate-only drop at exactly 0.5 point', () => {
  const g = gate(baseline(repo(900, 1000)), baseline(repo(895, 1000)));
  assert.equal(g.verdict, 'REGRESSION'); assert.equal(g.triggers.length, 2);
  assert(g.triggers.every((t) => t.scope === 'T2 micro'));
});
check('aggregate just below 0.5 point is immaterial', () => {
  assert.equal(gate(baseline(repo(900, 1001)), baseline(repo(895, 1001))).verdict, 'NO MATERIAL CHANGE');
});
check('precision floor counts added wrong edges when match count stays flat', () => {
  const g = gate(anchored(repo(270, 300, 200, 200)), anchored(repo(270, 300, 200, 203)));
  assert.equal(g.verdict, 'REGRESSION'); assert.equal(g.triggers[0].metric, 'precision'); assert.equal(g.triggers[0].sites, 3);
});
check('precision floor counts removed matches with a changing denominator', () => {
  assert.equal(gate(anchored(repo(270, 300, 50, 100)), anchored(repo(270, 300, 47, 97))).verdict, 'REGRESSION');
});
check('improvement is symmetric at repo and micro boundaries', () => {
  assert.equal(gate(anchored(repo(267)), old).verdict, 'IMPROVEMENT');
  const g = gate(baseline(repo(895, 1000)), baseline(repo(900, 1000)));
  assert.equal(g.verdict, 'IMPROVEMENT'); assert(g.triggers.every((t) => t.scope === 'T2 micro'));
});
check('changed missing-mode total excludes entire repo from both micro pools', () => {
  const g = gate(baseline(repo()), baseline(repo(0, 301)));
  assert.equal(g.verdict, 'NO MATERIAL CHANGE'); assert.equal(g.triggers.length, 0);
  assert.equal(g.incomparable[0].scope, 'small');
});
check('incomparable repo does not hide a comparable repo regression', () => {
  const a = { repos: { small: repo(), changed: repo(100000, 100000) } };
  const b = { repos: { small: repo(267), changed: repo(0, 100001) } };
  const g = gate(a, b); assert.equal(g.verdict, 'REGRESSION'); assert.equal(g.incomparable.length, 1);
});
check('absent repos or modes are incomparable; zero denominators never trigger', () => {
  const g = gate(baseline(), { repos: { zero: repo(0, 0) } });
  assert.equal(g.incomparable.length, 2); assert.equal(g.verdict, 'NO MATERIAL CHANGE');
  assert.equal(gate(baseline(repo(0, 0)), baseline(repo(0, 0))).triggers.length, 0);
  assert.equal(gate(baseline(), baseline({ ...repo(), missing: null })).incomparable.length, 1);
});
for (const verdict of ['BROKEN', 'CHANGED', 'GUESSED']) check(`FIXED -> ${verdict} overrides improving T2, reverse is improvement`, () => {
  const a = { ...baseline(repo(267)), replay: { fixture: 'FIXED' } };
  const b = { ...baseline(), replay: { fixture: verdict } };
  assert.equal(gate(a, b).verdict, 'REGRESSION');
  assert.equal(gate({ replay: b.replay }, { replay: a.replay }).verdict, 'IMPROVEMENT');
});
check('non-fixed fixture transitions do not trigger; missing/error is incomparable', () => {
  assert.equal(gate({ replay: { f: 'BROKEN' } }, { replay: { f: 'CHANGED' } }).verdict, 'NO MATERIAL CHANGE');
  assert.equal(gate({ replay: { f: 'FIXED' } }, { replay: {} }).incomparable.length, 1);
  assert.equal(gate({ replay: { f: 'FIXED' } }, { replay: { f: 'ERROR' } }).incomparable.length, 1);
});
const pycg = (hit, expected) => ({ pycg: { a: { hit: hit - 10, expected: expected - 20 }, b: { hit: 10, expected: 20 } } });
check('PyCG exact 0.5 point and symmetric improvement', () => {
  assert.equal(gate(pycg(100, 200), pycg(99, 200)).verdict, 'REGRESSION');
  assert.equal(gate(pycg(99, 200), pycg(100, 200)).verdict, 'IMPROVEMENT');
  assert.equal(gate(pycg(1000, 2001), pycg(990, 2001)).verdict, 'NO MATERIAL CHANGE');
});
check('PyCG 234 edges: one loss immaterial, two losses regress', () => {
  assert.equal(gate(pycg(200, 234), pycg(199, 234)).verdict, 'NO MATERIAL CHANGE');
  assert.equal(gate(pycg(200, 234), pycg(198, 234)).verdict, 'REGRESSION');
});
check('missing PyCG or changed expected total is incomparable', () => {
  assert.equal(gate(pycg(200, 234), {}).incomparable.length, 1);
  const g = gate(pycg(200, 234), pycg(10, 235));
  assert.equal(g.verdict, 'NO MATERIAL CHANGE'); assert.equal(g.incomparable.length, 1);
});
check('gate does not mutate inputs', () => {
  const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  const a = freeze(old); const b = freeze(anchored(repo(267))); gate(a, b);
  assert.deepEqual(a, anchored(repo())); assert.deepEqual(b, anchored(repo(267)));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-scores-'));
const write = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); };
const run = (...args) => spawnSync(process.execPath, [path.join(qa, 'oracle/baseline.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: tmp } });
try {
  const a = path.join(tmp, 'a.json'); const b = path.join(tmp, 'b.json'); const json = path.join(tmp, 'gate.json');
  write(a, old); write(b, anchored(repo(267)));
  check('diff preserves raw changes, emits verdict/metrics and JSON; opt-in exit 1', () => {
    const plain = run('diff', a, b); assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /small forward:.*ok\|calls/); assert.match(plain.stdout, /VERDICT: REGRESSION/);
    const fail = run('diff', a, b, '--fail-on-regression', '--json', json);
    assert.equal(fail.status, 1, fail.stderr); assert.match(fail.stdout, /-1.000 points, 3 sites/);
    assert.deepEqual(JSON.parse(fs.readFileSync(json)), gate(old, anchored(repo(267))));
  });
  check('diff exits 0 for immaterial change and improvement, prints incomparable repos', () => {
    assert.equal(run('diff', b, a, '--fail-on-regression').status, 0);
    write(b, old); assert.match(run('diff', a, b, '--fail-on-regression').stdout, /VERDICT: NO MATERIAL CHANGE/);
    write(b, anchored(repo(0, 301))); const r = run('diff', a, b, '--fail-on-regression');
    assert.equal(r.status, 0); assert.match(r.stdout, /INCOMPARABLE small: missing-mode total changed/);
  });
  check('fixture regression exits 1 even while scores rise', () => {
    write(a, { ...baseline(repo(267)), replay: { f: 'FIXED' } }); write(b, { ...baseline(), replay: { f: 'BROKEN' } });
    assert.equal(run('diff', a, b, '--fail-on-regression').status, 1);
  });
  check('diff input/read errors exit 2, distinct from regression', () => {
    assert.equal(run('diff', a, path.join(tmp, 'absent'), '--fail-on-regression').status, 2);
    write(b, '{bad'); assert.equal(run('diff', a, b).status, 2);
  });
  check('save honors --work as the first option and --targets', () => {
    const dir = path.join(tmp, 'saved'); const work = path.join(tmp, 'work'); const targets = path.join(tmp, 'targets.txt');
    write(path.join(work, 'w-synthetic/out.json'), repo().forward);
    write(path.join(work, 'w-synthetic/out-missing.json'), repo().missing);
    write(targets, 'synthetic unused ts\n'); fs.mkdirSync(dir);
    const r = run('save', dir, '--work', work, '--targets', targets); assert.equal(r.status, 0, r.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'))).repos.synthetic;
    assert.deepEqual(saved, Object.fromEntries(Object.entries(repo()).map(([mode, value]) => [mode, { adapterSha256: null, ...value }])));
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`${n}/${n} effect-size checks`);
