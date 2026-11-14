#!/usr/bin/env node
// Bug triage from an oracle run: every strict
// non-match, for each subject, clustered by shape across repositories and ranked by the macro headline
// points it costs. Model-free and reproducible: it reads finished oracle work dirs and runs nothing.
//
// Usage: node bench/triage.ts [--work <oracle work dir>] [--corpus corpus/v1.txt] [--split dev]
//                              [--t3 <dir with meta-cg.json / meta-cgr.json>] [--t1 <dir with replay-cg.json>]
//                              [--known fixtures/known-shapes.json] [--top 15] [--md out.md] [--json out.json]
//   --known: each fixture's shapes (tools/triage/tag-fixtures.ts); a codegraph shape whose key a fixture of
//   the same language produces lists that fixture and its upstream issue, with its replay verdict from --t1
//   (BROKEN: still open at this build). A match is a candidate, not proof: one key can hold several bugs.
//   --work: the dir holding w-<name>[-code-graph-rag] (default: the configured oracle work dir); for a
//   canonical reproduction, <results>/work.
//
// A shape is one bucket key: verdict or cause, edge kind, how the subject resolved it, and target kind
// against the oracle symbol kind (SPEC §5). Points at stake for a shape: the gain in the subject's
// macro strict precision (forward) or recall (missing) if all its units were right, i.e. the mean over
// the averaged repositories of k / n. It is an upper bound: a fix can create other errors. Noise
// verdicts (oracle artifacts, SPEC §5) are left out of the ranking and counted.
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.ts';
import { CORPUS, readRepos } from '../differential/builds.ts';
import { forward, missing } from '../lib/scores.ts';
import { isMain } from '../lib/main.ts';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const work = opt('--work', config.work); const corpus = opt('--corpus', CORPUS); const split = opt('--split', 'dev');
const t3Dir = opt('--t3', null); const t1Dir = opt('--t1', null); const top = Number(opt('--top', '15'));
const knownFile = opt('--known', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'known-shapes.json'));
const mdOut = opt('--md', null); const jsonOut = opt('--json', null);
const SUBJECTS = { codegraph: { sfx: '', tag: 'cg' }, 'code-graph-rag': { sfx: '-code-graph-rag', tag: 'cgr' } };
const FORWARD_BAD = /^(wrong-target|external|local-shadow|cross-file-unimported|receiver-fallback)\|/;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const workDir = (name, sfx) => [`w-pub-${name}${sfx}`, `w-${name}${sfx}`].map((d) => path.join(work, d)).find((d) => fs.existsSync(path.join(d, 'out.json')));

/** Plain words for a shape key. */
export function describe(key) {
  const p = key.split('|');
  if (p[0] === 'missing') {
    const [, cause, lang, kinds] = p;
    const [scip, node] = (kinds ?? '').split('>');
    return `missed call (${cause}) in ${lang}: callee is a ${scip.replace('@decl', ', a bodiless declaration')}${node ? `; the subject has a ${node} there` : ''}`;
  }
  const [verdict, kind, by, kinds] = p;
  const [node, scip] = (kinds ?? '').split('>');
  return `${verdict} ${kind} edge (resolved by ${by}): the subject links a ${node}, the compiler says ${scip}`;
}

/** Rank shapes for one subject from its per-repo results [{repo, fwd, miss, workDir}]. */
export function rankShapes(rows) {
  const shapes = new Map();
  const precisionRepos = rows.filter((r) => forward(r.fwd).strict[1] > 0).length;
  const recallRepos = rows.filter((r) => missing(r.miss).strict[1] > 0).length;
  const noise: Record<string, any> = {};
  for (const r of rows) {
    const [, pn] = forward(r.fwd).strict; const [, rn] = missing(r.miss).strict;
    const add = (dir, key, n, denom, groups) => {
      const s = shapes.get(`${dir}:${key}`) ?? { direction: dir, key, description: describe(key), sites: 0, points: 0, repos: [], groups: [], at: new Set(), langs: new Set() };
      if (r.language) s.langs.add(r.language);
      s.sites += n;
      s.points += denom ? (100 * n) / denom / (dir === 'precision' ? precisionRepos : recallRepos) : 0;
      s.repos.push({ repo: r.repo, sites: n, of: denom });
      for (const g of groups ?? []) s.groups.push({ repo: r.repo, workDir: r.workDir, ...g });
      shapes.set(`${dir}:${key}`, s);
    };
    for (const [key, n] of Object.entries<any>(r.fwd.buckets)) {
      if (key.startsWith('noise:')) { noise[key.split('|')[0]] = (noise[key.split('|')[0]] ?? 0) + n; continue; }
      if (FORWARD_BAD.test(`${key}|`)) add('precision', key, n, pn, r.fwd.groups?.[key]);
    }
    for (const [key, n] of Object.entries<any>(r.miss.buckets)) if (key.split('|')[1] !== 'found') add('recall', key, n, rn, r.miss.groups?.[key]);
    // Call sites per shape (ORACLE_ALLSITES lists), so shapes that are one cause seen from both
    // directions (a wrong edge here is the missed call there) can be linked.
    for (const [dir, list] of [['precision', r.fwd.sites], ['recall', r.miss.sites]]) {
      for (const x of list ?? []) shapes.get(`${dir}:${x.key}`)?.at.add(`${r.repo}:${x.site}:${x.name}`);
    }
  }
  const ranked = [...shapes.values()].sort((a, b) => b.points - a.points || b.sites - a.sites || b.repos.length - a.repos.length);
  // Shapes sharing at least half of the smaller one's call sites are the same calls (SPEC §5 has one
  // verdict per unit in each direction, so a cause shows once per direction).
  ranked.forEach((s, i) => {
    s.sameCalls = ranked.map((o, j) => ({ rank: j + 1, key: o.key, direction: o.direction,
      shared: [...s.at].filter((x) => o.at.has(x)).length, smaller: Math.min(s.at.size, o.at.size) }))
      .filter((o, j) => j !== i && o.smaller && o.shared >= o.smaller / 2).map(({ rank, key, direction, shared }) => ({ rank, key, direction, shared }));
  });
  for (const s of ranked) {
    delete s.at;
    s.langs = [...s.langs].sort();
    s.points = Math.round(s.points * 100) / 100;
    s.repos.sort((a, b) => b.sites - a.sites);
    s.groups.sort((a, b) => b.n - a.n);
  }
  return { shapes: ranked, noise };
}

const LANG = { python: 'python', go: 'go', typescript: 'ts', javascript: 'ts', ts: 'ts' };
/** Fixtures (tagged by tools/triage/tag-fixtures.ts) whose bug produces this shape in one of its languages. */
export function knownFor(shape, known, verdicts = {}) {
  const langs = new Set(shape.langs.map((l) => LANG[l]));
  return Object.entries<any>(known?.fixtures ?? {}).filter(([, f]) => f.shapes && f.shapes[shape.key] && langs.has(LANG[f.lang]))
    .map(([name, f]) => ({ fixture: name, issue: f.issue, verdict: verdicts[name] ?? null }));
}

/** Decoy captures and losses from a T3 result (metamorphic/run.ts --json). */
export function decoyFindings(meta) {
  const out = { seeds: 0, changed: 0, captured: [], lost: [] };
  for (const r of meta ?? []) {
    if (r.relation !== 'decoy' || !r.diffs) continue;
    out.seeds++;
    const c = r.diffs.CAPTURED ?? []; const l = r.diffs.LOST ?? [];
    if (c.length || l.length || (r.diffs.GAINED ?? []).length) out.changed++;
    for (const e of c) out.captured.push({ seed: r.seed, edge: e });
    for (const e of l) out.lost.push({ seed: r.seed, edge: e });
  }
  return out;
}

if (isMain(import.meta.url)) {
  const repos = readRepos(corpus, split);
  const known = fs.existsSync(knownFile) ? readJson(knownFile) : null;
  const result = { work, corpus: path.basename(corpus), split, subjects: {} };
  for (const [subj, { sfx, tag }] of Object.entries<any>(SUBJECTS)) {
    const rows = [];
    const notRun = [];
    for (const r of repos) {
      const w = workDir(r.name, sfx);
      if (!w) { notRun.push(r.name); continue; }
      rows.push({ repo: r.name, language: r.language, workDir: w, fwd: readJson(path.join(w, 'out.json')), miss: readJson(path.join(w, 'out-missing.json')) });
    }
    const t3 = t3Dir && fs.existsSync(path.join(t3Dir, `meta-${tag}.json`)) ? decoyFindings(readJson(path.join(t3Dir, `meta-${tag}.json`))) : null;
    const ranked = rankShapes(rows);
    // The fixtures are codegraph bugs, tagged with codegraph's shapes: matched for codegraph only.
    const replay = t1Dir && fs.existsSync(path.join(t1Dir, `replay-${tag}.json`)) ? Object.fromEntries(readJson(path.join(t1Dir, `replay-${tag}.json`)).results.map((x) => [x.name, x.verdict])) : {};
    if (subj === 'codegraph' && known) for (const s of ranked.shapes) s.known = knownFor(s, known, replay);
    result.subjects[subj] = { ...ranked, notRun, decoy: t3, specs: [...new Set(rows.flatMap((r) => [r.fwd.spec ?? null, r.miss.spec ?? null]))] };
  }

  const md = [`# Bug triage: corpus ${result.corpus}, split \`${split}\``, '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`bench/triage.ts\` from ${work}.`,
    'Shapes are ranked by headline points at stake: how much the subject\'s macro strict precision or recall would rise if every unit of the shape were right. It is an upper bound, since a fix can create other errors.',
    known ? `Filed fixtures come from ${path.basename(knownFile)} (codegraph ${String(known.build).slice(0, 8)}, ${known.generated}): a fixture listed for a shape produces that shape in the same language, which makes it a candidate match, not proof, since one shape can hold several bugs. BROKEN means the bug is still present at this run's build.` : 'No fixture shape file: filed fixtures are not matched.', ''];
  for (const [subj, v] of Object.entries<any>(result.subjects)) {
    md.push(`## ${subj}`, '', `Results recorded under: ${v.specs.map((s) => s ?? 'unrecorded').join(', ')}.${v.notRun.length ? ` Not run: ${v.notRun.join(', ')}.` : ''}`, '',
      `| rank | points | track | sites | repos | shape | same calls as |${v.shapes[0]?.known ? ' filed fixtures with this shape |' : ''}`, `|---|---|---|---|---|---|---|${v.shapes[0]?.known ? '---|' : ''}`);
    const knownCell = (s) => (s.known ? ` ${s.known.map((k) => `${k.issue ? `#${k.issue}` : 'unfiled'} ${k.fixture}${k.verdict ? ` (${k.verdict})` : ''}`).join(', ') || 'none: new'} |` : '');
    v.shapes.slice(0, top).forEach((s, i) => md.push(`| ${i + 1} | ${s.points.toFixed(2)} | ${s.direction} | ${s.sites} | ${s.repos.map((r) => `${r.repo} ${r.sites}`).join(', ')} | \`${s.key}\` | ${s.sameCalls.map((o) => `#${o.rank}`).join(', ') || '-'} |${knownCell(s)}`));
    md.push('');
    v.shapes.slice(0, Math.min(top, 5)).forEach((s, i) => {
      md.push(`### ${subj} #${i + 1}: ${s.description}`, '', `\`${s.key}\`: ${s.sites} sites, ${s.points.toFixed(2)} macro ${s.direction} points.${s.sameCalls.length ? ` Same calls as ${s.sameCalls.map((o) => `#${o.rank} (${o.direction}, ${o.shared} shared)`).join(', ')}.` : ''}`, '');
      for (const g of s.groups.slice(0, 3)) {
        md.push(`- **${g.n}** in ${g.repo}: \`${(g.code ?? '').slice(0, 100)}\``,
          `  - subject: \`${g.codegraph}\``, `  - compiler: \`${g.scipDef ? `${g.scipDef.file}:${g.scipDef.line}` : '-'}\` ${g.scip ? `(\`${g.scip.split(' ').pop().slice(-60)}\`)` : ''}`,
          `  - inspect: \`node oracle/site.ts ${g.workDir.replace(/-code-graph-rag$/, '')} ${g.sites[0].split(':').slice(0, 2).join(':')} --subject ${subj}\``);
      }
      md.push('');
    });
    if (Object.keys(v.noise).length) md.push(`Left out as oracle noise (SPEC §5): ${Object.entries<any>(v.noise).map(([k, n]) => `${k} ${n}`).join(', ')}.`, '');
    if (v.decoy) {
      md.push(`Decoy relation (T3): ${v.decoy.changed} of ${v.decoy.seeds} seeds changed; ${v.decoy.captured.length} calls captured by an unimported decoy, ${v.decoy.lost.length} correct edges lost.`);
      for (const c of v.decoy.captured.slice(0, 5)) md.push(`- seed ${c.seed}: \`${c.edge}\``);
      md.push('');
    }
  }
  const text = `${md.join('\n')}\n`;
  if (mdOut) fs.writeFileSync(mdOut, text); else process.stdout.write(text);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
}
