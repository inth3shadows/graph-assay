#!/usr/bin/env node
// Docker's entry point. Orchestration only: all scores come from the existing scorers.
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { adapterHash } from '../lib/provenance.ts';
import { SPEC_VERSION } from '../lib/spec.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CORPUS, readRepos, fetchRepos } from '../differential/builds.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const usage = 'usage: tools/repro.mjs [--split dev] [--repo mux|requests|click|ky|express] [--out /results]';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const opts = { '--split': 'dev', '--out': '/results' };
while (args.length) {
  const k = args.shift(); const v = args.shift();
  if (!['--split', '--repo', '--out'].includes(k) || !v || v.startsWith('--')) throw new Error(usage);
  opts[k] = v;
}
if (opts['--split'] !== 'dev') throw new Error('Only the dev split is supported; heldout is reserved for publication.');
const repos = readRepos(CORPUS, 'dev').filter((r) => !opts['--repo'] || r.name === opts['--repo']);
if (!repos.length) throw new Error(`Unknown dev repo: ${opts['--repo']}`);
const out = path.resolve(opts['--out']);
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`Output must be empty (prevents mixing runs): ${out}`);
fs.mkdirSync(out, { recursive: true });
for (const d of ['logs', 'work', 'scip', 't1', 't3']) fs.mkdirSync(path.join(out, d));
const env = { ...process.env, ORACLE_WORK: path.join(out, 'work'), ORACLE_SCIP_CACHE: path.join(out, 'scip'),
  PYCG_DIR: path.join(out, 'pycg'), ORACLE_SHOW: '0', CODEGRAPH_KERNEL: '0' };
// Never inherit oracle switches that could change the scores or select a stale snapshot.
for (const k of ['ORACLE_DISABLE', 'ORACLE_MODE', 'ORACLE_LANG', 'ORACLE_SNAPSHOT', 'ORACLE_REDACT']) delete env[k];

function run(cmd, argv, label, { cwd = qa, extra = {}, allowedExitCodes = [0] } = {}) {
  console.log(`repro: ${label}`);
  const log = path.join(out, 'logs', `${label}.log`);
  const fd = fs.openSync(log, 'w');
  let r;
  try { r = spawnSync(cmd, argv, { cwd, env: { ...env, ...extra }, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  if (!allowedExitCodes.includes(r.status)) {
    console.error(fs.readFileSync(log, 'utf8').trim().split('\n').slice(-12).join('\n'));
    throw new Error(`${label}: ${r.error?.message ?? `exit ${r.status}, signal ${r.signal}`} (log: ${log})`);
  }
  const last = fs.readFileSync(log, 'utf8').trim().split('\n').pop();
  if (last) console.log(last);
}
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const note = 'Oracle noise is recomputed from the committed labels snapshot (labels/data/); no labeller runs here, and it covers the whole labelled sample whatever --repo selects.';
// SPEC §10 run identity beyond the per-file hashes: corpus version, effective subject timeout,
// expectation schema and labelling protocol (each oracle output records its position encodings).
const manifest = { schema: 'graph-assay/repro@1', spec: SPEC_VERSION, snapshotSchema: 'graph-assay/snapshot@1', expectationSchema: 'graph-assay/expect@1',
  corpus: { file: path.relative(qa, CORPUS), sha256: hash(CORPUS) }, subjectTimeoutMs: 600_000,
  labellingProtocol: hash(path.join(qa, 'labels', 'protocol.json')),
  adapters: Object.fromEntries(['codegraph', 'code-graph-rag'].map((name) => [name, adapterHash(name)])),
  started: new Date().toISOString(), platform: { os: os.release(), arch: os.arch(), node: process.version },
  repos, pycg: '8d5dc40837803beef1d8d379fbf2cdad6cd94641', noise: note, files: {}, status: 'running' };
// Include actual scorer/input bytes: Docker context intentionally excludes the host's .git.
for (const dir of ['lib', 'oracle', 'bench', 'benchmarks', 'fixtures', 'schema', 'corpus', 'docker', 'labels', 'metamorphic']) {
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(qa, d), { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) manifest.files[f] = hash(path.join(qa, f));
    }
  };
  walk(dir);
}
for (const f of ['Dockerfile', 'SPEC.md', 'tools/repro.mjs', 'differential/modes.ts', 'differential/package.json']) manifest.files[f] = hash(path.join(qa, f));
const save = () => fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
save();
try {
  // Fail early with the exact Docker namespace requirement, before fetching the corpus.
  run('unshare', ['-rn', 'true'], 'namespace-check');
  run('node', ['-e', `console.log(JSON.stringify({codegraph:await (await import('./lib/subjects/codegraph.ts')).version(process.env.CODEGRAPH_BUILD),cgr:(await import('./lib/subjects/code-graph-rag.ts')).version(),tools:(await import('./lib/manifest.ts')).tools()}))`], 'versions');
  manifest.versions = JSON.parse(fs.readFileSync(path.join(out, 'logs/versions.log'), 'utf8'));
  console.log('repro: fetch pinned dev corpus');
  const dirs = fetchRepos(path.join(out, 'repos'), repos);
  for (const [i, r] of repos.entries()) {
    if (r.setup === 'npm') {
      fs.copyFileSync(path.join(qa, 'docker', `${r.name}-package-lock.json`), path.join(dirs[i], 'package-lock.json'));
      run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], `setup-${r.name}`, { cwd: dirs[i] });
    }
    for (const subj of ['codegraph', 'code-graph-rag']) {
      run('bash', ['oracle/run.sh', r.name, dirs[i], { python: 'python', go: 'go', typescript: 'ts', javascript: 'ts' }[r.language]],
        `oracle-${r.name}-${subj}`, { extra: { CGQA_SUBJECT: subj, ORACLE_EXCLUDE: r.exclude.join(',') } });
    }
  }
  fetchRepos(out, [{ name: 'pycg', url: 'https://github.com/vitsalis/PyCG.git', sha: manifest.pycg }]);
  for (const [subj, tag] of [['codegraph', 'cg'], ['code-graph-rag', 'cgr']]) {
    for (const [stage, script] of [['replay', 'fixtures/replay.mts'], ['pycg', 'benchmarks/pycg.ts']]) {
      const json = path.join(out, 't1', `${stage}-${tag}.json`);
      run('node', [script, '--subject', subj, 'default', ...(stage === 'replay' && subj === 'codegraph' ? ['--canary'] : []), '--json', json], `${stage}-${tag}`);
      // PyCG reports indexing errors in JSON but currently exits zero; never publish partial T1.
      const data = JSON.parse(fs.readFileSync(json, 'utf8'));
      if (!data.results.length || data.results.some((r) => r.error || r.verdict === 'ERROR')) throw new Error(`${stage}-${tag}: incomplete T1 results`);
    }
  }
  for (const [subj, tag] of [['codegraph', 'cg'], ['code-graph-rag', 'cgr']]) {
    run('node', ['metamorphic/run.ts', '--subject', subj, 'default', 'fixtures', '--relations', 'decoy,shift,repeat', '--json', path.join(out, 't3', `meta-${tag}.json`)],
      `t3-${tag}`, { allowedExitCodes: [0, 1] });
  }
  // A subset gets its own corpus, so it cannot masquerade as the full dev table.
  const corpus = path.join(out, 'corpus.txt');
  fs.writeFileSync(corpus, repos.map((r) => [r.name, r.url, r.sha, r.language, r.license, r.split, r.category, r.setup, r.exclude.length ? r.exclude.join(',') : '-'].join(' ')).join('\n') + '\n');
  const data = path.join(qa, 'labels', 'data');
  const samples = fs.readdirSync(data).sort().flatMap((d) => [path.join(data, d, 'items.jsonl'), path.join(data, d)]);
  run('node', ['labels/noise.mjs', ...samples, '--protocol', path.join(qa, 'labels', 'protocol.json'), '--json', path.join(out, 'noise.json')], 'noise');
  run('node', ['bench/tables.ts', '--canonical', '--corpus', corpus, '--split', 'dev', '--t1', path.join(out, 't1'), '--t3', path.join(out, 't3'), '--seed', '1',
    '--noise', path.join(out, 'noise.json'), '--md', path.join(out, 'tables.md'), '--json', path.join(out, 'tables.json')], 'tables');
  const table = JSON.parse(fs.readFileSync(path.join(out, 'tables.json'), 'utf8'));
  if (table.missingRuns.length) throw new Error(`Missing oracle runs: ${table.missingRuns.join(', ')}`);
  fs.appendFileSync(path.join(out, 'tables.md'), `\n${note}\n`);
  manifest.status = 'complete'; save();
  console.log(`repro: complete — ${repos.length} dev repo(s), both subjects, T1 replay + PyCG + T3 robustness`);
  console.log(`repro: ${note}`);
  console.log(`repro: tables written to ${out}/tables.md and ${out}/tables.json`);
} catch (error) {
  manifest.status = 'failed'; manifest.error = error.message; save();
  console.error(`repro: FAILED: ${error.message}`); process.exitCode = 1;
}
