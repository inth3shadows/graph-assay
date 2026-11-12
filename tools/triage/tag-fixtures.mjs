#!/usr/bin/env node
// Tag every oracle-candidate fixture with the oracle shapes its bug produces, so `graph-assay triage` can
// match a ranked shape to the fixtures (and upstream issues) already filed for it (triage plan, T2).
// Each fixture is indexed with the given codegraph build and its language's SCIP indexer, and the
// oracle runs both directions on it; a fixture's shapes are its strict non-match bucket keys.
//
// Usage: node tools/triage/tag-fixtures.mjs <codegraph.js> [--out fixtures/known-shapes.json] [fixture ...]
//   Named fixtures are updated in the existing file (same build only); with none, every fixture is re-tagged.
// Needs the SCIP tools (lib/config.mjs `tools`). Java, Kotlin and PHP fixtures are listed as not tagged:
// the oracle has no indexer wired for them here.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../../lib/config.mjs';
import { copySeed } from '../../lib/fixture-install.mjs';
import * as codegraph from '../../lib/subjects/codegraph.mjs';
import { coverPath, coverTsconfig } from '../../oracle/ts-cover.mjs';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.join(qa, 'fixtures', 'oracle-candidates');
const args = process.argv.slice(2);
const ai = args.indexOf('--allow-failures'); const allowFailures = ai >= 0; if (allowFailures) args.splice(ai, 1);
const oi = args.indexOf('--out'); const out = oi >= 0 ? args.splice(oi, 2)[1] : path.join(qa, 'fixtures', 'known-shapes.json');
const [build, ...only] = args;
if (!build || !fs.existsSync(build)) { console.error('usage: tag-fixtures.mjs <codegraph.js> [--out file] [--allow-failures] [fixture ...]'); process.exit(2); }
const FORWARD_BAD = /^(wrong-target|external|local-shadow|cross-file-unimported|receiver-fallback)\|/;

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
  return r;
};
const files = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile());
const langOf = (fs_) => (fs_.some((f) => /\.(java|kt|php)$/.test(f)) ? null : fs_.some((f) => f.endsWith('.go')) ? 'go' : fs_.some((f) => f.endsWith('.py')) ? 'python' : 'ts');

// Naming fixtures updates just those entries; the build must then match the file's.
const prior = only.length && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
const result = { build: codegraph.version(build), generated: new Date().toISOString().slice(0, 10), fixtures: { ...prior?.fixtures } };
if (prior && prior.build !== result.build) { console.error(`${path.relative(process.cwd(), out)} was tagged at ${prior.build}; re-tag every fixture with that build, or name none`); process.exit(2); }
const unknown = only.filter((n) => n.includes('/') || !fs.existsSync(path.join(root, n, 'expect.json')));
if (unknown.length) { console.error(`no such fixture: ${unknown.join(', ')}`); process.exit(2); }
const names = (only.length ? only : fs.readdirSync(root)).filter((n) => fs.existsSync(path.join(root, n, 'expect.json'))).sort();
const failed = [];
for (const name of names) {
  const src = path.join(root, name);
  const expect = JSON.parse(fs.readFileSync(path.join(src, 'expect.json'), 'utf8'));
  const lang = langOf(files(src));
  if (!lang) { result.fixtures[name] = { issue: expect.issue || null, lang: 'other', shapes: null, note: 'no oracle indexer for this language' }; console.log(`${name}: not tagged (language)`); continue; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-tag-'));
  try {
    const repo = path.join(work, 'repo');
    copySeed(src, repo, (p) => path.basename(p) !== 'expect.json' && !p.includes('.codegraph'));
    // An installed package is a dependency, not project source: keep it out of the covering tsconfig.
    if (fs.existsSync(path.join(repo, 'node_modules'))) fs.appendFileSync(path.join(repo, '.gitignore'), '\nnode_modules/\n');
    run('git', ['init', '-q'], { cwd: repo }); run('git', ['add', '-A', '.'], { cwd: repo });
    const ix = codegraph.index(repo, build, { kernel: '0' });
    if (!ix.ok) throw new Error(`codegraph index failed: ${ix.output.trim().split('\n').slice(-2).join(' | ')}`);
    const scip = path.join(work, 'index.scip');
    if (lang === 'python') run('bash', [path.join(qa, 'oracle', 'scip-python.sh'), repo, scip]);
    else if (lang === 'go') run(path.join(config.tools, 'scip-go'), ['--output', scip], { cwd: repo });
    else {
      // as oracle/run.sh: a root tsconfig gets the covering project, a repo without one an inferred config
      const project = fs.existsSync(path.join(repo, 'tsconfig.json')) ? coverPath(repo) : null;
      if (project) fs.writeFileSync(project, JSON.stringify(coverTsconfig(repo)));
      run(process.execPath, [path.join(config.tools, 'node_modules/.bin/scip-typescript'), 'index', ...(project ? [project] : ['--infer-tsconfig']), '--output', scip], { cwd: repo });
    }
    const shapes = {};
    for (const mode of ['', 'missing']) {
      const o = path.join(work, `out${mode && '-missing'}.json`);
      run(process.execPath, [path.join(qa, 'oracle', 'oracle.mjs'), repo, scip, o], {
        env: { ...process.env, NODE_NO_WARNINGS: '1', ORACLE_SHOW: '0', ORACLE_LANG: lang === 'ts' ? '' : lang, ORACLE_MODE: mode } });
      for (const [key, n] of Object.entries(JSON.parse(fs.readFileSync(o, 'utf8')).buckets)) {
        if (mode ? key.split('|')[1] !== 'found' : FORWARD_BAD.test(`${key}|`)) shapes[key] = n;
      }
    }
    result.fixtures[name] = { issue: expect.issue || null, lang, shapes };
    console.log(`${name}: ${Object.keys(shapes).length ? Object.keys(shapes).join(', ') : 'no non-match shape'}`);
  } catch (e) {
    result.fixtures[name] = { issue: expect.issue || null, lang, shapes: null, note: String(e.message).slice(0, 200) };
    failed.push(name);
    console.log(`${name}: not tagged (${String(e.message).slice(0, 120)})`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
// A failed tag must not overwrite a good one: without --allow-failures nothing is written.
if (failed.length && !allowFailures) {
  console.error(`${failed.length} fixture(s) not tagged (${failed.join(', ')}); ${path.relative(process.cwd(), out)} left unchanged. Fix the cause, or pass --allow-failures to record them as untagged.`);
  process.exit(1);
}
fs.writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
