// The codegraph subject: index a directory in a sandboxed HOME, and export its SQLite store as a
// snapshot v1. This is the only place in graph-assay that knows codegraph's storage schema.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../config.mjs';
import { SNAPSHOT_SCHEMA } from '../snapshot.mjs';
import { adapterHash } from '../provenance.mjs';
import { isMain } from '../main.mjs';

export const name = 'codegraph';
export const defaultBuild = () => config.codegraphBuild;

/**
 * Run the codegraph build `build` (path to dist/bin/codegraph.js) in `dir`: `init -y` by default,
 * or any other `args` (`['sync']`). HOME is a fresh temp dir outside `dir` (codegraph refuses to
 * init inside its own HOME), removed afterwards; pass `home` to keep one across calls (init, then
 * syncs). `kernel`: '0' (default) = wasm; any other value must load the native kernel; null leaves
 * CODEGRAPH_KERNEL unset (codegraph's own default). `nice` runs it at nice 10. `env` adds variables
 * (codegraph's switches, e.g. CODEGRAPH_PARSE_WORKERS) on top of the sandbox. The sandbox passes
 * only an allowlisted environment (no tokens or keys from the caller's shell) and, where the kernel
 * allows unprivileged namespaces (Linux), runs without network (`unshare -rn`); see SECURITY.md.
 * Returns {ok, status, signal, output (stdout + stderr), stdout, ms, kernelLoaded}.
 */
// Environment a codegraph index may see: locale, paths and codegraph's own switches; nothing else.
const PASS_ENV = /^(PATH|LANG|LC_[A-Z]+|TZ|TMPDIR|NODE_OPTIONS|CODEGRAPH_[A-Z0-9_]+)$/;
let offline;
/** `unshare -rn` works here (Linux with unprivileged user namespaces); checked once. */
export const canIsolateNetwork = () => (offline ??= spawnSync('unshare', ['-rn', 'true']).status === 0);

export function index(dir, build, { kernel = process.env.CODEGRAPH_KERNEL ?? '0', timeoutMs = 600_000, args = ['init', '-y'], home = null, nice = false, env: extra = {} } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const ownHome = !home;
  const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  if (!ownHome) fs.mkdirSync(h, { recursive: true });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS_ENV.test(k))),
    HOME: h, USERPROFILE: h, XDG_CONFIG_HOME: path.join(h, '.config'),
    CODEGRAPH_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NODE_NO_WARNINGS: '1',
  };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEGRAPH_KERNEL']) delete env[k];
  if (kernel !== null) env.CODEGRAPH_KERNEL = kernel;
  if (kernel !== null && kernel !== '0') env.CODEGRAPH_KERNEL_DEBUG = '1';
  Object.assign(env, extra);
  const argv = [...(canIsolateNetwork() ? ['unshare', '-rn'] : []), process.execPath, path.resolve(build), ...args];
  const t0 = Date.now();
  try {
    const r = spawnSync(nice ? 'nice' : argv[0], nice ? ['-n', '10', ...argv] : argv.slice(1),
      { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: timeoutMs });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[graph-assay] spawn failed: ${r.error.message}` : ''}${r.signal ? `\n[graph-assay] killed by ${r.signal}` : ''}`;
    const kernelLoaded = /\[codegraph-kernel\] loaded /.test(output);
    const ok = r.status === 0 && (kernel === null || kernel === '0' || kernelLoaded);
    return { ok, status: r.status, signal: r.signal, output, stdout: r.stdout ?? '', ms: Date.now() - t0, kernelLoaded };
  } finally {
    if (ownHome) fs.rmSync(h, { recursive: true, force: true });
  }
}

/** The build's checkout sha (or null), for the snapshot's subject.version. */
export function version(build) {
  const r = spawnSync('git', ['-C', path.dirname(path.resolve(build)), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Export `dir`/.codegraph/codegraph.db as a snapshot v1. */
export function snapshot(dir, { build = null, kernel = process.env.CODEGRAPH_KERNEL ?? '0' } = {}) {
  dir = path.resolve(dir); // relative dirs would resolve twice once the tool runs with cwd = dir
  const db = new DatabaseSync(path.join(dir, '.codegraph/codegraph.db'), { readOnly: true });
  try {
    const nodes = db.prepare(`SELECT id, kind, name, qualified_name AS qname, file_path AS file, language,
                                     start_line AS start, end_line AS "end" FROM nodes`).all();
    const edges = db.prepare(`SELECT kind, source AS src, target AS dst, line, col, provenance,
                                     json_extract(metadata, '$.refName') AS ref,
                                     json_extract(metadata, '$.resolvedBy') AS resolvedBy
                                FROM edges`).all();
    const unresolved = db.prepare(`SELECT from_node_id AS src, file_path AS file, line, col,
                                          reference_name AS name, reference_kind AS kind FROM unresolved_refs`).all();
    const fileRows = db.prepare(`SELECT DISTINCT file_path AS path, language FROM nodes WHERE kind = 'file'`).all();
    return {
      schema: SNAPSHOT_SCHEMA,
      subject: { name, adapterSha256: adapterHash(name), version: build ? version(build) : null, config: { kernel: kernel === '0' ? 'wasm' : 'native' } },
      capabilities: {
        // columns are UTF-16 code units (TS and Python; lib/conformance.mjs checks it)
        siteLines: true, siteColumns: true, columnEncoding: 'utf16', unresolved: true, provenance: true,
        edgeKinds: [...new Set(edges.map((e) => e.kind))].sort(),
      },
      files: fileRows,
      nodes: nodes.map((n) => ({ ...n, id: String(n.id) })),
      edges: edges.map((e) => ({ ...e, src: String(e.src), dst: String(e.dst) })),
      unresolved: unresolved.map((u) => ({ ...u, src: u.src == null ? null : String(u.src) })),
    };
  } finally {
    db.close();
  }
}

// CLI, for shell scripts:
//   node lib/subjects/codegraph.mjs index <dir> <codegraph.js>      exit status = codegraph's; output to stdout
//   node lib/subjects/codegraph.mjs snapshot <dir> <out.json> [codegraph.js]
if (isMain(import.meta.url)) {
  const [cmd, dir, a, b] = process.argv.slice(2);
  if (cmd === 'index' && dir && a) {
    const r = index(dir, a, { nice: process.env.CGQA_NICE === '1' });
    process.stdout.write(r.output);
    process.exit(r.ok ? 0 : (r.status || 1));
  } else if (cmd === 'snapshot' && dir && a) {
    const { writeSnapshot } = await import('../snapshot.mjs');
    writeSnapshot(a, snapshot(dir, { build: b ?? null }));
  } else {
    console.error('usage: codegraph.mjs index <dir> <codegraph.js> | snapshot <dir> <out.json> [codegraph.js]');
    process.exit(2);
  }
}
