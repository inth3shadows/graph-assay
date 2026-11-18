#!/usr/bin/env node
// Adapter conformance: index the awkward-case corpus (conformance/<lang>/) with a subject build, export
// the snapshot through the subject's adapter, and
//   FAIL when the adapter is unfaithful: an invalid snapshot, counts (and, for code-graph-rag, edge
//        endpoints, lines and columns) that differ from what the subject's own output holds, a call
//        edge without a site line when the adapter claims site lines, a declared column encoding the
//        columns do not use, a corpus file with no definition in the snapshot (a build that parsed
//        nothing is not conformant);
//   REPORT what the subject does with the awkward cases (facts about the subject, which scorers must
//        handle, not adapter bugs): which corpus definitions it extracted, two calls of one callee on a
//        line, a call to an overloaded function, calls inside anonymous functions, and which unit its
//        columns use.
//
// Usage: node lib/conformance.ts [--subject <name>] <build | default>   (subject default codegraph;
//        exit 1 on any FAIL)
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinedEdges, validateSnapshot } from './snapshot.ts';
import { buildFor, subject, SUBJECTS } from './subjects/index.ts';
import * as sandbox from './sandbox.ts';
import type { Snapshot } from './types.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const at = args.indexOf('--subject');
const name = at >= 0 ? args.splice(at, 2)[1] : 'codegraph';
const usage = () => { console.error(`usage: node lib/conformance.ts [--subject ${Object.keys(SUBJECTS).join('|')}] <build | default>`); process.exit(2); };
// hasOwn, not subject(): `__proto__` and friends are not subjects
if (!name || !Object.hasOwn(SUBJECTS, name) || args.length !== 1) usage();
const subj = subject(name);
const build = buildFor(subj, args[0]);
if (!fs.existsSync(build)) { console.error(`build not found: ${build}`); process.exit(2); }

/**
 * What the subject's own output holds: [what, in the subject's output, exported]. Each counts the records
 * the adapter documents it keeps (so it catches a dropped record, not a wrong filter); a subject with no
 * entry gets no count check, and its verdict says so.
 */
const STORE: Record<string, (dir: string, snap: Snapshot) => [string, number, number][]> = {
  codegraph: (dir, snap) => {
    const db = new DatabaseSync(path.join(dir, '.codegraph/codegraph.db'), { readOnly: true });
    try {
      const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
      return [['nodes', count('nodes'), snap.nodes.length], ['edges', count('edges'), snap.edges.length], ['unresolved', count('unresolved_refs'), snap.unresolved.length]];
    } finally { db.close(); }
  },
  // lib/subjects/code-graph-rag.ts keeps a node with a path in the repo that is not a Project, Folder,
  // Package, File or External* node (a Module becomes the file node), and every relationship between
  // two kept nodes; File nodes become `files`.
  'code-graph-rag': (dir, snap) => {
    const g = JSON.parse(fs.readFileSync(sandbox.confined(dir, path.join(dir, '.graph-assay/export.json')), 'utf8'));
    const kept = new Set(g.nodes.filter((n) => n.properties?.path && !['Project', 'Folder', 'Package', 'File'].includes(n.labels[0])
      && !n.labels[0].startsWith('External')).map((n) => String(n.node_id)));
    const rels = g.relationships.filter((r) => kept.has(String(r.from_id)) && kept.has(String(r.to_id))).length;
    const files = g.nodes.filter((n) => n.labels.includes('File') && n.properties?.path).length;
    return [['nodes', kept.size, snap.nodes.length], ['edges', rels, snap.edges.length], ['files', files, snap.files.length]];
  },
};

/** Edges as the subject's output holds them and as exported, keyed by endpoints, line and column, where
 * conformance reads them (code-graph-rag keeps its node ids as snapshot ids). */
const EDGES: Record<string, (dir: string, snap: Snapshot) => [string[], string[]]> = {
  'code-graph-rag': (dir, snap) => {
    const g = JSON.parse(fs.readFileSync(sandbox.confined(dir, path.join(dir, '.graph-assay/export.json')), 'utf8'));
    const ids = new Set(snap.nodes.map((n) => n.id));
    const raw = g.relationships.filter((r) => ids.has(String(r.from_id)) && ids.has(String(r.to_id)))
      .map((r) => JSON.stringify([String(r.from_id), String(r.to_id), r.properties?.line ?? null, r.properties?.col ?? null]));
    return [raw.sort(), snap.edges.map((e) => JSON.stringify([e.src, e.dst, e.line, e.col])).sort()];
  },
};
let counted = true;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-conf-'));
let fails = 0;
const fail = (m: string) => { fails++; console.log(`FAIL    ${m}`); };
const pass = (m: string) => console.log(`ok      ${m}`);
const report = (m: string) => console.log(`report  ${m}`);

/** Index conformance/<lang> in a fresh copy and check the adapter; returns the snapshot and the dir, or null. */
function run(lang: string) {
  const dir = path.join(work, lang);
  fs.cpSync(path.join(qa, 'conformance', lang), dir, { recursive: true });
  const r = subj.index(dir, build);
  if (!r.ok) { fail(`${lang}: index failed: ${r.output.trim().split('\n').slice(-3).join(' | ')}`); return null; }
  const snap: Snapshot = subj.snapshot(dir, { build });
  const problems = validateSnapshot(snap);
  if (problems.length) { fail(`${lang}: snapshot invalid: ${problems.join('; ')}`); return null; } // edges may not join
  pass(`${lang}: snapshot validates`);
  if (STORE[name]) for (const [what, store, out] of STORE[name](dir, snap)) {
    (store === out ? pass : fail)(`${lang}: ${what}: ${store} in ${name}'s output, ${out} exported`);
  } else { counted = false; report(`${lang}: no count check for ${name} (conformance does not read its store)`); }
  if (EDGES[name]) {
    const [raw, out] = EDGES[name](dir, snap);
    const diff = raw.filter((k, i) => k !== out[i]);
    raw.length === out.length && !diff.length ? pass(`${lang}: all ${out.length} edges keep their endpoints, line and column`)
      : fail(`${lang}: edges differ from ${name}'s output (endpoints, line or column), e.g. ${diff[0] ?? out[raw.length]}`);
  }
  // every corpus source defines something: a file without a definition was not parsed
  const corpus = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !f.startsWith('.'));
  const parsed = new Set(snap.nodes.filter((n) => n.kind !== 'file').map((n) => n.file));
  const missing = corpus.filter((f) => !parsed.has(f.split(path.sep).join('/')));
  missing.length ? fail(`${lang}: corpus files with no definition in the snapshot: ${missing.join(', ')}`) : pass(`${lang}: every corpus file has a definition in the snapshot`);
  const calls = joinedEdges(snap).filter((e) => e.kind === 'calls' || e.kind === 'instantiates');
  const noLine = calls.filter((e) => e.line == null);
  if (snap.capabilities.siteLines) noLine.length ? fail(`${lang}: ${noLine.length} call edges without a site line`) : pass(`${lang}: all ${calls.length} call edges carry a site line`);
  else report(`${lang}: the adapter claims no site lines (${calls.length - noLine.length} of ${calls.length} call edges have one)`);
  return { snap, dir, calls };
}

/** Report the column unit an edge's `col` matches at `needle` on 1-based line `n` of `file`, and FAIL when
 * the adapter declares an encoding (other than unknown) its columns do not use. */
function unit(snap: Snapshot, dir: string, file: string, n: number, needle: string, col: number | null) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')[n - 1] ?? '';
  const i = text.indexOf(needle);
  if (i < 0) { fail(`${file}:${n}: '${needle}' not found (the corpus changed?)`); return; }
  const before = text.slice(0, i);
  const units = { utf16: before.length, codepoint: [...before].length, utf8: Buffer.byteLength(before) };
  const match = Object.entries(units).filter(([, v]) => v === col).map(([k]) => k);
  const declared = snap.capabilities.columnEncoding ?? null;
  report(`column unit (${file}:${n}, after '😀é'): col ${col ?? '-'}; utf16 ${units.utf16}, codepoint ${units.codepoint}, utf8 ${units.utf8} -> ${match.join('/') || 'none'}; declared ${declared ?? '-'}`);
  if (col != null && declared && declared !== 'unknown' && !match.includes(declared)) fail(`${file}:${n}: columns are ${match.join('/') || 'none'}, but the adapter declares ${declared}`);
}

const defs = (snap: Snapshot, want: [string, string][]) => {
  const have = want.filter(([file, n]) => snap.nodes.some((x) => x.file === file && x.kind !== 'file' && x.name === n));
  return `${have.length} of ${want.length}${have.length < want.length ? ` (missing ${want.filter((w) => !have.includes(w)).map(([f, n]) => `${f}:${n}`).join(', ')})` : ''}`;
};

console.log(`subject ${name}, build ${build}`);
try {
  const ts = run('ts');
  if (ts) {
    const { snap, dir, calls } = ts;
    report(`ts: definitions extracted: ${defs(snap, [['dup.ts', 'g'], ['dup.ts', 'twice'], ['overload.ts', 'pick'], ['overload.ts', 'usePick'], ['anon.ts', 'viaArrow'], ['anon.ts', 'viaCallback'], ['unicode.ts', 'emoji']])}`);
    const twice = calls.filter((e) => e.sfile === 'dup.ts' && e.line === 6 && e.tname === 'g');
    report(`two calls of g on one line (dup.ts:6): ${twice.length} edge(s), columns ${twice.map((e) => e.col).join(', ') || '-'}`);
    const pick = calls.filter((e) => e.sfile === 'overload.ts' && e.tname === 'pick');
    report(`call to an overloaded function (overload.ts:8): ${pick.length} edge(s) -> start line(s) ${pick.map((e) => e.tstart).join(', ') || '-'}`);
    const anon = calls.filter((e) => e.sfile === 'anon.ts' && e.tname === 'g');
    report(`calls inside anonymous functions (anon.ts): ${anon.length} edge(s), from ${anon.map((e) => `${e.skind} ${e.sname}@${e.line}`).join('; ') || '-'}`);
    const u = calls.find((e) => e.sfile === 'unicode.ts' && e.tname === 'g');
    unit(snap, dir, 'unicode.ts', 4, 'g(s.length)', u?.col ?? null);
  }
  // Python: the same column question, from the subject's Python extractor.
  const py = run('py');
  if (py) {
    report(`py: definitions extracted: ${defs(py.snap, [['unicode.py', 'g'], ['unicode.py', 'emoji']])}`);
    const pe = py.calls.find((e) => e.kind === 'calls' && e.tname === 'g');
    unit(py.snap, py.dir, 'unicode.py', 6, 'g(len(s))', pe?.col ?? null);
  }
} finally {
  sandbox.remove(work); // the tool's output dir may hold a tree it made unreadable
}
console.log(fails ? `${fails} conformance failure(s)` : `adapter conformant${counted ? '' : ' (no count check against its own output)'}`);
process.exit(fails ? 1 : 0);
