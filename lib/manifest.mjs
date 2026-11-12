// A run manifest: everything that decides a run's results, content-addressed, so two runs are
// comparable only when their manifests say they ran the same scorers on the same inputs.
//
//   node lib/manifest.mjs <out.json> <codegraph.js> [stage=status ...] [--gate gate.json]
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from './config.mjs';
import { adapterHash } from './provenance.mjs';
import { SPEC_VERSION } from './spec.mjs';
import * as codegraph from './subjects/codegraph.mjs';
import { isMain } from './main.mjs';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** sha256 of every tracked scorer file, plus the repo's HEAD and whether it was dirty. */
export function scorers() {
  const files = (sh('git', ['ls-files', 'lib', 'oracle/*.mjs', 'metamorphic', 'benchmarks', 'fixtures/replay.mjs', 'differential/modes.mjs', 'schema', 'SPEC.md'], qa) ?? '')
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
  if (!out) { console.error('usage: node lib/manifest.mjs <out.json> <codegraph.js> [stage=status ...] [--gate gate.json]'); process.exit(2); }
  const gateAt = st.indexOf('--gate');
  const gateFile = gateAt < 0 ? null : st.splice(gateAt, 2)[1];
  const stages = Object.fromEntries(st.map((x) => x.split('=')).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
  const result = manifest(build ?? null, stages);
  result.gate = gateFile ? JSON.parse(fs.readFileSync(gateFile, 'utf8')) : { verdict: 'NOT COMPARED' };
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
}
