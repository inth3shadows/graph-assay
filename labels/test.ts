#!/usr/bin/env node
// Hermetic checks for the labelling harness's pure parts: answer parsing, truth rules, the
// candidate shuffle (stable per item, independent of input order) and the Wilson interval.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { correct, parseAnswer, question, unstub } from './questions.ts';
import { noiseGate, wilson } from './score.ts';
import { stratumCounts } from './strata.ts';

let failed = 0; let n = 0;
const check = (name, ok) => { n++; if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`); };
const L = { A: 'a.ts:1', B: 'b.ts:2', X: 'external', Y: 'local', Z: 'cannot-tell' };

check('parse: plain', parseAnswer('{"choice":"B","evidence":"b.ts:2","confidence":"high"}', L)?.answer === 'b.ts:2');
check('parse: braces inside evidence', parseAnswer('{"choice": "X", "evidence": "a.ts:2 ({ p: Map })"}', L)?.answer === 'external');
check('parse: prose before, last object wins', parseAnswer('I think {"choice":"A"} no wait {"choice":"Y"}', L)?.answer === 'local');
check('parse: lowercase letter', parseAnswer('{"choice":"a"}', L)?.answer === 'a.ts:1');
check('parse: unknown letter is null', parseAnswer('{"choice":"Q"}', L) === null);
check('parse: no object is null, and terminates', parseAnswer('{"x": {"y": 1}}', L) === null);
check('truth: exact', correct('a.ts:1', 'a.ts:1') && !correct('b.ts:2', 'a.ts:1'));
check('truth: outside takes external or local', correct('external', 'outside') && correct('local', 'outside') && !correct('a.ts:1', 'outside'));
check('truth: reject', correct('b.ts:2', 'reject:a.ts:1') && !correct('a.ts:1', 'reject:a.ts:1') && !correct('cannot-tell', 'reject:a.ts:1') && correct('external', 'reject:a.ts:1'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-labels-test-'));
fs.writeFileSync(path.join(dir, 'a.ts'), 'export function f() {}\nexport function g() { f(); }\n');
const cands = [{ file: 'a.ts', line: 1 }, { file: 'b.ts', line: 1 }, { file: 'c.ts', line: 1 }];
const item = { id: 'x1', site: { file: 'a.ts', line: 2, name: 'f' }, candidates: cands };
const q1 = question(item, dir); const q2 = question({ ...item, candidates: [...cands].reverse() }, dir);
check('shuffle: independent of input order', JSON.stringify(q1.letters) === JSON.stringify(q2.letters));
check('shuffle: differs across items', [...Array(8)].some((_, i) => JSON.stringify(question({ ...item, id: `y${i}` }, dir).letters) !== JSON.stringify(q1.letters)));
check('prompt: shows the site line, hides nothing it should not', q1.prompt.includes('export function g() { f(); }') && !/codegraph|SCIP|subject/i.test(q1.prompt));
fs.rmSync(dir, { recursive: true, force: true });

const [lo, hi] = wilson(8, 10);
check('wilson: 8/10 ~ [0.49, 0.94]', Math.abs(lo - 0.490) < 0.01 && Math.abs(hi - 0.943) < 0.01);
check('wilson: 0/0 is [0, 1]', JSON.stringify(wilson(0, 0)) === '[0,1]');
// Committed snapshots (labels/data/): no home paths, repos relative, and `unstub` answers from the
// precomputed `stubs` without reading a checkout.
const pyStub = { lang: 'python', repo: 'w-none/repo', stubs: { 'a.py:3': 'a.py:9' } };
check('unstub: precomputed stubs, no checkout read', unstub(pyStub, 'a.py:3') === 'a.py:9' && unstub(pyStub, 'a.py:5') === 'a.py:5');
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const snap = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).map((d) => fs.readFileSync(path.join(dataDir, d, 'items.jsonl'), 'utf8')) : [];
check('snapshot: items have relative repos and stubs, no home paths', snap.length > 0 && snap.every((t) => !t.includes('/home/') && t.split('\n').filter(Boolean).every((l) => { const i = JSON.parse(l); return !path.isAbsolute(i.repo) && i.stubs; })));
// SPEC §9 #2: the gate weights each stratum by its share of the tabled run's sites where SCIP answers,
// not by the sample's quotas.
{
  const st = (k, n, consensus = n) => ({ scip: [k, n], consensus });
  const sites = (o) => Object.fromEntries(Object.entries<number>(o).map(([k, v]) => [k, { sites: v, scipSites: v }]));
  // Pooled 78/97 (Wilson lower bound 71%); weighted by 9,000 agree and 500 disagree sites it is 98%.
  const py = noiseGate({ agree: st(50, 50), disagree: st(28, 47) }, sites({ agree: 9000, disagree: 500, 'subject-only': 70 }));
  check('noise gate: strata weighted by the run\'s sites, not the quotas (pooled 78/97 would fail)', !py.diagnostic && Math.abs(py.strata.agree.weight - 9000 / 9500) < 1e-9 && py.lower > 0.85 && py.lower < py.estimate);
  // 785 of 3,319 sites are disagreements, and 2 are labelled: unmeasured.
  const ts = noiseGate({ agree: st(25, 25), disagree: st(1, 2), 'scip-only': st(9, 9) }, sites({ agree: 1644, disagree: 785, 'scip-only': 890 }));
  check('noise gate: a stratum with >= 5% of the weight and < 20 labelled answers is unmeasured', ts.diagnostic && ts.unmeasured.join() === 'disagree,scip-only');
  // N1: the weight is the run's SCIP-answering sites, not the sample's answered fraction: a stratum the
  // sample saw SCIP answer nowhere still carries its run sites, and is unmeasured when heavy.
  const heavy = noiseGate({ agree: st(25, 25), disagree: st(0, 0, 1) }, sites({ agree: 300, disagree: 900 }));
  check('noise gate: a heavy stratum with no labelled answers is unmeasured, never weightless, and leaves no estimate (N1, P3)', heavy.diagnostic && heavy.unmeasured.join() === 'disagree' && heavy.estimate === null && heavy.lower === 0 && heavy.dropped.length === 0 && heavy.strata.disagree.weight === 0.75);
  // SCIP answers at 16 of 855 run disagreements (4.9% of the weight): too light to gate; dropped.
  const js = noiseGate({ agree: st(25, 25), disagree: st(0, 0, 35) }, { agree: { sites: 311, scipSites: 311 }, disagree: { sites: 855, scipSites: 16 }, 'scip-only': { sites: 2, scipSites: 2 } });
  check('noise gate: an unlabelled stratum under 5% of the weight is dropped', !js.diagnostic && js.dropped.join() === 'disagree,scip-only' && js.estimate === 1);
  check('noise gate: a low rate is diagnostic (28/47 alone)', noiseGate({ agree: st(28, 47) }, sites({ agree: 100 })).diagnostic);
  const none = noiseGate(undefined, sites({ agree: 10 }));
  check('noise gate: a tabled language with no labelled sample is diagnostic', none.diagnostic && !none.labelled && none.estimate === null);
  // N3: the bound is centred on the Agresti-Coull rate, so 87/100 (Wilson lower bound 79.0%) stays diagnostic.
  const ac = noiseGate({ agree: st(87, 100) }, sites({ agree: 50 }));
  check('noise gate: the bound is centred on the Agresti-Coull rate (87/100 is diagnostic) (N3)', ac.diagnostic && Math.abs(ac.lower - (89 / 104 - 1.96 * Math.sqrt((89 / 104) * (15 / 104) / 104))) < 1e-12);
}
// labels/strata.ts: one unit per site and name; both subjects' keys decide its stratum.
{
  const out = (fwd, miss) => ({ fwd: { sites: fwd.map(([site, key]) => ({ site, name: 'f', key })) }, miss: { sites: miss.map(([site, key]) => ({ site, name: 'f', key })) } });
  const counts = stratumCounts([
    out([['a:1', 'ok|x'], ['a:2', 'ok|x'], ['a:3', 'ok|x'], ['a:5', 'no-scip-ref|x'], ['a:6', 'ok|x']], [['a:4', 'missing|no-ref|x']]),
    out([['a:1', 'ok|y'], ['a:2', 'wrong-target|y'], ['a:4', 'ok|y'], ['a:5', 'ok|y']], []),
  ]);
  check('strata: agree, disagree, scip-only, subject-only; a site one subject has no edge at is in none', JSON.stringify(Object.entries(counts).map(([k, c]) => [k, c.sites]).sort()) === JSON.stringify([['agree', 1], ['disagree', 1], ['scip-only', 1], ['subject-only', 1]]));
  // SCIP answers where a record carries its symbol, unless the oracle found a local SCIP never defines.
  const ans = stratumCounts([
    { fwd: { sites: [{ site: 'b:1', name: 'f', key: 'wrong-target|x', scip: 's#' }, { site: 'b:2', name: 'f', key: 'scip-local-undefined|x', scip: 'local 3' }, { site: 'b:3', name: 'f', key: 'external|x' }] }, miss: { sites: [] } },
    { fwd: { sites: [{ site: 'b:1', name: 'f', key: 'ok|y' }, { site: 'b:2', name: 'f', key: 'ok|y' }, { site: 'b:3', name: 'f', key: 'ok|y' }] }, miss: { sites: [] } },
  ]);
  check('strata: SCIP-answered sites exclude a local SCIP never defines and a site with no symbol', ans.disagree.sites === 3 && ans.disagree.scipSites === 1);
}
// noise.ts: a later sample's meta.json retires a language from an earlier sample when pooling.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-noise-'));
  const mk = (dir, items, answer, meta?) => {
    fs.mkdirSync(path.join(tmp, dir));
    fs.writeFileSync(path.join(tmp, dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    for (const l of ['opus', 'sol']) fs.writeFileSync(path.join(tmp, dir, `${l}.jsonl`), items.map((i) => JSON.stringify({ id: i.id, ok: true, answer, model: 'm', deployment: 'm', served_by: ['m'] })).join('\n') + '\n');
    if (meta) fs.writeFileSync(path.join(tmp, dir, 'meta.json'), JSON.stringify(meta));
  };
  const item = (id, lang) => ({ id, lang, stratum: 'agree', candidates: [], meta: { target: 't', scip: 'a.js:1', sources: {} } });
  mk('old', [item('o1', 'javascript'), item('o2', 'typescript')], 'b.js:2');
  mk('new', [item('n1', 'javascript')], 'a.js:1', { supersedes: { old: ['javascript'] } });
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'noise.ts'), path.join(tmp, 'old', 'items.jsonl'), path.join(tmp, 'old'), path.join(tmp, 'new', 'items.jsonl'), path.join(tmp, 'new'), '--labellers', 'opus,sol', '--json', path.join(tmp, 'n.json')], { encoding: 'utf8' });
  const t = r.status === 0 ? JSON.parse(fs.readFileSync(path.join(tmp, 'n.json'), 'utf8')).table : {};
  check('noise: meta.json supersedes a language of an earlier sample', JSON.stringify(t.javascript?.ALL.scip) === '[1,1]' && t.javascript?.ALL.items === 1 && t.typescript?.ALL.items === 1);
  fs.rmSync(tmp, { recursive: true, force: true });
}
// SPEC §9: the labelling protocol pins the prompt, the models and every committed labelling file.
{
  const { loadProtocol, promptTemplateSha256 } = await import('./protocol.ts');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const good = loadProtocol();
  check(`protocol: labels/protocol.json matches the prompt, labellers.ts and every labelling file${good.problems.length ? ` (${good.problems.join('; ')})` : ''}`, good.problems.length === 0);
  check('protocol: qualification items have relative repos, no home paths', fs.readFileSync(path.join(here, 'qualification', 'items.jsonl'), 'utf8').split('\n').filter(Boolean).every((l) => !l.includes('/home/') && !path.isAbsolute(JSON.parse(l).repo)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-protocol-'));
  const bad = JSON.parse(fs.readFileSync(path.join(here, 'protocol.json'), 'utf8'));
  bad.files['labels/data/v1/opus.jsonl'] = '0'.repeat(64);
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify(bad));
  check('protocol: a file changed after pinning is a problem', loadProtocol(path.join(tmp, 'p.json')).problems.some((x) => x.includes('labels/data/v1/opus.jsonl')));
  check('protocol: the prompt hash is the template, not the item', promptTemplateSha256() === good.protocol.prompt.templateSha256);
  const noise = (proto) => spawnSync(process.execPath, [path.join(here, 'noise.ts'), path.join(here, 'data/v1/items.jsonl'), path.join(here, 'data/v1'), '--protocol', proto, '--json', path.join(tmp, 'n.json')], { encoding: 'utf8' });
  const ok = noise(path.join(here, 'protocol.json'));
  const rec = ok.status === 0 ? JSON.parse(fs.readFileSync(path.join(tmp, 'n.json'), 'utf8')).protocol : null;
  check('noise: --protocol records the protocol hash and qualification accuracy', rec?.sha256 === good.sha256 && rec.labellers.opus.qualification.answered === 54);
  check('noise: a protocol that does not match the data stops the run', noise(path.join(tmp, 'p.json')).status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${n - failed}/${n} labelling checks`);
process.exit(failed ? 1 : 0);
