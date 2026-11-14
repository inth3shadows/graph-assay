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
 * environment and, where unshare works, no network. The repo root is pinned to `dir` (`--repo` and
 * CRG_REPO_ROOT; crg otherwise walks up to the nearest .git). Then copy the graph's `nodes` and
 * `edges`, paths made relative to `dir`, to `dir`/.graph-assay/crg.db. `home` keeps HOME and data
 * across calls (then `args: ['update']` is incremental); `build` and `update` args extract again,
 * other `args` run as `<build> <args>` in the same sandbox.
 * Returns {ok, status, signal, output, stdout, ms}.
 */
export function index(dir, build = defaultBuild(), { timeoutMs = 600_000, home = null, args = null, nice = false, env: extra = {} } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const ownHome = !home;
  const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  const data = path.join(h, 'crg-data');
  fs.mkdirSync(path.join(h, 'tmp'), { recursive: true });
  const out = path.join(dir, OUT);
  const indexing = !args || args[0] === 'build' || args[0] === 'update';
  if (indexing) fs.rmSync(out, { recursive: true, force: true });
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS_ENV.test(k))),
    HOME: h, XDG_CONFIG_HOME: path.join(h, '.config'), XDG_CACHE_HOME: path.join(h, '.cache'), TMPDIR: path.join(h, 'tmp'),
    CRG_HOME: path.join(h, '.crg'), CRG_DATA_DIR: data, CRG_DISABLE_ENRICHMENT: '1', NO_COLOR: '1', DO_NOT_TRACK: '1',
    PYTHONDONTWRITEBYTECODE: '1', ...extra, CRG_REPO_ROOT: dir,
  };
  // build and update need --repo: update ignores CRG_REPO_ROOT and walks up to the nearest .git
  let cmd: string[] = args ?? ['build'];
  if ((cmd[0] === 'build' || cmd[0] === 'update') && !cmd.includes('--repo')) cmd = [...cmd, '--repo', dir];
  const argv = [...(canIsolateNetwork() ? ['unshare', '-rn'] : []), path.resolve(build), ...cmd];
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
 * (crg stores absolute ones, also inside qualified names and edge metadata) made relative to `root`. */
export function extract(from: string, to: string, root: string) {
  fs.rmSync(to, { force: true });
  // The repo as given and as resolved (a temp dir behind a symlink; on macOS /var/... resolves to
  // /private/var/..., which holds the given path as text): strip whichever crg wrote, longest first,
  // and only where a value starts with it.
  const prefixes = [...new Set([path.resolve(root), fs.realpathSync(root)])].map((p) => `${p}/`).sort((a, b) => b.length - a.length);
  const rel = (v: any) => { if (typeof v !== 'string') return v; const p = prefixes.find((x) => v.startsWith(x)); return p ? v.slice(p.length) : v; };
  // Edge metadata is JSON that Python wrote (non-ASCII escaped as \uXXXX): parse it and strip every
  // string inside, so the escaping never hides a path.
  const deep = (v: any): any => (typeof v === 'string' ? rel(v) : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  const relJson = (v: any) => { if (typeof v !== 'string') return v; try { return JSON.stringify(deep(JSON.parse(v))); } catch { return v; } };
  // Written under a temporary name and renamed once complete: a failed copy leaves no crg.db that
  // snapshot() would read as an empty graph.
  const tmp = `${to}.tmp`;
  fs.rmSync(tmp, { force: true });
  let src: DatabaseSync | null = null; let db: DatabaseSync | null = null;
  try {
    src = new DatabaseSync(from, { readOnly: true });
    db = new DatabaseSync(tmp);
    db.exec(`CREATE TABLE nodes (kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, line_start INTEGER, line_end INTEGER, language TEXT);
             CREATE TABLE edges (id INTEGER, kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT, line INTEGER, extra TEXT, confidence_tier TEXT);
             BEGIN;`);
    const putNode = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const n of src.prepare('SELECT kind, name, qualified_name, file_path, line_start, line_end, language FROM nodes').iterate() as Iterable<any>)
      putNode.run(n.kind, rel(n.name), rel(n.qualified_name), rel(n.file_path), n.line_start, n.line_end, n.language);
    const putEdge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of src.prepare('SELECT id, kind, source_qualified, target_qualified, file_path, line, extra, confidence_tier FROM edges').iterate() as Iterable<any>)
      putEdge.run(e.id, e.kind, rel(e.source_qualified), rel(e.target_qualified), rel(e.file_path), e.line, relJson(e.extra), e.confidence_tier);
    db.exec('COMMIT;');
    db.close(); db = null;
    fs.renameSync(tmp, to);
  } finally {
    db?.close(); src?.close();
    fs.rmSync(tmp, { force: true });
  }
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
// decides; only AMBIGUOUS says the target is a guess. crg stores an ambiguous call with a bare target
// and its candidates in `extra.ambiguous_targets`; snapshot() links it to each candidate as guessed.
const GUESSED = new Set(['AMBIGUOUS']);
/** crg's symbol part of a qualified name: `<file>::<Class>.<member>[:S<hash>[:n]]` -> `Class.member`. */
const symbol = (id: string) => { const cut = id.indexOf('::'); return (cut >= 0 ? id.slice(cut + 2) : id).replace(/:S[0-9a-f]+(?::\d+)?$/, ''); };
// `ns.I.m(a.b)` -> ['ns', 'I', 'm(a.b)']: dots inside a signature stay.
const segments = (q: string) => { const out: string[] = []; let cur = ''; let depth = 0; for (const ch of q) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === '.' && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };

/**
 * Give every definition node its container chain (`Class::method`, `Outer::Inner::m`, `f::inner`).
 * The container is the innermost node of the same file whose span holds the node (a stack walk over
 * the file's nodes sorted by span). Two nodes on one span nest only when crg's symbol says so (`K`
 * of `K.m`). A node that no span holds but whose crg symbol names a container (a Go receiver method
 * declared outside its type, a member of a one-line class beside another) takes that container: the
 * node with that symbol (or ending in it) whose span holds it if any, else the first; with none, the
 * symbol's own segments (a C++ namespace). crg's hash suffix on repeated names (`A.m:S<hash>`) is
 * ignored when comparing symbols, so spans decide between same-named classes. Two bare definitions
 * on one span (a one-line nested function) cannot be told apart and stay unnested.
 */
function qualify(nodes: SnapshotNode[]) {
  const byFile = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.kind !== 'file') (byFile.get(n.file) ?? byFile.set(n.file, []).get(n.file)).push(n);
  for (const list of byFile.values()) {
    const sym = new Map(list.map((n) => [n, symbol(n.id)]));
    const segs = new Map(list.map((n) => [n, segments(sym.get(n))]));
    const spans = (o: SnapshotNode, n: SnapshotNode) => o.start <= n.start && n.end <= o.end;
    // 1. span parents, by a stack walk
    const parent = new Map<SnapshotNode, SnapshotNode>();
    const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end || segs.get(a).length - segs.get(b).length);
    const stack: SnapshotNode[] = [];
    for (const n of sorted) {
      const holds = (o: SnapshotNode) => spans(o, n) && (o.start !== n.start || o.end !== n.end || sym.get(n).startsWith(`${sym.get(o)}.`));
      while (stack.length && !holds(stack[stack.length - 1])) stack.pop();
      if (stack.length) parent.set(n, stack[stack.length - 1]);
      stack.push(n);
    }
    // 2. chains; a node with no span parent falls back to the container its crg symbol names
    const done = new Map<SnapshotNode, string>();
    const chain = (n: SnapshotNode, seen: Set<SnapshotNode>): string => {
      if (done.has(n)) return done.get(n);
      if (seen.has(n)) return n.name; // a cycle cannot happen by construction; never loop on bad input
      seen.add(n);
      let outer: string | null = null;
      const p = parent.get(n);
      if (p) outer = chain(p, seen);
      else if (segs.get(n).length > 1) {
        const prefix = segs.get(n).slice(0, -1).join('.');
        const owners = list.filter((o) => o !== n && (sym.get(o) === prefix || sym.get(o).endsWith(`.${prefix}`)));
        const owner = owners.find((o) => spans(o, n)) ?? owners[0];
        outer = owner ? chain(owner, seen) : segs.get(n).slice(0, -1).map((x) => x.replace(/\(.*\)$/, '')).join('::');
      }
      const q = outer ? `${outer}::${n.name}` : n.name;
      done.set(n, q);
      return q;
    };
    for (const n of list) n.qname = chain(n, new Set());
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
                                  confidence_tier AS tier FROM edges ORDER BY id`).all() as unknown as
      { kind: string; src: string; dst: string; file: string; line: number | null; extra: string; tier: string | null }[];
    const nodes: SnapshotNode[] = [];
    for (const n of rows) {
      if (!n.file || internal(n.file)) continue;
      const start = n.start ?? 1;
      if (n.kind === 'File') {
        nodes.push({ id: n.qname, kind: 'file', name: n.file, qname: n.file, file: n.file, language: n.language, start: 1, end: Math.max(1, n.end ?? 1) });
        continue;
      }
      // qname is filled in below by qualify()
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
        // An ambiguous call names a bare target and lists the candidates it could not choose between:
        // one guessed edge to each candidate the snapshot holds.
        const candidates = e.tier === 'AMBIGUOUS' && Array.isArray(x.ambiguous_targets) ? x.ambiguous_targets.filter((t) => byId.has(t)) : [];
        for (const t of candidates) edges.push({ kind: KIND[e.kind] ?? e.kind.toLowerCase(), src: e.src, dst: t, line, col: null, ref,
          resolvedBy: e.tier, provenance: 'ambiguous' });
        if (candidates.length) continue;
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
