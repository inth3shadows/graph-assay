#!/usr/bin/env node
// tools/fixture-watch.ts: every change kind, what the stored state keeps, input validation, the report and
// its drafts, and the command line end to end on temp files.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diff, draft, nextState, report, rows, type Change } from './fixture-watch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
// A fixture set for the command line tests: the names they use, each with an expect.json.
let fixDir = '';
const fixtureDir = () => {
  if (fixDir) return fixDir;
  fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-watch-fx-'));
  for (const name of ['issue-1', 'issue-2', 'a']) { fs.mkdirSync(path.join(fixDir, name)); fs.writeFileSync(path.join(fixDir, name, 'expect.json'), '{}'); }
  process.on('exit', () => fs.rmSync(fixDir, { recursive: true, force: true }));
  return fixDir;
};
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`ok    ${name}`); };
const r = (name: string, verdict: string, detail = '', issue: number | null = 1) => ({ name, issue, verdict, detail });
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const G = 'c'.repeat(40);
const ctx = { prev: A, next: B, graphAssay: G, date: '2026-11-24', states: { 1: 'closed', 2: 'open' } as Record<string, string> };
const kinds = (cs: Change[]) => Object.fromEntries(cs.map((c) => [c.name, c.kind]));

check('each verdict change gets its kind; an unchanged fixture is not reported', () => {
  const prev = [r('fix', 'BROKEN', 'x'), r('reg', 'FIXED'), r('edg', 'BROKEN', 'x'), r('chg', 'BROKEN', 'x'), r('same', 'BROKEN', 'x'),
    r('err', 'BROKEN', 'x'), r('err2', 'ERROR', 'e'), r('gone', 'FIXED'), r('g2f', 'GUESSED', 'x')];
  const next = [r('fix', 'FIXED'), r('reg', 'BROKEN', 'y'), r('edg', 'BROKEN', 'y'), r('chg', 'CHANGED'), r('same', 'BROKEN', 'x'),
    r('err', 'ERROR', 'boom'), r('err2', 'ERROR', 'e2'), r('new', 'BROKEN', 'z'), r('g2f', 'FIXED')];
  assert.deepEqual(kinds(diff(prev, next)), { fix: 'fixed', reg: 'regression', edg: 'edges', chg: 'changed', err: 'error', new: 'new', g2f: 'fixed' });
});
check('a confirming rerun that disagrees makes the change unstable; one that agrees keeps it', () => {
  const prev = [r('a', 'BROKEN', 'x'), r('b', 'BROKEN', 'x'), r('c', 'BROKEN', 'x')];
  const next = [r('a', 'FIXED'), r('b', 'FIXED'), r('c', 'FIXED')];
  const confirm = [r('a', 'FIXED'), r('b', 'BROKEN', 'x')]; // c missing from the rerun: unstable too
  assert.deepEqual(kinds(diff(prev, next, confirm)), { a: 'fixed', b: 'unstable', c: 'unstable' });
});
// Changed in review round 1 (F1/F9, .review/pr-81.md): a new ERROR is now stored as an ERROR row (so it is reported
// once), an erroring fixture's held row is marked, and every stored row carries the commit it was seen on.
check('the stored state holds the previous row for ERROR (marked) and unstable fixtures, and stores a new ERROR as such', () => {
  const prev = [r('e', 'BROKEN', 'x'), r('u', 'BROKEN', 'x'), r('f', 'BROKEN', 'x')];
  const next = [r('e', 'ERROR', 'boom'), r('u', 'FIXED'), r('f', 'FIXED'), r('n', 'ERROR', 'boom')];
  const changes = diff(prev, next, [r('u', 'BROKEN', 'x'), r('f', 'FIXED')]);
  const s = nextState(prev, next, changes, { codegraph: B, recordedAt: 'd', graphAssay: G });
  assert.deepEqual(s.results, [{ ...r('e', 'BROKEN', 'x'), erroringSince: B }, r('u', 'BROKEN', 'x'), { ...r('f', 'FIXED'), seenAt: B },
    { ...r('n', 'ERROR', 'boom'), seenAt: B }]);
});
check('input is refused when its shape is wrong, never rendered', () => {
  assert.throws(() => rows({}), /no results/);
  assert.throws(() => rows({ results: [r('a', 'MAYBE')] }), /bad verdict/);
  assert.throws(() => rows({ results: [r('../x', 'FIXED')] }), /bad fixture name/);
  assert.throws(() => rows({ results: [r('a', 'FIXED'), r('a', 'FIXED')] }), /duplicate/);
  assert.throws(() => rows({ results: [r('a', 'FIXED')] }, new Set(['b'])), /unknown fixture/);
  assert.throws(() => rows({ results: [{ ...r('a', 'FIXED'), issue: '12' }] }), /bad issue/);
  assert.deepEqual(rows({ results: [{ name: 'a', issue: 0, verdict: 'FIXED' }] }), [r('a', 'FIXED', '', null)]);
});
check('drafts: fixed (closed vs open), regression and edges; none for changed, new, error, unstable or an unfiled fixture', () => {
  const c = (kind: any, from: any, to: any, issue = 1): Change => ({ kind, name: 'issue-1', issue, from, to });
  const closed = draft(c('fixed', r('x', 'BROKEN', 'w'), r('x', 'FIXED')), ctx);
  assert.match(closed, /^Confirmed fixed on `main` at bbbbbbbb, thanks\./);
  assert.match(closed, new RegExp(`tree/${G}/fixtures/oracle-candidates/issue-1\\)`));
  assert.match(closed, new RegExp(`compare/${A}\\.\\.\\.${B}`));
  assert.match(draft(c('fixed', r('x', 'BROKEN', 'w'), r('x', 'FIXED'), 2), ctx), /^This looks fixed on `main`/);
  assert.match(draft(c('regression', r('x', 'FIXED'), r('x', 'BROKEN', 'f -calls-> g')), ctx), /read FIXED on aaaaaaaa and reads BROKEN on bbbbbbbb: `f -calls-> g`/);
  assert.match(draft(c('edges', r('x', 'BROKEN', 'old'), r('x', 'BROKEN', 'new')), ctx), /^\*\*Edit \(2026-11-24\):\*\*.*On aaaaaaaa: `old`\. Now: `new`\./);
  for (const k of ['changed', 'new', 'error', 'unstable']) assert.equal(draft(c(k, r('x', 'BROKEN'), r('x', 'FIXED')), ctx), null, k);
  assert.equal(draft(c('fixed', r('x', 'BROKEN'), r('x', 'FIXED'), null), ctx), null);
});
check('a backtick or line break in detail text cannot break out of its code span', () => {
  const d = draft({ kind: 'regression', name: 'issue-1', issue: 1, from: r('x', 'FIXED'), to: r('x', 'BROKEN', 'a`b\nc') }, ctx);
  assert.match(d, /: `a b c`\./);
});
check('the report: empty with no changes, a table plus drafts otherwise, and a baseline line on the first run', () => {
  assert.equal(report([], ctx), '');
  const out = report(diff([r('issue-1', 'BROKEN', 'w')], [r('issue-1', 'FIXED')]), ctx);
  assert.match(out, /\| issue-1 \| colbymchenry\/codegraph#1 \(closed\) \| BROKEN \| FIXED \| fixed \|/);
  assert.match(out, /<details><summary>Draft for colbymchenry\/codegraph#1:/);
  assert.match(out, /````markdown\nConfirmed fixed/);
  assert.doesNotMatch(out, /\/home\//);
  assert.match(report([], ctx, { count: { FIXED: 2, BROKEN: 1 } }), /baseline\n\nNo earlier state.*BROKEN 1, FIXED 2/);
});
check('the command line: baseline, then a change, then flips; malformed input exits 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-watch-'));
  try {
    const f = (name: string, v: any) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), ...a, '--fixtures', fixtureDir()], { encoding: 'utf8' });
    const out = (name: string) => path.join(tmp, name);
    const r1 = f('r1.json', { results: [r('issue-1', 'BROKEN', 'w'), r('issue-2', 'FIXED', '', 2)] });
    let p = cli('run', '--next', r1, '--sha', A, '--graph-assay', G, '--state-out', out('s1.json'), '--report-out', out('m1.md'));
    assert.equal(p.status, 0, p.stderr);
    assert.match(fs.readFileSync(out('m1.md'), 'utf8'), /baseline/);
    const r2 = f('r2.json', { results: [r('issue-1', 'FIXED'), r('issue-2', 'FIXED', '', 2)] });
    assert.equal(cli('flips', '--prev', out('s1.json'), '--next', r2).stdout, 'issue-1\n');
    assert.equal(cli('flips', '--prev', out('s1.json'), '--next', r2, '--issues').stdout, '1\n');
    assert.equal(cli('flips', '--next', r2).stdout, '');
    p = cli('run', '--prev', out('s1.json'), '--next', r2, '--sha', B, '--graph-assay', G, '--confirm', r2,
      '--issue-states', f('st.json', { 1: 'open' }), '--state-out', out('s2.json'), '--report-out', out('m2.md'));
    assert.equal(p.status, 0, p.stderr);
    assert.match(fs.readFileSync(out('m2.md'), 'utf8'), /#1 \(open\) \| BROKEN \| FIXED/);
    assert.equal(JSON.parse(fs.readFileSync(out('s2.json'), 'utf8')).codegraph, B);
    p = cli('run', '--prev', out('s2.json'), '--next', r2, '--sha', B, '--graph-assay', G, '--state-out', out('s3.json'), '--report-out', out('m3.md'));
    assert.equal(fs.readFileSync(out('m3.md'), 'utf8'), '');
    assert.equal(cli('run', '--next', f('bad.json', { results: [r('a', 'NOPE')] }), '--sha', A, '--graph-assay', G, '--state-out', out('x'), '--report-out', out('y')).status, 2);
    assert.equal(cli('run', '--next', r2, '--sha', 'abc', '--graph-assay', G, '--state-out', out('x'), '--report-out', out('y')).status, 2);
    assert.equal(cli('run', '--next', r2, '--sha', A, '--graph-assay', G, '--issue-states', f('bs.json', { 1: 'merged' }), '--state-out', out('x'), '--report-out', out('y')).status, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- review round 1 (.review/pr-81.md) ----
const C = 'd'.repeat(40);
const meta = (sha: string) => ({ codegraph: sha, recordedAt: 'd', graphAssay: G });
const step = (prev: any[], next: any[], sha: string, confirm?: any[]) => {
  const changes = diff(prev, next, confirm ?? next);
  return { changes, state: nextState(prev, next, changes, meta(sha)).results };
};
check('F1: a fixture that keeps erroring is reported once, then quiet until it recovers', () => {
  const s0 = [{ ...r('a', 'BROKEN', 'w'), seenAt: A }];
  const s1 = step(s0, [r('a', 'ERROR', 'boom')], B);
  assert.deepEqual(kinds(s1.changes), { a: 'error' });
  const s2 = step(s1.state, [r('a', 'ERROR', 'boom again')], C);
  assert.deepEqual(kinds(s2.changes), {});
  const s3 = step(s2.state, [r('a', 'FIXED')], C);
  assert.deepEqual(kinds(s3.changes), { a: 'fixed' });
});
check('F1/F9: a fixture with no verdict yet stays quiet while it errors, and its first verdict is "new", not "fixed"', () => {
  const s1 = step([], [r('a', 'ERROR', 'boom')], A);
  assert.deepEqual(kinds(s1.changes), { a: 'error' });
  const s2 = step(s1.state, [r('a', 'ERROR', 'boom')], B);
  assert.deepEqual(kinds(s2.changes), {});
  const s3 = step(s2.state, [r('a', 'FIXED')], C);
  assert.deepEqual(kinds(s3.changes), { a: 'new' });
  assert.equal(draft(s3.changes[0], { ...ctx, prev: B, next: C }), null);
});
check('F2: a held row keeps the commit it was seen on, and the draft names that commit and range', () => {
  const s1 = step([{ ...r('issue-1', 'BROKEN', 'w'), seenAt: A }], [r('issue-1', 'ERROR', 'boom')], B);
  const s2 = step(s1.state, [r('issue-1', 'FIXED')], C);
  const d = draft(s2.changes[0], { ...ctx, prev: B, next: C });
  assert.match(d, /goes from BROKEN on aaaaaaaa to FIXED on dddddddd/);
  assert.match(d, new RegExp(`compare/${A}\\.\\.\\.${C}`));
  const u1 = step([{ ...r('issue-1', 'BROKEN', 'w'), seenAt: A }], [r('issue-1', 'FIXED')], B, [r('issue-1', 'BROKEN', 'w')]);
  assert.deepEqual(kinds(u1.changes), { 'issue-1': 'unstable' });
  assert.equal(u1.state[0].seenAt, A);
});
check('F5: a change where graph-assay changed the fixture or its scoring gets no draft and says so', () => {
  const prev = [{ ...r('issue-1', 'BROKEN', 'w'), seenAt: A, fixture: '1'.repeat(64) }];
  const own = diff(prev, [{ ...r('issue-1', 'FIXED'), fixture: '2'.repeat(64) }]);
  assert.equal(own[0].local, true);
  assert.equal(draft(own[0], ctx), null);
  assert.match(report(own, ctx), /graph-assay changed this fixture or its scoring/);
  const closure = diff(prev, [{ ...r('issue-1', 'FIXED'), fixture: '1'.repeat(64) }], undefined, { closureChanged: true });
  assert.equal(closure[0].local, true);
  assert.equal(diff(prev, [{ ...r('issue-1', 'FIXED'), fixture: '1'.repeat(64) }])[0].local, false);
});
check('F7: a report never exceeds GitHub\'s comment limit: drafts go first, then rows', () => {
  const big = Array.from({ length: 400 }, (_, i) => ({ kind: 'edges' as const, name: `issue-${i}`, issue: i + 1, local: false,
    from: { ...r(`issue-${i}`, 'BROKEN', 'x'.repeat(500)), seenAt: A }, to: r(`issue-${i}`, 'BROKEN', 'y'.repeat(500)) }));
  const out = report(big, ctx);
  assert.ok(out.length <= 60000, String(out.length));
  assert.match(out, /left out/);
});
check('F8: an ERROR row with no issue keeps the issue its previous row had', () => {
  assert.equal(diff([r('a', 'BROKEN', 'w', 5)], [r('a', 'ERROR', 'boom', null)])[0].issue, 5);
});
check('F3/F6/F9: the command line refuses changes without --confirm, accepts an unknown issue state, and state keeps ERROR rows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-watch-'));
  try {
    const f = (name: string, v: any) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), ...a, '--fixtures', fixtureDir()], { encoding: 'utf8' });
    const o = (name: string) => path.join(tmp, name);
    assert.equal(cli('state', f('r0.json', { results: [r('issue-1', 'BROKEN', 'w'), r('issue-2', 'ERROR', 'boom', 2)] }), A, o('s0.json')).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(o('s0.json'), 'utf8')).results.map((x: any) => x.verdict), ['BROKEN', 'ERROR']);
    const r1 = f('r1.json', { results: [r('issue-1', 'FIXED'), r('issue-2', 'ERROR', 'boom', 2)] });
    let p = cli('run', '--prev', o('s0.json'), '--next', r1, '--sha', B, '--graph-assay', G, '--state-out', o('x'), '--report-out', o('y'));
    assert.equal(p.status, 2); assert.match(p.stderr, /--confirm/);
    p = cli('run', '--prev', o('s0.json'), '--next', r1, '--confirm', r1, '--sha', B, '--graph-assay', G,
      '--issue-states', f('st.json', { 1: 'unknown' }), '--state-out', o('s1.json'), '--report-out', o('m1.md'));
    assert.equal(p.status, 0, p.stderr);
    const m = fs.readFileSync(o('m1.md'), 'utf8');
    assert.match(m, /#1 \(state unknown\)/); assert.match(m, /This looks fixed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
check('F4/F3: the report job reads only next.json and confirm.json from the artifact, and the replay job checks its rerun', () => {
  const wf = fs.readFileSync(path.join(here, '..', '.github/workflows/fixture-watch.yml'), 'utf8');
  const dl = /uses: actions\/download-artifact@\S+[^\n]*\n(?: {8}.*\n)+/.exec(wf)?.[0] ?? '';
  assert.match(dl, /path: artifact\n/);
  assert.match(wf, /cp artifact\/next\.json watch\/next\.json/);
  assert.match(wf, /test -s watch\/confirm\.json/);
});
console.log(`fixture-watch: ${n}/${n} checks`);
