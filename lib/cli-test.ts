#!/usr/bin/env node
// Hermetic CLI and verdict regressions (part of `graph-assay check`): each check pins a failure that
// used to pass silently.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreFixture } from './fixture.ts';
import { issueLabel } from './expect.ts';
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
    for (const f of ['config.ts', 'main.ts', 'package.json']) fs.copyFileSync(path.join(qa, 'lib', f), path.join(dir, f));
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

  check('replay prints - for the issue of a fixture whose expect.json is unreadable or invalid (#36)', () => {
    const build = path.join(tmp, 'build.js'); fs.writeFileSync(build, '');
    const root = path.join(tmp, 'unparsed'); fs.mkdirSync(path.join(root, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bad', 'expect.json'), '{'); fs.writeFileSync(path.join(root, 'bad', 'a.py'), '');
    const edge = { from: 'f', kind: 'calls', to: 'a.py:g' };
    const bodies: [string, object][] = [['noissue', { wrong: [edge], right: [] }], ['filed', { issue: 7, wrong: [edge], right: [] }]];
    for (const [name, body] of bodies) {
      fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'expect.json'), JSON.stringify(body)); fs.writeFileSync(path.join(root, name, 'a.py'), '');
    }
    const out = path.join(tmp, 'unparsed.json');
    const r = run(process.execPath, [path.join(qa, 'fixtures/replay.mts'), '--root', root, build, 'bad', 'noissue', 'filed', '--json', out]);
    assert.match(r.stdout, /^ERROR +- +bad /m, r.stdout + r.stderr);
    assert.match(r.stdout, /^ERROR +- +noissue /m, r.stdout); // parses, but `issue` is missing: unknown
    assert.match(r.stdout, /^ERROR +#7 +filed /m, r.stdout); // valid; the index fails on the empty build
    const rows = Object.fromEntries(JSON.parse(fs.readFileSync(out, 'utf8')).results.map((x) => [x.name, x]));
    assert.equal('issue' in rows.bad, false); assert.equal(rows.filed.issue, 7);
    assert.equal(issueLabel(null), 'unfiled'); assert.equal(issueLabel(0), 'unfiled'); assert.equal(issueLabel(12), '#12');
  });

  check('graph-assay refuses a Node without unflagged type stripping, or 25+, with a message (#28)', () => {
    const as = (v) => {
      const pre = path.join(tmp, `node-${v}.mjs`);
      fs.writeFileSync(pre, `Object.defineProperty(process.versions, 'node', { value: '${v}' }); Object.defineProperty(process, 'version', { value: 'v${v}' });\n`);
      return run(process.execPath, ['--import', pathToFileURL(pre).href, path.join(qa, 'bin/graph-assay'), 'help']);
    };
    for (const v of ['22.17.0', '23.5.0', '25.0.0', '20.19.0']) {
      const r = as(v); assert.equal(r.status, 2, `${v}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, new RegExp(`needs Node .*this is v${v.replace(/\./g, '\\.')}`));
    }
    for (const v of ['22.18.0', '23.6.0', '24.22.1']) assert.equal(as(v).status, 0, v);
    // the CLI's range is package.json's engines
    const range = fs.readFileSync(path.join(qa, 'bin/graph-assay'), 'utf8').match(/const NODE_RANGE = '([^']+)'/)?.[1];
    assert.equal(range, JSON.parse(fs.readFileSync(path.join(qa, 'package.json'), 'utf8')).engines.node);
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
    const r = run(process.execPath, [path.join(qa, 'labels/run.ts'), 'items.jsonl', tmp], { env });
    assert.equal(r.status, 2); assert.match(r.stderr, /sandbox/i);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (!process.exitCode) console.log(`${n}/${n} CLI regression checks`);
