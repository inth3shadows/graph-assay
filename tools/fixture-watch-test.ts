#!/usr/bin/env node
// tools/fixture-watch.ts: every change kind, the confirming reruns, what the stored state keeps, input
// validation, the report and its drafts, the command line end to end, and the workflow's hand-offs.
// Findings from the PR #81 reviews (F1-F9, R2-1..R2-5) are named where a check pins one.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMIT, diff, draft, nextState, report, rows, type Change } from './fixture-watch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`ok    ${name}`); };
const r = (name: string, verdict: string, detail = '', issue: number | null = 1) => ({ name, issue, verdict, detail });
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'd'.repeat(40); const G = 'c'.repeat(40);
const ctx = { prev: A, next: B, graphAssay: G, date: '2026-11-24', states: { 1: 'closed', 2: 'open' } as Record<string, string> };
const kinds = (cs: Change[]) => Object.fromEntries(cs.map((c) => [c.name, c.kind]));
/** One run: previous commit's replay, new replay (confirmed by identical reruns unless given), stored state. */
const step = (prev: any[], next: any[], prevSha: string, sha: string, stored: any[] = [], confirm?: { prev: any[]; next: any[] }) => {
  const changes = diff(prev, next, { stored, confirmPrev: confirm?.prev ?? prev, confirmNext: confirm?.next ?? next });
  return { changes, state: nextState(prev, next, changes, { codegraph: sha, recordedAt: 'd', graphAssay: G, prevSha }, stored).results };
};

check('each verdict change gets its kind; an unchanged fixture is not reported', () => {
  const prev = [r('fix', 'BROKEN', 'x'), r('reg', 'FIXED'), r('edg', 'BROKEN', 'x'), r('chg', 'BROKEN', 'x'), r('same', 'BROKEN', 'x'),
    r('err', 'BROKEN', 'x'), r('err2', 'ERROR', 'e'), r('g2f', 'GUESSED', 'x')];
  const next = [r('fix', 'FIXED'), r('reg', 'BROKEN', 'y'), r('edg', 'BROKEN', 'y'), r('chg', 'CHANGED'), r('same', 'BROKEN', 'x'),
    r('err', 'ERROR', 'boom'), r('err2', 'ERROR', 'e2'), r('new', 'BROKEN', 'z'), r('g2f', 'FIXED')];
  assert.deepEqual(kinds(diff(prev, next)), { fix: 'fixed', reg: 'regression', edg: 'edges', chg: 'changed', err: 'error', new: 'new', g2f: 'fixed' });
});
check('both confirming reruns must agree: either side disagreeing, or missing, makes the change unstable', () => {
  const prev = [r('a', 'BROKEN', 'x'), r('b', 'BROKEN', 'x'), r('c', 'BROKEN', 'x'), r('d', 'BROKEN', 'x')];
  const next = [r('a', 'FIXED'), r('b', 'FIXED'), r('c', 'FIXED'), r('d', 'FIXED')];
  const confirmNext = [r('a', 'FIXED'), r('b', 'BROKEN', 'x'), r('d', 'FIXED')]; // c missing
  const confirmPrev = [r('a', 'BROKEN', 'x'), r('b', 'BROKEN', 'x'), r('c', 'BROKEN', 'x'), r('d', 'FIXED')]; // d's previous side flaky
  assert.deepEqual(kinds(diff(prev, next, { confirmPrev, confirmNext })), { a: 'fixed', b: 'unstable', c: 'unstable', d: 'unstable' });
});
check('F5/R2-1: a graph-assay change cannot pass for an upstream one: the diff reads only the two replays made now', () => {
  // The stored state says FIXED (scored by an older graph-assay); both commits read BROKEN under today's code.
  const out = diff([r('a', 'BROKEN', 'x')], [r('a', 'BROKEN', 'x')], { stored: [{ ...r('a', 'FIXED'), seenAt: A }] });
  assert.deepEqual(out, []);
});
check('the stored state: new verdicts stamped with the new commit, an erroring fixture keeps its last real verdict, an unstable one its previous', () => {
  const prev = [r('e', 'BROKEN', 'x'), r('u', 'BROKEN', 'x'), r('f', 'BROKEN', 'x')];
  const next = [r('e', 'ERROR', 'boom'), r('u', 'FIXED'), r('f', 'FIXED'), r('n', 'ERROR', 'boom')];
  const { state } = step(prev, next, A, B, [], { prev, next: [r('u', 'BROKEN', 'x'), r('f', 'FIXED')] });
  assert.deepEqual(state, [{ ...r('e', 'BROKEN', 'x'), seenAt: A, erroringSince: B }, { ...r('u', 'BROKEN', 'x'), seenAt: A },
    { ...r('f', 'FIXED'), seenAt: B }, { ...r('n', 'ERROR', 'boom'), seenAt: B }]);
});
check('F1: a fixture that keeps erroring is reported once, then quiet until it recovers', () => {
  const s1 = step([r('a', 'BROKEN', 'w')], [r('a', 'ERROR', 'boom')], A, B);
  assert.deepEqual(kinds(s1.changes), { a: 'error' });
  const s2 = step([r('a', 'ERROR', 'boom')], [r('a', 'ERROR', 'boom')], B, C, s1.state);
  assert.deepEqual(kinds(s2.changes), {});
});
check('F2: recovery after errors compares with the last real verdict, marked stale: reported, no draft', () => {
  const s1 = step([r('issue-1', 'BROKEN', 'w')], [r('issue-1', 'ERROR', 'boom')], A, B);
  const s2 = step([r('issue-1', 'ERROR', 'boom')], [r('issue-1', 'FIXED')], B, C, s1.state);
  assert.deepEqual(kinds(s2.changes), { 'issue-1': 'fixed' });
  assert.equal(s2.changes[0].stale, true);
  assert.equal(draft(s2.changes[0], { ...ctx, prev: B, next: C }), null);
  assert.match(report(s2.changes, { ...ctx, prev: B, next: C }), /"was" is the last verdict recorded \(on aaaaaaaa\)/);
});
check('F2: a draft names exactly the two commits both replays were made on', () => {
  const d = draft(diff([r('issue-1', 'BROKEN', 'w')], [r('issue-1', 'FIXED')])[0], ctx);
  assert.match(d, /goes from BROKEN on aaaaaaaa to FIXED on bbbbbbbb/);
  assert.match(d, new RegExp(`compare/${A}\\.\\.\\.${B}`));
});
check('F9/R2-3: a fixture with no real verdict yet: quiet while it errors, "new" (no draft) when it gets one, labelled honestly', () => {
  const s1 = step([], [r('a', 'ERROR', 'boom')], A, B);
  assert.deepEqual(kinds(s1.changes), { a: 'error' });
  assert.match(report(s1.changes, ctx), /ERROR \(no verdict yet\)/);
  assert.deepEqual(kinds(step([r('a', 'ERROR', 'boom')], [r('a', 'ERROR', 'boom')], B, C, s1.state).changes), {});
  const s3 = step([r('a', 'ERROR', 'boom')], [r('a', 'FIXED')], B, C, s1.state);
  assert.deepEqual(kinds(s3.changes), { a: 'new' });
  assert.equal(draft(s3.changes[0], ctx), null);
});
check('F8: an ERROR row with no issue keeps the issue its previous row had', () => {
  assert.equal(diff([r('a', 'BROKEN', 'w', 5)], [r('a', 'ERROR', 'boom', null)])[0].issue, 5);
});
check('input is refused when its shape is wrong, never rendered; R2-4: a replay cannot carry state fields', () => {
  assert.throws(() => rows({}), /no results/);
  assert.throws(() => rows({ results: [r('a', 'MAYBE')] }), /bad verdict/);
  assert.throws(() => rows({ results: [r('../x', 'FIXED')] }), /bad fixture name/);
  assert.throws(() => rows({ results: [r('a', 'FIXED'), r('a', 'FIXED')] }), /duplicate/);
  assert.throws(() => rows({ results: [r('a', 'FIXED')] }, { fixtures: new Set(['b']) }), /unknown fixture/);
  assert.throws(() => rows({ results: [{ ...r('a', 'FIXED'), issue: '12' }] }), /bad issue/);
  assert.throws(() => rows({ results: [{ ...r('a', 'FIXED'), seenAt: 'x' }] }, { state: true }), /bad seenAt/);
  assert.deepEqual(rows({ results: [{ ...r('a', 'BROKEN'), erroringSince: A, seenAt: A }] }), [r('a', 'BROKEN')]);
  assert.deepEqual(rows({ results: [{ name: 'a', issue: 0, verdict: 'FIXED' }] }), [r('a', 'FIXED', '', null)]);
});
check('drafts: fixed (closed vs open), regression and edges; none for changed, new, error, unstable or an unfiled fixture', () => {
  const c = (kind: any, from: any, to: any, issue: number | null = 1): Change => ({ kind, name: 'issue-1', issue, from, to });
  const closed = draft(c('fixed', r('x', 'BROKEN', 'w'), r('x', 'FIXED')), ctx);
  assert.match(closed, /^Confirmed fixed on `main` at bbbbbbbb, thanks\./);
  assert.match(closed, new RegExp(`tree/${G}/fixtures/oracle-candidates/issue-1\\)`));
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
  assert.match(report([], ctx, { baseline: { FIXED: 2, BROKEN: 1 } }), /baseline\n\nNo earlier state.*BROKEN 1, FIXED 2/);
});
check('F7/R2-5: the comment stays under the limit (drafts first, then rows); the uncapped report keeps everything', () => {
  const big: Change[] = Array.from({ length: 400 }, (_, i) => ({ kind: 'edges', name: `issue-${i}`, issue: i + 1,
    from: r(`issue-${i}`, 'BROKEN', 'x'.repeat(500)), to: r(`issue-${i}`, 'BROKEN', 'y'.repeat(500)) }));
  const capped = report(big, ctx);
  assert.ok(capped.length <= LIMIT, String(capped.length));
  assert.match(capped, /left out to stay under GitHub's comment limit: the replay job's summary/);
  const full = report(big, ctx, { limit: Infinity });
  assert.equal(full.match(/^\| issue-/gm).length, 400);
  assert.equal(full.match(/<details>/g).length, 400);
});
check('the command line: baseline, a confirmed change, flips; F3: changes need both reruns; R2-2: a stored state for another commit is refused', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-watch-'));
  try {
    const fx = path.join(tmp, 'fixtures');
    for (const name of ['issue-1', 'issue-2']) { fs.mkdirSync(path.join(fx, name), { recursive: true }); fs.writeFileSync(path.join(fx, name, 'expect.json'), '{}'); }
    const f = (name: string, v: any) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
    const o = (name: string) => path.join(tmp, name);
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), ...a, '--fixtures', fx], { encoding: 'utf8' });
    const r1 = f('r1.json', { results: [r('issue-1', 'BROKEN', 'w'), r('issue-2', 'FIXED', '', 2)] });
    const r2 = f('r2.json', { results: [r('issue-1', 'FIXED'), r('issue-2', 'FIXED', '', 2)] });
    let p = cli('run', '--next', r1, '--sha', A, '--graph-assay', G, '--state-out', o('s1.json'), '--report-out', o('m1.md'));
    assert.equal(p.status, 0, p.stderr);
    assert.match(fs.readFileSync(o('m1.md'), 'utf8'), /baseline/);
    assert.equal(cli('flips', '--prev', r1, '--next', r2).stdout, 'issue-1\n');
    assert.equal(cli('flips', '--prev', r1, '--next', r2, '--issues').stdout, '1\n');
    const run2 = (...extra: string[]) => cli('run', '--prev', r1, '--prev-sha', A, '--next', r2, '--sha', B, '--graph-assay', G,
      '--state-out', o('s2.json'), '--report-out', o('m2.md'), ...extra);
    p = run2('--state', o('s1.json'));
    assert.equal(p.status, 2); assert.match(p.stderr, /--confirm-prev and --confirm-next/);
    p = run2('--state', o('s1.json'), '--confirm-prev', r1, '--confirm-next', r2, '--issue-states', f('st.json', { 1: 'unknown' }));
    assert.equal(p.status, 0, p.stderr);
    const m = fs.readFileSync(o('m2.md'), 'utf8');
    assert.match(m, /#1 \(state unknown\) \| BROKEN \| FIXED/); assert.match(m, /This looks fixed/); // F6
    assert.equal(JSON.parse(fs.readFileSync(o('s2.json'), 'utf8')).codegraph, B);
    p = run2('--state', o('s2.json'), '--confirm-prev', r1, '--confirm-next', r2); // s2 is B's state, not A's
    assert.equal(p.status, 2); assert.match(p.stderr, /stored state is for bbbbbbbb, not the previous commit aaaaaaaa/);
    p = cli('run', '--prev', r2, '--prev-sha', B, '--next', r2, '--sha', C, '--graph-assay', G, '--state', o('s2.json'), '--state-out', o('s3.json'), '--report-out', o('m3.md'));
    assert.equal(p.status, 0, p.stderr); assert.equal(fs.readFileSync(o('m3.md'), 'utf8'), '');
    assert.equal(cli('run', '--next', f('bad.json', { results: [r('issue-1', 'NOPE')] }), '--sha', A, '--graph-assay', G, '--state-out', o('x'), '--report-out', o('y')).status, 2);
    assert.equal(cli('run', '--next', r2, '--sha', 'abc', '--graph-assay', G, '--state-out', o('x'), '--report-out', o('y')).status, 2);
    assert.equal(cli('run', '--next', r2, '--prev', r1, '--sha', B, '--graph-assay', G, '--state-out', o('x'), '--report-out', o('y')).status, 2); // --prev without --prev-sha
    assert.equal(cli('run', '--next', r2, '--sha', A, '--graph-assay', G, '--issue-states', f('bs.json', { 1: 'merged' }), '--state-out', o('x'), '--report-out', o('y')).status, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
check('the workflow: the previous commit is replayed with today\'s checkout; reruns are required; the report job takes only replay results and checks the state it diffs', () => {
  const wf = fs.readFileSync(path.join(here, '..', '.github/workflows/fixture-watch.yml'), 'utf8');
  assert.match(wf, /replay "\$PREV_JS" --json watch\/prev\.json/); // F5
  assert.match(wf, /test -s watch\/confirm-next\.json/); // F3
  assert.match(wf, /test -s watch\/confirm-prev\.json/);
  const dl = /uses: actions\/download-artifact@\S+[^\n]*\n(?: {8}.*\n)+/.exec(wf)?.[0] ?? '';
  assert.match(dl, /path: artifact\n/); // F4
  for (const file of ['next', 'prev', 'confirm-prev', 'confirm-next']) assert.match(wf, new RegExp(`artifact/${file}\\.json`));
  assert.match(wf, /--state watch\/stored\.json/); // R2-2: run checks it is the previous commit's
  assert.match(wf, /\|\| s=unknown/); // F6
  assert.match(wf, /--no-limit/); // R2-5
});
console.log(`fixture-watch: ${n}/${n} checks`);
