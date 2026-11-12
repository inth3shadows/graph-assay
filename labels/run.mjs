#!/usr/bin/env node
// Ask labellers about every item; resumable (an item already answered is skipped).
// Usage: GRAPH_ASSAY_LABEL_SANDBOX=1 node labels/run.mjs <items.jsonl> <out dir> [--labellers opus,sol] [--jobs 4] [--limit N] [--tiebreak a,b] [--unsafe-host]
// --tiebreak a,b: ask only items where labellers a and b both answered and disagree (overload stubs
// read as their implementation), so a third labeller decides a 2-of-3 consensus without labelling all.
// Every labeller is probed first and refused if it could reach anything beyond its read-only
// repo tools. Output: <out dir>/<labeller>.jsonl, one {id, labeller, ok, choice, answer,
// evidence, confidence, served_by, error, ms} per item, plus <out dir>/probe-<labeller>.json.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LABELLERS, probe } from './labellers.mjs';
import { parseAnswer, question, repoCopy, repoOf, unstub } from './questions.mjs';

const args = process.argv.slice(2);
// Labellers read untrusted repository text with file-reading tools; a prompt injection there could
// steer them to read other local files. Run them only where that cannot reach anything (a container
// or VM: GRAPH_ASSAY_LABEL_SANDBOX=1), or say explicitly that you accept the risk. SECURITY.md.
const unsafeAt = args.indexOf('--unsafe-host'); if (unsafeAt >= 0) args.splice(unsafeAt, 1);
if (process.env.GRAPH_ASSAY_LABEL_SANDBOX !== '1' && unsafeAt < 0) {
  console.error('labels/run.mjs: refusing to run labellers on this host. Run inside a container or VM with GRAPH_ASSAY_LABEL_SANDBOX=1, or pass --unsafe-host to accept the risk (see SECURITY.md).');
  process.exit(2);
}
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const labellers = opt('--labellers', 'opus,sol').split(',');
const jobs = Number(opt('--jobs', '4'));
if (!Number.isInteger(jobs) || jobs < 1) { console.error('--jobs must be a positive integer'); process.exit(2); }
const limit = Number(opt('--limit', '0'));
const tiebreak = opt('--tiebreak', null)?.split(',');
const [itemsFile, outDir] = args;
if (!itemsFile || !outDir || labellers.some((l) => !LABELLERS[l])) {
  console.error(`usage: run.mjs <items.jsonl> <out dir> [--labellers ${Object.keys(LABELLERS).join(',')}] [--jobs N] [--limit N] [--unsafe-host]`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
let items = fs.readFileSync(itemsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
if (limit) items = items.slice(0, limit);
if (tiebreak) {
  const ans = (l) => new Map(fs.readFileSync(path.join(outDir, `${l}.jsonl`), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((r) => r.ok).map((r) => [r.id, r.answer]));
  const [a, b] = tiebreak.map(ans);
  items = items.filter((i) => a.has(i.id) && b.has(i.id) && unstub(i, a.get(i.id)) !== unstub(i, b.get(i.id)));
  console.error(`tiebreak ${tiebreak.join(' vs ')}: ${items.length} items disagree`);
}

for (const name of labellers) {
  const p = await probe(name);
  fs.writeFileSync(path.join(outDir, `probe-${name}.json`), JSON.stringify(p, null, 1));
  if (!p.ok) { console.error(`${name}: probe FAILED (${p.error ?? `offending tools: ${p.offending.join(', ')}`}); not labelling`); process.exitCode = 1; continue; }
  const file = path.join(outDir, `${name}.jsonl`);
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ok).map((r) => r.id) : []);
  const todo = items.filter((i) => !done.has(i.id));
  console.error(`${name}: probe ok (${p.tools.length} tools); ${todo.length} to ask, ${done.size} done`);
  let next = 0; let n = 0;
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++];
      const repo = repoCopy(repoOf(item));
      const { prompt, letters } = question(item, repo);
      const t0 = Date.now();
      const r = await LABELLERS[name].ask(repo, prompt);
      const a = r.ok ? parseAnswer(r.text, letters) : null;
      const row = { id: item.id, labeller: name, model: LABELLERS[name].model, deployment: LABELLERS[name].deployment, ok: !!a, ...(a ?? {}), served_by: r.served_by ?? [],
        error: r.ok ? (a ? null : `unparsable: ${r.text.slice(0, 200)}`) : r.error, ms: Date.now() - t0, ...(r.cost != null ? { cost: r.cost, tokens: r.tokens } : {}) };
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
      n++;
      console.error(`${name} ${n}/${todo.length} ${row.ok ? row.choice : 'ERR'} ${item.id} ${(row.ms / 1000).toFixed(0)}s${row.error ? ` ${row.error.slice(0, 80)}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}
