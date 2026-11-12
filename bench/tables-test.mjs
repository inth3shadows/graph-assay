#!/usr/bin/env node
// Hermetic SPEC §8/§9 checks for bench/tables.mjs on fabricated oracle outputs: a failed subject run
// is scored (recall 0, precision left out), averages are macro-first over the repos every subject
// ran, canonical tables refuse a missing run, and the function-pair track (SPEC §3) is scored.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRepos } from '../differential/builds.mjs';
import { SPEC_VERSION } from '../lib/spec.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-tables-'));
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const repos = readRepos(undefined, 'dev').map((r) => r.name);

const PAIRS = (o) => ({ oracle: 10, subject: 9, matched: 8, guessOnly: 0, subjectOnly: { oracleDisagrees: 1, oracleSilent: 3 }, skipped: 0,
  decorators: { total: 0, found: 0 }, unmappedEdges: { caller: 2, target: 1 }, skippedEdges: { 'skip-framework-self-site': 4 }, callerRanges: { enclosing: 5, braces: 0 }, unitsAtFileLevel: 1, ...o });
function fabricate(work, { failed = null, missingDir = null, noPairs = null, spec = SPEC_VERSION, noScored = null, noLines = null } = {}) {
  fs.rmSync(work, { recursive: true, force: true });
  for (const r of repos) {
    for (const sfx of ['', '-code-graph-rag']) {
      const dir = path.join(work, `w-pub-${r}${sfx}`);
      if (`${r}${sfx}` === missingDir) continue;
      if (`${r}${sfx}` === failed) {
        write(path.join(dir, 'out.json'), { buckets: {}, skipped: {}, subjectFailed: 'index exited 1', spec });
        write(path.join(dir, 'out-missing.json'), { buckets: { 'missing|file-not-indexed|py|method': 10 }, subjectFailed: 'index exited 1', decorators: { total: 0, causes: {} },
          pairs: PAIRS({ subject: 0, matched: 0, subjectOnly: { oracleDisagrees: 0, oracleSilent: 0 } }), spec });
      } else {
        const lines = `${r}${sfx}` !== noLines;
        write(path.join(dir, 'out.json'), { buckets: `${r}${sfx}` === noScored ? {} : { 'ok|calls': 9, 'wrong-target|calls|-|method>method': 1 }, skipped: {}, spec, siteLines: lines });
        write(path.join(dir, 'out-missing.json'), { buckets: { 'missing|found|py|method': 8, 'missing|no-ref|py|method': 2 }, decorators: { total: 0, causes: {} },
          skipped: { 'corpus-exclude': 1 }, waterfall: { filesInCorpus: 7, excluded: 2, supportedLanguage: 5, indexedBySubject: 4, indexedByOracle: 5 },
          ...(`${r}${sfx}` === noPairs ? {} : { pairs: PAIRS() }), spec, siteLines: lines });
      }
    }
  }
}
const tables = (work, extra = []) => {
  const out = path.join(tmp, 'out.json');
  const r = spawnSync(process.execPath, [path.join(qa, 'bench/tables.mjs'), '--json', out, '--md', path.join(tmp, 'out.md'), ...extra],
    { encoding: 'utf8', env: { ...process.env, ORACLE_WORK: work, NODE_NO_WARNINGS: '1' } });
  return { status: r.status, stderr: r.stderr, json: r.status === 0 ? JSON.parse(fs.readFileSync(out, 'utf8')) : null, md: r.status === 0 ? fs.readFileSync(path.join(tmp, 'out.md'), 'utf8') : '' };
};

try {
  const work = path.join(tmp, 'work');
  check('a failed subject run scores recall 0 and leaves precision out (SPEC §8)', () => {
    fabricate(work, { failed: repos[0] });
    const { status, json, md } = tables(work);
    assert.equal(status, 0);
    const cg = json.subjects.codegraph;
    assert.equal(cg.agg['recall strict'].macro, (0.8 * (repos.length - 1)) / repos.length);
    assert.equal(cg.agg['precision strict'].macro, 0.9);
    assert.equal(cg.agg['recall strict'].micro, (8 * (repos.length - 1)) / (10 * repos.length));
    assert.deepEqual(cg.failed, [`${repos[0]} (index exited 1)`]);
    assert.deepEqual(json.subjects['code-graph-rag'].failed, []);
    assert.match(md, /codegraph failed \(scored as misses/);
    assert.match(md, /\(FAILED: scored as misses\)/);
  });
  check('a repo one subject never ran is left out of every subject (SPEC §8)', () => {
    fabricate(work, { missingDir: `${repos[1]}-code-graph-rag` });
    const { status, json } = tables(work);
    assert.equal(status, 0);
    assert.deepEqual(json.averagedRepos, repos.filter((r) => r !== repos[1]));
    assert.equal(json.subjects.codegraph.agg['recall strict'].macro, 0.8);
  });
  check('canonical tables refuse a missing run', () => {
    fabricate(work, { missingDir: `${repos[1]}-code-graph-rag` });
    const { status, stderr } = tables(work, ['--canonical']);
    assert.equal(status, 2); assert.match(stderr, /canonical tables need every run/);
  });
  check('the coverage waterfall shows file steps and skipped call sites (SPEC §7)', () => {
    fabricate(work);
    const { md } = tables(work);
    assert.match(md, new RegExp(`\\| codegraph \\| ${repos[0]} \\| 7 \\| 2 \\| 5 \\| 4 \\| 5 \\| corpus-exclude 1 \\| 10 \\|`));
  });
  check('the T2 headline is macro (SPEC §9)', () => {
    fabricate(work);
    const { md } = tables(work);
    assert.match(md, /\| subject \| precision strict \(macro\) \| precision strict \(micro\) \|/);
  });
  check('the function-pair track scores matched pairs; a failed run is recall 0 (SPEC §3, §8)', () => {
    fabricate(work, { failed: repos[0] });
    const { status, json, md } = tables(work);
    assert.equal(status, 0);
    const cg = json.subjects.codegraph.agg; const cgr = json.subjects['code-graph-rag'].agg;
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
    near(cgr['pair precision'].macro, 8 / 9); near(cgr['pair recall'].macro, 0.8);
    near(cg['pair recall'].macro, (0.8 * (repos.length - 1)) / repos.length);
    near(cg['pair precision'].macro, 8 / 9);
    assert.match(md, /## T2 compiler agreement \(function-pair track\)/);
    assert.match(md, new RegExp(`\\| code-graph-rag \\| ${repos[0]} \\| 10 \\| 9 \\| 8 \\| 1 \\| 3 \\| 0 \\| 88\\.9% \\| 80\\.0% \\| 0 \\| - \\| 3 / 4 \\|`));
  });
  check('results from before the function-pair track are listed and left out of its averages', () => {
    fabricate(work, { noPairs: repos[1] });
    const { status, json, md } = tables(work);
    assert.equal(status, 0);
    assert.deepEqual(json.subjects.codegraph.noPairs, [repos[1]]);
    assert.ok(Math.abs(json.subjects.codegraph.agg['pair recall'].macro - 0.8) < 1e-12);
    assert.match(md, /codegraph: no function-pair results/);
  });
  check('canonical tables refuse results from another spec version; development tables mark them (SPEC §12)', () => {
    fabricate(work, { spec: 'SPEC v0' === SPEC_VERSION ? 'SPEC v0.9' : 'SPEC v0' });
    const c = tables(work, ['--canonical']);
    assert.equal(c.status, 2); assert.match(c.stderr, /canonical tables need SPEC v/);
    const d = tables(work);
    assert.equal(d.status, 0); assert.match(d.md, /Inputs scored under another spec version/);
    assert.equal(d.json.spec, SPEC_VERSION); assert.equal(d.json.bootstrap.seed, 1);
  });
  check('a zero denominator leaves the repo out of that average and lists it (SPEC §9)', () => {
    fabricate(work, { noScored: repos[0] });
    const { json, md } = tables(work);
    assert.deepEqual(json.subjects.codegraph.agg['precision strict'].zeroDenominator, [repos[0]]);
    assert.equal(json.subjects.codegraph.agg['precision strict'].macro, 0.9);
    assert.match(md, new RegExp(`Left out for a zero denominator \\(SPEC §9\\): codegraph precision strict: ${repos[0]}`));
  });
  check('a subject without site lines has no call-site score but keeps its pairs (SPEC §3)', () => {
    fabricate(work, { noLines: `${repos[0]}-code-graph-rag` });
    const { json, md } = tables(work);
    const cgr = json.subjects['code-graph-rag'];
    assert.deepEqual(cgr.noSiteLines, [repos[0]]);
    assert.equal(cgr.agg['recall strict'].micro, 0.8);
    assert.ok(Math.abs(cgr.agg['pair recall'].micro - 0.8) < 1e-12);
    assert.match(md, /code-graph-rag records no site lines/);
  });
  check('confidence bounds print to one decimal place (SPEC §9)', () => {
    fabricate(work);
    assert.match(tables(work).md, /\| codegraph \| 90\.0%( \[\d+\.\d-\d+\.\d\])? \|/);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${n}/${n} table checks`);
