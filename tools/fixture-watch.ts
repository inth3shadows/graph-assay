#!/usr/bin/env node
// Fixture watch (.github/workflows/fixture-watch.yml): which filed codegraph fixtures changed verdict between
// the last recorded upstream commit and a new one, as a report with ready-to-paste drafts for the upstream
// issues. It only reads replay JSON (fixtures/replay.mts --json) and writes files: it never posts anything.
// A draft is a candidate, not a post: someone re-checks it on current upstream main and posts it by hand.
//
// Usage:
//   node tools/fixture-watch.ts state <replay.json> <codegraph sha> <out.json> [--fixtures dir]
//       turn a replay into a state file (a dry run's "previous" side, or a hand-made baseline)
//   node tools/fixture-watch.ts flips [--prev state.json] --next replay.json [--issues]
//       print the fixtures whose verdict or wrong edges changed, one per line (with --issues: their
//       upstream issue numbers instead, deduplicated); nothing without --prev
//   node tools/fixture-watch.ts run [--prev state.json] --next replay.json --sha <codegraph sha>
//       --graph-assay <sha> [--confirm replay.json] [--issue-states states.json] [--fixtures dir]
//       [--date YYYY-MM-DD] --state-out state.json --report-out report.md
//       write the new state and the report; the report file is empty when there is nothing to say.
//       A change other than a new fixture or an error needs --confirm (the rerun of the changed fixtures).
//
// State: { codegraph, recordedAt, graphAssay, closure, results: [{ name, issue, verdict, detail, seenAt,
// fixture, erroringSince? }] }. `seenAt` is the codegraph commit the row's verdict was last observed on, so a
// draft names the range a change really happened in. A fixture whose new verdict is ERROR keeps its previous
// row with `erroringSince` set, and is reported once; a fixture with no verdict yet is stored as ERROR, and its
// first verdict is "new". An unstable fixture (the rerun disagrees) keeps its previous row unchanged.
// `closure` hashes the replay's own code and `fixture` each fixture's files: when either changed since the
// previous run, a change may be graph-assay's own doing, so it gets no draft.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importClosure } from '../lib/manifest.ts';

export const UPSTREAM = 'colbymchenry/codegraph';
export const REPO = 'inth3shadows/graph-assay';
const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERDICTS = new Set(['BROKEN', 'GUESSED', 'FIXED', 'CHANGED', 'ERROR']);
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISSUE_STATES = new Set(['open', 'closed', 'unknown']);
const LIMIT = 60000; // GitHub refuses a comment over 65,536 characters

export interface Row { name: string; issue: number | null; verdict: string; detail: string; seenAt?: string; fixture?: string; erroringSince?: string }
export interface State { codegraph: string; recordedAt: string; graphAssay: string | null; closure?: string; results: Row[] }
export type Kind = 'fixed' | 'regression' | 'edges' | 'changed' | 'new' | 'error' | 'unstable';
export interface Change { kind: Kind; name: string; issue: number | null; from: Row | null; to: Row; local?: boolean }

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
    const row: Row = { name: r.name, issue, verdict: r.verdict, detail: typeof r.detail === 'string' ? r.detail : '' };
    for (const [k, re] of [['seenAt', SHA], ['erroringSince', SHA], ['fixture', HASH]] as const) {
      if (r[k] === undefined) continue;
      if (typeof r[k] !== 'string' || !re.test(r[k])) throw new Error(`${r.name}: bad ${k} ${JSON.stringify(r[k])}`);
      row[k] = r[k];
    }
    return row;
  });
}

/** sha256 over a set of files: their paths (relative to `root`) and contents, in sorted order. */
function hashFiles(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort()) { h.update(f.split(path.sep).join('/')); h.update('\0'); h.update(fs.readFileSync(path.join(root, f))); h.update('\0'); }
  return h.digest('hex');
}
function filesUnder(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(dir, path.join(rel, e.name)) : e.isFile() ? [path.join(rel, e.name)] : []));
}
/** What the verdicts depend on in graph-assay itself: the replay's code, and each fixture's files. */
export function fingerprints(fixturesDir: string): { closure: string; fixtures: Record<string, string> } {
  const closure = hashFiles(qa, importClosure(['fixtures/replay.mts']));
  const fixtures: Record<string, string> = {};
  for (const n of fs.readdirSync(fixturesDir)) {
    const d = path.join(fixturesDir, n);
    if (fs.existsSync(path.join(d, 'expect.json'))) fixtures[n] = hashFiles(d, filesUnder(d));
  }
  return { closure, fixtures };
}

/** Stamp replay rows with the commit they were seen on and their fixture's hash. */
const stamp = (rs: Row[], sha: string, fp?: Record<string, string>): Row[] =>
  rs.map((r) => ({ ...r, seenAt: sha, ...(fp?.[r.name] ? { fixture: fp[r.name] } : {}) }));

export function toState(replay: any, codegraph: string, graphAssay: string | null, date: string,
  fp?: { closure: string; fixtures: Record<string, string> }): State {
  if (!SHA.test(codegraph)) throw new Error(`not a full codegraph sha: ${codegraph}`);
  return { codegraph, recordedAt: date, graphAssay, ...(fp ? { closure: fp.closure } : {}), results: stamp(rows(replay), codegraph, fp?.fixtures) };
}

const broken = (v: string) => v === 'BROKEN' || v === 'GUESSED';

/** Every fixture whose verdict changed, whose wrong edges changed, that is new, or that started erroring. */
export function diff(prev: Row[], next: Row[], confirm?: Row[], opts: { closureChanged?: boolean } = {}): Change[] {
  const before = new Map(prev.map((r) => [r.name, r]));
  const again = confirm && new Map(confirm.map((r) => [r.name, r]));
  const out: Change[] = [];
  for (const to of next) {
    const from = before.get(to.name) ?? null;
    let kind: Kind | null;
    if (to.verdict === 'ERROR') kind = from && (from.verdict === 'ERROR' || from.erroringSince) ? null : 'error';
    else if (!from || from.verdict === 'ERROR') kind = 'new';
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
    const local = !!opts.closureChanged || !!(from?.fixture && to.fixture && from.fixture !== to.fixture);
    out.push({ kind, name: to.name, issue: to.issue ?? from?.issue ?? null, from, to, local });
  }
  return out;
}

/** Whether a change needs the confirming rerun before it can be reported. */
export const needsConfirm = (c: Change) => c.kind !== 'error' && c.kind !== 'new';

/** The state to store. An erroring fixture keeps its previous row (marked), an unstable one keeps it as it was. */
export function nextState(prev: Row[], next: Row[], changes: Change[], meta: Omit<State, 'results'>): State {
  const before = new Map(prev.map((r) => [r.name, r]));
  const unstable = new Set(changes.filter((c) => c.kind === 'unstable').map((c) => c.name));
  const results = next.map((r) => {
    const from = before.get(r.name);
    if (unstable.has(r.name) && from) return from;
    if (r.verdict === 'ERROR' && from && from.verdict !== 'ERROR') return { ...from, erroringSince: from.erroringSince ?? meta.codegraph };
    return { ...r, seenAt: r.seenAt ?? meta.codegraph };
  });
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
  if (!c.issue || !c.from || c.local) return null;
  const was = c.from.seenAt ?? ctx.prev; // the commit the previous verdict was really observed on
  const range = `${short(was)}..${short(ctx.next)} (https://github.com/${UPSTREAM}/compare/${was}...${ctx.next})`;
  if (c.kind === 'fixed') {
    const lead = ctx.states[String(c.issue)] === 'closed' ? `Confirmed fixed on \`main\` at ${short(ctx.next)}, thanks.` : `This looks fixed on \`main\` at ${short(ctx.next)}.`;
    return `${lead}\n\n${intro(c, ctx)} goes from ${c.from.verdict} on ${short(was)} to FIXED on ${short(ctx.next)}: none of its wrong edges remain and every right edge is there. The change is in ${range}.\n\n${rerun(c)}\n`;
  }
  if (c.kind === 'regression') {
    return `This is back on \`main\` at ${short(ctx.next)}.\n\n${intro(c, ctx)} read FIXED on ${short(was)} and reads ${c.to.verdict} on ${short(ctx.next)}: ${code(c.to.detail)}. The change is in ${range}.\n\n${rerun(c)}\n`;
  }
  if (c.kind === 'edges') {
    return `**Edit (${ctx.date}):** on \`main\` at ${short(ctx.next)} the ${fixtureLink(c, ctx)} still reads ${c.to.verdict}, but its wrong edges changed. On ${short(was)}: ${code(c.from.detail)}. Now: ${code(c.to.detail)}.\n`;
  }
  return null;
}

const WHAT: Record<Kind, string> = {
  fixed: 'fixed', regression: 'REGRESSION', edges: 'wrong edges changed', changed: 'changed (look by hand)',
  new: 'first verdict', error: 'ERROR (kept previous verdict)', unstable: 'unstable (rerun disagreed; kept previous verdict)',
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

/** The tracking-issue comment, or '' when nothing changed. Kept under GitHub's comment limit. */
export function report(changes: Change[], ctx: Ctx, baseline?: { count: Record<string, number> }): string {
  const head = `### codegraph ${short(ctx.next)}`;
  if (baseline) {
    const counts = Object.entries(baseline.count).sort().map(([k, v]) => `${k} ${v}`).join(', ');
    return `${head}: baseline\n\nNo earlier state, so this run only records verdicts for [${short(ctx.next)}](https://github.com/${UPSTREAM}/commit/${ctx.next}): ${counts}. The next upstream commit is compared with it.\n`;
  }
  if (!changes.length) return '';
  const title = `${head} (${short(ctx.prev)}..${short(ctx.next)}, [compare](https://github.com/${UPSTREAM}/compare/${ctx.prev}...${ctx.next}))`;
  const row = (c: Change) => `| ${c.name} | ${issueCell(c, ctx)} | ${c.from?.erroringSince ? `${c.from.verdict}, erroring` : c.from?.verdict ?? '-'} | ${c.to.verdict} | ${WHAT[c.kind]}${c.local ? '; graph-assay changed this fixture or its scoring since the last run, so check by hand (no draft)' : ''} |`;
  const drafts = changes.flatMap((c) => {
    const d = draft(c, ctx);
    return d ? [['', `<details><summary>Draft for ${UPSTREAM}#${c.issue}: ${ADVICE[c.kind]}</summary>`, '', '````markdown', d.trimEnd(), '````', '', '</details>'].join('\n')] : [];
  });
  const foot = '\nDrafts are candidates: re-check on current upstream `main`, then post by hand after approval.\n';
  const build = (rowsShown: number, draftsShown: number) => {
    const lines = [title, '', '| fixture | upstream issue | was | now | change |', '|---|---|---|---|---|', ...changes.slice(0, rowsShown).map(row)];
    if (rowsShown < changes.length) lines.push('', `${changes.length - rowsShown} more change(s) left out to stay under GitHub's comment limit: the run's job summary has them all.`);
    lines.push(...drafts.slice(0, draftsShown));
    if (draftsShown < drafts.length) lines.push('', `${drafts.length - draftsShown} draft(s) left out to stay under GitHub's comment limit: rerun the fixtures named above.`);
    return lines.join('\n') + '\n' + foot;
  };
  let d = drafts.length; let rs = changes.length; let out = build(rs, d);
  while (out.length > LIMIT && d > 0) out = build(rs, --d);
  while (out.length > LIMIT && rs > 0) out = build(--rs, d);
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
const fixturesDir = (args: string[]) => opt(args, '--fixtures') ?? path.join(qa, 'fixtures', 'oracle-candidates');

function main(argv: string[]) {
  const [cmd, ...args] = argv;
  if (cmd === 'state') {
    const [replay, sha, out] = args;
    if (!out || out.startsWith('--')) throw new Error('usage: state <replay.json> <codegraph sha> <out.json> [--fixtures dir]');
    const st = toState(read(replay), sha, null, new Date().toISOString().slice(0, 10), fingerprints(fixturesDir(args)));
    fs.writeFileSync(out, JSON.stringify(st, null, 1) + '\n');
    return;
  }
  if (cmd === 'flips') {
    const prev = opt(args, '--prev');
    const next = opt(args, '--next');
    if (!next) throw new Error('flips needs --next');
    if (!prev) return;
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
    const fp = fingerprints(fixturesDir(args));
    const known = new Set(Object.keys(fp.fixtures));
    const next = stamp(rows(read(need('--next')), known), sha, fp.fixtures);
    const prevFile = opt(args, '--prev');
    const prevDoc = prevFile ? read(prevFile) : null;
    if (prevDoc && !SHA.test(prevDoc.codegraph)) throw new Error('previous state has no full codegraph sha');
    const prev = prevDoc ? rows(prevDoc) : [];
    const confirmFile = opt(args, '--confirm');
    const confirm = confirmFile ? rows(read(confirmFile), known) : undefined;
    const statesFile = opt(args, '--issue-states');
    const states = statesFile ? read(statesFile) : {};
    for (const [k, v] of Object.entries(states)) if (!/^\d+$/.test(k) || !ISSUE_STATES.has(v as string)) throw new Error(`bad issue state ${k}: ${v}`);
    const closureChanged = !!(prevDoc?.closure && prevDoc.closure !== fp.closure);
    const changes = prevDoc ? diff(prev, next, confirm, { closureChanged }) : [];
    if (!confirm && changes.some(needsConfirm)) throw new Error(`changes need --confirm (the rerun of: ${changes.filter(needsConfirm).map((c) => c.name).join(', ')})`);
    const meta = { codegraph: sha, recordedAt: date, graphAssay: ga, closure: fp.closure };
    const state = nextState(prev, next, changes, meta);
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
