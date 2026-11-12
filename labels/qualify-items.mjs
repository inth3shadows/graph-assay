#!/usr/bin/env node
// Known-answer items for labeller qualification, from the oracle-candidate fixtures: each fixture's
// `right` edges are human-confirmed truth (an upstream issue and its fix), its `wrong` edges are
// the distractors a code graph actually produced. A fixture with `right: []` asserts only that the
// wrong targets are wrong (the call may reach an interface member, a local, or a library):
// truth `reject:<file>:<line>,...` (any answer but those, and not `cannot tell`).
//
// Usage: node labels/qualify-items.mjs <codegraph.js> > items.jsonl
// codegraph is used only to find node spans (caller span, definition lines); the truth comes from
// expect.json, never from codegraph's edges.
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chainMatch, definedNames } from '../lib/expect.ts';
import { copySeed } from '../lib/fixture-install.ts';
import * as codegraph from '../lib/subjects/codegraph.ts';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(qa, 'fixtures/oracle-candidates');
const [build] = process.argv.slice(2);
if (!build) { console.error('usage: qualify-items.mjs <codegraph.js>'); process.exit(2); }
const LANG = { '.py': 'python', '.ts': 'ts', '.tsx': 'ts', '.js': 'ts', '.mjs': 'ts', '.go': 'go', '.java': 'jvm', '.kt': 'jvm', '.php': 'php' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let skipped = 0;
for (const fx of fs.readdirSync(root).sort()) {
  const ef = path.join(root, fx, 'expect.json');
  if (!fs.existsSync(ef)) continue;
  const expect = JSON.parse(fs.readFileSync(ef, 'utf8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-qual-'));
  try {
    copySeed(path.join(root, fx), work, (p) => !p.includes('.codegraph'));
    if (!codegraph.index(work, build).ok) { skipped++; continue; }
    const snap = codegraph.snapshot(work);
    const defined = definedNames(snap);
    const defs = snap.nodes.filter((n) => n.kind !== 'file');
    const files = new Map(snap.nodes.filter((n) => n.kind === 'file').map((n) => [n.file, n]));
    const node = (spec) => { // "<file>:<chain>" target spec, toLine
      const cut = spec.to.indexOf(':'); const file = spec.to.slice(0, cut); const chain = spec.to.slice(cut + 1);
      return defs.find((n) => n.file === file && chainMatch(n.qname ?? n.name, chain, defined(n.file)) && (!spec.toLine || n.start === spec.toLine));
    };
    const callers = (from, fromFile) => [...defs, ...files.values()].filter((n) => chainMatch(n.qname ?? n.name, from, defined(n.file)) && (!fromFile || n.file === fromFile));
    // one item per (caller, called name): the right target is the truth, wrong targets and every
    // same-named definition are the candidates
    const groups = new Map();
    for (const x of [...expect.right.map((e) => ({ ...e, right: true })), ...expect.wrong.map((e) => ({ ...e, right: false }))]) {
      const t = node(x);
      if (!t) continue;
      const g = `${x.from}|${x.fromFile ?? ''}|${t.name}`;
      if (!groups.has(g)) groups.set(g, { x, name: t.name, right: null, wrong: [] });
      if (x.right) groups.get(g).right = t; else groups.get(g).wrong.push(t);
    }
    for (const [g, v] of groups) {
      if (expect.right.length && !v.right) continue; // a wrong edge whose right counterpart has another name
      const src = callers(v.x.from, v.x.fromFile);
      if (src.length !== 1) { skipped++; continue; }
      const s = src[0];
      const lines = fs.readFileSync(path.join(work, s.file), 'utf8').split('\n');
      const re = new RegExp(`(^|[^\\w$])${esc(v.name)}\\s*(\\(|<|\\.call\\(|\\.apply\\()|\\bnew\\s+${esc(v.name)}\\b`);
      const hits = [];
      for (let l = s.start; l <= Math.min(s.end, lines.length); l++) if (re.test(lines[l - 1]) && !/^\s*(def|function|class|async def)\s/.test(lines[l - 1])) hits.push(l);
      if (hits.length !== 1) { skipped++; continue; }
      const same = defs.filter((n) => n.name === v.name);
      const cands = [...new Map([v.right, ...v.wrong, ...same].filter(Boolean).map((n) => [`${n.file}:${n.start}`, { file: n.file, line: n.start, kind: n.kind, name: n.name }])).values()];
      console.log(JSON.stringify({
        id: `qual:${fx}:${g}`, lang: LANG[path.extname(s.file)] ?? 'other', repo: path.join(root, fx),
        site: { file: s.file, line: hits[0], name: v.name }, candidates: cands,
        truth: v.right ? `${v.right.file}:${v.right.start}` : `reject:${v.wrong.map((n) => `${n.file}:${n.start}`).join(',')}`, stratum: 'qualification', meta: { fixture: fx, issue: expect.issue },
      }));
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
console.error(`skipped ${skipped}`);
