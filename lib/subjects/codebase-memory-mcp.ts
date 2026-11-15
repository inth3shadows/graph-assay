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
    const r = sandbox.run(argv, { cwd: dir, env, timeoutMs, nice, rw: [dir, h], ro: [] });
    let output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[graph-assay] spawn failed: ${r.error.message}` : ''}${r.signal ? `\n[graph-assay] killed by ${r.signal}` : ''}`;
    let ok = r.status === 0;
    // the tool could write its store and the output dir: nothing in them may be a link or a special file
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
    if (ownHome) fs.rmSync(h, { recursive: true, force: true });
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
      // `<project>.<dir>.<module>.<Class>.<member>`: the local part is what follows the module's own qname.
      // A file with only a File node has no module qname to strip, so its definitions keep their bare
      // names (containers from cbm's ownership edges are a separate change).
      const local = n.qname.startsWith(`${mod.qname}.`) ? n.qname.slice(mod.qname.length + 1) : n.name;
      nodes.push({ id: String(n.id), kind: n.label.toLowerCase(), name: n.name, qname: local.split('.').join('::'), file: n.file,
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
      // cbm's DEFINES from a File node can cross files (same-stem `client.ts` "defines" `client.js` and its
      // functions): containment never leaves a file.
      if (e.type.startsWith('DEFINES') && byId.get(src)?.file !== byId.get(dst)?.file) continue;
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
