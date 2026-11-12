#!/usr/bin/env node
// Score codegraph against PyCG's Python call-graph micro-benchmark (Apache-2.0; fetched, not
// vendored: tools/fetch-benchmarks.sh). Each snippet dir holds Python files and a callgraph.json
// of the edges a call graph must have: {"main.A.f": ["main.B.g", "<builtin>.print"], ...}.
//
// Usage: node benchmarks/pycg.mjs [--subject name] <build | default> [category[/snippet] ...] [--json out.json]
// Guessed edges (any provenance) never count as hits or extras (SPEC §4); an expected edge a guess
// alone would satisfy is reported in its own `guessOnly` column.
//
// A dotted name maps to the file it lives in (longest module prefix: a/b.py or a/b/__init__.py)
// plus a qualified name (`A::f`); a module's own name is that file's top-level code.
// Per snippet:
//   expected  PyCG edges between project names: a module prefix is a .py file in the snippet
//             (builtins, externals and lambdas left out); never depends on what the subject indexed
//   hit       a codegraph calls/instantiates edge from the source node to the target node.
//             `A.__init__` also matches an edge to class A; a decorator matches a `decorates`
//             edge in either direction.
//   extra     codegraph calls/instantiates edges between mapped project nodes that PyCG lacks
// A snippet is PASS when every expected edge is hit and nothing is extra.
import { buildFor, subject } from '../lib/subjects/index.mjs';
import * as fs from 'node:fs';
import { adapterHash } from '../lib/provenance.mjs';
import { SPEC_VERSION } from '../lib/spec.mjs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const ji = args.indexOf('--json');
const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
const si = args.indexOf('--subject');
const subj = subject(si >= 0 ? args.splice(si, 2)[1] : 'codegraph');
const [buildArg, ...only] = args;
const build = buildArg && buildFor(subj, buildArg);
const bench = process.env.PYCG_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'graph-assay/oracle/bench/pycg');
const snippets = path.join(bench, 'micro-benchmark/snippets');
if (!build || !fs.existsSync(build) || !fs.existsSync(snippets)) {
  console.error('usage: node benchmarks/pycg.mjs [--subject name] <build | default> [category[/snippet] ...]  (run tools/fetch-benchmarks.sh first)');
  process.exit(2);
}
const all = fs.readdirSync(snippets).sort().flatMap((c) => fs.readdirSync(path.join(snippets, c)).sort().map((s) => `${c}/${s}`))
  .filter((n) => fs.existsSync(path.join(snippets, n, 'callgraph.json')));
const names = only.length ? all.filter((n) => only.some((o) => n === o || n.startsWith(`${o}/`))) : all;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pycg-'));

// A node's path inside its file: the names of the definitions whose spans contain it, outermost
// first, then its own (`A.f` -> ['A', 'f']). Read from spans, not from the subject's qualified-name
// format, so any subject's snapshot maps the same way.
function nodePaths(nodes) {
  const paths = new Map();
  const byFile = new Map();
  for (const n of nodes) if (n.kind !== 'file' && n.kind !== 'import') (byFile.get(n.file) ?? byFile.set(n.file, []).get(n.file)).push(n);
  for (const list of byFile.values()) {
    list.sort((a, b) => a.start - b.start || b.end - a.end);
    const stack = [];
    for (const n of list) {
      while (stack.length && !(stack[stack.length - 1].start <= n.start && n.end <= stack[stack.length - 1].end && stack[stack.length - 1] !== n)) stack.pop();
      paths.set(n.id, [...stack.map((x) => x.name), n.name]);
      stack.push(n);
    }
  }
  return paths;
}

const results = [];
try {
  for (const name of names) {
    const dir = path.join(work, name.replace('/', '__'));
    fs.cpSync(path.join(snippets, name), dir, { recursive: true, filter: (p) => !/\.codegraph$|callgraph\.json$|README\.md$/.test(p) });
    const cg = JSON.parse(fs.readFileSync(path.join(snippets, name, 'callgraph.json'), 'utf8'));
    // SPEC §9: the expected set comes from PyCG and the snippet's own files, never from what the
    // subject indexed. A dotted name is a project name when a module prefix is a .py file on disk.
    const diskFiles = new Set(fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.py')).map((f) => f.split(path.sep).join('/')));
    const moduleOf = (dotted) => {
      if (dotted.includes('<')) return null;
      const parts = dotted.split('.');
      for (let i = parts.length; i > 0; i--) {
        const mod = parts.slice(0, i).join('/');
        const file = diskFiles.has(`${mod}.py`) ? `${mod}.py` : diskFiles.has(`${mod}/__init__.py`) ? `${mod}/__init__.py` : null;
        if (file) return { file, rest: parts.slice(i) };
      }
      return null;
    };
    const pairs = Object.entries(cg).flatMap(([src, dsts]) => dsts.map((dst) => [src, dst])).filter(([s, t]) => moduleOf(s) && moduleOf(t));
    const r = subj.index(dir, build);
    // SPEC §9: a snippet whose indexing failed counts every expected edge as a miss.
    if (!r.ok) { results.push({ name, error: r.output.trim().split('\n').slice(-2).join(' | '), expected: pairs.length, hit: 0, misses: pairs.map(([s, t]) => `${s} -> ${t} (index failed)`), guessOnly: [], extra: [] }); continue; }
    const snap = subj.snapshot(dir, { build });
    const nodes = snap.nodes.filter((n) => n.language === 'python');
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = snap.edges.filter((e) => ['calls', 'instantiates', 'decorates', 'extends'].includes(e.kind) && nodeIds.has(e.src))
      .map((e) => ({ source: e.src, target: e.dst, kind: e.kind, guessed: e.provenance != null }));
    const paths = nodePaths(nodes);

    // dotted name -> node id; `missing-node:` when the subject has no node for a project name
    // (including a whole file it did not index), null when the name is not a project name.
    const resolve = (dotted) => {
      const m = moduleOf(dotted);
      if (!m) return null;
      const { file, rest } = m;
      if (rest.length === 0) return nodes.find((n) => n.file === file && n.kind === 'file')?.id ?? `missing-node:${dotted}`;
      const same = (p) => p.length === rest.length && p.every((x, k) => x === rest[k]);
      const tail = (p) => p.length > rest.length && rest.every((x, k) => p[p.length - rest.length + k] === x);
      const inFile = nodes.filter((n) => n.file === file && paths.has(n.id));
      return (inFile.find((n) => same(paths.get(n.id))) ?? inFile.find((n) => tail(paths.get(n.id))))?.id ?? `missing-node:${dotted}`;
    };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const label = (id) => { const n = byId.get(id); return n ? (n.kind === 'file' ? n.file.replace(/\.py$/, '') : `${n.file.replace(/\.py$/, '')}:${(paths.get(n.id) ?? [n.name]).join('.')}`) : id; };
    // Module-level code: the subject's source is the file node, or a top-level non-definition node
    // the code sits in (codegraph: the variable an assignment binds, `b = B()` -> variable b).
    const isDef = (n) => /function|method|class|struct|interface/i.test(n.kind);
    const fromIds = (id) => {
      const n = byId.get(id);
      if (!n || n.kind !== 'file') return [id];
      return [id, ...nodes.filter((m) => m.file === n.file && paths.get(m.id)?.length === 1 && !isDef(m)).map((m) => m.id)];
    };
    const has = (s, t, kinds, guessed = false) => edges.some((e) => e.guessed === guessed && fromIds(s).includes(e.source) && e.target === t && kinds.includes(e.kind));
    // classes that are `cls` or inherit from it (through extends edges)
    const subclassesOf = (cls) => {
      const out = new Set([cls]);
      for (let grew = true; grew;) {
        grew = false;
        for (const e of edges) if (e.kind === 'extends' && out.has(e.target) && !out.has(e.source)) { out.add(e.source); grew = true; }
      }
      return out;
    };
    const expected = [];
    const want = new Set();
    for (const [src, dst] of pairs) expected.push({ src, dst, s: resolve(src), t: resolve(dst) });
    const hits = []; const misses = []; const guessOnly = [];
    const holds = (x, guessed) => {
      let ok = has(x.s, x.t, ['calls', 'instantiates'], guessed) || has(x.s, x.t, ['decorates'], guessed) || has(x.t, x.s, ['decorates'], guessed);
      // `A()` (or a subclass's `B()` that inherits it) runs A.__init__: an edge to the class counts.
      if (!ok && x.dst.endsWith('.__init__')) {
        const cls = resolve(x.dst.slice(0, -'.__init__'.length));
        if (cls && !cls.startsWith('missing-node:')) {
          for (const c of subclassesOf(cls)) if (has(x.s, c, ['calls', 'instantiates'], guessed)) { ok = true; for (const f of fromIds(x.s)) want.add(`${f}>${c}`); }
        }
      }
      return ok;
    };
    for (const x of expected) {
      const mapped = !x.s.startsWith('missing-node:') && !x.t.startsWith('missing-node:');
      const ok = mapped && holds(x, false);
      if (mapped && !ok && holds(x, true)) guessOnly.push(`${x.src} -> ${x.dst}`);
      for (const f of fromIds(x.s)) want.add(`${f}>${x.t}`);
      (ok ? hits : misses).push(`${x.src} -> ${x.dst}${x.s.startsWith('missing-node:') || x.t.startsWith('missing-node:') ? ' (no node)' : ''}`);
    }
    // Calls to a class PyCG records as nothing (no __init__) or as __init__: don't count those as extra.
    const extra = edges.filter((e) => !e.guessed && (e.kind === 'calls' || e.kind === 'instantiates') && byId.has(e.source) && byId.has(e.target)
      && !want.has(`${e.source}>${e.target}`) && !(e.kind === 'instantiates' && byId.get(e.target).kind === 'class'))
      .map((e) => `${label(e.source)} -${e.kind}-> ${label(e.target)}`);
    results.push({ name, expected: expected.length, hit: hits.length, misses, guessOnly, extra: [...new Set(extra)] });
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const cats = {};
for (const r of results) {
  const c = (cats[r.name.split('/')[0]] ??= { snippets: 0, pass: 0, expected: 0, hit: 0, guessOnly: 0, extra: 0, errors: 0 });
  c.snippets++;
  if (r.error) { c.errors++; c.expected += r.expected; continue; }
  c.expected += r.expected; c.hit += r.hit; c.guessOnly += r.guessOnly.length; c.extra += r.extra.length;
  if (r.hit === r.expected && r.extra.length === 0) c.pass++;
}
const verbose = process.env.PYCG_VERBOSE === '1';
for (const r of results) {
  if (r.error) { console.log(`ERROR  ${r.name}: ${r.error}`); continue; }
  const pass = r.hit === r.expected && r.extra.length === 0;
  if (pass && !verbose) continue;
  console.log(`${pass ? 'PASS' : 'FAIL'}   ${r.name.padEnd(42)} ${r.hit}/${r.expected}${r.extra.length ? `, ${r.extra.length} extra` : ''}`);
  for (const m of r.misses) console.log(`         miss  ${m}`);
  for (const x of r.extra) console.log(`         extra ${x}`);
  for (const g of r.guessOnly) console.log(`         guess ${g}`);
}
console.log('\ncategory        snippets  pass  recall        extra  guess-only');
const tot = { snippets: 0, pass: 0, expected: 0, hit: 0, guessOnly: 0, extra: 0, errors: 0 };
for (const [c, v] of Object.entries(cats)) {
  for (const k of Object.keys(tot)) tot[k] += v[k];
  console.log(`${c.padEnd(15)} ${String(v.snippets).padStart(8)}  ${String(v.pass).padStart(4)}  ${`${v.hit}/${v.expected}`.padStart(7)} ${v.expected ? `${Math.round((100 * v.hit) / v.expected)}%`.padStart(5) : '    -'}  ${String(v.extra).padStart(5)}  ${String(v.guessOnly).padStart(10)}${v.errors ? `  (${v.errors} errors)` : ''}`);
}
console.log(`${'TOTAL'.padEnd(15)} ${String(tot.snippets).padStart(8)}  ${String(tot.pass).padStart(4)}  ${`${tot.hit}/${tot.expected}`.padStart(7)} ${tot.expected ? `${Math.round((100 * tot.hit) / tot.expected)}%`.padStart(5) : '    -'}  ${String(tot.extra).padStart(5)}  ${String(tot.guessOnly).padStart(10)}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ spec: SPEC_VERSION, subject: subj.name, adapterSha256: adapterHash(subj.name), categories: cats, results }, null, 1));
