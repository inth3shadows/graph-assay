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
import { LIMIT, diff, draft, erroringOf, nextState, prSection, prSelect, prState, report, rerunNames, reviewDraft, rows, signature, type Change } from './fixture-watch.ts';

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
  assert.match(report(both.changes, ctx), /errors on the new commit: check by hand/); // R5-4: no "reported once" promise
});
check('R3-1/F2/R4-4: recovery after errors is reported as recovered (no draft), and the run goes through', () => {
  const s1 = step([r('issue-1', 'BROKEN', 'w')], [r('issue-1', 'ERROR', 'boom')], B, { erroring: [] });
  const s2 = step([r('issue-1', 'ERROR', 'boom')], [r('issue-1', 'FIXED')], C, s1.state);
  assert.deepEqual(kinds(s2.changes), { 'issue-1': 'recovered' });
  assert.equal(draft(s2.changes[0], { ...ctx, prev: B, next: C }), null);
});
check('R5-1/R5-2: when the previous commit errors, nothing is rerun or drafted: listed or not, the change is for a person to check', () => {
  const prev = [r('issue-1', 'ERROR', 'timeout')]; const next = [r('issue-1', 'FIXED')];
  assert.deepEqual(rerunNames(prev, next), []);
  const unlisted = diff(prev, next, { erroring: new Set() });
  assert.deepEqual(kinds(unlisted), { 'issue-1': 'prev-error' });
  assert.equal(unlisted[0].issue, 1);
  assert.equal(draft(unlisted[0], ctx), null);
  assert.match(report(unlisted, ctx), /\| issue-1 \| `colbymchenry\/codegraph#1` \(closed\) \| - \| FIXED \| the previous commit errored when re-scored: check by hand \(no draft\) \|/);
  const listed = diff(prev, next, { erroring: new Set(['issue-1']) });
  assert.deepEqual(kinds(listed), { 'issue-1': 'recovered' });
  assert.equal(draft(listed[0], ctx), null);
  // A rerun of the previous commit, if one were passed, changes nothing: there is no flake-resolution path.
  assert.deepEqual(kinds(diff(prev, next, { erroring: new Set(), confirmPrev: [r('issue-1', 'BROKEN', 'w')], confirmNext: next })), { 'issue-1': 'prev-error' });
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
check('F9: a brand-new fixture: reported once while it errors, then "first verdict" with no draft', () => {
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
  assert.match(out, /\| issue-1 \| `colbymchenry\/codegraph#1` \(closed\) \| BROKEN \| FIXED \| fixed \|/);
  assert.match(out, /<details><summary>Draft for <code>colbymchenry\/codegraph#1<\/code>:/);
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
    assert.match(m, /#1` \(state unknown\) \| BROKEN \| FIXED/); assert.match(m, /This looks fixed/); // F6
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
    assert.match(fs.readFileSync(o('full.md'), 'utf8'), /#1` \(closed\)[\s\S]*Confirmed fixed/);
    // R3-1 end to end, reruns limited to what flips picks: baseline, error, recovery. Every run goes through.
    const r3 = f('r3.json', { results: [r('issue-1', 'ERROR', 'boom'), r('issue-2', 'FIXED', '', 2)] });
    assert.equal(cli('flips', '--prev', r1, '--next', r3).stdout, '');
    p = cli('run', '--prev', r1, '--prev-sha', A, '--next', r3, '--sha', B, '--graph-assay', G, '--state', o('s1.json'), '--state-out', o('e1.json'), '--report-out', o('e1.md'));
    assert.equal(p.status, 0, p.stderr); assert.match(fs.readFileSync(o('e1.md'), 'utf8'), /errors on the new commit/);
    assert.deepEqual(JSON.parse(fs.readFileSync(o('e1.json'), 'utf8')).erroring, ['issue-1']);
    // The previous commit errors: nothing to rerun (no flake resolution), and run needs no rerun files.
    assert.equal(cli('flips', '--prev', r3, '--next', r2).stdout, '');
    // #82: the issues to look up cover every change the report can list, not only the rerun ones.
    assert.equal(cli('issues', '--prev', r3, '--next', r2).stdout, '1\n');
    assert.equal(cli('issues', '--prev', r3, '--next', r3).stdout, '1\n'); // errors on both commits: may be listed
    assert.equal(cli('issues', '--prev', r2, '--next', r2).stdout, ''); // nothing changed, nothing errors
    p = cli('run', '--prev', r3, '--prev-sha', B, '--next', r2, '--sha', C, '--graph-assay', G, '--state', o('e1.json'), '--state-out', o('e2.json'), '--report-out', o('e2.md'));
    assert.equal(p.status, 0, p.stderr); assert.match(fs.readFileSync(o('e2.md'), 'utf8'), /\| issue-1 \| [^|]+ \| - \| FIXED \| has a verdict again after erroring: check by hand \(no draft\) \|/); // R4-5
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
  assert.match(wf, /for n in \$\(node tools\/fixture-watch\.ts issues --prev watch\/prev\.json --next watch\/next\.json --fixtures fixtures\/oracle-candidates\)/); // #82
  assert.doesNotMatch(wf, /A change is rerun on both commits before it counts/); // #82: errors are listed without a rerun
  assert.match(wf, /--summary-out watch\/full\.md/); // R2-5/R3-6: the report job's own uncapped summary
  assert.equal(wf.match(/key: codegraph-build-\$\{\{ steps\.shas\.outputs\.(new|prev) \}\}-node\$\{\{ env\.NODE_VERSION \}\}-\$\{\{ hashFiles\('tools\/build-codegraph\.sh'\) \}\}/g)?.length, 2); // R3-2
  assert.equal(wf.match(/node-version: \$\{\{ env\.NODE_VERSION \}\}/g)?.length, 2);
  assert.equal(wf.match(/(?:flips|issues) --prev watch\/prev\.json --next watch\/next\.json [^\n]*--fixtures fixtures\/oracle-candidates/g)?.length, 2); // R3-5: both reads of replay names are checked
  assert.equal(wf.match(/if \[ -f watch\/stored\.json \]; then args\+=\(--state watch\/stored\.json\); fi/g)?.length, 2); // R3-3
});
// ---- PR watch: open upstream PRs, before merge (plan graph-assay-pr-watch.md) ----
const pctx = { prev: A, next: B, graphAssay: G, date: '2026-11-24', states: { 3447: 'open' } as Record<string, string> };
check('PR watch: a review draft for a PR that fixes a fixture, in the review-comment shape, pinned and lint-shaped', () => {
  const ch = diff([r('issue-3447', 'BROKEN', 'fromNew -calls-> route.go:Route::Path', 3447)], [r('issue-3447', 'FIXED', '', 3447)]);
  const d = reviewDraft(3454, ch, pctx);
  assert.match(d, /^Checked against the fixtures in \[graph-assay\]\(https:\/\/github\.com\/inth3shadows\/graph-assay\), which I maintain: this PR fixes the issue-3447 fixture \(#3447\)\./);
  assert.match(d, /\*\*The issue-3447 fixture is fixed\.\*\* Verified on head `bbbbbbbb` vs base `aaaaaaaa`: on base it reads BROKEN \(`fromNew -calls-> route\.go:Route::Path`\); on head none of its wrong edges remain and every right edge is there \(\[fixture\]\(/);
  assert.match(d, new RegExp(`tree/${G}/fixtures/oracle-candidates/issue-3447\\)`));
  assert.match(d, /The other fixtures read the same on head and base\./);
  assert.doesNotMatch(d, /\/home\//);
});
check('PR watch: a PR that breaks a fixture gets the failing case; an error-only change gets no draft', () => {
  const ch = diff([r('issue-9', 'FIXED', '', 9)], [r('issue-9', 'BROKEN', 'a -calls-> b', 9)]);
  assert.match(reviewDraft(1, ch, pctx), /this PR breaks the issue-9 fixture \(#9\)[\s\S]*\*\*The issue-9 fixture breaks\.\*\* Failing case \(verified on head `bbbbbbbb` vs base `aaaaaaaa`\): it reads FIXED on base and BROKEN on head: `a -calls-> b` \(\[fixture\]\(/);
  assert.equal(reviewDraft(1, diff([r('x', 'BROKEN', 'w', 9)], [r('x', 'ERROR', 'boom', 9)]), pctx), null);
});
check('PR watch: the PR section names the PR by number only (no upstream-written title), with a table and the draft', () => {
  const ch = diff([r('issue-3447', 'BROKEN', 'w', 3447)], [r('issue-3447', 'FIXED', '', 3447)]);
  const sec = prSection(3454, ch, pctx);
  assert.match(sec, /^#### `colbymchenry\/codegraph#3454` at `bbbbbbbb` \(merge base `aaaaaaaa`\)/);
  assert.match(sec, /\| issue-3447 \| `colbymchenry\/codegraph#3447` \(open\) \| BROKEN \| FIXED \| fixed \|/);
  assert.match(sec, /<details><summary>Draft review comment for <code>colbymchenry\/codegraph#3454<\/code><\/summary>/);
  assert.equal(prSection(3454, [], pctx), '');
});
check('PR watch: select PRs whose head moved since the last check, newest first, capped; state keeps open PRs only', () => {
  const prs = [{ number: 5, head: B, base: A }, { number: 4, head: A, base: A }, { number: 3, head: C, base: A }, { number: 2, head: B, base: A }];
  const state = { prs: { 4: { head: A, sig: '' }, 2: { head: A, sig: 'x' }, 99: { head: A, sig: '' } } };
  assert.deepEqual(prSelect(prs, state, 2).map((p) => p.number), [5, 3]);
  assert.throws(() => prSelect([{ number: 1, head: 'zz', base: A }], { prs: {} }, 5), /bad pr/);
  const next = prState(state, [5, 4, 3, 2], [{ number: 5, head: B, sig: 'k' }]);
  assert.deepEqual(next, { prs: { 2: { head: A, sig: 'x' }, 4: { head: A, sig: '' }, 5: { head: B, sig: 'k' } } });
});
check('PR watch: the signature ignores order and detail-free noise, so a PR is re-reported only when its result changes', () => {
  const a = diff([r('x', 'BROKEN', 'w'), r('y', 'FIXED')], [r('x', 'FIXED'), r('y', 'BROKEN', 'z')]);
  assert.equal(signature(a), signature([...a].reverse()));
  assert.notEqual(signature(a), signature(a.slice(0, 1)));
  assert.equal(signature([]), '');
});
check('PR watch command line: select, issues, report once per changed result, missing results left for the next run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-prwatch-'));
  try {
    const fx = path.join(tmp, 'fixtures');
    for (const name of ['issue-1', 'issue-2']) { fs.mkdirSync(path.join(fx, name), { recursive: true }); fs.writeFileSync(path.join(fx, name, 'expect.json'), '{}'); }
    const f = (name: string, v: any) => { const p = path.join(tmp, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); return p; };
    const o = (name: string) => path.join(tmp, name);
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), ...a, '--fixtures', fx], { encoding: 'utf8' });
    const before = { results: [r('issue-1', 'BROKEN', 'w'), r('issue-2', 'FIXED', '', 2)] };
    const after = { results: [r('issue-1', 'FIXED'), r('issue-2', 'FIXED', '', 2)] };
    for (const [k, v] of Object.entries({ prev: before, next: after, 'confirm-prev': { results: [before.results[0]] }, 'confirm-next': { results: [after.results[0]] } })) f(`artifact/pr-5/${k}.json`, v);
    const prs = f('prs.json', [{ number: 5, head: B, base: A }, { number: 6, head: C, base: A }]);
    let p = spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), 'pr-select', '--prs', prs, '--cap', '1'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(p.stdout), [{ number: 5, head: B, base: A }]);
    assert.equal(cli('pr-issues', '--prs', prs, '--dir', o('artifact')).stdout, '1\n');
    const report = (...extra: string[]) => cli('pr-report', '--prs', prs, '--dir', o('artifact'), '--graph-assay', G, '--open', f('open.json', [5, 6]), '--report-out', o('c.md'), '--state-out', o('s.json'), ...extra);
    p = report('--issue-states', f('st.json', { 1: 'open' }));
    assert.equal(p.status, 0, p.stderr); assert.match(p.stderr, /no complete results for #6/);
    const c = fs.readFileSync(o('c.md'), 'utf8');
    assert.match(c, /^### PR watch: 1 open PR\(s\) checked, 1 with a changed result/);
    assert.match(c, /#### `colbymchenry\/codegraph#5` at `bbbbbbbb` \(merge base `aaaaaaaa`\)[\s\S]*this PR fixes the issue-1 fixture \(#1\)/);
    const st = JSON.parse(fs.readFileSync(o('s.json'), 'utf8'));
    assert.deepEqual(Object.keys(st.prs), ['5', '6']); assert.equal(st.prs['5'].head, B); assert.equal(st.prs['6'].failed, 1); // P5: a failed PR is recorded for one retry
    fs.copyFileSync(o('s.json'), o('s0.json'));
    p = report('--state', o('s0.json'));
    assert.equal(p.status, 0, p.stderr); assert.equal(fs.readFileSync(o('c.md'), 'utf8'), ''); // same result: not reported again
    fs.rmSync(path.join(tmp, 'artifact/pr-5/confirm-next.json'));
    p = report(); assert.equal(p.status, 0); assert.equal(JSON.parse(fs.readFileSync(o('s.json'), 'utf8')).prs['5'].failed, 1); // reruns missing: failed, retried once
    assert.equal(cli('pr-report', '--prs', f('bad.json', [{ number: 1, head: 'x', base: A }]), '--dir', o('artifact'), '--graph-assay', G, '--open', o('open.json'), '--report-out', o('x'), '--state-out', o('y')).status, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
check('PR watch workflow: upstream code runs only in the read-only replay job; the report job reads four files per PR; its own state branch; no PR title rendered', () => {
  const wf = fs.readFileSync(path.join(here, '..', '.github/workflows/pr-watch.yml'), 'utf8');
  const jobs = wf.split(/\n  (?=select:|replay:|report:)/);
  const [select, replay, report] = ['select:', 'replay:', 'report:'].map((k) => jobs.find((j) => j.startsWith(k)) ?? '');
  assert.match(replay, /permissions:\n {6}contents: read\n/);
  assert.match(select, /permissions:\n {6}contents: read\n/);
  assert.match(report, /contents: write/);
  assert.doesNotMatch(report, /build-codegraph|replay\.mts/); // the write job never builds or runs upstream code
  assert.doesNotMatch(select, /build-codegraph|replay\.mts/);
  assert.match(wf, /pr-watch-state/); assert.doesNotMatch(wf, /watch-state\b(?<!pr-watch-state)/);
  assert.doesNotMatch(wf, /\.title/); // upstream-written text never reaches our comment
  // P1: a job that runs PR code never saves a cache (a fork could plant a build the fixture watch then restores).
  assert.doesNotMatch(wf, /uses: actions\/cache@/);
  assert.match(select, /console\.error\(`skipping #\$\{p\.number\}: no merge base/); // P4: one PR's failed compare skips that PR only
  assert.match(report, /pr-watch-state changed since this run picked its PRs/); // P13
  // Q1/Q2: PR-head code runs only in a locked-down container; the runner itself only builds and runs the merge base.
  assert.match(replay, /docker run --rm --user "\$\(id -u\):\$\(id -g\)" --cap-drop ALL --security-opt no-new-privileges/);
  assert.match(replay, /-v "\$PWD:\/ga:ro"/);
  assert.doesNotMatch(wf, /--privileged|docker\.sock|--pid=host|--network[= ]host|--cap-add/);
  assert.doesNotMatch(replay, /HEAD_JS|BASE_JS/); // no host-side build or replay of either side
  // R1: the merge base is scored in the same container image and options as the head.
  assert.match(replay, /sandbox base '[^']*tools\/build-codegraph\.sh "\$SHA" \/build/);
  assert.match(replay, /sandbox head '[^']*tools\/build-codegraph\.sh "\$SHA" \/build/);
  // R2: a sandbox output is taken only if it is a regular file, not a symlink, and of sane size.
  assert.match(replay, /take\(\) \{ \[ -f "\$1" \] && \[ ! -L "\$1" \] && \[ "\$\(stat -c %s "\$1"\)" -lt 50000000 \]/);
  assert.doesNotMatch(replay, /\bcp "\$head_out|\bcp "\$base_out/);
  // R3: only a definite 404/422 counts as a failed check; any other API error stops the loop, unrecorded.
  assert.match(select, /if \(\/HTTP \(404\|422\)\/\.test\(msg\)\)/);
  // S3: an unclear API error leaves that PR for a later run and moves on; only several in a row stop the lookups.
  assert.match(select, /left for a later run/);
  assert.match(select, /if \(\+\+errs >= 3\)/);
  assert.match(select, /skip limit reached/); // S5
  // S2: every value the container needs is passed with its value, not forwarded from an unexported shell variable.
  assert.match(replay, /-e SHA="\$SHA"/);
  assert.doesNotMatch(replay, /-e SHA( |\\)/);
  // S4: no cache at all in the PR watch: both sides are built in the container, every run.
  assert.doesNotMatch(wf, /actions\/cache/);
  assert.match(replay, /sandbox head 'git clone -q --filter=blob:none "\$CODEGRAPH_REPO" \/build\n\s+git -C \/build fetch -q origin "pull\/\$N\/head"/); // fork heads, fetched in the sandbox
  assert.match(wf, /^defaults:\n  run:\n    shell: bash/m); // Q3: pipefail
  assert.match(report, /if: \$\{\{ !cancelled\(\) && /); // Q5
  assert.match(report, /pr-issues [^\n]* > rep\/issues\.txt/); // Q6
  assert.match(select, /dry run: no PR could be checked/); // Q7
  assert.match(report, /--skipped rep\/skipped\.json/); // Q4
});
// ---- PR #85 review round 1 (.review/pr-85.md) ----
check('P3: reports never write an upstream reference GitHub would turn into a cross-reference on the upstream timeline', () => {
  const ch = diff([r('issue-3447', 'BROKEN', 'w', 3447)], [r('issue-3447', 'FIXED', '', 3447)]);
  const outside = (md: string) => md.replace(/````markdown[\s\S]*?````/g, ''); // a fenced draft is inert until a person pastes it
  for (const md of [report(ch, pctx), prSection(3454, ch, pctx)]) {
    const bare = outside(md).replace(/`[^`]*`/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
    assert.doesNotMatch(bare, /colbymchenry\/codegraph#\d/, md);
    assert.doesNotMatch(bare, /github\.com\/colbymchenry\/codegraph\/(issues|pull)\//, md);
  }
});
check('P2: the PR draft claims nothing about fixtures it does not cover; the section names them for a person', () => {
  const ch = diff([r('issue-3447', 'BROKEN', 'w', 3447), r('b', 'FIXED', '', 3035)], [r('issue-3447', 'FIXED', '', 3447), r('b', 'ERROR', 'boom', 3035)]);
  const d = reviewDraft(1, ch, pctx);
  assert.doesNotMatch(d, /The other fixtures read the same/);
  assert.match(prSection(1, ch, pctx), /Not in the draft, check by hand before posting: b\./);
  const only = diff([r('issue-3447', 'BROKEN', 'w', 3447)], [r('issue-3447', 'FIXED', '', 3447)]);
  assert.match(reviewDraft(1, only, pctx), /The other fixtures read the same on head and base\./);
});
check('P9: an empty base detail adds no empty code span to the draft', () => {
  const d = reviewDraft(1, diff([r('issue-3447', 'CHANGED', '', 3447)], [r('issue-3447', 'FIXED', '', 3447)]), pctx);
  assert.doesNotMatch(d, /``/);
});
check('P5/P10/P11/P12: select retries a failed head once, dedupes, refuses a bad cap or a bad stored state', () => {
  const prs = [{ number: 5, head: B, base: A }, { number: 5, head: C, base: A }, { number: 4, head: B, base: A }];
  assert.deepEqual(prSelect(prs, { prs: {} }, 6).map((p) => p.number), [5, 4]);
  assert.deepEqual(prSelect([{ number: 4, head: B, base: A }], { prs: { 4: { head: B, sig: '', failed: 1 } } }, 6).length, 1);
  assert.deepEqual(prSelect([{ number: 4, head: B, base: A }], { prs: { 4: { head: B, sig: '', failed: 2 } } }, 6).length, 0);
  assert.throws(() => prSelect(prs, { prs: {} }, NaN), /bad cap/);
  assert.throws(() => prSelect(prs, { prs: [] } as any, 6), /bad pr state/);
  assert.throws(() => prSelect(prs, { prs: { 4: { head: 'main', sig: '' } } }, 6), /bad pr state/);
  const st = prState({ prs: { 4: { head: A, sig: 'old' } } }, [4, 5], [], [{ number: 4, head: B }, { number: 5, head: B }]);
  assert.deepEqual(st.prs['4'], { head: B, sig: 'old', failed: 1 });
  assert.deepEqual(prState(st, [4], [], [{ number: 4, head: B }]).prs['4'], { head: B, sig: 'old', failed: 2 });
});
check('P6/P7/P8: a bad artifact fails only its PR; a reverted result is reported once; a section cut for size is re-reported later', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-prwatch2-'));
  try {
    const fx = path.join(tmp, 'fixtures');
    for (const name of ['issue-1', 'issue-2']) { fs.mkdirSync(path.join(fx, name), { recursive: true }); fs.writeFileSync(path.join(fx, name, 'expect.json'), '{}'); }
    const f = (name: string, v: any) => { const p = path.join(tmp, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); return p; };
    const o = (name: string) => path.join(tmp, name);
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), ...a, '--fixtures', fx], { encoding: 'utf8' });
    const same = { results: [r('issue-1', 'BROKEN', 'w'), r('issue-2', 'FIXED', '', 2)] };
    f('artifact/pr-5/prev.json', same); f('artifact/pr-5/next.json', same);
    f('artifact/pr-6/prev.json', same); f('artifact/pr-6/next.json', { results: [r('issue-1', 'PWNED')] });
    const prs = f('prs.json', [{ number: 5, head: B, base: A }, { number: 6, head: C, base: A }]);
    const st = f('st.json', { prs: { 5: { head: A, sig: 'issue-1:fixed:FIXED:' } } });
    const p = cli('pr-report', '--prs', prs, '--dir', o('artifact'), '--graph-assay', G, '--open', f('open.json', [5, 6]), '--state', st, '--report-out', o('c.md'), '--state-out', o('s.json'));
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stderr, /#6/);
    const c = fs.readFileSync(o('c.md'), 'utf8');
    assert.match(c, /`colbymchenry\/codegraph#5` at `bbbbbbbb`[\s\S]*no longer changes any fixture/);
    const s2 = JSON.parse(fs.readFileSync(o('s.json'), 'utf8'));
    assert.deepEqual(s2.prs['5'], { head: B, sig: '' }); assert.equal(s2.prs['6'].failed, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // P8: a PR section left out of the comment for size is not recorded, so the next run reports it.
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-prwatch3-'));
  try {
    const fx = path.join(t2, 'fixtures');
    const names = Array.from({ length: 40 }, (_, k) => `f-${k}`);
    for (const name of names) { fs.mkdirSync(path.join(fx, name), { recursive: true }); fs.writeFileSync(path.join(fx, name, 'expect.json'), '{}'); }
    const w = (rel: string, v: any) => { const q = path.join(t2, rel); fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, JSON.stringify(v)); return q; };
    const side = (d: string) => ({ results: names.map((nm, k) => r(nm, 'BROKEN', `${d}${k}`.padEnd(480, d), 100 + k)) });
    for (const n of [7, 8]) { w(`artifact/pr-${n}/prev.json`, side('x')); w(`artifact/pr-${n}/next.json`, side('y')); w(`artifact/pr-${n}/confirm-prev.json`, side('x')); w(`artifact/pr-${n}/confirm-next.json`, side('y')); }
    const q = spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), 'pr-report', '--prs', w('prs.json', [{ number: 7, head: B, base: A }, { number: 8, head: C, base: A }]),
      '--dir', path.join(t2, 'artifact'), '--graph-assay', G, '--open', w('open.json', [7, 8]), '--fixtures', fx, '--report-out', path.join(t2, 'c.md'), '--state-out', path.join(t2, 's.json')], { encoding: 'utf8' });
    assert.equal(q.status, 0, q.stderr);
    const c = fs.readFileSync(path.join(t2, 'c.md'), 'utf8');
    assert.ok(c.length <= LIMIT, String(c.length));
    assert.match(c, /1 more PR section\(s\) left for the next run/);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(t2, 's.json'), 'utf8')).prs), ['7']); // #8 not recorded: reported next run
  } finally { fs.rmSync(t2, { recursive: true, force: true }); }
});
// ---- PR #85 review round 2 ----
check('Q4/Q8/Q9: PRs skipped by select are recorded as failed; the header counts every changed PR; sections that fit are kept', () => {
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-prwatch4-'));
  try {
    const fx = path.join(t3, 'fixtures');
    const names = Array.from({ length: 70 }, (_, k) => `f-${k}`);
    for (const name of names) { fs.mkdirSync(path.join(fx, name), { recursive: true }); fs.writeFileSync(path.join(fx, name, 'expect.json'), '{}'); }
    const w = (rel: string, v: any) => { const q = path.join(t3, rel); fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, JSON.stringify(v)); return q; };
    const side = (d: string, n: number) => ({ results: names.map((nm, k) => r(nm, 'BROKEN', k < n ? `${d}${k}`.padEnd(480, d) : 'same', 100 + k)) });
    // #7: one section too large for any comment; #8: small; #9: small.
    const put = (pr: number, n: number) => { for (const [f, v] of [['prev', side('x', n)], ['next', side('y', n)], ['confirm-prev', side('x', n)], ['confirm-next', side('y', n)]] as const) w(`artifact/pr-${pr}/${f}.json`, v); };
    put(7, 70); put(8, 1); put(9, 1);
    const q = spawnSync(process.execPath, [path.join(here, 'fixture-watch.ts'), 'pr-report', '--prs', w('prs.json', [{ number: 7, head: B, base: A }, { number: 8, head: C, base: A }, { number: 9, head: G, base: A }]),
      '--skipped', w('skipped.json', [{ number: 11, head: B }]),
      '--dir', path.join(t3, 'artifact'), '--graph-assay', G, '--open', w('open.json', [7, 8, 9, 11]), '--fixtures', fx, '--report-out', path.join(t3, 'c.md'), '--state-out', path.join(t3, 's.json')], { encoding: 'utf8' });
    assert.equal(q.status, 0, q.stderr);
    const c = fs.readFileSync(path.join(t3, 'c.md'), 'utf8');
    assert.ok(c.length <= LIMIT);
    assert.match(c, /^### PR watch: 3 open PR\(s\) checked, 3 with a changed result/); // Q8
    assert.match(c, /`colbymchenry\/codegraph#8` at/); assert.match(c, /`colbymchenry\/codegraph#9` at/); // Q9: small sections still shown
    assert.match(c, /Too large for a comment[^\n]*`colbymchenry\/codegraph#7`/);
    const st = JSON.parse(fs.readFileSync(path.join(t3, 's.json'), 'utf8')).prs;
    assert.deepEqual(Object.keys(st), ['7', '8', '9', '11']);
    assert.deepEqual(st['11'], { head: B, sig: '', failed: 1 }); // Q4
  } finally { fs.rmSync(t3, { recursive: true, force: true }); }
});
check('every node -e script in the workflows is one single-quoted shell word (an apostrophe inside would end it early)', () => {
  for (const name of ['fixture-watch', 'pr-watch']) {
    const wf = fs.readFileSync(path.join(here, '..', `.github/workflows/${name}.yml`), 'utf8');
    for (const m of wf.matchAll(/node -e '([^']*)'/g)) {
      const after = wf.slice(m.index + m[0].length, m.index + m[0].length + 1);
      assert.ok(after === '' || /[\s;|)]/.test(after), `${name}.yml: a node -e script ends early (an apostrophe in it?): ...${m[1].slice(-60)}'${after}`);
    }
  }
});
console.log(`fixture-watch: ${n}/${n} checks`);
