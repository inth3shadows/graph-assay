#!/usr/bin/env node
// Fixture watch (.github/workflows/fixture-watch.yml): which filed codegraph fixtures changed verdict between
// the last recorded upstream commit and a new one, as a report with ready-to-paste drafts for the upstream
// issues. It only reads replay JSON (fixtures/replay.mts --json) and writes files: it never posts anything.
// A draft is a candidate, not a post: someone re-checks it on current upstream main and posts it by hand.
//
// Usage:
//   node tools/fixture-watch.ts state <replay.json> <codegraph sha> <out.json>
//       turn a replay into a state file (a dry run's "previous" side, or a hand-made baseline)
//   node tools/fixture-watch.ts flips [--prev state.json] --next replay.json [--issues]
//       print the fixtures whose verdict or wrong edges changed, one per line (with --issues: their
//       upstream issue numbers instead, deduplicated); nothing without --prev
//   node tools/fixture-watch.ts run [--prev state.json] --next replay.json --sha <codegraph sha>
//       --graph-assay <sha> [--confirm replay.json] [--issue-states states.json] [--fixtures dir]
//       [--date YYYY-MM-DD] --state-out state.json --report-out report.md
//       write the new state and the report; the report file is empty when there is nothing to say
//
// State: { codegraph, recordedAt, graphAssay, results: [{ name, issue, verdict, detail }] }. A fixture whose new
// verdict is ERROR, or whose confirming rerun disagrees (unstable), keeps its previous row, so a transient
// failure is reported once and never becomes a fake flip on the next run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM = 'colbymchenry/codegraph';
export const REPO = 'inth3shadows/graph-assay';
const VERDICTS = new Set(['BROKEN', 'GUESSED', 'FIXED', 'CHANGED', 'ERROR']);
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface Row { name: string; issue: number | null; verdict: string; detail: string }
export interface State { codegraph: string; recordedAt: string; graphAssay: string | null; results: Row[] }
export type Kind = 'fixed' | 'regression' | 'edges' | 'changed' | 'new' | 'error' | 'unstable';
export interface Change { kind: Kind; name: string; issue: number | null; from: Row | null; to: Row }

/** The rows of a replay or state file, checked: an unexpected shape is refused, never rendered. */
export function rows(doc: any, fixtures?: Set<string>): Row[] {
  if (!doc || !Array.isArray(doc.results)) throw new Error('no results array');
  const seen = new Set<string>();
  return doc.results.map((r: any) => {
    if (typeof r?.name !== 'string' || !NAME.test(r.name)) throw new Error(`bad fixture name: ${JSON.stringify(r?.name)}`);
    if (fixtures && !fixtures.has(r.name)) throw new Error(`unknown fixture: ${r.name}`);
    if (seen.has(r.name)) throw new Error(`duplicate fixture: ${r.name}`);
    seen.add(r.name);
    if (!VERDICTS.has(r.verdict)) throw new Error(`${r.name}: bad verdict ${JSON.stringify(r.verdict)}`);
    const issue = r.issue === undefined || r.issue === null || r.issue === 0 ? null : r.issue;
    if (issue !== null && !(Number.isInteger(issue) && issue > 0)) throw new Error(`${r.name}: bad issue ${JSON.stringify(r.issue)}`);
    const detail = typeof r.detail === 'string' ? r.detail : '';
    return { name: r.name, issue, verdict: r.verdict, detail };
  });
}

export function toState(replay: any, codegraph: string, graphAssay: string | null, date: string): State {
  if (!SHA.test(codegraph)) throw new Error(`not a full codegraph sha: ${codegraph}`);
  return { codegraph, recordedAt: date, graphAssay, results: rows(replay) };
}

const broken = (v: string) => v === 'BROKEN' || v === 'GUESSED';

/** Every fixture whose verdict changed, whose wrong edges changed, or that is new. */
export function diff(prev: Row[], next: Row[], confirm?: Row[]): Change[] {
  const before = new Map(prev.map((r) => [r.name, r]));
  const again = confirm && new Map(confirm.map((r) => [r.name, r]));
  const out: Change[] = [];
  for (const to of next) {
    const from = before.get(to.name) ?? null;
    let kind: Kind | null;
    if (to.verdict === 'ERROR') kind = from?.verdict === 'ERROR' ? null : 'error';
    else if (!from) kind = 'new';
    else if (from.verdict === to.verdict) kind = broken(to.verdict) && from.detail !== to.detail ? 'edges' : null;
    else if (to.verdict === 'FIXED') kind = 'fixed';
    else if (from.verdict === 'FIXED' && broken(to.verdict)) kind = 'regression';
    else kind = 'changed';
    if (!kind) continue;
    // The confirming rerun must say the same thing, or the change is not reported as one.
    if (again && kind !== 'error' && kind !== 'new') {
      const c = again.get(to.name);
      if (!c || c.verdict !== to.verdict || c.detail !== to.detail) kind = 'unstable';
    }
    out.push({ kind, name: to.name, issue: to.issue, from, to });
  }
  return out;
}

/** The state to store: the new rows, except that an ERROR or unstable fixture keeps its previous row. */
export function nextState(prev: Row[], next: Row[], changes: Change[], meta: Omit<State, 'results'>): State {
  const before = new Map(prev.map((r) => [r.name, r]));
  const hold = new Set(changes.filter((c) => c.kind === 'error' || c.kind === 'unstable').map((c) => c.name));
  const results = next.flatMap((r) => (hold.has(r.name) ? (before.has(r.name) ? [before.get(r.name)] : []) : [r]));
  return { ...meta, results };
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
  const state = ctx.states[String(c.issue)];
  if (c.kind === 'fixed') {
    const lead = state === 'closed' ? `Confirmed fixed on \`main\` at ${short(ctx.next)}, thanks.` : `This looks fixed on \`main\` at ${short(ctx.next)}.`;
    return `${lead}\n\n${intro(c, ctx)} goes from ${c.from.verdict} on ${short(ctx.prev)} to FIXED on ${short(ctx.next)}: none of its wrong edges remain and every right edge is there. The change is in ${short(ctx.prev)}..${short(ctx.next)} (https://github.com/${UPSTREAM}/compare/${ctx.prev}...${ctx.next}).\n\n${rerun(c)}\n`;
  }
  if (c.kind === 'regression') {
    return `This is back on \`main\` at ${short(ctx.next)}.\n\n${intro(c, ctx)} read FIXED on ${short(ctx.prev)} and reads ${c.to.verdict} on ${short(ctx.next)}: ${code(c.to.detail)}. The change is in ${short(ctx.prev)}..${short(ctx.next)} (https://github.com/${UPSTREAM}/compare/${ctx.prev}...${ctx.next}).\n\n${rerun(c)}\n`;
  }
  if (c.kind === 'edges') {
    return `**Edit (${ctx.date}):** on \`main\` at ${short(ctx.next)} the ${fixtureLink(c, ctx)} still reads ${c.to.verdict}, but its wrong edges changed. On ${short(ctx.prev)}: ${code(c.from.detail)}. Now: ${code(c.to.detail)}.\n`;
  }
  return null;
}

const WHAT: Record<Kind, string> = {
  fixed: 'fixed', regression: 'REGRESSION', edges: 'wrong edges changed', changed: 'changed (look by hand)',
  new: 'new fixture', error: 'ERROR (kept previous verdict)', unstable: 'unstable (rerun disagreed; kept previous verdict)',
};
const ADVICE: Partial<Record<Kind, string>> = {
  fixed: 'a comment on the issue (closed: a confirmation; open: tells the maintainer it may be fixed)',
  regression: 'a comment on the issue; if the issue is closed, a new issue linking it is usually better (posting skill)',
  edges: 'a dated Edit line in our issue body (no notification), not a comment',
};

/** The tracking-issue comment, or '' when nothing changed. */
export function report(changes: Change[], ctx: Ctx, baseline?: { count: Record<string, number> }): string {
  const head = `### codegraph ${short(ctx.next)}`;
  if (baseline) {
    const counts = Object.entries(baseline.count).sort().map(([k, v]) => `${k} ${v}`).join(', ');
    return `${head}: baseline\n\nNo earlier state, so this run only records verdicts for [${short(ctx.next)}](https://github.com/${UPSTREAM}/commit/${ctx.next}): ${counts}. The next upstream commit is compared with it.\n`;
  }
  if (!changes.length) return '';
  const lines = [
    `${head} (${short(ctx.prev)}..${short(ctx.next)}, [compare](https://github.com/${UPSTREAM}/compare/${ctx.prev}...${ctx.next}))`, '',
    '| fixture | upstream issue | was | now | change |', '|---|---|---|---|---|',
    ...changes.map((c) => `| ${c.name} | ${c.issue ? `${UPSTREAM}#${c.issue}${ctx.states[String(c.issue)] ? ` (${ctx.states[String(c.issue)]})` : ''}` : 'unfiled'} | ${c.from?.verdict ?? '-'} | ${c.to.verdict} | ${WHAT[c.kind]} |`),
  ];
  for (const c of changes) {
    const d = draft(c, ctx);
    if (!d) continue;
    lines.push('', `<details><summary>Draft for ${UPSTREAM}#${c.issue}: ${ADVICE[c.kind]}</summary>`, '', '````markdown', d.trimEnd(), '````', '', '</details>');
  }
  lines.push('', 'Drafts are candidates: re-check on current upstream `main`, then post by hand after approval.');
  return lines.join('\n') + '\n';
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
  if (cmd === 'state') {
    const [replay, sha, out] = args;
    if (!out) throw new Error('usage: state <replay.json> <codegraph sha> <out.json>');
    fs.writeFileSync(out, JSON.stringify(toState(read(replay), sha, null, new Date().toISOString().slice(0, 10)), null, 1) + '\n');
    return;
  }
  if (cmd === 'flips') {
    const prev = opt(args, '--prev');
    const next = opt(args, '--next');
    if (!next) throw new Error('flips needs --next');
    if (!prev) return;
    const changes = diff(rows(read(prev)), rows(read(next))).filter((c) => c.kind !== 'error' && c.kind !== 'new');
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
    const next = rows(read(need('--next')), fixtures);
    const prevFile = opt(args, '--prev');
    const prevDoc = prevFile ? read(prevFile) : null;
    if (prevDoc && !SHA.test(prevDoc.codegraph)) throw new Error('previous state has no full codegraph sha');
    const prev = prevDoc ? rows(prevDoc, undefined) : [];
    const confirmFile = opt(args, '--confirm');
    const confirm = confirmFile ? rows(read(confirmFile), fixtures) : undefined;
    const statesFile = opt(args, '--issue-states');
    const states = statesFile ? read(statesFile) : {};
    for (const [k, v] of Object.entries(states)) if (!/^\d+$/.test(k) || !['open', 'closed'].includes(v as string)) throw new Error(`bad issue state ${k}: ${v}`);
    const changes = prevDoc ? diff(prev, next, confirm) : [];
    const meta = { codegraph: sha, recordedAt: date, graphAssay: ga };
    const state = prevDoc ? nextState(prev, next, changes, meta) : { ...meta, results: next.filter((r) => r.verdict !== 'ERROR') };
    const ctx = { prev: prevDoc?.codegraph ?? sha, next: sha, graphAssay: ga, date, states: states as Record<string, string> };
    const count = next.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {} as Record<string, number>);
    fs.writeFileSync(need('--state-out'), JSON.stringify(state, null, 1) + '\n');
    fs.writeFileSync(need('--report-out'), prevDoc ? report(changes, ctx) : report([], ctx, { count }));
    console.log(prevDoc ? `${changes.length} change(s) since ${short(prevDoc.codegraph)}` : `baseline: ${next.length} fixtures`);
    return;
  }
  throw new Error('usage: fixture-watch.ts state|flips|run ... (see the header)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`fixture-watch: ${(e as Error).message}`); process.exit(2); }
}
