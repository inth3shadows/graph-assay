#!/usr/bin/env node
// Fixture watch (.github/workflows/fixture-watch.yml): which filed codegraph fixtures changed verdict between
// the last recorded upstream commit and a new one, as a report with ready-to-paste drafts for the upstream
// issues. It only reads replay JSON (fixtures/replay.mts --json) and writes files: it never posts anything.
// A draft is a candidate, not a post: someone re-checks it on current upstream main and posts it by hand.
//
// Both sides are replayed by the same graph-assay checkout on every run (the previous commit is re-scored, not
// read from an old run), so a change in graph-assay's own fixtures, scoring, build script or Node version can
// never pass for a change upstream made.
//
// Usage:
//   node tools/fixture-watch.ts flips --prev prev.json --next next.json [--issues] [--fixtures dir]
//       print the fixtures to rerun on both commits (rerunNames: a verdict on both, and the verdict or wrong
//       edges changed; prev.json and next.json are replays of the previous and the new commit), one per line;
//       with --issues their upstream issue numbers, deduplicated
//   node tools/fixture-watch.ts issues --prev prev.json --next next.json [--fixtures dir]
//       print the upstream issue numbers (deduplicated) of every fixture the report can list: new, changed,
//       or erroring on either commit; the report job looks up their open/closed state
//   node tools/fixture-watch.ts pr-select --prs prs.json [--state pr-state.json] --cap N
//       print (JSON) the open PRs [{number, head, base}] whose head moved since the last check, capped
//   node tools/fixture-watch.ts pr-issues --prs selected.json --dir artifact [--fixtures dir]
//       print the upstream issues every selected PR's report can list (for their open/closed state)
//   node tools/fixture-watch.ts pr-report --prs selected.json --dir artifact --graph-assay <sha> --open open.json
//       [--state pr-state.json] [--skipped skipped.json] [--errored errored.json] [--issue-states states.json] [--fixtures dir] --report-out comment.md
//       --state-out pr-state.json [--summary-out full.md]
//       one section per PR whose confirmed result changed since it was last reported (artifact/pr-N/ holds
//       prev.json, next.json and, when reruns were needed, confirm-prev.json / confirm-next.json); a PR whose
//       results are missing or invalid is a failed check: retried once on the same head, then it waits for a new head
//   node tools/fixture-watch.ts run --next next.json --sha <new sha> --graph-assay <sha>
//       [--prev prev.json --prev-sha <sha> [--confirm-prev c.json --confirm-next c.json]] [--state stored.json]
//       [--issue-states states.json] [--fixtures dir] [--date YYYY-MM-DD] [--summary-out full.md]
//       --state-out state.json --report-out report.md
//       write the new state and the report (empty when nothing changed). Without --prev it records a baseline.
//       When `flips` picks anything, both confirming reruns are required. --state must be the state
//       recorded for --prev-sha (a baseline refuses any). --summary-out also writes the report uncapped.
//
// State: { codegraph, recordedAt, graphAssay, erroring: [fixture names], results }. Only `codegraph` (the commit to
// compare against next time) and `erroring` (the fixtures erroring on it) are read back; `results` is a record
// for people. A change where either commit errored is never rerun or drafted, only listed for a person: an
// ERROR on the new commit is listed unless the fixture is on the list and the previous commit errors too; a
// verdict after an ERROR on the previous commit is listed as "has a verdict again" (on the list) or "the
// previous commit errored when re-scored" (not on it).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM = 'colbymchenry/codegraph';
export const REPO = 'inth3shadows/graph-assay';
const VERDICTS = new Set(['BROKEN', 'GUESSED', 'FIXED', 'CHANGED', 'ERROR']);
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISSUE_STATES = new Set(['open', 'closed', 'unknown']);
export const LIMIT = 60000; // GitHub refuses a comment over 65,536 characters

export interface Row { name: string; issue: number | null; verdict: string; detail: string }
export interface State { codegraph: string; recordedAt: string; graphAssay: string | null; erroring: string[]; results: Row[] }
export type Kind = 'fixed' | 'regression' | 'edges' | 'changed' | 'new' | 'error' | 'recovered' | 'prev-error' | 'unstable';
export interface Change { kind: Kind; name: string; issue: number | null; from: Row | null; to: Row }

/** The rows of a replay, checked: an unexpected shape is refused, never rendered. Other fields are dropped. */
export function rows(doc: any, opts: { fixtures?: Set<string> } = {}): Row[] {
  if (!doc || !Array.isArray(doc.results)) throw new Error('no results array');
  const seen = new Set<string>();
  return doc.results.map((r: any) => {
    if (typeof r?.name !== 'string' || !NAME.test(r.name)) throw new Error(`bad fixture name: ${JSON.stringify(r?.name)}`);
    if (opts.fixtures && !opts.fixtures.has(r.name)) throw new Error(`unknown fixture: ${r.name}`);
    if (seen.has(r.name)) throw new Error(`duplicate fixture: ${r.name}`);
    seen.add(r.name);
    if (!VERDICTS.has(r.verdict)) throw new Error(`${r.name}: bad verdict ${JSON.stringify(r.verdict)}`);
    const issue = r.issue === undefined || r.issue === null || r.issue === 0 ? null : r.issue;
    if (issue !== null && !(Number.isSafeInteger(issue) && issue > 0)) throw new Error(`${r.name}: bad issue ${JSON.stringify(r.issue)}`);
    return { name: r.name, issue, verdict: r.verdict, detail: typeof r.detail === 'string' ? r.detail : '' };
  });
}

/**
 * The rows with each fixture's upstream issue taken from this checkout's expect.json, never from the replay:
 * the PR watch's head replay is written by the PR's own code (#87).
 */
export function withIssues(rs: Row[], fixturesDir: string): Row[] {
  return rs.map((r) => {
    let issue: number | null = null;
    try { const e = JSON.parse(fs.readFileSync(path.join(fixturesDir, r.name, 'expect.json'), 'utf8')); if (Number.isSafeInteger(e?.issue) && e.issue > 0) issue = e.issue; } catch { /* unreadable: unfiled */ }
    return { ...r, issue };
  });
}

/** The stored state's list of erroring fixtures, checked. */
export function erroringOf(state: any): Set<string> {
  const e = state?.erroring;
  if (!Array.isArray(e) || !e.every((n) => typeof n === 'string' && NAME.test(n))) throw new Error('stored state: bad erroring list');
  return new Set(e);
}

const broken = (v: string) => v === 'BROKEN' || v === 'GUESSED';
const same = (a: Row | undefined, b: Row) => !!a && a.verdict === b.verdict && a.detail === b.detail;

/**
 * The fixtures to rerun on both commits, from the two replays alone (so `flips`, which picks them, and `run`
 * always agree): every fixture with a verdict on both commits whose verdict or wrong edges changed. A change
 * where either commit errored is never rerun or drafted: it is listed for a person to check.
 */
export function rerunNames(prev: Row[], next: Row[]): string[] {
  const before = new Map(prev.map((r) => [r.name, r]));
  return next.filter((to) => {
    const p = before.get(to.name);
    if (!p || p.verdict === 'ERROR' || to.verdict === 'ERROR') return false;
    return p.verdict !== to.verdict || (broken(to.verdict) && p.detail !== to.detail);
  }).map((r) => r.name);
}

/**
 * Every fixture whose verdict or wrong edges changed between the previous commit's replay and the new one, that
 * is new, that started erroring, or that recovered. `erroring` is the stored list of fixtures erroring on the
 * previous commit (without one: those its replay has as ERROR); `confirmPrev` / `confirmNext` are the reruns of
 * `rerunNames`, which must agree with the first replays.
 */
export function diff(prev: Row[], next: Row[], opts: { erroring?: Set<string>; confirmPrev?: Row[]; confirmNext?: Row[] } = {}): Change[] {
  const before = new Map(prev.map((r) => [r.name, r]));
  const erroring = opts.erroring ?? new Set(prev.filter((r) => r.verdict === 'ERROR').map((r) => r.name));
  const againPrev = opts.confirmPrev && new Map(opts.confirmPrev.map((r) => [r.name, r]));
  const againNext = opts.confirmNext && new Map(opts.confirmNext.map((r) => [r.name, r]));
  const out: Change[] = [];
  for (const to of next) {
    const p = before.get(to.name);
    const listed = erroring.has(to.name);
    let kind: Kind | null;
    if (to.verdict === 'ERROR') {
      // Quiet only while it is already known to error and still errors on the previous commit too.
      kind = listed && (!p || p.verdict === 'ERROR') ? null : 'error';
      if (kind) out.push({ kind, name: to.name, issue: to.issue ?? p?.issue ?? null, from: p && p.verdict !== 'ERROR' ? p : null, to });
      continue;
    }
    if (!p) { out.push({ kind: 'new', name: to.name, issue: to.issue, from: null, to }); continue; }
    if (p.verdict === 'ERROR') {
      // No verdict on the previous commit today: listed for a person, never rerun or drafted.
      out.push({ kind: listed ? 'recovered' : 'prev-error', name: to.name, issue: to.issue ?? p.issue, from: null, to });
      continue;
    }
    const from = p;
    if (from.verdict === to.verdict) kind = broken(to.verdict) && from.detail !== to.detail ? 'edges' : listed ? 'recovered' : null;
    else if (to.verdict === 'FIXED') kind = 'fixed';
    else if (from.verdict === 'FIXED' && broken(to.verdict)) kind = 'regression';
    else kind = 'changed';
    if (!kind) continue;
    if (needsConfirm({ kind }) && againNext && againPrev) {
      // Both sides' reruns must say the same thing again, or it is not reported as a change.
      if (!same(againNext.get(to.name), to) || !same(againPrev.get(to.name), from)) kind = 'unstable';
    }
    out.push({ kind, name: to.name, issue: to.issue ?? from.issue ?? null, from: kind === 'recovered' ? null : from, to });
  }
  return out;
}

/** The upstream issues of every fixture the report can list (a superset of the changes `diff` reports). */
export function listableIssues(prev: Row[], next: Row[]): number[] {
  const before = new Map(prev.map((r) => [r.name, r]));
  const out = new Set<number>();
  for (const to of next) {
    const p = before.get(to.name);
    const listable = !p || p.verdict === 'ERROR' || to.verdict === 'ERROR' || p.verdict !== to.verdict || p.detail !== to.detail;
    const issue = to.issue ?? p?.issue ?? null;
    if (listable && issue) out.add(issue);
  }
  return [...out];
}

/** Whether a change is one whose reruns must agree (the others need none, or were settled by one). */
export const needsConfirm = (c: Pick<Change, 'kind'>) => ['fixed', 'regression', 'edges', 'changed'].includes(c.kind);

/** The state to store for the new commit: the commit, the fixtures erroring on it, and its verdicts (a record). */
export function nextState(next: Row[], meta: Omit<State, 'results' | 'erroring'>): State {
  return { ...meta, erroring: next.filter((r) => r.verdict === 'ERROR').map((r) => r.name).sort(), results: next };
}

const short = (s: string) => s.slice(0, 8);
// Detail text goes in inline code; a backtick or a line break inside it would end the span.
const code = (s: string) => `\`${s.replace(/[`\r\n]+/g, ' ').slice(0, 500)}\``;
export interface Ctx { prev: string; next: string; graphAssay: string; date: string; states: Record<string, string> }

const fixtureLink = (c: Change, ctx: Ctx) =>
  `[${c.name} fixture](https://github.com/${REPO}/tree/${ctx.graphAssay}/fixtures/oracle-candidates/${c.name})`;
const rerun = (c: Change) => `Rerun: \`node bin/graph-assay replay <codegraph build>/dist/bin/codegraph.js ${c.name}\``;
const intro = (c: Change, ctx: Ctx) => `The ${fixtureLink(c, ctx)} in [graph-assay](https://github.com/${REPO}), which I maintain,`;

/** A ready-to-paste upstream draft for one change, or null when the change needs a person first. */
export function draft(c: Change, ctx: Ctx): string | null {
  if (!c.issue || !c.from) return null;
  const range = `${short(ctx.prev)}..${short(ctx.next)} (https://github.com/${UPSTREAM}/compare/${ctx.prev}...${ctx.next})`;
  if (c.kind === 'fixed') {
    const lead = ctx.states[String(c.issue)] === 'closed' ? `Confirmed fixed on \`main\` at ${short(ctx.next)}, thanks.` : `This looks fixed on \`main\` at ${short(ctx.next)}.`;
    return `${lead}\n\n${intro(c, ctx)} goes from ${c.from.verdict} on ${short(ctx.prev)} to FIXED on ${short(ctx.next)}: none of its wrong edges remain and every right edge is there. The change is in ${range}.\n\n${rerun(c)}\n`;
  }
  if (c.kind === 'regression') {
    return `This is back on \`main\` at ${short(ctx.next)}.\n\n${intro(c, ctx)} read FIXED on ${short(ctx.prev)} and reads ${c.to.verdict} on ${short(ctx.next)}: ${code(c.to.detail)}. The change is in ${range}.\n\n${rerun(c)}\n`;
  }
  if (c.kind === 'edges') {
    return `**Edit (${ctx.date}):** on \`main\` at ${short(ctx.next)} the ${fixtureLink(c, ctx)} still reads ${c.to.verdict}, but its wrong edges changed. On ${short(ctx.prev)}: ${code(c.from.detail)}. Now: ${code(c.to.detail)}.\n`;
  }
  return null;
}

const what = (c: Change): string => ({
  fixed: 'fixed', regression: 'REGRESSION', edges: 'wrong edges changed', changed: 'changed (look by hand)',
  new: 'first verdict (no draft)', error: 'errors on the new commit: check by hand', recovered: 'has a verdict again after erroring: check by hand (no draft)',
  'prev-error': 'the previous commit errored when re-scored: check by hand (no draft)',
  unstable: 'unstable (a rerun disagreed; not re-checked later: check by hand)',
} as Record<Kind, string>)[c.kind];
const ADVICE: Partial<Record<Kind, string>> = {
  fixed: 'a comment on the issue (closed: a confirmation; open: tells the maintainer it may be fixed)',
  regression: 'a comment on the issue; if the issue is closed, a new issue linking it is usually better (posting skill)',
  edges: 'a dated Edit line in our issue body (no notification), not a comment',
};

// An upstream reference as code: GitHub would turn a bare owner/repo#N into a cross-reference on the upstream
// issue's or PR's timeline, which is a post upstream nobody approved (PR #85 review, P3).
const ref = (n: number) => `\`${UPSTREAM}#${n}\``;
const refHtml = (n: number) => `<code>${UPSTREAM}#${n}</code>`;

function issueCell(c: Change, ctx: Ctx): string {
  if (!c.issue) return 'unfiled';
  const s = ctx.states[String(c.issue)];
  return `${ref(c.issue)}${s ? (s === 'unknown' ? ' (state unknown)' : ` (${s})`) : ''}`;
}

/** The tracking-issue comment, or '' when nothing changed. Kept under `limit` (drafts go first, then rows). */
export function report(changes: Change[], ctx: Ctx, opts: { baseline?: Record<string, number>; limit?: number } = {}): string {
  const head = `### codegraph ${short(ctx.next)}`;
  if (opts.baseline) {
    const counts = Object.entries(opts.baseline).sort().map(([k, v]) => `${k} ${v}`).join(', ');
    return `${head}: baseline\n\nNo earlier state, so this run only records verdicts for [${short(ctx.next)}](https://github.com/${UPSTREAM}/commit/${ctx.next}): ${counts}. The next upstream commit is compared with it.\n`;
  }
  if (!changes.length) return '';
  const limit = opts.limit ?? LIMIT;
  const title = `${head} (${short(ctx.prev)}..${short(ctx.next)}, [compare](https://github.com/${UPSTREAM}/compare/${ctx.prev}...${ctx.next}))`;
  const row = (c: Change) => `| ${c.name} | ${issueCell(c, ctx)} | ${c.from?.verdict ?? '-'} | ${c.to.verdict} | ${what(c)} |`;
  const drafts = changes.flatMap((c) => {
    const d = draft(c, ctx);
    return d ? [['', `<details><summary>Draft for ${refHtml(c.issue)}: ${ADVICE[c.kind]}</summary>`, '', '````markdown', d.trimEnd(), '````', '', '</details>'].join('\n')] : [];
  });
  const foot = '\nDrafts are candidates: re-check on current upstream `main`, then post by hand after approval.\n';
  const build = (rowsShown: number, draftsShown: number) => {
    const lines = [title, '', '| fixture | upstream issue | was | now | change |', '|---|---|---|---|---|', ...changes.slice(0, rowsShown).map(row)];
    if (rowsShown < changes.length) lines.push('', `${changes.length - rowsShown} more change(s) left out to stay under GitHub's comment limit: the report job's summary lists them all.`);
    lines.push(...drafts.slice(0, draftsShown));
    if (draftsShown < drafts.length) lines.push('', `${drafts.length - draftsShown} draft(s) left out to stay under GitHub's comment limit: the report job's summary has them.`);
    return lines.join('\n') + '\n' + foot;
  };
  let d = drafts.length; let rs = changes.length; let out = build(rs, d);
  while (out.length > limit && d > 0) out = build(rs, --d);
  while (out.length > limit && rs > 0) out = build(--rs, d);
  return out;
}

// ---- PR watch: open upstream PRs, before they merge (plan graph-assay-pr-watch.md) ----
// The same diff, between a PR's merge base (prev) and its head (next). The output is a section of the tracking
// issue's comment with a ready-to-paste review comment for the PR; nothing is posted upstream from here.

export interface Pr { number: number; head: string; base: string }
export interface PrState { prs: Record<string, { head: string; sig: string; failed?: number; errored?: number }> }

/** A stored PR state, checked (PR #85 review, P11). */
export function prStateOf(st: any): PrState {
  if (!st || typeof st.prs !== 'object' || Array.isArray(st.prs) || st.prs === null) throw new Error('bad pr state');
  for (const [k, v] of Object.entries<any>(st.prs)) {
    const count = (x: any) => x === undefined || (Number.isSafeInteger(x) && x > 0);
    if (!/^\d+$/.test(k) || !v || !SHA.test(v.head) || typeof v.sig !== 'string' || !count(v.failed) || !count(v.errored)) throw new Error(`bad pr state entry ${k}`);
  }
  return st;
}

/** A stable summary of a PR's confirmed result, so a PR is re-reported only when its result changes. */
// Detail text only where it is the result (wrong edges); error text can hold temp paths and would churn (#87).
export const signature = (changes: Change[]) => changes.map((c) => `${c.name}:${c.kind}:${c.to.verdict}${c.kind === 'edges' || c.kind === 'regression' ? `:${c.to.detail}` : ''}`).sort().join('\n');

const DRAFTABLE = new Set<Kind>(['fixed', 'regression', 'edges']);
const drafted = (c: Change) => DRAFTABLE.has(c.kind) && !!c.issue && !!c.from;

/** A review comment for the PR, in the posting skill's shape, or null when no change can be drafted. */
export function reviewDraft(pr: number, changes: Change[], ctx: Ctx, allScored = true): string | null {
  const ds = changes.filter(drafted);
  if (!ds.length) return null;
  const ref = (c: Change) => `the ${c.name} fixture (#${c.issue})`;
  const fixes = ds.filter((c) => c.kind === 'fixed').map(ref); const breaks = ds.filter((c) => c.kind === 'regression').map(ref);
  const edges = ds.filter((c) => c.kind === 'edges').map(ref);
  const parts = [fixes.length ? `fixes ${fixes.join(', ')}` : '', breaks.length ? `breaks ${breaks.join(', ')}` : '',
    edges.length ? `changes the wrong edges of ${edges.join(', ')}` : ''].filter(Boolean);
  const on = `head \`${short(ctx.next)}\` vs base \`${short(ctx.prev)}\``;
  const lines = [`Checked against the fixtures in [graph-assay](https://github.com/${REPO}), which I maintain: this PR ${parts.join(' and ')}.`, ''];
  for (const c of ds) {
    const link = `([fixture](https://github.com/${REPO}/tree/${ctx.graphAssay}/fixtures/oracle-candidates/${c.name}))`;
    if (c.kind === 'fixed') lines.push(`**The ${c.name} fixture is fixed.** Verified on ${on}: on base it reads ${c.from.verdict}${c.from.detail ? ` (${code(c.from.detail)})` : ''}; on head none of its wrong edges remain and every right edge is there ${link}.`, '');
    else if (c.kind === 'regression') lines.push(`**The ${c.name} fixture breaks.** Failing case (verified on ${on}): it reads FIXED on base and ${c.to.verdict} on head: ${code(c.to.detail)} ${link}.`, '');
    else lines.push(`**The ${c.name} fixture's wrong edges change.** Verified on ${on}: it reads ${c.to.verdict} on both. Base: ${code(c.from.detail)}. Head: ${code(c.to.detail)} ${link}.`, '');
  }
  // Only claim the rest is unchanged when the draft covers every change (PR #85 review, P2).
  // ...and only when every fixture was scored on both sides (none errored, none missing: #87).
  const rest = ds.length !== changes.length ? '' : allScored ? 'The other fixtures read the same on head and base. ' : 'Not every fixture could be scored on both sides, so the others are unchecked. ';
  lines.push(`${rest}Rerun: \`node bin/graph-assay replay <codegraph build>/dist/bin/codegraph.js ${ds.map((c) => c.name).join(' ')}\``);
  return lines.join('\n') + '\n';
}

/** One PR's section of the tracking-issue comment ('' when nothing changed). Upstream-written text (the PR's title) is never rendered. */
export function prSection(pr: number, changes: Change[], ctx: Ctx, allScored = true): string {
  if (!changes.length) return '';
  const lines = [`#### ${ref(pr)} at \`${short(ctx.next)}\` (merge base \`${short(ctx.prev)}\`)`, '',
    '| fixture | upstream issue | base | head | change |', '|---|---|---|---|---|',
    ...changes.map((c) => `| ${c.name} | ${issueCell(c, ctx)} | ${c.from?.verdict ?? '-'} | ${c.to.verdict} | ${what(c)} |`)];
  const d = reviewDraft(pr, changes, ctx, allScored);
  const left = changes.filter((c) => !drafted(c)).map((c) => c.name);
  if (d && left.length) lines.push('', `Not in the draft, check by hand before posting: ${left.join(', ')}.`);
  if (d) lines.push('', `<details><summary>Draft review comment for ${refHtml(pr)}</summary>`, '', '````markdown', d.trimEnd(), '````', '', '</details>');
  return lines.join('\n') + '\n';
}

/** The open PRs to check this run: head moved since the last check, in the given (newest-updated-first) order, capped. */
export function prSelect(prs: Pr[], state: PrState, cap: number): Pr[] {
  if (!(cap === Infinity || (Number.isSafeInteger(cap) && cap > 0))) throw new Error(`bad cap: ${cap}`);
  if (!Array.isArray(prs)) throw new Error('bad pr list');
  for (const p of prs) if (!(Number.isSafeInteger(p?.number) && p.number > 0 && SHA.test(p.head) && SHA.test(p.base))) throw new Error(`bad pr: ${JSON.stringify(p)}`);
  const st = prStateOf(state);
  const seen = new Set<number>();
  // A head already checked is skipped; one whose check failed gets one retry, then waits for a new head (P5).
  return prs.filter((p) => !seen.has(p.number) && seen.add(p.number)).filter((p) => {
    const e = st.prs[String(p.number)];
    if (!e || e.head !== p.head) return true;
    // A head whose merge-base lookup kept failing with an unclear error is set aside after 3 runs (#87).
    if ((e.errored ?? 0) >= 3) return false;
    return e.failed !== undefined ? e.failed < 2 : e.errored !== undefined;
  }).slice(0, cap);
}

/** The PR state after a run: checked PRs updated, PRs no longer open dropped. */
export function prState(state: PrState, open: number[], checked: Array<{ number: number; head: string; sig: string }>,
  failed: Array<{ number: number; head: string }> = [], errored: Array<{ number: number; head: string }> = []): PrState {
  const keep = new Set(open.map(String));
  const prs: PrState['prs'] = {};
  for (const [k, v] of Object.entries(prStateOf(state).prs)) if (keep.has(k)) prs[k] = v;
  for (const c of checked) if (keep.has(String(c.number))) prs[String(c.number)] = { head: c.head, sig: c.sig };
  for (const f of failed) {
    const k = String(f.number); if (!keep.has(k)) continue;
    const old = prs[k];
    prs[k] = { head: f.head, sig: old?.sig ?? '', failed: old?.head === f.head && old.failed ? old.failed + 1 : 1 };
  }
  for (const f of errored) {
    const k = String(f.number); if (!keep.has(k)) continue;
    const old = prs[k];
    prs[k] = { head: f.head, sig: old?.sig ?? '', ...(old?.head === f.head && old.failed ? { failed: old.failed } : {}), errored: old?.head === f.head && old.errored ? old.errored + 1 : 1 };
  }
  return { prs: Object.fromEntries(Object.entries(prs).sort(([a], [b]) => Number(a) - Number(b))) };
}

// ---- command line ----
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
function opt(args: string[], k: string): string | undefined {
  const i = args.indexOf(k);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${k} needs a value`);
  return v;
}

const fixtureSet = (dir: string | undefined) =>
  dir ? new Set(fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'expect.json')))) : undefined;

function main(argv: string[]) {
  const [cmd, ...args] = argv;
  if (cmd === 'flips') {
    const prev = opt(args, '--prev'); const next = opt(args, '--next');
    if (!prev || !next) throw new Error('flips needs --prev and --next');
    const fxDir = opt(args, '--fixtures'); const fixtures = fixtureSet(fxDir);
    // Issue numbers from this checkout's expect.json, as run and pr-report take them (PR #88 review, T4).
    const iss = (rs: Row[]) => (fxDir ? withIssues(rs, fxDir) : rs);
    const p = iss(rows(read(prev), { fixtures })); const nx = iss(rows(read(next), { fixtures }));
    const names = new Set(rerunNames(p, nx));
    const picked = nx.filter((r) => names.has(r.name));
    const out = args.includes('--issues') ? [...new Set(picked.map((r) => r.issue ?? p.find((x) => x.name === r.name)?.issue).filter(Boolean))].map(String) : picked.map((r) => r.name);
    if (out.length) console.log(out.join('\n'));
    return;
  }
  if (cmd === 'issues') {
    const prev = opt(args, '--prev'); const next = opt(args, '--next');
    if (!prev || !next) throw new Error('issues needs --prev and --next');
    const fxDir = opt(args, '--fixtures'); const fixtures = fixtureSet(fxDir);
    const iss = (rs: Row[]) => (fxDir ? withIssues(rs, fxDir) : rs);
    const out = listableIssues(iss(rows(read(prev), { fixtures })), iss(rows(read(next), { fixtures })));
    if (out.length) console.log(out.join('\n'));
    return;
  }
  if (cmd === 'pr-select') {
    const capArg = opt(args, '--cap') ?? '6';
    const cap = /^\d+$/.test(capArg) ? Number(capArg) : NaN;
    const prsFile = opt(args, '--prs'); if (!prsFile) throw new Error('pr-select needs --prs');
    const st = opt(args, '--state');
    console.log(JSON.stringify(prSelect(read(prsFile), st ? prStateOf(read(st)) : { prs: {} }, cap)));
    return;
  }
  if (cmd === 'pr-issues' || cmd === 'pr-report') {
    const need = (k: string) => { const v = opt(args, k); if (!v) throw new Error(`${cmd} needs ${k}`); return v; };
    const selected: Pr[] = prSelect(read(need('--prs')), { prs: {} }, Infinity); // validates every entry
    const dir = need('--dir');
    const fixtures = fixtureSet(opt(args, '--fixtures'));
    const fxDir = opt(args, '--fixtures');
    const iss = (rs: Row[]) => (fxDir ? withIssues(rs, fxDir) : rs);
    const load = (pr: Pr) => {
      const d = path.join(dir, `pr-${pr.number}`);
      const f = (n: string) => path.join(d, `${n}.json`);
      // A PR whose results are missing or invalid fails on its own; the others are still reported (P6).
      try {
        if (!fs.existsSync(f('prev')) || !fs.existsSync(f('next'))) return null;
        const prev = iss(rows(read(f('prev')), { fixtures })); const next = iss(rows(read(f('next')), { fixtures }));
        const reruns = rerunNames(prev, next);
        if (reruns.length && !(fs.existsSync(f('confirm-prev')) && fs.existsSync(f('confirm-next')))) return null;
        const confirm = reruns.length ? { confirmPrev: iss(rows(read(f('confirm-prev')), { fixtures })), confirmNext: iss(rows(read(f('confirm-next')), { fixtures })) } : {};
        // Every fixture scored on both sides: none errored, and both replays list the same fixtures (#87).
        const names = (rs: Row[]) => rs.map((r) => r.name).sort().join('\n');
        // With --fixtures, both must list every fixture this checkout has, not only the same ones (PR #88 review, T6).
        const allScored = ![...prev, ...next].some((r) => r.verdict === 'ERROR') && names(prev) === names(next) && (!fixtures || names(next) === [...fixtures].sort().join('\n'));
        return { prev, next, changes: diff(prev, next, confirm), allScored };
      } catch (e) { console.error(`pr-report: #${pr.number}: ${(e as Error).message}`); return null; }
    };
    if (cmd === 'pr-issues') {
      const out = new Set<number>();
      for (const pr of selected) { const l = load(pr); if (l) for (const i of listableIssues(l.prev, l.next)) out.add(i); }
      if (out.size) console.log([...out].join('\n'));
      return;
    }
    const ga = need('--graph-assay'); if (!SHA.test(ga)) throw new Error('--graph-assay must be a full sha');
    const open: number[] = read(need('--open'));
    if (!Array.isArray(open) || !open.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('bad --open list');
    const stFile = opt(args, '--state'); const state: PrState = stFile ? prStateOf(read(stFile)) : { prs: {} };
    const statesFile = opt(args, '--issue-states'); const states = statesFile ? read(statesFile) : {};
    for (const [k, v] of Object.entries(states)) if (!/^\d+$/.test(k) || !ISSUE_STATES.has(v as string)) throw new Error(`bad issue state ${k}: ${v}`);
    const date = opt(args, '--date') ?? new Date().toISOString().slice(0, 10);
    const quiet: Array<{ number: number; head: string; sig: string }> = []; // checked, nothing to report
    const reported: Array<{ entry: { number: number; head: string; sig: string }; section: string }> = [];
    const failed: Array<{ number: number; head: string }> = [];
    for (const pr of selected) {
      const l = load(pr);
      if (!l) { console.error(`pr-report: no complete results for #${pr.number}; tried again once on this head`); failed.push({ number: pr.number, head: pr.head }); continue; }
      const sig = signature(l.changes);
      const before = state.prs[String(pr.number)]?.sig ?? '';
      const entry = { number: pr.number, head: pr.head, sig };
      if (sig && sig !== before) reported.push({ entry, section: prSection(pr.number, l.changes, { prev: pr.base, next: pr.head, graphAssay: ga, date, states }, l.allScored) });
      // A PR reported before whose head now changes no fixture: say so once, so a stale draft is not the last word (P7).
      else if (!sig && before) reported.push({ entry, section: `#### ${ref(pr.number)} at \`${short(pr.head)}\` (merge base \`${short(pr.base)}\`)\n\nThis head no longer changes any fixture${l.allScored ? '' : ' that could be scored on both sides (some could not, so the others are unchecked)'}: the earlier report on this PR no longer applies.\n` });
      else quiet.push(entry);
    }
    // PRs select could not compare (no merge base) count as failed checks of their head (Q4).
    // PRs whose merge-base lookup failed with an unclear API error: counted, set aside after 3 runs (#87).
    const erroredFile = opt(args, '--errored');
    const errored: Array<{ number: number; head: string }> = [];
    if (erroredFile) {
      const er = read(erroredFile);
      if (!Array.isArray(er) || !er.every((x: any) => Number.isSafeInteger(x?.number) && x.number > 0 && SHA.test(x?.head))) throw new Error('bad --errored list');
      errored.push(...er.map((x: any) => ({ number: x.number, head: x.head })));
    }
    const skippedFile = opt(args, '--skipped');
    let skipped = 0;
    if (skippedFile) {
      const sk = read(skippedFile);
      if (!Array.isArray(sk) || !sk.every((x: any) => Number.isSafeInteger(x?.number) && x.number > 0 && SHA.test(x?.head))) throw new Error('bad --skipped list');
      for (const x of sk) failed.push({ number: x.number, head: x.head });
      skipped = sk.length;
    }
    // An unclear error counts against its PR only when GitHub answered other lookups in the same select run (a
    // merge base found, or a definite 404/422). When every lookup failed, it was an outage, a rate limit or a
    // timeout on GitHub's side: no PR gets a strike, and each is tried again next run (PR #88 review, T1).
    if (errored.length && !selected.length && !skipped) {
      console.error(`pr-report: GitHub answered no lookup this run: no strike for ${errored.map((x) => `#${x.number}`).join(', ')}`);
      errored.length = 0;
    }
    const head = (shown: number) => `### PR watch: ${quiet.length + reported.length} open PR(s) checked, ${reported.length} with a changed result${shown < reported.length ? ` (${shown} shown)` : ''}\n\nDrafts are candidates: re-check on the PR's current head, then post by hand after approval.\n`;
    const all = reported.length ? [head(reported.length), ...reported.map((x) => x.section)].join('\n') : '';
    // Fill the comment in order with the sections that fit (Q9). A section too large for any comment is named
    // and recorded (its full text is in the summary); one that only missed this comment is left for the next run.
    const room = LIMIT - head(0).length - 400;
    const shown: typeof reported = []; const tooLarge: typeof reported = [];
    let used = 0;
    for (const x of reported) {
      if (x.section.length + 1 > room) tooLarge.push(x); // could never fit, even alone
      else if (used + x.section.length + 1 <= room) { shown.push(x); used += x.section.length + 1; }
    }
    const deferred = reported.length - shown.length - tooLarge.length;
    const tail = [
      tooLarge.length ? `Too large for a comment; the report job's summary has them: ${tooLarge.map((x) => ref(x.entry.number)).join(', ')}.\n` : '',
      deferred ? `${deferred} more PR section(s) left for the next run to stay under GitHub's comment limit; the report job's summary has them now.\n` : '',
    ].filter(Boolean);
    const capped = reported.length ? [head(shown.length), ...shown.map((x) => x.section), ...tail].join('\n') : '';
    const recorded = [...shown, ...tooLarge].map((x) => x.entry);
    fs.writeFileSync(need('--report-out'), capped);
    const summary = opt(args, '--summary-out'); if (summary) fs.writeFileSync(summary, all);
    const next = prState(state, open, [...quiet, ...recorded], failed, errored);
    const setAside = Object.entries(next.prs).filter(([, v]) => (v.errored ?? 0) >= 3).map(([k]) => `#${k}`);
    fs.writeFileSync(need('--state-out'), JSON.stringify(next, null, 1) + '\n');
    // Errored and set-aside PRs are named in the log too, so a PR the watch stopped trying is visible (PR #88 review, T8).
    console.log(`${quiet.length + reported.length} PR(s) checked, ${shown.length} shown, ${tooLarge.length} too large, ${deferred} deferred, ${failed.length} failed, ${errored.length} errored${setAside.length ? `; set aside until their head moves: ${setAside.join(', ')}` : ''}`);
    return;
  }
  if (cmd === 'run') {
    const need = (k: string) => { const v = opt(args, k); if (!v) throw new Error(`run needs ${k}`); return v; };
    const sha = need('--sha'); const ga = need('--graph-assay');
    if (!SHA.test(sha) || !SHA.test(ga)) throw new Error('--sha and --graph-assay must be full shas');
    const date = opt(args, '--date') ?? new Date().toISOString().slice(0, 10);
    const fixtures = fixtureSet(opt(args, '--fixtures'));
    const fxDir = opt(args, '--fixtures');
    const iss = (rs: Row[]) => (fxDir ? withIssues(rs, fxDir) : rs);
    const next = iss(rows(read(need('--next')), { fixtures }));
    const prevFile = opt(args, '--prev');
    const prevSha = opt(args, '--prev-sha');
    if (!!prevFile !== !!prevSha) throw new Error('--prev and --prev-sha go together');
    if (prevSha && !SHA.test(prevSha)) throw new Error('--prev-sha must be a full sha');
    const stateFile = opt(args, '--state');
    const stored = stateFile ? read(stateFile) : null;
    // The stored state must be the one for the commit this run compares against, or it is someone else's
    // (a baseline compares against nothing, so it refuses any stored state).
    if (stored && stored.codegraph !== prevSha) throw new Error(`stored state is for ${String(stored.codegraph).slice(0, 8)}, not ${prevSha ? `the previous commit ${prevSha.slice(0, 8)}` : 'a baseline'}`);
    const erroring = stored ? erroringOf(stored) : undefined;
    const prev = prevFile ? iss(rows(read(prevFile), { fixtures })) : [];
    const cp = opt(args, '--confirm-prev'); const cn = opt(args, '--confirm-next');
    if (!!cp !== !!cn) throw new Error('--confirm-prev and --confirm-next go together');
    const confirmPrev = cp ? iss(rows(read(cp), { fixtures })) : undefined;
    const confirmNext = cn ? iss(rows(read(cn), { fixtures })) : undefined;
    const statesFile = opt(args, '--issue-states');
    const states = statesFile ? read(statesFile) : {};
    for (const [k, v] of Object.entries(states)) if (!/^\d+$/.test(k) || !ISSUE_STATES.has(v as string)) throw new Error(`bad issue state ${k}: ${v}`);
    const changes = prevFile ? diff(prev, next, { erroring, confirmPrev, confirmNext }) : [];
    const reruns = prevFile ? rerunNames(prev, next) : [];
    if (!confirmNext && reruns.length) throw new Error(`changes need --confirm-prev and --confirm-next (the reruns of: ${reruns.join(', ')})`);
    const state = nextState(next, { codegraph: sha, recordedAt: date, graphAssay: ga });
    const ctx = { prev: prevSha ?? sha, next: sha, graphAssay: ga, date, states: states as Record<string, string> };
    const count = next.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {} as Record<string, number>);
    const render = (limit: number) => (prevFile ? report(changes, ctx, { limit }) : report([], ctx, { baseline: count }));
    fs.writeFileSync(need('--state-out'), JSON.stringify(state, null, 1) + '\n');
    fs.writeFileSync(need('--report-out'), render(LIMIT));
    const summary = opt(args, '--summary-out');
    if (summary) fs.writeFileSync(summary, render(Infinity));
    console.log(prevFile ? `${changes.length} change(s) since ${short(prevSha)}` : `baseline: ${next.length} fixtures`);
    return;
  }
  throw new Error('usage: fixture-watch.ts flips|issues|run|pr-select|pr-issues|pr-report ... (see the header)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`fixture-watch: ${(e as Error).message}`); process.exit(2); }
}
