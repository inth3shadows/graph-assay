#!/usr/bin/env node
// Rebuild an oracle self-test case's frozen inputs from its sources: snapshot.json (a fresh
// codegraph index, exported by lib/subjects/codegraph.ts) and index.scip.json (scip-python /
// scip-typescript, decoded). Run it after editing a case's sources, then re-check the case's
// expectations with run.ts --dump.
//
// Usage: node oracle/test/regen.ts <codegraph.js> [case ...]
// A case.json `subject` (e.g. code-graph-rag, for a behavior only that subject shows) indexes with
// that subject's default build instead.
// The inputs are frozen so the tests pin the ORACLE: a later codegraph fix must not break them.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../../lib/config.ts';
import { loadScip } from '../../lib/scip.ts';
import { writeSnapshot } from '../../lib/snapshot.ts';
import { subject } from '../../lib/subjects/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const [build, ...only] = process.argv.slice(2);
if (!build || !fs.existsSync(build)) { console.error('usage: node oracle/test/regen.ts <codegraph.js> [case ...]'); process.exit(2); }
const cases = only.length ? only : fs.readdirSync(here).filter((n) => fs.existsSync(path.join(here, n, 'case.json'))).sort();
const FROZEN = new Set(['case.json', 'snapshot.json', 'index.scip.json']);

const run = (cmd: string, args: string[], opts?: object) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ')}`);
  return r;
};

for (const name of cases) {
  const dir = path.join(here, name);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  if (spec.inputs) { console.log(`${name}: reuses ${spec.inputs}'s inputs`); continue; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-test-'));
  try {
    const repo = path.join(work, 'repo');
    fs.cpSync(dir, repo, { recursive: true, filter: (p) => !FROZEN.has(path.basename(p)) && !p.includes('.codegraph') });
    const subj = subject(spec.subject ?? 'codegraph');
    const b = spec.subject ? subj.defaultBuild() : build;
    const r = subj.index(repo, b, { kernel: '0' });
    if (!r.ok) throw new Error(`${subj.name} index failed: ${r.output.trim().split('\n').slice(-3).join(' | ')}`);
    const snap = subj.snapshot(repo, { build: b, kernel: '0' });
    fs.rmSync(path.join(repo, '.graph-assay'), { recursive: true, force: true });
    writeSnapshot(path.join(dir, 'snapshot.json'), snap);
    const scip = path.join(work, 'index.scip');
    if (spec.lang === 'go') {
      // as oracle/run.sh: scip-go at the module root (the case holds a go.mod)
      run(path.join(config.tools, 'scip-go'), ['--output', scip], { cwd: repo });
    } else if (spec.lang === 'python') {
      run('git', ['init', '-q'], { cwd: repo });
      run('git', ['add', '-A', '.'], { cwd: repo });
      run('bash', [path.join(here, '..', 'scip-python.sh'), repo, scip]);
    } else {
      // as oracle/run.sh: a plain-JS case (no tsconfig / jsconfig) gets an inferred one
      const infer = fs.existsSync(path.join(repo, 'tsconfig.json')) || fs.existsSync(path.join(repo, 'jsconfig.json')) ? [] : ['--infer-tsconfig'];
      run(process.execPath, [path.join(config.tools, 'node_modules/.bin/scip-typescript'), 'index', ...infer, '--output', scip], { cwd: repo });
    }
    fs.writeFileSync(path.join(dir, 'index.scip.json'), JSON.stringify(loadScip(scip)));
    console.log(`${name}: snapshot.json (${snap.nodes.length} nodes, ${snap.edges.length} edges), index.scip.json`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
