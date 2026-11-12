#!/usr/bin/env node
// Adapter conformance: index conformance/<lang>/ with a subject build, export the snapshot, and
//   FAIL when the adapter is unfaithful: invalid snapshot, counts that differ from the subject's own
//        store, a call edge without a site line, an edge endpoint that is not a node;
//   REPORT what the subject does with the awkward cases (they are facts about the subject, which
//        scorers must handle, not adapter bugs): two calls of one callee on a line, a call to an
//        overloaded function, calls inside anonymous functions, and which unit its columns use.
//
// Usage: node lib/conformance.mjs <codegraph.js>      (exit 1 on any FAIL)
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinedEdges, validateSnapshot } from './snapshot.mjs';
import * as codegraph from './subjects/codegraph.mjs';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [build] = process.argv.slice(2);
if (!build || !fs.existsSync(build)) { console.error('usage: node lib/conformance.mjs <codegraph.js>'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-conf-'));
let fails = 0;
const fail = (m) => { fails++; console.log(`FAIL    ${m}`); };
const pass = (m) => console.log(`ok      ${m}`);
const report = (m) => console.log(`report  ${m}`);
try {
  const dir = path.join(work, 'ts');
  fs.cpSync(path.join(qa, 'conformance/ts'), dir, { recursive: true });
  const r = codegraph.index(dir, build);
  if (!r.ok) throw new Error(`index failed: ${r.output.trim().split('\n').slice(-3).join(' | ')}`);
  const snap = codegraph.snapshot(dir, { build });

  const problems = validateSnapshot(snap);
  problems.length ? fail(`snapshot invalid: ${problems.join('; ')}`) : pass('snapshot validates');
  const db = new DatabaseSync(path.join(dir, '.codegraph/codegraph.db'), { readOnly: true });
  const count = (t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  for (const [t, k] of [['nodes', 'nodes'], ['edges', 'edges'], ['unresolved_refs', 'unresolved']]) {
    const n = count(t);
    n === snap[k].length ? pass(`${k}: ${n} in the store, ${snap[k].length} exported`) : fail(`${k}: ${n} in the store, ${snap[k].length} exported`);
  }
  db.close();
  const edges = joinedEdges(snap);
  const calls = edges.filter((e) => e.kind === 'calls' || e.kind === 'instantiates');
  const noLine = calls.filter((e) => e.line == null);
  noLine.length ? fail(`${noLine.length} call edges without a site line`) : pass(`all ${calls.length} call edges carry a site line`);

  // Facts about the subject.
  const twice = calls.filter((e) => e.sfile === 'dup.ts' && e.line === 6 && e.tname === 'g');
  report(`two calls of g on one line (dup.ts:6): ${twice.length} edge(s), columns ${twice.map((e) => e.col).join(', ') || '-'}`);
  const pick = calls.filter((e) => e.sfile === 'overload.ts' && e.tname === 'pick');
  report(`call to an overloaded function (overload.ts:8): ${pick.length} edge(s) -> start line(s) ${pick.map((e) => e.tstart).join(', ') || '-'}`);
  const anon = calls.filter((e) => e.sfile === 'anon.ts' && e.tname === 'g');
  report(`calls inside anonymous functions (anon.ts): ${anon.length} edge(s), from ${anon.map((e) => `${e.skind} ${e.sname}@${e.line}`).join('; ') || '-'}`);
  const text = fs.readFileSync(path.join(dir, 'unicode.ts'), 'utf8').split('\n')[3];
  const at = text.indexOf('g(s.length)');
  const units = { utf16: at, codepoint: [...text.slice(0, at)].length, utf8: Buffer.byteLength(text.slice(0, at)) };
  const u = calls.find((e) => e.sfile === 'unicode.ts' && e.tname === 'g');
  const match = u ? Object.entries(units).filter(([, v]) => v === u.col).map(([k]) => k) : [];
  report(`column unit (unicode.ts:4, after '😀é'): col ${u?.col ?? '-'}; utf16 ${units.utf16}, codepoint ${units.codepoint}, utf8 ${units.utf8} -> ${match.join('/') || 'none'}`);

  // Python: the same column question, from its own extractor.
  const pdir = path.join(work, 'py');
  fs.cpSync(path.join(qa, 'conformance/py'), pdir, { recursive: true });
  const pr = codegraph.index(pdir, build);
  if (!pr.ok) fail(`python index failed: ${pr.output.trim().split('\n').slice(-2).join(' | ')}`);
  else {
    const psnap = codegraph.snapshot(pdir, { build });
    const ptext = fs.readFileSync(path.join(pdir, 'unicode.py'), 'utf8').split('\n')[5];
    const pat = ptext.indexOf('g(len(s))');
    const pu = { utf16: pat, codepoint: [...ptext.slice(0, pat)].length, utf8: Buffer.byteLength(ptext.slice(0, pat)) };
    const pe = joinedEdges(psnap).find((e) => e.kind === 'calls' && e.tname === 'g');
    const pm = pe ? Object.entries(pu).filter(([, v]) => v === pe.col).map(([k]) => k) : [];
    report(`column unit (unicode.py:6, after '😀é'): col ${pe?.col ?? '-'}; utf16 ${pu.utf16}, codepoint ${pu.codepoint}, utf8 ${pu.utf8} -> ${pm.join('/') || 'none'}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(fails ? `${fails} conformance failure(s)` : 'adapter conformant');
process.exit(fails ? 1 : 0);
