#!/usr/bin/env node
// Hermetic provenance and evaluation isolation checks, including the actual replay/oracle/table CLIs.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { adapterHash, ADAPTER_SHARED, recordedAdapterHash } from './provenance.ts';
import { copyFixture, markerLeaks, scoreFixture } from './fixture.ts';
import { validateSnapshot } from './snapshot.ts';
import { gate } from './scores.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-anti-gaming-'));
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const env = { ...process.env, XDG_CONFIG_HOME: tmp, XDG_CACHE_HOME: tmp, NODE_NO_WARNINGS: '1' };
const run = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
const clone = (x) => JSON.parse(JSON.stringify(x));
const hashA = 'a'.repeat(64); const hashB = 'b'.repeat(64);
const snap = { schema: 'graph-assay/snapshot@1', subject: { name: 'codegraph' },
  capabilities: { siteLines: true, siteColumns: true, unresolved: true, provenance: true },
  files: [{ path: 'main.js', language: 'javascript' }],
  nodes: [{ id: '1', name: 'main.js', kind: 'file', file: 'main.js', start: 1, end: 2 },
    { id: '2', name: 'f', kind: 'function', file: 'main.js', start: 1, end: 1 }],
  edges: [{ kind: 'calls', src: '1', dst: '2', line: 2, col: 0, provenance: null }], unresolved: [] };
const edge = { from: 'main.js', kind: 'calls', to: 'main.js:f', toLine: 1 };
const expect = { issue: 1, wrong: [], right: [edge] };
try {
  const root = path.join(tmp, 'hash-root'); const moved = path.join(tmp, 'moved');
  const files = [...ADAPTER_SHARED, 'lib/subjects/codegraph.ts', 'lib/subjects/code-graph-rag.ts'];
  for (const file of files) write(path.join(root, file), fs.readFileSync(path.join(qa, file), 'utf8'));
  const cg = adapterHash('codegraph', root); const cgr = adapterHash('code-graph-rag', root);
  check('adapter hashes are deterministic, subject-specific and independent of install path/.git', () => {
    fs.cpSync(root, moved, { recursive: true });
    assert.match(cg, /^[a-f0-9]{64}$/); assert.notEqual(cg, cgr);
    assert.equal(cg, adapterHash('codegraph', moved)); assert.equal(cgr, adapterHash('code-graph-rag', moved));
  });
  check('editing one adapter invalidates its hash but not the peer', () => {
    fs.appendFileSync(path.join(root, 'lib/subjects/codegraph.ts'), '\n// edit\n');
    assert.notEqual(cg, adapterHash('codegraph', root)); assert.equal(cgr, adapterHash('code-graph-rag', root));
  });
  check('shared implementation/schema changes invalidate both adapters without a commit', () => {
    for (const file of ADAPTER_SHARED) {
      const before = ['codegraph', 'code-graph-rag'].map((name) => adapterHash(name, moved));
      fs.appendFileSync(path.join(moved, file), '\n');
      for (const [i, name] of ['codegraph', 'code-graph-rag'].entries()) assert.notEqual(before[i], adapterHash(name, moved));
    }
    assert.throws(() => adapterHash('unknown', root), /unknown adapter/);
    fs.unlinkSync(path.join(root, 'lib/config.ts')); assert.throws(() => adapterHash('codegraph', root), /ENOENT/);
  });
  check('snapshot contract accepts legacy and valid hashes, rejects malformed typed hashes', () => {
    assert.deepEqual(validateSnapshot(snap), []);
    assert.deepEqual(validateSnapshot({ ...snap, subject: { name: 'codegraph', adapterSha256: hashA } }), []);
    for (const value of [null, 'bad', [hashA]]) assert(validateSnapshot({ ...snap, subject: { name: 'codegraph', adapterSha256: value } }).length);
    assert.equal(recordedAdapterHash(snap), null); assert.equal(recordedAdapterHash({ subject: { adapterSha256: hashA } }), hashA);
  });
  check('fixture scoring preserves correct, wrong, guessed and missing edge verdicts', () => {
    assert.equal(scoreFixture(snap, expect).verdict, 'FIXED');
    assert.equal(scoreFixture({ ...snap, edges: [] }, expect).verdict, 'BROKEN');
    const wrong = { issue: 1, wrong: [edge], right: [] };
    assert.equal(scoreFixture(snap, wrong).verdict, 'BROKEN');
    const guessed = clone(snap); guessed.edges[0].provenance = 'heuristic';
    assert.equal(scoreFixture(guessed, wrong).verdict, 'GUESSED');
    assert.equal(scoreFixture({ ...snap, edges: [] }, { issue: 1, wrong: [edge], right: [edge] }).verdict, 'CHANGED');
    // SPEC §4: a guess never satisfies a right edge
    const onlyGuessed = scoreFixture(guessed, expect);
    assert.equal(onlyGuessed.verdict, 'BROKEN'); assert.equal(onlyGuessed.guessOnly.length, 1);
    assert.deepEqual(scoreFixture(snap, expect).guessOnly, []);
  });
  check('a caller found by qualified name counts as present (route node named GET /..., #29)', () => {
    // codegraph names a Laravel route node `GET /api/admin/users/{id}`; only its qualified name ends
    // in `route:/admin/users/{id}`, which is what a fixture's `from` is written as.
    const from = 'routes/api.php::route:/admin/users/{id}';
    const route = { id: 'r', name: 'GET /api/admin/users/{id}', qname: from, kind: 'route', file: 'routes/api.php', start: 4, end: 4 };
    const admin = { id: 'a', name: 'show', qname: 'App\\Admin::UserController::show', kind: 'method', file: 'Admin.php', start: 3, end: 3 };
    const top = { id: 't', name: 'show', qname: 'App::UserController::show', kind: 'method', file: 'User.php', start: 3, end: 3 };
    const routeSnap = { ...snap, nodes: [route, admin, top], edges: [{ kind: 'references', src: 'r', dst: 'a', line: 4, col: 0, provenance: null }] };
    const routeExpect = { issue: 2975, wrong: [{ from, kind: 'references', to: 'User.php:App::UserController::show' }],
      right: [{ from, kind: 'references', to: 'Admin.php:App\\Admin::UserController::show' }] };
    assert.equal(scoreFixture(routeSnap, routeExpect).verdict, 'FIXED');
    // the safeguard stays: a graph without the caller at all is not a fix
    assert.equal(scoreFixture({ ...routeSnap, nodes: [admin, top], edges: [] }, { ...routeExpect, right: [] }).verdict, 'CHANGED');
  });
  check('the qualified-name caller match is exact, and never a file node or another file (#29 review)', () => {
    const top = { id: 't', name: 'show', qname: 'App::UserController::show', kind: 'method', file: 'User.php', start: 3, end: 3 };
    const wrongOnly = (from, extra = {}) => ({ issue: 1, wrong: [{ from, kind: 'references', to: 'User.php:App::UserController::show', ...extra }], right: [] });
    const score = (nodes, expect) => scoreFixture({ ...snap, nodes: [top, ...nodes], edges: [] }, expect).verdict;
    // a file node's qualified name is its path, but an empty or unparsed file proves nothing about the caller
    const fileNode = { id: 'f', name: 'hooks.js', qname: 'lib/hooks.js', kind: 'file', file: 'lib/hooks.js', start: 1, end: 1 };
    assert.equal(score([fileNode], wrongOnly('lib/hooks.js')), 'CHANGED');
    // a route with the same path in another file, or a bare tail, is not the caller
    const from = 'routes/api.php::route:/admin/users/{id}';
    const web = { id: 'w', name: 'GET /admin/users/{id}', qname: 'routes/web.php::route:/admin/users/{id}', kind: 'route', file: 'routes/web.php', start: 2, end: 2 };
    const bare = { id: 'b', name: 'GET /admin/users/{id}', qname: 'route:/admin/users/{id}', kind: 'route', file: 'routes/web.php', start: 2, end: 2 };
    assert.equal(score([web], wrongOnly(from)), 'CHANGED');
    assert.equal(score([bare], wrongOnly(from)), 'CHANGED');
    // a parenthesised route group is part of the name, not a signature to strip
    const slug = { id: 's', name: 'GET /users/(slug)', qname: 'routes/api.php::route:/users/(slug)', kind: 'route', file: 'routes/api.php', start: 2, end: 2 };
    assert.equal(score([slug], wrongOnly('routes/api.php::route:/users/(\\d+)')), 'CHANGED');
    // fromFile pins the caller's file
    const api = { id: 'a', name: 'GET /api/admin/users/{id}', qname: from, kind: 'route', file: 'routes/api.php', start: 4, end: 4 };
    assert.equal(score([api], wrongOnly(from, { fromFile: 'routes/other.php' })), 'CHANGED');
    assert.equal(score([api], wrongOnly(from, { fromFile: 'routes/api.php' })), 'FIXED');
    // a node with no qualified name is matched on its name, as an edge source is
    const noQname = { id: 'n', name: 'Cls::method', kind: 'method', file: 'a.php', start: 1, end: 1 };
    assert.equal(score([noQname], wrongOnly('Cls::method')), 'FIXED');
  });
  const seed = path.join(tmp, 'seed'); write(path.join(seed, 'main.js'), 'export function f() {}\nf();\n');
  write(path.join(seed, 'main.py'), '#!/usr/bin/env python3\nfrom __future__ import annotations\ndef f(): pass\nf()\n');
  for (const file of ['expect.json', 'nested/expect.json', '.codegraph/stale', '.claude/control', '.env', 'AGENTS.md']) write(path.join(seed, file), 'CGQA_EVALUATION_ONLY_MARKER');
  check('ordinary copies exclude evaluator answers/control files/generated graphs, preserving source', () => {
    const dest = path.join(tmp, 'plain'); assert.equal(copyFixture(seed, dest), null);
    for (const file of ['expect.json', 'nested/expect.json', '.codegraph', '.claude', '.env', 'AGENTS.md']) assert(!fs.existsSync(path.join(dest, file)), file);
    assert.equal(fs.readFileSync(path.join(dest, 'main.js'), 'utf8'), fs.readFileSync(path.join(seed, 'main.js'), 'utf8'));
  });
  check('canaries have fresh markers and preserve existing source coordinates/shebang/future imports', () => {
    const a = path.join(tmp, 'canary-a'); const b = path.join(tmp, 'canary-b');
    const x = copyFixture(seed, a, { canary: true }); const y = copyFixture(seed, b, { canary: true });
    assert.notEqual(x.marker, y.marker); assert.deepEqual(x.files, ['main.js', 'main.py']);
    for (const file of x.files) assert(fs.readFileSync(path.join(a, file), 'utf8').startsWith(fs.readFileSync(path.join(seed, file), 'utf8')));
    assert.match(fs.readFileSync(path.join(a, 'main.js'), 'utf8'), new RegExp(`// ${x.marker}`));
    assert.match(fs.readFileSync(path.join(a, 'main.py'), 'utf8'), new RegExp(`# ${x.marker}`));
    const noSource = path.join(tmp, 'no-source'); write(path.join(noSource, 'data.txt'), 'text');
    assert.throws(() => copyFixture(noSource, path.join(tmp, 'no-source-out'), { canary: true }), /no supported source/);
  });
  check('symlink input cannot bypass expectation isolation', () => {
    const linked = path.join(tmp, 'linked'); write(path.join(linked, 'ok.js'), 'f()');
    fs.symlinkSync(path.join(seed, 'expect.json'), path.join(linked, 'answers.json'));
    assert.throws(() => copyFixture(linked, path.join(tmp, 'linked-out')), /symlink/);
  });
  check('marker scanning covers node names, qnames, edge refs and unresolved names', () => {
    const s = clone(snap); s.nodes[0].name = 'MARK'; s.nodes[1].qname = 'prefixMARK'; s.edges[0].ref = 'MARK'; s.unresolved = [{ name: 'MARK' }];
    assert.equal(markerLeaks(s, 'MARK').length, 4); assert.deepEqual(markerLeaks(snap, 'MARK'), []);
  });

  check('PHP corpus and open/closed PHP comment canaries preserve source and PHP lexical context', () => {
    const source = path.join(tmp, 'php');
    write(path.join(source, 'open.php'), '<?php\nfunction f() {}\nf();\n');
    write(path.join(source, 'closed.php'), '<?php\nfunction g() {}\ng();\n?>');
    const target = path.join(tmp, 'php-out'); const input = copyFixture(source, target, { canary: true });
    assert.deepEqual(input.files, ['closed.php', 'open.php']);
    for (const file of input.files) assert(fs.readFileSync(path.join(target, file), 'utf8').startsWith(fs.readFileSync(path.join(source, file), 'utf8')));
    assert.match(fs.readFileSync(path.join(target, 'open.php'), 'utf8'), new RegExp(`\n// ${input.marker}`));
    assert.match(fs.readFileSync(path.join(target, 'closed.php'), 'utf8'), new RegExp(`<\\?php /\\* ${input.marker} \\*/`));
    const corpus = copyFixture(path.join(qa, 'fixtures/oracle-candidates/issue-2975'), path.join(tmp, 'php-corpus'), { canary: true });
    assert.equal(corpus.files.length, 3);
    const mixed = path.join(tmp, 'php-mixed'); write(path.join(mixed, 'mixed.php'), '<?php f(); ?> trailing HTML');
    assert.throws(() => copyFixture(mixed, path.join(tmp, 'php-mixed-out'), { canary: true }), /mixed PHP/);
  });

  // Real oracle must identify the loaded snapshot, never today's adapter.
  for (const hash of [undefined, hashA]) check(`oracle preserves ${hash ? 'recorded' : 'legacy unknown'} snapshot provenance`, () => {
    const frozen = read(path.join(qa, 'oracle/test/ts-forward/snapshot.json'));
    if (hash) frozen.subject.adapterSha256 = hash;
    const input = path.join(tmp, 'snapshot.json'); const output = path.join(tmp, 'oracle.json'); write(input, frozen);
    const dir = path.join(qa, 'oracle/test/ts-forward');
    const r = run(path.join(qa, 'oracle/oracle.mjs'), [dir, path.join(dir, 'index.scip.json'), output], { ORACLE_SNAPSHOT: input, ORACLE_LANG: 'ts' });
    assert.equal(r.status, 0, r.stderr); assert.equal(read(output).adapterSha256, hash ?? null);
  });
  const fwd = { total: 10, buckets: { 'ok|calls': 10 }, groups: {}, adapterSha256: hashA };
  const miss = { total: 10, buckets: { 'missing|found|ts': 10 }, groups: {}, adapterSha256: hashB };
  const work = path.join(tmp, 'work'); write(path.join(work, 'w-tiny/out.json'), fwd); write(path.join(work, 'w-tiny/out-missing.json'), miss);
  check('baseline preserves per-mode and T1 adapter hashes and canary results', () => {
    const dir = path.join(tmp, 'baseline'); const targets = path.join(tmp, 'targets.txt');
    write(targets, 'tiny unused ts\n'); write(path.join(dir, 'replay.json'), { subject: 'codegraph', adapterSha256: hashA, results: [{ name: 'f', verdict: 'FIXED' }], canaries: { f: { status: 'FAIL' } } });
    write(path.join(dir, 'pycg.json'), { adapterSha256: hashB, categories: {} });
    const r = run(path.join(qa, 'oracle/baseline.mjs'), ['save', dir, '--work', work, '--targets', targets]);
    assert.equal(r.status, 0, r.stderr); const b = read(path.join(dir, 'baseline.json'));
    assert.equal(b.repos.tiny.forward.adapterSha256, hashA); assert.equal(b.repos.tiny.missing.adapterSha256, hashB);
    assert.equal(b.adapters.replay, hashA); assert.equal(b.adapters.pycg, hashB); assert.equal(b.canaries.f.status, 'FAIL');
  });
  check('tables retain mixed/legacy input provenance instead of stamping the current adapter', () => {
    const corpus = path.join(tmp, 'corpus.txt'); const output = path.join(tmp, 'tables.json');
    write(corpus, 'tiny https://example.invalid/tiny aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa typescript MIT dev small none\n');
    let r = run(path.join(qa, 'bench/tables.mjs'), ['--corpus', corpus, '--json', output], { ORACLE_WORK: work });
    assert.equal(r.status, 0, r.stderr); let data = read(output).subjects.codegraph;
    assert.deepEqual(data.adapterHashes, [hashA, hashB]); assert.equal(data.adapterSha256, null);
    const legacy = { ...miss }; delete legacy.adapterSha256; write(path.join(work, 'w-tiny/out-missing.json'), legacy);
    r = run(path.join(qa, 'bench/tables.mjs'), ['--corpus', corpus, '--json', output], { ORACLE_WORK: work });
    assert.equal(r.status, 0, r.stderr); data = read(output).subjects.codegraph;
    assert.deepEqual(data.adapterHashes, [hashA, null]); assert.match(r.stdout, /unknown \(legacy\)/);
  });
  check('canary PASS -> FAIL/ERROR regresses, recovery improves, missing runs incomparable', () => {
    const a = { canaries: { f: { status: 'PASS' } } };
    for (const status of ['FAIL', 'ERROR']) {
      const b = { canaries: { f: { status } } }; assert.equal(gate(a, b).verdict, 'REGRESSION'); assert.equal(gate(b, a).verdict, 'IMPROVEMENT');
    }
    const missing = gate(a, {}); assert.equal(missing.verdict, 'NO MATERIAL CHANGE'); assert.equal(missing.incomparable.length, 1);
  });

  // Actual replay CLI with a stub subject; the stub refuses any indexed copy containing answers.
  const fake = path.join(tmp, 'qa');
  for (const file of [...ADAPTER_SHARED, 'lib/subjects/codegraph.ts', 'lib/expect.ts', 'lib/fixture.ts', 'lib/fixture-install.ts', 'lib/spec.ts', 'fixtures/replay.mjs']) write(path.join(fake, file), fs.readFileSync(path.join(qa, file), 'utf8'));
  const fixture = path.join(fake, 'fixtures/oracle-candidates/issue-canary');
  write(path.join(fixture, 'main.js'), 'export function f() {}\nf();\n'); write(path.join(fixture, 'expect.json'), expect);
  write(path.join(fake, 'lib/subjects/index.ts'), `import * as fs from 'node:fs'; import * as path from 'node:path';
const source = dir => fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
const isCanary = dir => /CGQA_CANARY_/.test(source(dir));
const mode = process.env.CGQA_TEST_MODE;
export const buildFor = (s,b) => b;
export const subject = () => ({ name:'codegraph',
 index(dir) { if(fs.existsSync(path.join(dir,'expect.json'))) throw Error('answers leaked');
  const failed = mode==='base-error' || (isCanary(dir) && mode==='error');
  return {ok:!failed,status:failed?7:0,output:'synthetic index error'}; },
 snapshot(dir) { const s=${JSON.stringify(snap)};
  if(isCanary(dir)) { if(mode==='changed') s.edges=[];
   if(mode==='leak') s.unresolved=[{name:source(dir).match(/CGQA_CANARY_[a-f0-9]+/)[0]}]; }
  return s; }
});\n`);
  const result = path.join(tmp, 'replay.json');
  const replay = (mode = 'stable', canary = true, names = []) => run(path.join(fake, 'fixtures/replay.mjs'), [path.join(fake, 'lib/subjects/codegraph.ts'), ...names, '--json', result, ...(canary ? ['--canary'] : [])], { CGQA_TEST_MODE: mode });
  check('replay CLI isolates answers, writes hash, and reports stable canary PASS', () => {
    const r = replay(); assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = read(result); assert.match(out.adapterSha256, /^[a-f0-9]{64}$/); assert.equal(out.results[0].verdict, 'FIXED');
    assert.equal(out.canaries['issue-canary'].status, 'PASS'); assert(out.canaries['issue-canary'].files.includes('main.js'));
  });
  check('changed verdict canary fails without overwriting original fixture verdict', () => {
    const r = replay('changed'); assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = read(result); assert.equal(out.results[0].verdict, 'FIXED'); assert.equal(out.canaries['issue-canary'].verdict, 'BROKEN'); assert.equal(out.canaries['issue-canary'].status, 'FAIL');
  });
  check('marker leakage fails even when both fixture verdicts stay FIXED', () => {
    const r = replay('leak'); assert.equal(r.status, 1, r.stdout + r.stderr);
    const canary = read(result).canaries['issue-canary']; assert.equal(canary.verdict, 'FIXED'); assert.equal(canary.status, 'FAIL'); assert.equal(canary.leaks.length, 1);
  });
  check('canary index errors and baseline index errors are visible and nonzero', () => {
    assert.equal(replay('error').status, 1); assert.equal(read(result).canaries['issue-canary'].status, 'ERROR');
    assert.equal(replay('base-error').status, 1); assert.equal(read(result).results[0].verdict, 'ERROR'); assert.equal(read(result).canaries['issue-canary'].status, 'ERROR');
  });
  check('ordinary replay remains opt-in; empty fixture selection never silently passes', () => {
    assert.equal(replay('changed', false).status, 0); assert.equal(read(result).canaries, null);
    assert.equal(replay('stable', true, ['nonexistent']).status, 2); // unknown fixture name: usage error
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`${n}/${n} anti-gaming checks`);
