#!/usr/bin/env node
// Hermetic checks for the labelling harness's pure parts: answer parsing, truth rules, the
// candidate shuffle (stable per item, independent of input order) and the Wilson interval.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { correct, parseAnswer, question, unstub } from './questions.mjs';
import { diagnosticLanguages, wilson } from './score.mjs';

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
const diag = diagnosticLanguages({ javascript: { ALL: { scip: [28, 47] } }, typescript: { ALL: { scip: [35, 36] } }, go: { ALL: { scip: [0, 0] } } });
check('diagnostic: 28/47 (lower bound 45%) is diagnostic, 35/36 is not, no answers is', diag.has('javascript') && !diag.has('typescript') && diag.has('go') && Math.abs(diag.get('javascript').lower - 0.453) < 0.01);
// noise.mjs: a later sample's meta.json retires a language from an earlier sample when pooling.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-noise-'));
  const mk = (dir, items, answer, meta) => {
    fs.mkdirSync(path.join(tmp, dir));
    fs.writeFileSync(path.join(tmp, dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    for (const l of ['opus', 'sol']) fs.writeFileSync(path.join(tmp, dir, `${l}.jsonl`), items.map((i) => JSON.stringify({ id: i.id, ok: true, answer, model: 'm', deployment: 'm', served_by: ['m'] })).join('\n') + '\n');
    if (meta) fs.writeFileSync(path.join(tmp, dir, 'meta.json'), JSON.stringify(meta));
  };
  const item = (id, lang) => ({ id, lang, stratum: 'agree', candidates: [], meta: { target: 't', scip: 'a.js:1', sources: {} } });
  mk('old', [item('o1', 'javascript'), item('o2', 'typescript')], 'b.js:2');
  mk('new', [item('n1', 'javascript')], 'a.js:1', { supersedes: { old: ['javascript'] } });
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'noise.mjs'), path.join(tmp, 'old', 'items.jsonl'), path.join(tmp, 'old'), path.join(tmp, 'new', 'items.jsonl'), path.join(tmp, 'new'), '--labellers', 'opus,sol', '--json', path.join(tmp, 'n.json')], { encoding: 'utf8' });
  const t = r.status === 0 ? JSON.parse(fs.readFileSync(path.join(tmp, 'n.json'), 'utf8')).table : {};
  check('noise: meta.json supersedes a language of an earlier sample', JSON.stringify(t.javascript?.ALL.scip) === '[1,1]' && t.javascript?.ALL.items === 1 && t.typescript?.ALL.items === 1);
  fs.rmSync(tmp, { recursive: true, force: true });
}
// SPEC §9: the labelling protocol pins the prompt, the models and every committed labelling file.
{
  const { loadProtocol, promptTemplateSha256 } = await import('./protocol.mjs');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const good = loadProtocol();
  check(`protocol: labels/protocol.json matches the prompt, labellers.mjs and every labelling file${good.problems.length ? ` (${good.problems.join('; ')})` : ''}`, good.problems.length === 0);
  check('protocol: qualification items have relative repos, no home paths', fs.readFileSync(path.join(here, 'qualification', 'items.jsonl'), 'utf8').split('\n').filter(Boolean).every((l) => !l.includes('/home/') && !path.isAbsolute(JSON.parse(l).repo)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-protocol-'));
  const bad = JSON.parse(fs.readFileSync(path.join(here, 'protocol.json'), 'utf8'));
  bad.files['labels/data/v1/opus.jsonl'] = '0'.repeat(64);
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify(bad));
  check('protocol: a file changed after pinning is a problem', loadProtocol(path.join(tmp, 'p.json')).problems.some((x) => x.includes('labels/data/v1/opus.jsonl')));
  check('protocol: the prompt hash is the template, not the item', promptTemplateSha256() === good.protocol.prompt.templateSha256);
  const noise = (proto) => spawnSync(process.execPath, [path.join(here, 'noise.mjs'), path.join(here, 'data/v1/items.jsonl'), path.join(here, 'data/v1'), '--protocol', proto, '--json', path.join(tmp, 'n.json')], { encoding: 'utf8' });
  const ok = noise(path.join(here, 'protocol.json'));
  const rec = ok.status === 0 ? JSON.parse(fs.readFileSync(path.join(tmp, 'n.json'), 'utf8')).protocol : null;
  check('noise: --protocol records the protocol hash and qualification accuracy', rec?.sha256 === good.sha256 && rec.labellers.opus.qualification.answered === 54);
  check('noise: a protocol that does not match the data stops the run', noise(path.join(tmp, 'p.json')).status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${n - failed}/${n} labelling checks`);
process.exit(failed ? 1 : 0);
