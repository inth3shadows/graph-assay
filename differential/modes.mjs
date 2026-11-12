#!/usr/bin/env node
// Execution-mode differential: index the same source under each of codegraph's execution modes and
// diff every result against `base`. Codegraph documents each of these switches as producing the
// same graph (store worker, parse pool, resolver pool, fast init), so any canonical difference is
// a bug in codegraph or in that claim.
//
// Usage: node differential/modes.mjs <codegraph.js> <dir ...> [--modes repeat,native,...] [--json out]
//
// Two levels per mode, against base:
//   raw        snapshot bytes (ids and row order included), subject.config excluded
//   canonical  multisets of files, nodes, joined edges (every column) and unresolved refs, ids
//              replaced by what they point at
// Verdicts: IDENTICAL (raw equal), SAME-GRAPH (canonical equal, raw not), DIFFER, FAILED (the run
// failed: a failure, never missing data). Exit 0 = no DIFFER/FAILED, 1 = some, 2 = usage.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { adapterHash } from '../lib/provenance.mjs';
import { placeFixtureInstall } from '../lib/fixture-install.mjs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as codegraph from '../lib/subjects/codegraph.mjs';
import { isMain } from '../lib/main.mjs';

const SKIP = new Set(['.codegraph', 'node_modules']);

// Each mode: how to build the index in a fresh copy `work` of the source `src`.
const init = (env = {}, kernel = '0') => (work, _src, build) => codegraph.index(work, build, { kernel, env });
export const MODES = {
  base: init(),
  repeat: init(),
  native: init({}, '1'),
  parse1: init({ CODEGRAPH_PARSE_WORKERS: '1' }),
  parse4: init({ CODEGRAPH_PARSE_WORKERS: '4' }),
  'resolve-pool': init({ CODEGRAPH_PARALLEL_RESOLVE_MIN: '0', CODEGRAPH_RESOLVE_WORKERS: '4' }),
  'no-parallel-resolve': init({ CODEGRAPH_NO_PARALLEL_RESOLVE: '1' }),
  'no-store-worker': init({ CODEGRAPH_NO_STORE_WORKER: '1' }),
  'no-fast-init': init({ CODEGRAPH_NO_FAST_INIT: '1' }),
  // init, then a full rebuild over the existing store
  reindex: (work, _src, build) => withHome((home) => {
    const a = codegraph.index(work, build, { home });
    return a.ok ? join(a, codegraph.index(work, build, { home, args: ['index'] })) : a;
  }),
  // init an empty directory, then add every file and sync
  'sync-from-empty': (work, src, build) => withHome((home) => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work);
    const a = codegraph.index(work, build, { home });
    if (!a.ok) return a;
    copy(src, work);
    return join(a, codegraph.index(work, build, { home, args: ['sync'] }));
  }),
};

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
const join = (a, b) => ({ ...b, ms: a.ms + b.ms, output: `${a.output}\n${b.output}` });
const copy = (src, dst) => { fs.cpSync(src, dst, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) }); placeFixtureInstall(dst); };

const count = (keys) => { const m = new Map(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m; };

/** The snapshot as multisets with ids replaced by what they point at. SPEC §2: a node is identified
 * by kind, file and line span (and language), never by name, since subjects encode position in names
 * (code-graph-rag's `setup@26`). Names are compared in their own `names` category, so a renamed node
 * is one `names` difference rather than every one of its edges reported as moved. */
export function canonical(s) {
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  // An edge whose endpoint is not a node is a graph defect to report, not a crash.
  const id = (n, ref) => (n ? JSON.stringify([n.kind, n.file, n.start, n.end, n.language ?? null]) : JSON.stringify(['<dangling>', ref ?? null]));
  return {
    files: count(s.files.map((f) => JSON.stringify([f.path, f.language ?? null]))),
    nodes: count(s.nodes.map(id)),
    names: count(s.nodes.map((n) => JSON.stringify([id(n), n.name, n.qname ?? null]))),
    edges: count(s.edges.map((e) => JSON.stringify([e.kind, id(byId.get(e.src), e.src), id(byId.get(e.dst), e.dst), e.line ?? null, e.col ?? null,
      e.ref ?? null, e.resolvedBy ?? null, e.provenance ?? null]))),
    unresolved: count(s.unresolved.map((u) => JSON.stringify([u.src == null ? null : id(byId.get(u.src), u.src), u.file, u.line, u.col ?? null, u.name, u.kind]))),
  };
}

/** Per category: entries whose count differs, as {key, a, b}. */
export function diffCanonical(a, b) {
  const out = {};
  for (const cat of Object.keys(a)) {
    const d = [];
    for (const k of new Set([...a[cat].keys(), ...b[cat].keys()])) {
      const x = a[cat].get(k) ?? 0; const y = b[cat].get(k) ?? 0;
      if (x !== y) d.push({ key: k, a: x, b: y });
    }
    if (d.length) out[cat] = d;
  }
  return out;
}

export const rawHash = (s) => createHash('sha256').update(JSON.stringify([s.capabilities, s.files, s.nodes, s.edges, s.unresolved])).digest('hex');

/** Run `modes` on one source dir. Returns {dir, results: [{mode, verdict, ms, diff?, error?}]}. */
export function runDir(build, src, modes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-modes-'));
  const runs = {};
  try {
    for (const mode of ['base', ...modes.filter((m) => m !== 'base')]) {
      const work = path.join(tmp, mode);
      copy(src, work);
      const r = MODES[mode](work, src, build);
      if (!r.ok) { runs[mode] = { ms: r.ms, error: `status ${r.status}${r.signal ? ` ${r.signal}` : ''}: ${r.output.trim().split('\n').slice(-3).join(' | ')}` }; continue; }
      let snap;
      try { snap = codegraph.snapshot(work, { kernel: mode === 'native' ? '1' : '0' }); } catch (e) {
        runs[mode] = { ms: r.ms, error: `snapshot failed: ${e.message}` }; fs.rmSync(work, { recursive: true, force: true }); continue;
      }
      runs[mode] = { ms: r.ms, raw: rawHash(snap), canon: canonical(snap), size: { nodes: snap.nodes.length, edges: snap.edges.length, unresolved: snap.unresolved.length } };
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const base = runs.base;
  const results = [];
  for (const [mode, r] of Object.entries(runs)) {
    const row = { mode, ms: r.ms, size: r.size };
    if (r.error) row.verdict = 'FAILED', row.error = r.error;
    else if (mode === 'base') row.verdict = 'BASE';
    else if (base.error) row.verdict = 'FAILED', row.error = 'base failed';
    else if (r.raw === base.raw) row.verdict = 'IDENTICAL';
    else {
      const diff = diffCanonical(base.canon, r.canon);
      row.verdict = Object.keys(diff).length ? 'DIFFER' : 'SAME-GRAPH';
      if (row.verdict === 'DIFFER') row.diff = diff;
    }
    results.push(row);
  }
  return { dir: src, results };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1];
    if (v == null || v.startsWith('--')) { console.error(`${k} needs a value`); process.exit(2); }
    args.splice(i, 2); return v;
  };
  const jsonOut = opt('--json');
  const modeArg = opt('--modes');
  const [build, ...dirs] = args;
  const modes = modeArg ? modeArg.split(',') : Object.keys(MODES).filter((m) => m !== 'base');
  if (!modes.some((m) => m !== 'base')) { console.error('nothing to compare: name at least one mode besides base'); process.exit(2); }
  const unknown = modes.filter((m) => !MODES[m]);
  if (!build || !dirs.length || unknown.length) {
    console.error(`usage: modes.mjs <codegraph.js> <dir ...> [--modes ${Object.keys(MODES).join(',')}] [--json out]`);
    if (unknown.length) console.error(`unknown mode(s): ${unknown.join(', ')}`);
    process.exit(2);
  }
  const all = [];
  let bad = 0;
  for (const dir of dirs) {
    const res = runDir(build, path.resolve(dir), modes);
    all.push(res);
    console.log(`== ${dir}`);
    for (const r of res.results) {
      const size = r.size ? `${r.size.nodes}n ${r.size.edges}e ${r.size.unresolved}u` : '';
      console.log(`${r.verdict.padEnd(10)} ${r.mode.padEnd(20)} ${String(r.ms).padStart(7)}ms  ${size}${r.error ? `  ${r.error}` : ''}`);
      if (r.verdict === 'DIFFER' || r.verdict === 'FAILED') bad++;
      for (const [cat, d] of Object.entries(r.diff ?? {})) {
        console.log(`           ${cat}: ${d.length} differ (base -> ${r.mode})`);
        for (const x of d.slice(0, 5)) console.log(`             ${x.a} -> ${x.b}  ${x.key}`);
      }
    }
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ build, adapterSha256: adapterHash('codegraph'), modes, results: all }, null, 1));
  console.log(`\n${bad} mode result(s) DIFFER or FAILED`);
  process.exit(bad ? 1 : 0);
}
