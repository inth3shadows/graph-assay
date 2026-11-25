// The codebase-memory-mcp subject (`cbm`, https://github.com/DeusData/codebase-memory-mcp, MIT): index
// a directory with the release binary in a sandboxed HOME and cache, keep the graph's nodes and edges
// as a small SQLite file inside the indexed dir, and map that to a snapshot v1. This is the only place
// in graph-assay that knows cbm's storage schema. Install: tools/setup.sh (pinned release, sha256).
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../config.ts';
import { SNAPSHOT_SCHEMA } from '../snapshot.ts';
import { adapterHash } from '../provenance.ts';
import { isMain } from '../main.ts';
import * as sandbox from '../sandbox.ts';
import type { Snapshot, SnapshotEdge, SnapshotNode } from '../types.ts';

export const name = 'codebase-memory-mcp';
/** Where index() leaves the graph, inside the indexed dir; dropped before the next index. */
const OUT = '.graph-assay';
const DB = 'cbm.db';
/** The project name cbm stores; every qualified name starts with `<PROJECT>.`. */
const PROJECT = 'graph-assay';

export const defaultBuild = () => path.join(config.subjects, 'codebase-memory-mcp', 'codebase-memory-mcp');

// Environment an index may see: locale, PATH and cbm's own tuning switches; never its cache, root,
// download or diagnostics settings, which the sandbox sets or leaves off.
const PASS_ENV = /^(PATH|LANG|LC_[A-Z]+|TZ|CBM_(WORKERS|MEM_BUDGET_MB|LOG_LEVEL))$/;
/** The index runs isolated (lib/sandbox.ts: unshare or docker), not with network access. */
export const canIsolateNetwork = sandbox.isolated;

/**
 * Index `dir` with the cbm binary `build`: one-shot `cli index_repository` (mode full, no
 * persistence artifact in the repo), HOME and CBM_CACHE_DIR in a temp dir, CBM_ALLOWED_ROOT = `dir`,
 * an allowlisted environment and isolation where it can (lib/sandbox.ts). Then copy the project's `nodes`
 * and `edges` tables to `dir`/.graph-assay/cbm.db (the full store carries search indexes and vectors
 * a snapshot never reads). `home` keeps HOME and cache across calls (incremental re-index); `args`
 * other than the default run as `<build> <args>` in the same sandbox. Returns {ok, status, signal,
 * output, stdout, ms}.
 */
export function index(dir, build = defaultBuild(), { timeoutMs = 600_000, home = null, args = null, nice = false, env: extra = {} } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const ownHome = !home;
  const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  const cache = path.join(h, 'cbm-cache');
  fs.mkdirSync(path.join(h, 'tmp'), { recursive: true });
  const out = path.join(dir, OUT);
  if (!args) fs.rmSync(out, { recursive: true, force: true });
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS_ENV.test(k))),
    HOME: h, XDG_CONFIG_HOME: path.join(h, '.config'), XDG_CACHE_HOME: path.join(h, '.cache'), TMPDIR: path.join(h, 'tmp'),
    CBM_CACHE_DIR: cache, CBM_ALLOWED_ROOT: dir, DO_NOT_TRACK: '1', NO_COLOR: '1', ...extra,
  };
  const argv = [path.resolve(build), ...(args ?? ['cli', '--quiet', 'index_repository', '--repo-path', dir, '--name', PROJECT, '--mode', 'full'])];
  const t0 = Date.now();
  try {
    const r = sandbox.run(argv, { cwd: dir, env, timeoutMs, nice, rw: [h], ro: [dir] }); // the repo read-only: cbm writes its store under HOME, nothing in the repo
    let output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[graph-assay] spawn failed: ${r.error.message}` : ''}${r.signal ? `\n[graph-assay] killed by ${r.signal}` : ''}`;
    let ok = r.status === 0;
    // the tool could write its store (the host writes the output dir): nothing in either may be a link or a special file
    const bad = ok && !args ? sandbox.vetAll(cache, out) : null;
    if (bad) { ok = false; output += `\n${bad}`; }
    if (ok && !args) {
      const store = path.join(cache, `${PROJECT}.db`);
      if (!/"status"\s*:\s*"indexed"/.test(r.stdout ?? '') || !fs.existsSync(store)) { ok = false; output += '\n[graph-assay] cbm reported no indexed store'; }
      else {
        // the store and the output dir were writable inside the sandbox: follow no link out of them
        try { sandbox.confined(h, store); sandbox.confined(dir, out); fs.mkdirSync(out, { recursive: true }); extract(store, sandbox.confined(dir, path.join(out, DB))); }
        catch (e) { ok = false; output += `\n${e.message}`; }
      }
    }
    return { ok, status: r.status, signal: r.signal, output, stdout: r.stdout ?? '', ms: Date.now() - t0 };
  } finally {
    if (ownHome) sandbox.remove(h);
  }
}

/** Copy the nodes and edges of cbm's store `from` into a new SQLite file `to`. */
export function extract(from: string, to: string) {
  fs.rmSync(to, { force: true });
  const db = new DatabaseSync(to);
  try {
    db.exec(`ATTACH DATABASE '${from.replaceAll("'", "''")}' AS src;
      CREATE TABLE nodes AS SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties FROM src.nodes;
      CREATE TABLE edges AS SELECT id, source_id, target_id, type, properties FROM src.edges;
      DETACH DATABASE src;`);
  } finally { db.close(); }
}

/** The release version the binary reports (`codebase-memory-mcp 0.12.1`), or null. */
export function version(build = defaultBuild()) {
  const r = spawnSync(build, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() } });
  return r.status === 0 ? (r.stdout.match(/\b\d+\.\d+\.\d+\S*/)?.[0] ?? null) : null;
}

const LANG = {
  '.py': 'python', '.pyi': 'python', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx', '.go': 'go', '.java': 'java',
  '.kt': 'kotlin', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.php': 'php', '.rb': 'ruby',
};
const lang = (p: string) => LANG[path.extname(p).toLowerCase()] ?? null;
const KIND = { CALLS: 'calls', CALL_REFERENCE: 'references', USAGE: 'references', IMPORTS: 'imports', DEFINES: 'contains',
  DEFINES_METHOD: 'contains', INHERITS: 'extends', IMPLEMENTS: 'implements' };
// cbm's own list of weak short-name strategies (registry.c weak_short_name_strategy, v0.12.1): a
// match on a name alone, not on a receiver or an import. SPEC §1: the subject's marking decides.
const GUESSED = new Set(['unique_name', 'suffix_match', 'field_type_hint', 'fuzzy']);
// Labels that are not code definitions. A File node duplicates the file's Module node, or stands in
// for a file that has no Module (snapshot()).
const SKIP = new Set(['File', 'Folder', 'Project', 'Branch', 'Route']);

type FileRow = { id: number; label: string; qname: string };

/**
 * The qname prefix of each file's definitions. A Module node's own qname. A file with only a File node
 * (`<project>.<path with / as .>.__file__`) has none, and cbm 0.12.1 names its definitions from the
 * directory (Java `src.A.Inner.run`, Go `Match`) or from the directory and the file's stem (Python
 * `pkg.aliases.Config.read_config` beside an `aliases.ini` that took the Module). The shorter candidate
 * is taken when it holds: every definition is under it and every container its local names leaves
 * (`A`, `A.Inner` for `A.Inner.run`) is a definition of the file, as lib/expect.ts reads containers.
 * Otherwise the longer one; neither holds: no prefix (bare names). #47 tried the stem first and stripped
 * a class named like its file (`Svc.java`: `Svc.run` became `run`).
 */
export function filePrefixes(moduleOf: Map<string, FileRow>, defs: { file: string; qname: string }[]): Map<string, string> {
  const byFile = new Map<string, string[]>();
  for (const d of defs) (byFile.get(d.file) ?? byFile.set(d.file, []).get(d.file)).push(d.qname);
  const out = new Map<string, string>();
  for (const [file, m] of moduleOf) {
    if (m.label === 'Module') { out.set(file, m.qname); continue; }
    const base = path.posix.basename(file); const tail = `.${base}.__file__`;
    if (!m.qname.endsWith(tail)) continue;
    const dir = m.qname.slice(0, -tail.length);
    const qs = byFile.get(file) ?? [];
    const holds = (p: string) => {
      if (!qs.every((q) => q.startsWith(`${p}.`))) return false;
      const locals = new Set(qs.map((q) => q.slice(p.length + 1)));
      return [...locals].every((l) => { const s = l.split('.'); return s.slice(0, -1).every((_, i) => locals.has(s.slice(0, i + 1).join('.'))); });
    };
    const ext = path.posix.extname(base);
    const p = [dir, `${dir}.${ext ? base.slice(0, -ext.length) : base}`].find(holds);
    if (p !== undefined) out.set(file, p);
  }
  return out;
}

/** Map `dir`/.graph-assay/cbm.db (left there by index()) to a snapshot v1. */
export function snapshot(dir: string, { build = null as string | null } = {}): Snapshot {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const bad = sandbox.vet(path.join(dir, OUT)); if (bad) throw new Error(bad);
  const db = new DatabaseSync(sandbox.confined(dir, path.join(dir, OUT, DB)), { readOnly: true });
  try {
    type Row = { id: number; label: string; name: string; qname: string; file: string; start: number; end: number };
    const rows = db.prepare(`SELECT id, label, name, qualified_name AS qname, file_path AS file, start_line AS start,
                                    end_line AS "end" FROM nodes ORDER BY id`).all() as unknown as Row[];
    const er = db.prepare('SELECT source_id AS src, target_id AS dst, type, properties FROM edges ORDER BY id').all() as unknown as
      { src: number; dst: number; type: string; properties: string }[];
    // A file is its Module node; File nodes (the same file) are folded into it. cbm 0.12.1 writes no
    // Module for some files, only a File node: Go and Java files, and a file whose extensionless path
    // another file's Module already took (`aliases.py` next to `aliases.ini`). There the File node of a
    // code file (a known extension) is the file.
    const moduleOf = new Map<string, Row>();
    for (const n of rows) if (n.label === 'Module' && n.file && !n.file.startsWith(`${OUT}/`)) moduleOf.set(n.file, n);
    const alias = new Map<number, number>();
    for (const n of rows) {
      if (n.label !== 'File' || !n.file || n.file.startsWith(`${OUT}/`)) continue;
      if (moduleOf.has(n.file)) alias.set(n.id, moduleOf.get(n.file).id);
      else if (lang(n.file)) moduleOf.set(n.file, n);
    }
    // cbm's owners of each method (DEFINES_METHOD). Go: several when cbm folded same-named methods of
    // different receivers into one node (gorilla/mux's eight `Match` methods are one node), so none is its owner.
    // Distinct owners: the same edge written twice is one owner (PR #96 review, C3).
    const owners = new Map<number, Set<number>>();
    for (const e of er) if (e.type === 'DEFINES_METHOD') (owners.get(e.dst) ?? owners.set(e.dst, new Set()).get(e.dst)).add(e.src);
    const soleOwner = (id: number) => { const o = owners.get(id); return o?.size === 1 ? [...o][0] : null; };
    // cbm also folds a Go function with a same-named method: the node is a Function that still carries the
    // method's owner edge. Only a Method has an owner (PR #96 review, C1).
    const isMethod = new Set(rows.filter((n) => n.label === 'Method').map((n) => n.id));
    const defs = rows.filter((n) => n.file && moduleOf.has(n.file) && n.label !== 'Module' && moduleOf.get(n.file).id !== n.id
      && !SKIP.has(n.label) && !n.file.startsWith(`${OUT}/`));
    const prefixOf = filePrefixes(moduleOf, defs);
    const local = new Map<number, string>();
    const stripped = new Set<number>(); // a local cbm's own qname gave, not the bare-name fallback
    // `<project>.<dir>.<module>.<Class>.<member>`: the local part is what follows the file's prefix
    // (filePrefixes). Without one, a definition keeps cbm's bare name.
    for (const n of defs) {
      const p = prefixOf.get(n.file);
      const ok = p !== undefined && n.qname.startsWith(`${p}.`);
      local.set(n.id, ok ? n.qname.slice(p.length + 1) : n.name);
      if (ok) stripped.add(n.id);
    }
    // Go writes a method flat (`graph-assay.Match`): its receiver is only in the ownership edge. A method
    // whose qname, under its file's prefix, has no container and that has one owner is `<owner>.<name>`
    // (only in File-only files: a Module file's names already nest). A bare-name fallback is not flat: in
    // `a.ts` beside `a.js`, cbm folded class A into a.js, so no prefix holds there (PR #96 review, C2).
    const named = new Set<number>(); // methods named by their owner: the only containment that may cross files
    for (const n of defs) {
      const o = soleOwner(n.id);
      if (!isMethod.has(n.id) || !stripped.has(n.id) || moduleOf.get(n.file).label === 'Module' || local.get(n.id).includes('.') || o === null || !local.has(o)) continue;
      local.set(n.id, `${local.get(o)}.${n.name}`);
      named.add(n.id);
    }
    const nodes: SnapshotNode[] = [];
    for (const n of rows) {
      // no file: injected builtins (`builtins.len`), routes, the project and branch nodes
      const mod = n.file ? moduleOf.get(n.file) : null;
      const isFile = n.label === 'Module' || mod?.id === n.id;
      if (!n.file || (SKIP.has(n.label) && !isFile) || n.file.startsWith(`${OUT}/`)) continue;
      if (!mod) continue;
      if (isFile) {
        nodes.push({ id: String(n.id), kind: 'file', name: n.file, qname: n.file, file: n.file, language: lang(n.file), start: 1, end: Math.max(1, n.end) });
        continue;
      }
      nodes.push({ id: String(n.id), kind: n.label.toLowerCase(), name: n.name, qname: local.get(n.id).split('.').join('::'), file: n.file,
        language: lang(n.file), start: n.start, end: Math.max(n.start, n.end) });
    }
    const keep = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: SnapshotEdge[] = [];
    for (const e of er) {
      const src = String(alias.get(e.src) ?? e.src); const dst = String(alias.get(e.dst) ?? e.dst);
      // An edge to a node the snapshot does not hold (a route, a builtin) is dropped with it.
      if (!keep.has(src) || !keep.has(dst)) continue;
      if (src === dst && (alias.has(e.src) || alias.has(e.dst))) continue; // File DEFINES its own Module
      if (KIND[e.type] === 'contains') {
        // A folded method's owners are each claimed and at most one is right, and a function has no
        // owner: neither keeps an owner edge.
        if (e.type === 'DEFINES_METHOD' && (soleOwner(e.dst) === null || !isMethod.has(e.dst))) continue;
        // Containment crosses files only as the owner of a Go method named by it (a receiver type declared
        // in another file). Anything else across files is one of cbm's folds: a File's DEFINES of a
        // same-stem file (`client.ts` "defines" `client.js`'s functions), or a class folded across
        // `a.js`/`a.ts` "defining" the other file's method (PR #96 review, C2).
        if (byId.get(src)?.file !== byId.get(dst)?.file && !(e.type === 'DEFINES_METHOD' && named.has(e.dst))) continue;
      }
      let p: Record<string, any> = {};
      try { p = JSON.parse(e.properties || '{}'); } catch { /* malformed properties: no metadata */ }
      const strategy = typeof p.strategy === 'string' ? p.strategy : null;
      edges.push({ kind: KIND[e.type] ?? e.type.toLowerCase(), src, dst, line: Number.isInteger(p.line) ? p.line : null, col: null,
        ref: typeof p.callee === 'string' ? p.callee : null, resolvedBy: strategy,
        provenance: strategy && GUESSED.has(strategy) ? strategy : null });
    }
    const files = [...moduleOf.keys()].sort().map((f) => ({ path: f, language: lang(f) }));
    return {
      schema: SNAPSHOT_SCHEMA,
      subject: { name, adapterSha256: adapterHash(name), version: build ? version(build) : null, config: { mode: 'full' } },
      capabilities: {
        // cbm keeps one edge per (caller, callee, type) with the line of one of its sites, so lines
        // are not call sites: SPEC §3 scores a subject without site lines on the function-pair track.
        // USAGE (an unproven callable target) has no line, so no unresolved references are exported.
        siteLines: false, siteColumns: false, columnEncoding: null, unresolved: false, provenance: true,
        edgeKinds: [...new Set(edges.map((e) => e.kind))].sort(),
      },
      files,
      nodes,
      edges,
      unresolved: [],
    };
  } finally {
    db.close();
  }
}

// CLI: node lib/subjects/codebase-memory-mcp.ts index <dir> [binary] | snapshot <dir> <out.json> [binary]
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
    console.error('usage: codebase-memory-mcp.ts index <dir> [binary] | snapshot <dir> <out.json> [binary]');
    process.exit(2);
  }
}
