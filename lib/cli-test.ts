#!/usr/bin/env node
// Hermetic CLI and verdict regressions (part of `graph-assay check`): each check pins a failure that
// used to pass silently.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreFixture } from './fixture.ts';
import { gate } from './scores.ts';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const check = (name, fn) => { n++; try { fn(); } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }, ...opts });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-cli-test-'));

try {
  check('a CLI runs from a checkout path with a space in it', () => {
    const dir = path.join(tmp, 'path with space', 'lib');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['config.ts', 'main.ts']) fs.copyFileSync(path.join(qa, 'lib', f), path.join(dir, f));
    const r = run(process.execPath, [path.join(dir, 'config.ts'), 'tools']);
    assert.equal(r.status, 0, r.stderr); assert.notEqual(r.stdout.trim(), '', 'the main guard did not fire');
  });

  check('run-all.sh exits 2 on a missing targets file', () => {
    const r = run('bash', [path.join(qa, 'oracle/run-all.sh'), path.join(tmp, 'absent.txt')]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });

  check('run-all.sh runs a last line with no trailing newline', () => {
    const dir = path.join(tmp, 'runall'); fs.mkdirSync(dir);
    fs.copyFileSync(path.join(qa, 'oracle/run-all.sh'), path.join(dir, 'run-all.sh'));
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/usr/bin/env bash\necho "ran $1"\n'); fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
    fs.writeFileSync(path.join(dir, 't.txt'), 'a /x ts\nb /y ts');
    const r = run('bash', [path.join(dir, 'run-all.sh'), path.join(dir, 't.txt')]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ran b/);
  });

  check('replay exits 2 on an unknown or path-like fixture name', () => {
    const build = path.join(tmp, 'build.js'); fs.writeFileSync(build, '');
    for (const name of ['no-such-fixture', '../oracle-candidates']) {
      const r = run(process.execPath, [path.join(qa, 'fixtures/replay.mts'), build, name]);
      assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
    }
  });

  check('an empty graph never reads as FIXED', () => {
    const empty = { nodes: [], edges: [], files: [], unresolved: [] };
    const expect = { issue: 1, wrong: [{ from: 'caller', kind: 'calls', to: 'a.py:target' }], right: [] };
    assert.equal(scoreFixture(empty, expect).verdict, 'CHANGED');
  });

  check('the gate flags a fixture that errored on the new build as incomplete', () => {
    const r = gate({ repos: {}, replay: { f: 'FIXED' } }, { repos: {}, replay: { f: 'ERROR' } });
    assert.equal(r.verdict, 'NO MATERIAL CHANGE'); assert.equal(r.incomplete, true);
    assert.equal(gate({ repos: {}, replay: { f: 'FIXED' } }, { repos: {}, replay: { f: 'FIXED' } }).incomplete, false);
  });

  check('ORACLE_LANG outside the known set exits 2', () => {
    const r = run(process.execPath, [path.join(qa, 'oracle/oracle.ts'), tmp, path.join(tmp, 'x.scip')], { env: { ...process.env, ORACLE_LANG: 'java' } });
    assert.equal(r.status, 2, r.stderr);
  });

  check('labellers refuse to run outside a declared sandbox', () => {
    const env = { ...process.env }; delete env.GRAPH_ASSAY_LABEL_SANDBOX;
    const r = run(process.execPath, [path.join(qa, 'labels/run.mjs'), 'items.jsonl', tmp], { env });
    assert.equal(r.status, 2); assert.match(r.stderr, /sandbox/i);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (!process.exitCode) console.log(`${n}/${n} CLI regression checks`);
