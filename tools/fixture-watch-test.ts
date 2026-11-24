#!/usr/bin/env node
// tools/fixture-watch.ts: every change kind, the confirming reruns, what the stored state keeps, input
// validation, the report and its drafts, the command line end to end, and the workflow's hand-offs.
// Findings from the PR #81 reviews (F1-F9, R2-x, R3-x) are named where a check pins one.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMIT, diff, draft, erroringOf, nextState, report, rerunNames, rows, type Change } from './fixture-watch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`ok    ${name}`); };
const r = (name: string, verdict: string, detail = '', issue: number | null = 1) => ({ name, issue, verdict, detail });
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'd'.repeat(40); const G = 'c'.repeat(40);
const ctx = { prev: A, next: B, graphAssay: G, date: '2026-11-24', states: { 1: 'closed', 2: 'open' } as Record<string, string> };
const kinds = (cs: Change[]) => Object.fromEntries(cs.map((c) => [c.name, c.kind]));
/**
 * One run as the workflow does it: the reruns cover only the fixtures `flips` picks (the changes that need
 * confirming), never every row (round 3 found a test that confirmed everything hid a stall).
 */
const step = (prev: any[], next: any[], sha: string, stored?: { erroring: string[] }, reruns?: { prev: any[]; next: any[] }) => {
  const picked = new Set(rerunNames(prev, next));
  // As the workflow: no rerun files at all when nothing is picked (R4-5).
  const confirmPrev = reruns?.prev ?? (picked.size ? prev.filter((r) => picked.has(r.name)) : undefined);
  const confirmNext = reruns?.next ?? (picked.size ? next.filter((r) => picked.has(r.name)) : undefined);
  const changes = diff(prev, next, { erroring: stored ? erroringOf(stored) : undefined, confirmPrev, confirmNext });
  return { changes, state: nextState(next, { codegraph: sha, recordedAt: 'd', graphAssay: G }) };
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
check('the stored state: the new commit, the fixtures erroring on it (sorted), and its verdicts as a record', () => {
  const next = [r('z', 'ERROR', 'boom'), r('f', 'FIXED'), r('a', 'ERROR', 'boom')];
  assert.deepEqual(nextState(next, { codegraph: B, recordedAt: 'd', graphAssay: G }),
    { codegraph: B, recordedAt: 'd', graphAssay: G, erroring: ['a', 'z'], results: next });
  assert.throws(() => erroringOf({ erroring: ['../x'] }), /bad erroring list/);
  assert.throws(() => erroringOf({ codegraph: A }), /bad erroring list/); // R4-6 (was: read as [])
});
check('F1: a fixture that keeps erroring is reported once, then quiet; R3-4: also when both commits error', () => {
  const s1 = step([r('a', 'BROKEN', 'w')], [r('a', 'ERROR', 'boom')], B, { erroring: [] });
  assert.deepEqual(kinds(s1.changes), { a: 'error' });
  assert.deepEqual(kinds(step([r('a', 'ERROR', 'boom')], [r('a', 'ERROR', 'boom')], C, s1.state).changes), {});
  // Both commits error under today's graph-assay, and the stored list (from an older run) does not have it.
  const both = step([r('b', 'ERROR', 'boom')], [r('b', 'ERROR', 'boom')], C, { erroring: [] });
  assert.deepEqual(kinds(both.changes), { b: 'error' });
  assert.match(report(both.changes, ctx), /started erroring \(reported once\)/);
});
check('R3-1/F2/R4-4: recovery after errors is reported as recovered (no draft), and the run goes through', () => {
  const s1 = step([r('issue-1', 'BROKEN', 'w')], [r('issue-1', 'ERROR', 'boom')], B, { erroring: [] });
  const s2 = step([r('issue-1', 'ERROR', 'boom')], [r('issue-1', 'FIXED')], C, s1.state);
  assert.deepEqual(kinds(s2.changes), { 'issue-1': 'recovered' });
  assert.equal(draft(s2.changes[0], { ...ctx, prev: B, next: C }), null);
});
check('R4-1: the previous commit erroring only on re-score is rerun: confirmed, the fix is a fix (with a draft); still erroring, it says check by hand', () => {
  const prev = [r('issue-1', 'ERROR', 'timeout')]; const next = [r('issue-1', 'FIXED')];
  assert.deepEqual(rerunNames(prev, next), ['issue-1']);
  const ok = diff(prev, next, { erroring: new Set(), confirmPrev: [r('issue-1', 'BROKEN', 'w')], confirmNext: next });
  assert.deepEqual(kinds(ok), { 'issue-1': 'fixed' });
  assert.equal(ok[0].from?.verdict, 'BROKEN');
  assert.match(draft(ok[0], ctx), /goes from BROKEN on aaaaaaaa to FIXED on bbbbbbbb/);
  const still = diff(prev, next, { erroring: new Set(), confirmPrev: prev, confirmNext: next });
  assert.deepEqual(kinds(still), { 'issue-1': 'prev-error' });
  assert.equal(draft(still[0], ctx), null);
  assert.match(report(still, ctx), /the previous commit errored when re-scored: check by hand \(no draft\)/);
});
check('R4-2: an ERROR on the new commit is reported when the previous commit has a verdict today, whatever the stored list says', () => {
  assert.deepEqual(kinds(diff([r('x', 'BROKEN', 'w')], [r('x', 'ERROR', 'boom')], { erroring: new Set(['x']) })), { x: 'error' });
  assert.deepEqual(kinds(diff([r('x', 'ERROR', 'boom')], [r('x', 'ERROR', 'boom')], { erroring: new Set(['x']) })), {});
});
check('R4-4: a listed fixture whose error cleared on both commits is reported as recovered', () => {
  assert.deepEqual(kinds(diff([r('a', 'BROKEN', 'x')], [r('a', 'BROKEN', 'x')], { erroring: new Set(['a']) })), { a: 'recovered' });
});
check('R4-3: an unstable change says it will not be looked at again', () => {
  const u = diff([r('a', 'BROKEN', 'x')], [r('a', 'FIXED')], { confirmPrev: [r('a', 'BROKEN', 'x')], confirmNext: [r('a', 'BROKEN', 'x')] });
  assert.match(report(u, ctx), /unstable \(a rerun disagreed; not re-checked later: check by hand\)/);
});
check('F2: a draft names exactly the two commits both replays were made on', () => {
  const d = draft(diff([r('issue-1', 'BROKEN', 'w')], [r('issue-1', 'FIXED')])[0], ctx);
  assert.match(d, /goes from BROKEN on aaaaaaaa to FIXED on bbbbbbbb/);
  assert.match(d, new RegExp(`compare/${A}\\.\\.\\.${B}`));
});
check('F9: a brand-new fixture: "started erroring" once while it errors, then "first verdict" with no draft', () => {
  const s1 = step([], [r('a', 'ERROR', 'boom')], B, { erroring: [] });
  assert.deepEqual(kinds(s1.changes), { a: 'error' });
  assert.deepEqual(kinds(step([], [r('a', 'FIXED')], C, s1.state).changes), { a: 'new' });
});
check('F8: an ERROR row with no issue keeps the issue its previous row had', () => {
  assert.equal(diff([r('a', 'BROKEN', 'w', 5)], [r('a', 'ERROR', 'boom', null)])[0].issue, 5);
});
check('input is refused when its shape is wrong, never rendered; R2-4: a replay carries no other fields; R3-5: no unsafe issue numbers', () => {
  assert.throws(() => rows({}), /no results/);
  assert.throws(() => rows({ results: [r('a', 'MAYBE')] }), /bad verdict/);
  assert.throws(() => rows({ results: [r('../x', 'FIXED')] }), /bad fixture name/);
  assert.throws(() => rows({ results: [r('a', 'FIXED'), r('a', 'FIXED')] }), /duplicate/);
  assert.throws(() => rows({ results: [r('a', 'FIXED')] }, { fixtures: new Set(['b']) }), /unknown fixture/);
  assert.throws(() => rows({ results: [{ ...r('a', 'FIXED'), issue: '12' }] }), /bad issue/);
  assert.throws(() => rows({ results: [{ ...r('a', 'FIXED'), issue: 1e21 }] }), /bad issue/); // R3-5
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
  assert.match(capped, /left out to stay under GitHub's comment limit: the report job's summary/);
  const full = report(big, ctx, { limit: Infinity });
  assert.equal(full.match(/^\| issue-/gm).length, 400);
  assert.equal(full.match(/<details>/g).length, 400);
});
check('the command line: baseline, a confirmed change, flips; F3: changes need both reruns; R2-2/R3-3: a stored state for another commit, or any for a baseline, is refused', () => {
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
    // R3-3: a baseline run (no --prev) refuses an existing stored state rather than overwrite it.
    p = cli('run', '--next', r2, '--sha', C, '--graph-assay', G, '--state', o('s2.json'), '--state-out', o('x'), '--report-out', o('y'));
    assert.equal(p.status, 2); assert.match(p.stderr, /not a baseline/);
    // R3-5: flips refuses a fixture the checkout does not have (job 2 looks up issues only for real fixtures).
    assert.equal(cli('flips', '--prev', r1, '--next', f('fake.json', { results: [r('made-up', 'FIXED', '', 9)] })).status, 2);
    // R3-6: --summary-out writes the uncapped report, with the issue states the comment has.
    p = run2('--state', o('s1.json'), '--confirm-prev', r1, '--confirm-next', r2, '--issue-states', f('st2.json', { 1: 'closed' }), '--summary-out', o('full.md'));
    assert.equal(p.status, 0, p.stderr);
    assert.match(fs.readFileSync(o('full.md'), 'utf8'), /#1 \(closed\)[\s\S]*Confirmed fixed/);
    // R3-1 end to end, reruns limited to what flips picks: baseline, error, recovery. Every run goes through.
    const r3 = f('r3.json', { results: [r('issue-1', 'ERROR', 'boom'), r('issue-2', 'FIXED', '', 2)] });
    assert.equal(cli('flips', '--prev', r1, '--next', r3).stdout, '');
    p = cli('run', '--prev', r1, '--prev-sha', A, '--next', r3, '--sha', B, '--graph-assay', G, '--state', o('s1.json'), '--state-out', o('e1.json'), '--report-out', o('e1.md'));
    assert.equal(p.status, 0, p.stderr); assert.match(fs.readFileSync(o('e1.md'), 'utf8'), /started erroring/);
    assert.deepEqual(JSON.parse(fs.readFileSync(o('e1.json'), 'utf8')).erroring, ['issue-1']);
    // The previous commit errors and the new one has a verdict: rerun on both sides (R4-1), as the workflow does.
    assert.equal(cli('flips', '--prev', r3, '--next', r2).stdout, 'issue-1\n');
    const pick = (file: string, name: string) => f(`pick-${name}-${path.basename(file)}`, { results: JSON.parse(fs.readFileSync(file, 'utf8')).results.filter((x: any) => x.name === name) });
    p = cli('run', '--prev', r3, '--prev-sha', B, '--next', r2, '--sha', C, '--graph-assay', G, '--state', o('e1.json'),
      '--confirm-prev', pick(r3, 'issue-1'), '--confirm-next', pick(r2, 'issue-1'), '--state-out', o('e2.json'), '--report-out', o('e2.md'));
    assert.equal(p.status, 0, p.stderr); assert.match(fs.readFileSync(o('e2.md'), 'utf8'), /\| issue-1 \| [^|]+ \| - \| FIXED \| recovered from errors \(no draft\) \|/); // R4-5
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
  assert.match(wf, /--summary-out watch\/full\.md/); // R2-5/R3-6: the report job's own uncapped summary
  assert.equal(wf.match(/key: codegraph-build-\$\{\{ steps\.shas\.outputs\.(new|prev) \}\}-node\$\{\{ env\.NODE_VERSION \}\}-\$\{\{ hashFiles\('tools\/build-codegraph\.sh'\) \}\}/g)?.length, 2); // R3-2
  assert.equal(wf.match(/node-version: \$\{\{ env\.NODE_VERSION \}\}/g)?.length, 2);
  assert.equal(wf.match(/flips --prev watch\/prev\.json --next watch\/next\.json [^\n]*--fixtures fixtures\/oracle-candidates/g)?.length, 2); // R3-5
  assert.equal(wf.match(/if \[ -f watch\/stored\.json \]; then args\+=\(--state watch\/stored\.json\); fi/g)?.length, 2); // R3-3
});
console.log(`fixture-watch: ${n}/${n} checks`);
