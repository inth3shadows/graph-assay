#!/usr/bin/env node
// Hermetic checks for the modes differential's comparison (no codegraph needed): a frozen
// self-test snapshot must compare equal to itself after id renumbering and row shuffling, and
// each single-field mutation must be reported in the right category.
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonical, diffCanonical } from './modes.ts';
import { lineDiff } from './shadow.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(here, '..', 'oracle/test/ts-forward/snapshot.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));

// Same graph, different ids and row order.
function renumber(s) {
  const map = new Map(s.nodes.map((n, i) => [n.id, `r${s.nodes.length - i}`]));
  s.nodes = s.nodes.map((n) => ({ ...n, id: map.get(n.id) })).reverse();
  s.edges = s.edges.map((e) => ({ ...e, src: map.get(e.src), dst: map.get(e.dst) })).reverse();
  s.unresolved = s.unresolved.map((u) => ({ ...u, src: u.src == null ? null : map.get(u.src) })).reverse();
  return s;
}

const cases: [string, (s: any) => void, string[]][] = [
  ['renumbered + reordered', (s) => renumber(s), []],
  ['edge line moved', (s) => { s.edges[0].line += 1; }, ['edges']],
  ['edge duplicated', (s) => { s.edges.push({ ...s.edges[0] }); }, ['edges']],
  ['edge retargeted', (s) => { const e = s.edges.find((x) => x.dst !== s.edges[0].dst); s.edges[0].dst = e.dst; }, ['edges']],
  ['edge dropped', (s) => { s.edges.pop(); }, ['edges']],
  ['edge provenance', (s) => { s.edges[0].provenance = 'mutated'; }, ['edges']],
  // a caller no edge targets: joined edges carry both spans, so its edges change with it
  ['node span', (s) => { s.nodes.find((x) => s.edges.some((e) => e.src === x.id) && !s.edges.some((e) => e.dst === x.id)).end += 1; }, ['edges', 'names', 'nodes']],
  // SPEC §2: a rename keeps the node's identity, so its edges do not move
  ['node renamed', (s) => { const x = s.nodes.find((n) => s.edges.some((e) => e.dst === n.id)); x.name += '_r'; x.qname = `${x.qname ?? x.name}_r`; }, ['names']],
  ['edge ref', (s) => { const e = s.edges.find((x) => x.ref); e.ref += '_r'; }, ['edges']],
  ['unresolved dropped', (s) => { s.unresolved.pop(); }, ['unresolved']],
  ['file language', (s) => { s.files[0].language = 'mutated'; }, ['files']],
];

let failed = 0;
for (const [name, mutate, want] of cases) {
  const s = clone();
  mutate(s);
  const got = Object.keys(diffCanonical(canonical(base), canonical(s))).sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(24)} ${got.join(',') || '(equal)'}`);
}
// shadow.ts's line diff: applying it must turn a into b, and equal texts give no changes.
const texts = [['a\nb\nc', 'a\nb\nc'], ['a\nb\nc', 'a\nx\nc'], ['', 'a\nb'], ['a\nb', ''], ['x\na\nb', 'a\nb\ny']];
let n = cases.length;
for (const [a, b] of texts) {
  n++;
  const d = lineDiff(a, b);
  const side = (keep) => d.filter((l) => l[0] === ' ' || l[0] === keep).map((l) => l.slice(1)).join('\n');
  const ok = side('-') === a && side('+') === b && (a !== b || d.every((l) => l[0] === ' '));
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  lineDiff ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}
console.log(`${n - failed}/${n} comparison checks`);
process.exit(failed ? 1 : 0);
