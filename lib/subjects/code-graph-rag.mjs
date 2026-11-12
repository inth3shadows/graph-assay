// The code-graph-rag subject (`cgr`, https://github.com/vitali87/code-graph-rag, MIT): index a
// directory offline in a sandboxed HOME, and map its JSON export to a snapshot v1. Install:
// `uv venv <subjects>/cgr/venv && uv pip install 'code-graph-rag[treesitter-full]==0.5.0'`
// (without treesitter-full, TS and Go files become bare File nodes). Pins: TECHNICAL.md, Docker reproduction.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../config.mjs';
import { SNAPSHOT_SCHEMA } from '../snapshot.mjs';
import { adapterHash } from '../provenance.mjs';
import { isMain } from '../main.mjs';

export const name = 'code-graph-rag';
/** Where index() leaves the export, inside the indexed dir (and excluded from the index). */
const OUT = '.graph-assay';

export const defaultBuild = () => path.join(config.subjects, 'cgr/venv/bin/cgr');

/**
 * Index `dir` with the cgr binary `build`: one `start --update-graph` (parse, sync into the
 * embedded store under HOME/.cgr, export the project), offline (`unshare -rn`: no network), with
 * an empty environment apart from PATH and the sandbox HOME. `home` keeps a HOME across calls.
 * `args` other than the default are run as `cgr <args>` in the same sandbox (queries).
 * Returns {ok, status, signal, output, stdout, ms}.
 */
export function index(dir, build = defaultBuild(), { timeoutMs = 600_000, home = null, args = null, env: extra = {} } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const ownHome = !home;
  const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  fs.mkdirSync(h, { recursive: true });
  const out = path.join(dir, OUT);
  fs.mkdirSync(out, { recursive: true });
  const env = { PATH: `${path.dirname(build)}:/usr/bin:/bin`, HOME: h, LANG: 'C.UTF-8', NO_COLOR: '1', ...extra };
  const argv = args ?? ['-q', 'start', '--repo-path', '.', '--update-graph', '-o', path.join(out, 'export.json'),
    '--no-start-stack', '--no-embeddings', '--exclude', OUT];
  const t0 = Date.now();
  try {
    const r = spawnSync('unshare', ['-rn', build, ...argv], { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: timeoutMs });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[graph-assay] spawn failed: ${r.error.message}` : ''}${r.signal ? `\n[graph-assay] killed by ${r.signal}` : ''}`;
    const ok = r.status === 0 && (args !== null || fs.existsSync(path.join(out, 'export.json')));
    return { ok, status: r.status, signal: r.signal, output, stdout: r.stdout ?? '', ms: Date.now() - t0 };
  } finally {
    if (ownHome) fs.rmSync(h, { recursive: true, force: true });
  }
}

export function version(build = defaultBuild()) {
  const r = spawnSync(build, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.match(/\b\d+\.\d+\.\d+\S*/)?.[0] ?? null) : null;
}

const LANG = {
  '.py': 'python', '.pyi': 'python', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx', '.go': 'go', '.java': 'java',
  '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php',
  '.rb': 'ruby', '.kt': 'kotlin', '.scala': 'scala', '.lua': 'lua', '.dart': 'dart', '.md': 'markdown',
};
const lang = (p) => LANG[path.extname(p).toLowerCase()] ?? null;
const KIND = { CALLS: 'calls', INSTANTIATES: 'instantiates', IMPORTS: 'imports', REFERENCES: 'references', INHERITS: 'extends', IMPLEMENTS: 'implements', OVERRIDES: 'overrides' };
// `a.b.m(java.io.File,int)` -> ['a', 'b', 'm(java.io.File,int)']: dots inside a signature stay.
const segments = (q) => { const out = []; let cur = ''; let depth = 0; for (const ch of q) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === '.' && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const edgeKind = (t) => KIND[t] ?? (/^(DEFINES|CONTAINS)/.test(t) ? 'contains' : t.toLowerCase());

/** Map `dir`'s cgr export (left there by index()) to a snapshot v1. */
export function snapshot(dir, { build = null } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const g = JSON.parse(fs.readFileSync(path.join(dir, OUT, 'export.json'), 'utf8'));
  const lines = new Map();
  const lineCount = (p) => {
    if (!lines.has(p)) { let n = 1; try { n = fs.readFileSync(path.join(dir, p), 'utf8').split('\n').length; } catch { /* unreadable: 1 */ } lines.set(p, n); }
    return lines.get(p);
  };
  // Module qualified names, by path: a definition's local name is its qname minus its module's.
  const moduleQ = new Map(g.nodes.filter((n) => n.labels.includes('Module') && n.properties.path).map((n) => [n.properties.path, n.properties.qualified_name]));
  const nodes = [];
  const keep = new Set();
  for (const n of g.nodes) {
    const p = n.properties; const label = n.labels[0];
    // Project, Folder, Package, File (listed under files), and external modules (no path in the repo)
    if (!p.path || ['Project', 'Folder', 'Package', 'File'].includes(label) || label.startsWith('External')) continue;
    const id = String(n.node_id);
    keep.add(id);
    if (label === 'Module') {
      nodes.push({ id, kind: 'file', name: p.path, qname: p.path, file: p.path, language: lang(p.path), start: 1, end: lineCount(p.path) });
      continue;
    }
    const mq = moduleQ.get(p.path);
    const local = mq && p.qualified_name?.startsWith(`${mq}.`) ? p.qualified_name.slice(mq.length + 1) : (p.qualified_name ?? p.name);
    nodes.push({ id, kind: label.toLowerCase(), name: p.name ?? segments(local).pop(), qname: segments(local).join('::'), file: p.path,
      language: lang(p.path), start: p.start_line ?? 1, end: p.end_line ?? p.start_line ?? 1 });
  }
  const edges = [];
  for (const r of g.relationships) {
    const src = String(r.from_id); const dst = String(r.to_id);
    if (!keep.has(src) || !keep.has(dst)) continue;
    const q = r.properties ?? {};
    edges.push({ kind: edgeKind(r.type), src, dst, line: q.line ?? null, col: q.col ?? null, ref: null,
      resolvedBy: q.resolution ?? null, provenance: q.resolution && q.resolution !== 'exact' ? q.resolution : null });
  }
  const files = g.nodes.filter((n) => n.labels.includes('File') && n.properties.path).map((n) => ({ path: n.properties.path, language: lang(n.properties.path) }));
  return {
    schema: SNAPSHOT_SCHEMA,
    subject: { name, adapterSha256: adapterHash(name), version: build ? version(build) : null, config: { extras: 'treesitter-full', embeddings: false } },
    capabilities: {
      // cgr's export lists unresolved names per module without a line, so none are exported
      siteLines: true, siteColumns: true, columnEncoding: 'unknown', unresolved: false, provenance: true,
      edgeKinds: [...new Set(edges.map((e) => e.kind))].sort(),
    },
    files,
    nodes,
    edges,
    unresolved: [],
  };
}

// CLI: node lib/subjects/code-graph-rag.mjs index <dir> [cgr] | snapshot <dir> <out.json> [cgr]
if (isMain(import.meta.url)) {
  const [cmd, dir, a, b] = process.argv.slice(2);
  if (cmd === 'index' && dir) {
    const r = index(dir, a ?? defaultBuild());
    process.stdout.write(r.output);
    process.exit(r.ok ? 0 : (r.status || 1));
  } else if (cmd === 'snapshot' && dir && a) {
    const { writeSnapshot } = await import('../snapshot.mjs');
    writeSnapshot(a, snapshot(dir, { build: b ?? defaultBuild() }));
  } else {
    console.error('usage: code-graph-rag.mjs index <dir> [cgr] | snapshot <dir> <out.json> [cgr]');
    process.exit(2);
  }
}
