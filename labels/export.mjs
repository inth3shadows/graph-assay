#!/usr/bin/env node
// Freeze a labelled sample into a committed snapshot (labels/data/<name>/) so the oracle-noise
// numbers can be recomputed without the labellers or the repo checkouts:
//   items.jsonl     the sample; `repo` relative to the oracle work dir (no home paths), plus
//                   `stubs`: each Python `@overload` stub answer mapped to its implementation
//                   (SPEC §4), precomputed here because `unstub` otherwise reads the checkout
//   <labeller>.jsonl  the last ok answer per item, for each labeller that answered
// Usage: node labels/export.mjs <sample.jsonl> <answers dir> <dest dir> [--labellers opus,sol,astra]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.mjs';
import { unstub } from './questions.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const labellers = opt('--labellers', 'opus,sol,astra').split(',');
const [sampleFile, answersDir, dest] = args;
if (!sampleFile || !answersDir || !dest) { console.error('usage: export.mjs <sample.jsonl> <answers dir> <dest dir> [--labellers a,b,c]'); process.exit(2); }
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

fs.mkdirSync(dest, { recursive: true });
const items = readJsonl(sampleFile).map((item) => {
  const answers = new Set([...item.candidates.map((c) => `${c.file}:${c.line}`), item.meta.scip, ...Object.keys(item.meta.sources ?? {})].filter(Boolean));
  const stubs = {};
  for (const a of answers) { const u = unstub(item, a); if (u !== a) stubs[a] = u; }
  const repo = path.relative(config.work, item.repo);
  if (repo.startsWith('..')) throw new Error(`${item.id}: repo ${item.repo} is outside the oracle work dir ${config.work}`);
  return { ...item, repo, stubs };
});
fs.writeFileSync(path.join(dest, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
const ids = new Set(items.map((i) => i.id));
const counts = {};
for (const l of labellers) {
  const file = path.join(answersDir, `${l}.jsonl`);
  if (!fs.existsSync(file)) continue;
  const last = new Map();
  for (const r of readJsonl(file)) if (r.ok && ids.has(r.id)) last.set(r.id, r);
  fs.writeFileSync(path.join(dest, `${l}.jsonl`), [...last.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  counts[l] = last.size;
}
console.log(`${items.length} items, ${items.filter((i) => Object.keys(i.stubs).length).length} with overload stubs; answers ${JSON.stringify(counts)} -> ${dest}`);
