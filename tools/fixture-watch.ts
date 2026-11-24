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
//   node tools/fixture-watch.ts flips --prev prev.json --next next.json [--issues]
//       print the fixtures whose verdict or wrong edges changed (prev.json and next.json are replays of the
//       previous and the new commit), one per line; with --issues their upstream issue numbers, deduplicated
//   node tools/fixture-watch.ts run --next next.json --sha <new sha> --graph-assay <sha>
//       [--prev prev.json --prev-sha <sha> [--confirm-prev c.json --confirm-next c.json]] [--state stored.json]
//       [--issue-states states.json] [--fixtures dir] [--date YYYY-MM-DD] [--no-limit]
//       --state-out state.json --report-out report.md
//       write the new state and the report (empty when nothing changed). Without --prev it records a baseline.
//       A change other than a new fixture or an error needs both confirming reruns. --state must be the state
//       recorded for --prev-sha. --no-limit skips the comment size cap (for the job summary).
//
// State: { codegraph, recordedAt, graphAssay, results: [{ name, issue, verdict, detail, seenAt, erroringSince? }] }.
// It is not used for the comparison itself, only to remember what a re-scored replay cannot say: a fixture
// that errors keeps its last real verdict (with erroringSince), so it is reported once, and if the previous
// commit's replay errors too, that remembered verdict stands in for it (marked stale: no draft).
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

export interface Row { name: string; issue: number | null; verdict: string; detail: string; seenAt?: string; erroringSince?: string }
export interface State { codegraph: string; recordedAt: string; graphAssay: string | null; results: Row[] }
export type Kind = 'fixed' | 'regression' | 'edges' | 'changed' | 'new' | 'error' | 'unstable';
export interface Change { kind: Kind; name: string; issue: number | null; from: Row | null; to: Row; stale?: boolean }

/**
 * The rows of a replay (`state: false`) or a stored state (`state: true`), checked: an unexpected shape is
 * refused, never rendered. A replay's rows never carry the state-only fields, whatever its file says.
 */
export function rows(doc: any, opts: { fixtures?: Set<string>; state?: boolean } = {}): Row[] {
  if (!doc || !Array.isArray(doc.results)) throw new Error('no results array');
  const seen = new Set<string>();
  return doc.results.map((r: any) => {
    if (typeof r?.name !== 'string' || !NAME.test(r.name)) throw new Error(`bad fixture name: ${JSON.stringify(r?.name)}`);
    if (opts.fixtures && !opts.fixtures.has(r.name)) throw new Error(`unknown fixture: ${r.name}`);
    if (seen.has(r.name)) throw new Error(`duplicate fixture: ${r.name}`);
    seen.add(r.name);
    if (!VERDICTS.has(r.verdict)) throw new Error(`${r.name}: bad verdict ${JSON.stringify(r.verdict)}`);
    const issue = r.issue === undefined || r.issue === null || r.issue === 0 ? null : r.issue;
    if (issue !== null && !(Number.isInteger(issue) && issue > 0)) throw new Error(`${r.name}: bad issue ${JSON.stringify(r.issue)}`);
    const row: Row = { name: r.name, issue, verdict: r.verdict, detail: typeof r.detail === 'string' ? r.detail : '' };
    if (opts.state) for (const k of ['seenAt', 'erroringSince'] as const) {
      if (r[k] === undefined) continue;
      if (typeof r[k] !== 'string' || !SHA.test(r[k])) throw new Error(`${r.name}: bad ${k} ${JSON.stringify(r[k])}`);
      row[k] = r[k];
    }
    return row;
  });
}

const broken = (v: string) => v === 'BROKEN' || v === 'GUESSED';
const same = (a: Row | undefined, b: Row) => !!a && a.verdict === b.verdict && a.detail === b.detail;

/**
 * Every fixture whose verdict or wrong edges changed between the previous commit's replay and the new one,
 * that is new, or that started erroring. `stored` is the recorded state (for erroring fixtures only);
 * `confirmPrev` / `confirmNext` are the reruns of the changed fixtures on each side, which must agree.
 */
export function diff(prev: Row[], next: Row[], opts: { stored?: Row[]; confirmPrev?: Row[]; confirmNext?: Row[] } = {}): Change[] {
  const before = new Map(prev.map((r) => [r.name, r]));
  const stored = new Map((opts.stored ?? []).map((r) => [r.name, r]));
  const againPrev = opts.confirmPrev && new Map(opts.confirmPrev.map((r) => [r.name, r]));
  const againNext = opts.confirmNext && new Map(opts.confirmNext.map((r) => [r.name, r]));
  const out: Change[] = [];
  for (const to of next) {
    const p = before.get(to.name);
    const s = stored.get(to.name);
    // The previous commit's own verdict, re-scored now; if that replay errored, the last real verdict the state
    // remembers stands in, marked stale (scored by an older graph-assay, so it gets no draft).
    let from: Row | null = p && p.verdict !== 'ERROR' ? p : null;
    let stale = false;
    if (!from && s && s.verdict !== 'ERROR') { from = s; stale = true; }
    // Already erroring: the previous commit's replay says so; only for a fixture it lacks, the state does.
    const erroring = p ? p.verdict === 'ERROR' : !!s?.erroringSince || s?.verdict === 'ERROR';
    let kind: Kind | null;
    if (to.verdict === 'ERROR') kind = erroring ? null : 'error';
    else if (!from) kind = 'new';
    else if (from.verdict === to.verdict) kind = broken(to.verdict) && from.detail !== to.detail ? 'edges' : null;
    else if (to.verdict === 'FIXED') kind = 'fixed';
    else if (from.verdict === 'FIXED' && broken(to.verdict)) kind = 'regression';
    else kind = 'changed';
    if (!kind) continue;
    if (needsConfirm({ kind } as Change) && againNext) {
      // Both sides' reruns must say the same thing again, or it is not reported as a change.
      if (!same(againNext.get(to.name), to) || (!stale && againPrev && !same(againPrev.get(to.name), from))) kind = 'unstable';
    }
    out.push({ kind, name: to.name, issue: to.issue ?? from?.issue ?? null, from, to, stale });
  }
  return out;
}

/** Whether a change needs the confirming reruns before it can be reported. */
export const needsConfirm = (c: Pick<Change, 'kind'>) => c.kind !== 'error' && c.kind !== 'new';

/**
 * The state to store for the new commit. A fixture that errors keeps its last real verdict (the previous
 * commit's, else the remembered one) with erroringSince; an unstable one keeps its previous verdict; a fixture
 * with no real verdict yet is stored as ERROR.
 */
export function nextState(prev: Row[], next: Row[], changes: Change[], meta: Omit<State, 'results'> & { prevSha?: string }, stored: Row[] = []): State {
  const before = new Map(prev.map((r) => [r.name, r]));
  const kept = new Map(stored.map((r) => [r.name, r]));
  const unstable = new Set(changes.filter((c) => c.kind === 'unstable').map((c) => c.name));
  const last = (name: string): Row | null => {
    const p = before.get(name);
    if (p && p.verdict !== 'ERROR') return { ...p, seenAt: meta.prevSha };
    const s = kept.get(name);
    return s && s.verdict !== 'ERROR' ? s : null;
  };
  const { prevSha, ...head } = meta;
  const results = next.map((r) => {
    const l = last(r.name);
    if (unstable.has(r.name) && l) return { ...l, erroringSince: undefined };
    if (r.verdict === 'ERROR' && l) {
      const since = before.get(r.name)?.verdict === 'ERROR' ? kept.get(r.name)?.erroringSince : undefined;
      return { ...l, erroringSince: since ?? meta.codegraph };
    }
    return { ...r, seenAt: meta.codegraph };
  }).map((r) => JSON.parse(JSON.stringify(r)) as Row); // drops undefined fields
  return { ...head, results };
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
  if (!c.issue || !c.from || c.stale) return null;
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

const what = (c: Change): string => {
  const base: Record<Kind, string> = {
    fixed: 'fixed', regression: 'REGRESSION', edges: 'wrong edges changed', changed: 'changed (look by hand)', new: 'first verdict',
    error: c.from ? 'ERROR (kept previous verdict)' : 'ERROR (no verdict yet)', unstable: 'unstable (a rerun disagreed; kept previous verdict)',
  };
  return base[c.kind] + (c.stale ? `; the previous commit errored, so "was" is the last verdict recorded (on ${short(c.from?.seenAt ?? '')}): check by hand (no draft)` : '');
};
const ADVICE: Partial<Record<Kind, string>> = {
  fixed: 'a comment on the issue (closed: a confirmation; open: tells the maintainer it may be fixed)',
  regression: 'a comment on the issue; if the issue is closed, a new issue linking it is usually better (posting skill)',
  edges: 'a dated Edit line in our issue body (no notification), not a comment',
};

function issueCell(c: Change, ctx: Ctx): string {
  if (!c.issue) return 'unfiled';
  const s = ctx.states[String(c.issue)];
  return `${UPSTREAM}#${c.issue}${s ? (s === 'unknown' ? ' (state unknown)' : ` (${s})`) : ''}`;
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
    return d ? [['', `<details><summary>Draft for ${UPSTREAM}#${c.issue}: ${ADVICE[c.kind]}</summary>`, '', '````markdown', d.trimEnd(), '````', '', '</details>'].join('\n')] : [];
  });
  const foot = '\nDrafts are candidates: re-check on current upstream `main`, then post by hand after approval.\n';
  const build = (rowsShown: number, draftsShown: number) => {
    const lines = [title, '', '| fixture | upstream issue | was | now | change |', '|---|---|---|---|---|', ...changes.slice(0, rowsShown).map(row)];
    if (rowsShown < changes.length) lines.push('', `${changes.length - rowsShown} more change(s) left out to stay under GitHub's comment limit: the replay job's summary lists them all.`);
    lines.push(...drafts.slice(0, draftsShown));
    if (draftsShown < drafts.length) lines.push('', `${drafts.length - draftsShown} draft(s) left out to stay under GitHub's comment limit: the replay job's summary has them.`);
    return lines.join('\n') + '\n' + foot;
  };
  let d = drafts.length; let rs = changes.length; let out = build(rs, d);
  while (out.length > limit && d > 0) out = build(rs, --d);
  while (out.length > limit && rs > 0) out = build(--rs, d);
  return out;
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

function main(argv: string[]) {
  const [cmd, ...args] = argv;
  if (cmd === 'flips') {
    const prev = opt(args, '--prev'); const next = opt(args, '--next');
    if (!prev || !next) throw new Error('flips needs --prev and --next');
    const changes = diff(rows(read(prev)), rows(read(next))).filter(needsConfirm);
    const out = args.includes('--issues') ? [...new Set(changes.map((c) => c.issue).filter(Boolean))].map(String) : changes.map((c) => c.name);
    if (out.length) console.log(out.join('\n'));
    return;
  }
  if (cmd === 'run') {
    const need = (k: string) => { const v = opt(args, k); if (!v) throw new Error(`run needs ${k}`); return v; };
    const sha = need('--sha'); const ga = need('--graph-assay');
    if (!SHA.test(sha) || !SHA.test(ga)) throw new Error('--sha and --graph-assay must be full shas');
    const date = opt(args, '--date') ?? new Date().toISOString().slice(0, 10);
    const dir = opt(args, '--fixtures');
    const fixtures = dir ? new Set(fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'expect.json')))) : undefined;
    const next = rows(read(need('--next')), { fixtures });
    const prevFile = opt(args, '--prev');
    const prevSha = opt(args, '--prev-sha');
    if (!!prevFile !== !!prevSha) throw new Error('--prev and --prev-sha go together');
    if (prevSha && !SHA.test(prevSha)) throw new Error('--prev-sha must be a full sha');
    const stateFile = opt(args, '--state');
    const stored = stateFile ? read(stateFile) : null;
    // The stored state must be the one for the commit this run compares against, or it is someone else's.
    if (stored && stored.codegraph !== prevSha) throw new Error(`stored state is for ${String(stored.codegraph).slice(0, 8)}, not the previous commit ${String(prevSha).slice(0, 8)}`);
    const storedRows = stored ? rows(stored, { state: true }) : [];
    const prev = prevFile ? rows(read(prevFile), { fixtures }) : [];
    const cp = opt(args, '--confirm-prev'); const cn = opt(args, '--confirm-next');
    if (!!cp !== !!cn) throw new Error('--confirm-prev and --confirm-next go together');
    const confirmPrev = cp ? rows(read(cp), { fixtures }) : undefined;
    const confirmNext = cn ? rows(read(cn), { fixtures }) : undefined;
    const statesFile = opt(args, '--issue-states');
    const states = statesFile ? read(statesFile) : {};
    for (const [k, v] of Object.entries(states)) if (!/^\d+$/.test(k) || !ISSUE_STATES.has(v as string)) throw new Error(`bad issue state ${k}: ${v}`);
    const changes = prevFile ? diff(prev, next, { stored: storedRows, confirmPrev, confirmNext }) : [];
    if (!confirmNext && changes.some(needsConfirm)) throw new Error(`changes need --confirm-prev and --confirm-next (the reruns of: ${changes.filter(needsConfirm).map((c) => c.name).join(', ')})`);
    const state = nextState(prev, next, changes, { codegraph: sha, recordedAt: date, graphAssay: ga, prevSha }, storedRows);
    const ctx = { prev: prevSha ?? sha, next: sha, graphAssay: ga, date, states: states as Record<string, string> };
    const count = next.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {} as Record<string, number>);
    const limit = args.includes('--no-limit') ? Infinity : LIMIT;
    fs.writeFileSync(need('--state-out'), JSON.stringify(state, null, 1) + '\n');
    fs.writeFileSync(need('--report-out'), prevFile ? report(changes, ctx, { limit }) : report([], ctx, { baseline: count }));
    console.log(prevFile ? `${changes.length} change(s) since ${short(prevSha)}` : `baseline: ${next.length} fixtures`);
    return;
  }
  throw new Error('usage: fixture-watch.ts flips|run ... (see the header)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`fixture-watch: ${(e as Error).message}`); process.exit(2); }
}
