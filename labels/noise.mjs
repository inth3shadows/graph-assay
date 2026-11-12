#!/usr/bin/env node
// Oracle noise from the labelled sample: consensus truth (at least 2 of the labellers give the same
// answer; v1 asks astra only where opus and sol disagree; otherwise `no-consensus`, reported, never
// imputed), then per language x stratum how often SCIP and each subject match it, with Wilson 95%
// intervals.
// Usage: node labels/noise.mjs <sample.jsonl> <answers dir> [<sample.jsonl> <answers dir> ...] [--labellers opus,sol,astra] [--protocol labels/protocol.json] [--json out]
// --protocol: the pinned labelling protocol (labels/protocol.mjs). Every file it lists must match its
// hash and every sample file used must be listed, or the run fails; the output records the protocol's
// sha256 and each labeller's qualification accuracy, which the tables show (SPEC §9).
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unstub } from './questions.mjs';
import { loadProtocol } from './protocol.mjs';
import { wilson } from './score.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const labellers = opt('--labellers', 'opus,sol,astra').split(',');
const jsonOut = opt('--json', null);
const protocolFile = opt('--protocol', null);
// One or more <sample.jsonl> <answers dir> pairs (e.g. sample v1 and the TS/JS sample v2), pooled.
if (!args.length || args.length % 2) { console.error('usage: noise.mjs <sample.jsonl> <answers dir> [<sample.jsonl> <answers dir> ...] [--labellers a,b,c] [--json out]'); process.exit(2); }
const pairs = []; for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
let protocol = null;
if (protocolFile) {
  const p = loadProtocol(protocolFile);
  const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const used = pairs.flatMap(([f, dir]) => [f, ...labellers.map((l) => path.join(dir, `${l}.jsonl`)).filter((x) => fs.existsSync(x)), path.join(dir, 'meta.json')].filter((x) => fs.existsSync(x)));
  for (const f of used) { const rel = path.relative(qa, path.resolve(f)); if (!(rel in p.protocol.files)) p.problems.push(`${rel} is used but not pinned by the protocol`); }
  if (p.problems.length) { console.error(`labelling protocol check failed:\n  ${p.problems.join('\n  ')}`); process.exit(2); }
  protocol = { sha256: p.sha256, name: p.protocol.name, promptTemplateSha256: p.protocol.prompt.templateSha256,
    labellers: Object.fromEntries(Object.entries(p.protocol.labellers).map(([k, v]) => [k, { model: v.model, effort: v.effort, role: v.role, qualification: p.qualification[k] ?? null }])) };
}
// A sample dir's optional meta.json {"supersedes": {"<other dir name>": ["<language>", ...]}} retires
// those languages' items from an earlier sample (a fresh sample after an oracle rule change, SPEC §9).
const retired = new Set(pairs.flatMap(([, dir]) => {
  const m = path.join(dir, 'meta.json');
  if (!fs.existsSync(m)) return [];
  return Object.entries(JSON.parse(fs.readFileSync(m, 'utf8')).supersedes ?? {}).flatMap(([d, langs]) => langs.map((l) => `${d}|${l}`));
}));
const items = pairs.flatMap(([f, dir]) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((i) => !retired.has(`${path.basename(path.resolve(dir))}|${i.lang}`)));
const answers = Object.fromEntries(labellers.map((l) => {
  const m = new Map();
  for (const [, dir] of pairs) {
    const file = path.join(dir, `${l}.jsonl`);
    if (!fs.existsSync(file)) continue; // a tie-breaker with no ties in this sample
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.ok && !(r.served_by ?? []).some((s) => s !== (r.deployment ?? r.model))) m.set(r.id, r.answer);
    }
  }
  // A misspelled --labellers name, or answers for some other sample, must not read as "no consensus".
  if (![...pairs].some(([, dir]) => fs.existsSync(path.join(dir, `${l}.jsonl`)))) { console.error(`noise.mjs: no ${l}.jsonl in any answers dir`); process.exit(2); }
  if (m.size && !items.some((i) => m.has(i.id))) { console.error(`noise.mjs: ${l}'s answers match no item in these samples`); process.exit(2); }
  return [l, m];
}));

/** What a subject said at this site: the candidate it proposed, or `none` (no edge). */
const subjectAnswer = (item, subj) => Object.entries(item.meta.sources).find(([, who]) => who.includes(subj))?.[0] ?? 'none';
const SUBJ = ['codegraph', 'code-graph-rag'];

/** Where labellers[0] and [1] disagree and labellers[2] answered: 'a', 'b' (its name) or 'neither'. */
const tieSide = (item) => {
  const [a, b, c] = labellers.map((l) => l && unstub(item, answers[l].get(item.id)));
  if (!a || !b || !c || a === b) return null;
  return c === a ? labellers[0] : c === b ? labellers[1] : 'neither';
};
const rows = [];
for (const item of items) {
  const got = labellers.map((l) => unstub(item, answers[l].get(item.id))).filter(Boolean);
  const counts = {};
  for (const a of got) counts[a] = (counts[a] ?? 0) + 1;
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const truth = n >= 2 && top !== 'cannot-tell' ? top : null;
  rows.push({ id: item.id, lang: item.lang, stratum: item.stratum, target: item.meta.target, labels: got.length, unanimous: got.length >= 2 && n === got.length,
    // A tie-breaker (third labeller) answering where the first two disagree: whose side it took.
    sided: tieSide(item),
    truth, scip: unstub(item, item.meta.scip), ...Object.fromEntries(SUBJ.map((s) => [s, unstub(item, subjectAnswer(item, s))])) });
}

const fmt = (k, n) => { if (!n) return '      -          '; const [a, b] = wilson(k, n); return `${`${k}/${n}`.padStart(7)} ${`${Math.round((100 * k) / n)}%`.padStart(4)} [${Math.round(100 * a)}-${Math.round(100 * b)}]`.padEnd(22); };
const out = {};
console.log(`labellers: ${labellers.join(', ')}; consensus = 2+ agree (cannot-tell never counts)\n`);
console.log('lang    stratum       items consensus unanim.   SCIP right (when it answers)   codegraph right        code-graph-rag right');
for (const lang of [...new Set(rows.map((r) => r.lang))]) {
  for (const stratum of ['agree', 'disagree', 'scip-only', 'subject-only', 'ALL']) {
    const rs = rows.filter((r) => r.lang === lang && (stratum === 'ALL' || r.stratum === stratum));
    if (!rs.length) continue;
    const t = rs.filter((r) => r.truth);
    const sc = t.filter((r) => r.scip !== 'none');
    const k = (xs, f) => xs.filter(f).length;
    const res = { items: rs.length, consensus: t.length, unanimous: k(rs, (r) => r.unanimous),
      scip: [k(sc, (r) => r.scip === r.truth), sc.length], ...Object.fromEntries(SUBJ.map((s) => [s, [k(t, (r) => r[s] === r.truth), t.length]])) };
    (out[lang] ??= {})[stratum] = res;
    console.log(`${lang.padEnd(7)} ${stratum.padEnd(13)} ${String(rs.length).padStart(5)} ${String(t.length).padStart(9)} ${String(res.unanimous).padStart(7)}   ${fmt(...res.scip)}  ${fmt(...res.codegraph)} ${fmt(...res['code-graph-rag'])}`);
  }
}
const truthKinds = {};
for (const r of rows.filter((x) => x.truth)) { const k = r.truth.includes(':') ? 'repo-definition' : r.truth; truthKinds[k] = (truthKinds[k] ?? 0) + 1; }
console.log(`\nconsensus answers: ${JSON.stringify(truthKinds)}; no consensus: ${rows.filter((r) => !r.truth).length}`);
const sided = {};
for (const r of rows.filter((x) => x.sided)) sided[r.sided] = (sided[r.sided] ?? 0) + 1;
if (labellers[2]) console.log(`${labellers[2]} on ${labellers[0]}/${labellers[1]} disagreements sided with: ${JSON.stringify(sided)}`);
if (protocol) console.log(`labelling protocol ${protocol.sha256.slice(0, 12)}: ${Object.entries(protocol.labellers).map(([k, v]) => `${k} ${v.qualification ? `${v.qualification.correct}/${v.qualification.answered}` : '-'}`).join(', ')} on qualification`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ labellers, protocol, table: out, sided, rows }, null, 1));
