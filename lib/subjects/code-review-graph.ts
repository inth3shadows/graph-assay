// The code-review-graph subject (`crg`, https://github.com/tirth8205/code-review-graph, MIT): index a
// directory with `code-review-graph build` in a sandboxed HOME and data dir, keep the graph's nodes
// and edges (paths made relative to the repo) as a small SQLite file inside the indexed dir, and map
// that to a snapshot v1. This is the only place in graph-assay that knows crg's storage schema.
// Install: tools/setup.sh (PyPI 2.4.0, core only, hash-locked by docker/crg-requirements.lock).
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../config.ts';
import { SNAPSHOT_SCHEMA } from '../snapshot.ts';
import { adapterHash } from '../provenance.ts';
import { isMain } from '../main.ts';
import type { Snapshot, SnapshotEdge, SnapshotNode, Unresolved } from '../types.ts';

export const name = 'code-review-graph';
/** Where index() leaves the graph, inside the indexed dir; dropped before the next index. */
const OUT = '.graph-assay';
const DB = 'crg.db';
/** crg writes `<repo>/.code-review-graph/.gitignore` even with CRG_DATA_DIR elsewhere. */
const OWN = '.code-review-graph';

export const defaultBuild = () => path.join(config.subjects, 'code-review-graph', 'venv', 'bin', 'code-review-graph');

// Environment a build may see: locale, PATH and crg's own parse switches; never its data, home,
// enrichment or any embedding-provider setting, which the sandbox sets or leaves off.
const PASS_ENV = /^(PATH|LANG|LC_[A-Z]+|TZ|CRG_(SERIAL_PARSE|GIT_TIMEOUT))$/;
let offline;
/** `unshare -rn` works here (Linux with unprivileged user namespaces); checked once. */
export const canIsolateNetwork = () => (offline ??= spawnSync('unshare', ['-rn', 'true']).status === 0);

/**
 * Index `dir` with the crg binary `build`: one `build` (full parse, core install: no embeddings;
 * Jedi enrichment forced off) with HOME, CRG_HOME and CRG_DATA_DIR in a temp dir, an allowlisted
 * environment and, where unshare works, no network. Then copy the graph's `nodes` and `edges`, paths
 * made relative to `dir`, to `dir`/.graph-assay/crg.db. `home` keeps HOME and data across calls
 * (then `args: ['update']` is incremental); other `args` run as `<build> <args>` in the same sandbox.
 * Returns {ok, status, signal, output, stdout, ms}.
 */
export function index(dir, build = defaultBuild(), { timeoutMs = 600_000, home = null, args = null, nice = false, env: extra = {} } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const ownHome = !home;
  const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  const data = path.join(h, 'crg-data');
  fs.mkdirSync(path.join(h, 'tmp'), { recursive: true });
  const out = path.join(dir, OUT);
  const indexing = !args || args[0] === 'update';
  if (indexing) fs.rmSync(out, { recursive: true, force: true });
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS_ENV.test(k))),
    HOME: h, XDG_CONFIG_HOME: path.join(h, '.config'), XDG_CACHE_HOME: path.join(h, '.cache'), TMPDIR: path.join(h, 'tmp'),
    CRG_HOME: path.join(h, '.crg'), CRG_DATA_DIR: data, CRG_DISABLE_ENRICHMENT: '1', NO_COLOR: '1', DO_NOT_TRACK: '1',
    PYTHONDONTWRITEBYTECODE: '1', ...extra,
  };
  const argv = [...(canIsolateNetwork() ? ['unshare', '-rn'] : []), path.resolve(build), ...(args ?? ['build'])];
  const t0 = Date.now();
  try {
    const r = spawnSync(nice ? 'nice' : argv[0], nice ? ['-n', '10', ...argv] : argv.slice(1),
      { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: timeoutMs });
    let output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[graph-assay] spawn failed: ${r.error.message}` : ''}${r.signal ? `\n[graph-assay] killed by ${r.signal}` : ''}`;
    let ok = r.status === 0;
    if (ok && indexing) {
      const store = path.join(data, 'graph.db');
      if (!fs.existsSync(store)) { ok = false; output += '\n[graph-assay] crg wrote no graph.db'; }
      else { fs.mkdirSync(out, { recursive: true }); extract(store, path.join(out, DB), dir); }
    }
    return { ok, status: r.status, signal: r.signal, output, stdout: r.stdout ?? '', ms: Date.now() - t0 };
  } finally {
    if (ownHome) fs.rmSync(h, { recursive: true, force: true });
  }
}

/** Copy the nodes and edges of crg's store `from` into a new SQLite file `to`, with every path
 * (crg stores absolute ones, also inside qualified names) made relative to `root`. */
export function extract(from: string, to: string, root: string) {
  fs.rmSync(to, { force: true });
  const db = new DatabaseSync(to);
  // The repo as given and as resolved (a temp dir behind a symlink): strip whichever crg wrote.
  const prefixes = [...new Set([path.resolve(root), fs.realpathSync(root)])].map((p) => `${p}/`);
  const rel = (col: string) => prefixes.reduce((x, p) => `replace(${x}, '${p.replaceAll("'", "''")}', '')`, col);
  try {
    db.exec(`ATTACH DATABASE '${from.replaceAll("'", "''")}' AS src;
      CREATE TABLE nodes AS SELECT kind, ${rel('name')} AS name, ${rel('qualified_name')} AS qualified_name, ${rel('file_path')} AS file_path,
        line_start, line_end, language, parent_name FROM src.nodes;
      CREATE TABLE edges AS SELECT id, kind, ${rel('source_qualified')} AS source_qualified, ${rel('target_qualified')} AS target_qualified,
        ${rel('file_path')} AS file_path, line, extra, confidence_tier, target_resolution FROM src.edges;
      DETACH DATABASE src;`);
  } finally { db.close(); }
}

/** The release version the program reports (`code-review-graph 2.4.0`), or null. */
export function version(build = defaultBuild()) {
  const r = spawnSync(build, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() } });
  return r.status === 0 ? (r.stdout.match(/\b\d+\.\d+\.\d+\S*/)?.[0] ?? null) : null;
}

const KIND = { CALLS: 'calls', CONTAINS: 'contains', IMPORTS_FROM: 'imports', REFERENCES: 'references', INHERITS: 'extends',
  IMPLEMENTS: 'implements' };
// crg's own tiers (graph.py v2.4.0): EXTRACTED (the source names the symbol and the node exists),
// INFERRED (a resolver chose the node from other evidence, e.g. a receiver's class), AMBIGUOUS
// (several nodes fit and nothing chooses), UNRESOLVED (no node). SPEC Terms: the subject's marking
// decides; only AMBIGUOUS says the target is a guess.
const GUESSED = new Set(['AMBIGUOUS']);
/** crg's symbol part of a qualified name: `<file>::<Class>.<member>[:S<hash>[:n]]` -> `Class.member`. */
const symbol = (id: string) => { const cut = id.indexOf('::'); return (cut >= 0 ? id.slice(cut + 2) : id).replace(/:S[0-9a-f]+(?::\d+)?$/, ''); };

/**
 * Give every definition node its container chain (`Outer::inner`, `Class::method`) from the nesting
 * of crg's own spans within a file. crg names a class member `Class.member` but a nested function by
 * its bare name, with a hash suffix when the name repeats in the file (`skipString:S<hash>:2`), so the
 * chain is read from the spans: a node's container is the innermost node of the same file whose span
 * holds it. Two nodes with one span (a one-line class and its method) nest only when crg's symbol for
 * the outer one is a prefix of the inner one's (`A` of `A.m`).
 */
function qualify(nodes: SnapshotNode[]) {
  const byFile = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.kind !== 'file') (byFile.get(n.file) ?? byFile.set(n.file, []).get(n.file)).push(n);
  for (const list of byFile.values()) {
    const depth = (n: SnapshotNode) => symbol(n.id).split('.').length;
    list.sort((a, b) => a.start - b.start || b.end - a.end || depth(a) - depth(b));
    const stack: SnapshotNode[] = [];
    for (const n of list) {
      const holds = (o: SnapshotNode) => o.start <= n.start && n.end <= o.end
        && (o.start !== n.start || o.end !== n.end || symbol(n.id).startsWith(`${symbol(o.id)}.`));
      while (stack.length && !holds(stack[stack.length - 1])) stack.pop();
      n.qname = [...stack.map((o) => o.name), n.name].join('::');
      stack.push(n);
    }
  }
}

const internal = (p: string) => p === OUT || p.startsWith(`${OUT}/`) || p === OWN || p.startsWith(`${OWN}/`);

/** Map `dir`/.graph-assay/crg.db (left there by index()) to a snapshot v1. */
export function snapshot(dir: string, { build = null as string | null } = {}): Snapshot {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const db = new DatabaseSync(path.join(dir, OUT, DB), { readOnly: true });
  try {
    type Row = { kind: string; name: string; qname: string; file: string; start: number | null; end: number | null; language: string | null };
    const rows = db.prepare(`SELECT kind, name, qualified_name AS qname, file_path AS file, line_start AS start, line_end AS "end",
                                    language FROM nodes ORDER BY file_path, line_start, qualified_name`).all() as unknown as Row[];
    const er = db.prepare(`SELECT kind, source_qualified AS src, target_qualified AS dst, file_path AS file, line, extra,
                                  confidence_tier AS tier, target_resolution AS resolution FROM edges ORDER BY id`).all() as unknown as
      { kind: string; src: string; dst: string; file: string; line: number | null; extra: string; tier: string | null; resolution: string | null }[];
    const nodes: SnapshotNode[] = [];
    for (const n of rows) {
      if (!n.file || internal(n.file)) continue;
      const start = n.start ?? 1;
      if (n.kind === 'File') {
        nodes.push({ id: n.qname, kind: 'file', name: n.file, qname: n.file, file: n.file, language: n.language, start: 1, end: Math.max(1, n.end ?? 1) });
        continue;
      }
      // qname is filled in below from the nesting of spans
      nodes.push({ id: n.qname, kind: n.kind.toLowerCase(), name: n.name, qname: n.name, file: n.file,
        language: n.language, start, end: Math.max(start, n.end ?? start) });
    }
    qualify(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: SnapshotEdge[] = [];
    const unresolved: Unresolved[] = [];
    for (const e of er) {
      let x: Record<string, any> = {};
      try { x = JSON.parse(e.extra || '{}'); } catch { /* malformed extra: no metadata */ }
      const ref = typeof x.member_call === 'string' ? x.member_call : null;
      const line = Number.isInteger(e.line) && e.line > 0 ? e.line : null;
      if (!byId.has(e.src)) continue;
      if (!byId.has(e.dst)) {
        // An unresolved call names a bare target (`print`, `get`); other kinds to a non-node are dropped.
        if (e.kind === 'CALLS' && line) unresolved.push({ src: e.src, file: e.file, line, col: null, name: ref ?? e.dst, kind: 'calls' });
        continue;
      }
      edges.push({ kind: KIND[e.kind] ?? e.kind.toLowerCase(), src: e.src, dst: e.dst, line, col: null, ref,
        resolvedBy: e.tier ?? null, provenance: e.tier && GUESSED.has(e.tier) ? e.tier.toLowerCase() : null });
    }
    const files = nodes.filter((n) => n.kind === 'file').map((n) => ({ path: n.file, language: n.language ?? null }));
    return {
      schema: SNAPSHOT_SCHEMA,
      subject: { name, adapterSha256: adapterHash(name), version: build ? version(build) : null, config: { install: 'core', enrichment: false } },
      capabilities: {
        // one edge per (caller, callee, line): two calls on one line are one edge, and no columns
        siteLines: true, siteColumns: false, columnEncoding: null, unresolved: true, provenance: true,
        edgeKinds: [...new Set(edges.map((e) => e.kind))].sort(),
      },
      files,
      nodes,
      edges,
      unresolved,
    };
  } finally {
    db.close();
  }
}

// CLI: node lib/subjects/code-review-graph.ts index <dir> [binary] | snapshot <dir> <out.json> [binary]
if (isMain(import.meta.url)) {
  const [cmd, dir, a, b] = process.argv.slice(2);
  if (cmd === 'index' && dir) {
    const r = index(dir, a ?? defaultBuild(), { nice: process.env.CGQA_NICE === '1' });
    process.stdout.write(r.output);
    process.exit(r.ok ? 0 : (r.status || 1));
  } else if (cmd === 'snapshot' && dir && a) {
    const { writeSnapshot } = await import('../snapshot.ts');
    writeSnapshot(a, snapshot(dir, { build: b ?? null }));
  } else {
    console.error('usage: code-review-graph.ts index <dir> [binary] | snapshot <dir> <out.json> [binary]');
    process.exit(2);
  }
}
