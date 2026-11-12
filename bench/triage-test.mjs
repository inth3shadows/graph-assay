#!/usr/bin/env node
// Hermetic checks for bench/triage.mjs: shapes rank by macro headline points (not raw sites), noise is
// left out, shapes that share call sites are linked, and decoy findings are counted.
import assert from 'node:assert/strict';
import { decoyFindings, describe, knownFor, rankShapes } from './triage.mjs';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const WRONG = 'wrong-target|calls|exact-match|method>method';
const FALLBACK = 'receiver-fallback|calls|import|constant>term';
const MISSED = 'missing|receiver-fallback|ts|term@decl>method';
const row = (repo, fwdBuckets, missBuckets, sites = {}) => ({ repo, workDir: `/w/w-${repo}`,
  fwd: { buckets: fwdBuckets, skipped: {}, groups: {}, sites: sites.fwd ?? [] },
  miss: { buckets: missBuckets, groups: {}, sites: sites.miss ?? [] } });

check('a shape costing more macro points outranks one with more sites (SPEC §9 macro)', () => {
  const rows = [
    row('small', { 'ok|calls': 95, [WRONG]: 5 }, { 'missing|found|py|method': 10 }),
    row('big', { 'ok|calls': 960, [FALLBACK]: 40 }, { 'missing|found|py|method': 10 }),
  ];
  const { shapes } = rankShapes(rows);
  assert.deepEqual(shapes.map((s) => s.key), [WRONG, FALLBACK]);
  assert.equal(shapes[0].points, 2.5); // 100 * 5/100 over 2 repos
  assert.equal(shapes[1].points, 2); // 100 * 40/1000 over 2 repos
});
check('noise is counted, never ranked (SPEC §5)', () => {
  const { shapes, noise } = rankShapes([row('r', { 'ok|calls': 8, 'noise:pytest-fixture-param|calls|-|function>parameter': 2 }, {})]);
  assert.equal(shapes.length, 0);
  assert.deepEqual(noise, { 'noise:pytest-fixture-param': 2 });
});
check('a wrong edge and the missed call at the same sites are linked as the same calls', () => {
  const sites = { fwd: [{ site: 'a.ts:3', name: 'get', key: FALLBACK }, { site: 'a.ts:4', name: 'get', key: FALLBACK }],
    miss: [{ site: 'a.ts:3', name: 'get', key: MISSED }, { site: 'a.ts:4', name: 'get', key: MISSED }, { site: 'b.ts:9', name: 'x', key: 'missing|no-ref|ts|method' }] };
  const { shapes } = rankShapes([row('r', { 'ok|calls': 8, [FALLBACK]: 2 }, { 'missing|found|ts|method': 7, [MISSED]: 2, 'missing|no-ref|ts|method': 1 }, sites)]);
  const fb = shapes.find((s) => s.key === FALLBACK);
  assert.deepEqual(fb.sameCalls.map((o) => [o.key, o.shared]), [[MISSED, 2]]);
  assert.deepEqual(shapes.find((s) => s.key === 'missing|no-ref|ts|method').sameCalls, []);
});
check('decoy captures and losses come from the T3 diffs', () => {
  const d = decoyFindings([{ relation: 'decoy', seed: 'c', diffs: { CAPTURED: ['orch.ts:5 check -calls-> zz_cg_decoy/decoy-fns.ts:has'], LOST: ['orch.ts:5 check -calls-> cache.ts:Cache::has'], GAINED: [] } },
    { relation: 'decoy', seed: 'a', diffs: { CAPTURED: [], LOST: [], GAINED: [] } }, { relation: 'shift', seed: 'a', diffs: {} }]);
  assert.equal(d.seeds, 2); assert.equal(d.changed, 1); assert.equal(d.captured.length, 1); assert.equal(d.lost.length, 1);
});
check('shapes read in plain words', () => {
  assert.match(describe(MISSED), /^missed call \(receiver-fallback\) in ts: callee is a term, a bodiless declaration; the subject has a method there$/);
  assert.match(describe(WRONG), /^wrong-target calls edge \(resolved by exact-match\): the subject links a method, the compiler says method$/);
});
check('a filed fixture matches a shape it produces in the same language, with its replay verdict', () => {
  const known = { fixtures: {
    'g1-go-new-receiver': { issue: 3237, lang: 'go', shapes: { [WRONG]: 1 } },
    'py-same-key': { issue: 9, lang: 'python', shapes: { [WRONG]: 2 } },
    'java-untagged': { issue: 7, lang: 'other', shapes: null } } };
  const shape = { key: WRONG, langs: ['go'] };
  assert.deepEqual(knownFor(shape, known, { 'g1-go-new-receiver': 'BROKEN' }), [{ fixture: 'g1-go-new-receiver', issue: 3237, verdict: 'BROKEN' }]);
  assert.deepEqual(knownFor({ key: WRONG, langs: ['typescript'] }, known), []);
  assert.deepEqual(knownFor({ key: FALLBACK, langs: ['go'] }, known), []);
});
check('the row language travels with a shape', () => {
  const r = row('mux', { 'ok|calls': 8, [WRONG]: 2 }, {}); r.language = 'go';
  assert.deepEqual(rankShapes([r]).shapes[0].langs, ['go']);
});
console.log(`${n}/${n} triage checks`);
