// A run manifest: everything that decides a run's results, content-addressed, so two runs are
// comparable only when their manifests say they ran the same scorers on the same inputs.
//
//   node lib/manifest.ts <out.json> <codegraph.js> [stage=status ...] [--gate gate.json]
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from './config.ts';
import { adapterHash } from './provenance.ts';
import { SPEC_VERSION } from './spec.ts';
import * as codegraph from './subjects/codegraph.ts';
import { isMain } from './main.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sh = (cmd: string, args: string[], cwd?: string): string | null => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Scripts holding a `node -e` program that runs from the repo root: their imports may resolve from there. */
const ROOT_RELATIVE = new Set(['tools/repro.ts']);
/** Every repo file the entries load through relative imports (`import ... from`, `export ... from`, a
 * bare `import '...'`, `import('...')` and `require('...')` with a literal path; comments are not read),
 * plus, for a .ts or .js file, the package.json that decides how it loads: the nearest one above it, as
 * Node finds it. A specifier that resolves to no file is an error, never skipped; only ROOT_RELATIVE
 * scripts may resolve one from the repo root. */
export function importClosure(entries: string[], root = qa) {
  const seen = new Set<string>();
  const todo = [...entries];
  const marker = (rel: string) => {
    for (let d = path.posix.dirname(rel); ; d = path.posix.dirname(d)) {
      const pkg = d === '.' ? 'package.json' : `${d}/package.json`;
      if (fs.existsSync(path.join(root, pkg))) return pkg;
      if (d === '.') return null;
    }
  };
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    // .mts/.mjs (and .cts/.cjs) fix their own module type; .ts and .js take the nearest package.json's.
    const pkg = /\.(ts|js)$/.test(rel) && !rel.endsWith('.d.ts') ? marker(rel) : null;
    if (pkg) seen.add(pkg);
    // A template literal counts only without `${`: a computed path cannot be followed, and must be listed by hand.
    const src = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}()])\/\/[^\n]*/gm, '$1');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(?:['"](\.{1,2}\/[^'"]+)['"]|`(\.{1,2}\/[^`$]+)`)/g)) {
      const spec = (m[1] ?? m[2]).replace(/[?#].*$/, '');
      const tries = [path.posix.join(path.posix.dirname(rel), spec), ...(ROOT_RELATIVE.has(rel) ? [spec] : [])].map((x) => path.posix.normalize(x));
      const dep = tries.find((x) => fs.statSync(path.join(root, x), { throwIfNoEntry: false })?.isFile());
      if (!dep) throw new Error(`${rel}: import '${spec}' resolves to no file`);
      todo.push(dep);
    }
  }
  return [...seen].sort();
}
/** The scripts whose output is a score or a table: the oracle, the tables (with T3 and the noise gate),
 * the noise table, fixture replay, PyCG, the metamorphic relations and the build differ. */
export const SCORING_ENTRIES = ['oracle/oracle.ts', 'bench/tables.ts', 'labels/noise.ts', 'fixtures/replay.mts', 'benchmarks/pycg.ts', 'metamorphic/run.ts', 'differential/builds.ts'];

/** sha256 of every tracked scorer file, plus the repo's HEAD and whether it was dirty. The list covers
 * every file a scoring entry point loads (lib/manifest-test.ts walks their imports to pin it): the
 * tables and T3, the noise table and gate (`labels/`), and the corpus reader the tables and the build
 * differ share (`differential/builds.ts`); and the scripts run by path, which no import reaches: the
 * oracle's shell steps (`oracle/run.sh` and the indexer wrappers it calls). */
export function scorers() {
  const files = (sh('git', ['ls-files', 'lib', ':(glob)oracle/*.ts', ':(glob)oracle/*.sh', ':(glob)oracle/test/*.ts', 'oracle/package.json', 'bench/tables.ts', 'bench/robustness.ts', 'bench/package.json', 'metamorphic', 'benchmarks', 'fixtures/replay.mts',
    'differential/builds.ts', 'differential/modes.ts', 'differential/package.json', 'labels/noise.ts', 'labels/score.ts', 'labels/strata.ts', 'labels/questions.ts', 'labels/protocol.ts',
    'labels/labellers.ts', 'labels/package.json', 'schema', 'SPEC.md'], qa) ?? '')
    .split('\n').filter(Boolean).sort();
  const hashes = Object.fromEntries(files.map((f) => [f, sha(path.join(qa, f))]));
  const all = createHash('sha256').update(files.map((f) => `${f} ${hashes[f]}`).join('\n')).digest('hex');
  return { head: sh('git', ['rev-parse', 'HEAD'], qa), dirty: Boolean(sh('git', ['status', '--porcelain', '--', ...files], qa)), sha256: all, files: hashes };
}

export function tools() {
  const ver = (pkg) => { try { return JSON.parse(fs.readFileSync(path.join(config.tools, 'node_modules', pkg, 'package.json'), 'utf8')).version; } catch { return null; } };
  return {
    'scip-typescript': ver('@sourcegraph/scip-typescript'),
    'scip-python': ver('@sourcegraph/scip-python'),
    scip: sh(config.scipBin, ['--version']),
    'scip-go': sh(path.join(config.tools, 'scip-go'), ['--version']),
  };
}

export function manifest(build, stages = {}) {
  return {
    schema: 'graph-assay/manifest@1',
    at: new Date().toISOString(),
    spec: SPEC_VERSION,
    snapshotSchema: 'graph-assay/snapshot@1',
    scorers: scorers(),
    subject: { name: 'codegraph', adapterSha256: adapterHash('codegraph'), build, version: build ? codegraph.version(build) : null, kernel: process.env.CODEGRAPH_KERNEL ?? '0' },
    tools: tools(),
    platform: { os: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version },
    stages,
  };
}

if (isMain(import.meta.url)) {
  const [out, build, ...st] = process.argv.slice(2);
  if (!out) { console.error('usage: node lib/manifest.ts <out.json> <codegraph.js> [stage=status ...] [--gate gate.json]'); process.exit(2); }
  const gateAt = st.indexOf('--gate');
  const gateFile = gateAt < 0 ? null : st.splice(gateAt, 2)[1];
  const stages = Object.fromEntries(st.map((x) => x.split('=')).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
  const result: ReturnType<typeof manifest> & { gate?: unknown } = manifest(build ?? null, stages);
  result.gate = gateFile ? JSON.parse(fs.readFileSync(gateFile, 'utf8')) : { verdict: 'NOT COMPARED' };
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
}
