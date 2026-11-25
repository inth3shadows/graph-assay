#!/usr/bin/env node
// Hermetic adapter tests (part of `graph-assay check`):
//   1. mapping: each adapter's snapshot of a frozen index (lib/test/adapters/<subject>/: the source,
//      plus codegraph's .codegraph DB, code-graph-rag's export, or codebase-memory-mcp's or
//      code-review-graph's extract) equals the committed golden
//      snapshot. A change to how an adapter maps a tool's output shows up as a diff here.
//   2. sandbox: what a codegraph, codebase-memory-mcp or code-review-graph index process can see (environment, HOME, network).
//   node lib/adapter-test.ts --update   rewrites the golden snapshots (after a deliberate change)
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codegraph from './subjects/codegraph.ts';
import * as cgr from './subjects/code-graph-rag.ts';
import * as cbm from './subjects/codebase-memory-mcp.ts';
import * as crg from './subjects/code-review-graph.ts';
import { validateSnapshot } from './snapshot.ts';
import * as sandbox from './sandbox.ts';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
// The sandbox probes below are Node scripts: under the docker backend the container needs this Node.
process.env.GRAPH_ASSAY_SANDBOX_RO = [process.env.GRAPH_ASSAY_SANDBOX_RO, process.execPath].filter(Boolean).join(':');
const update = process.argv.includes('--update');
let n = 0;
const check = (name, fn) => { n++; try { fn(); } catch (e) { console.error(`FAIL ${name}\n${e.message}`); process.exitCode = 1; } };

// Fields that name the adapter build or the machine, not the mapping.
const normalize = (s) => JSON.parse(JSON.stringify({ ...s, subject: { ...s.subject, adapterSha256: '<hash>', version: '<version>' } }));
for (const [name, adapter] of [['codegraph', codegraph], ['code-graph-rag', cgr], ['codebase-memory-mcp', cbm], ['code-review-graph', crg]] as const) {
  const dir = path.join(here, 'test', 'adapters', name);
  const golden = path.join(here, 'test', 'adapters', `${name}.snapshot.json`);
  check(`${name}: snapshot of the frozen index matches the golden snapshot`, () => {
    const snap = normalize(adapter.snapshot(dir));
    if (update) fs.writeFileSync(golden, `${JSON.stringify(snap, null, 1)}\n`);
    assert.deepEqual(snap, JSON.parse(fs.readFileSync(golden, 'utf8')));
  });
  check(`${name}: snapshot validates against snapshot v1`, () => {
    const problems = validateSnapshot(adapter.snapshot(dir));
    assert.deepEqual(problems, []);
  });
}

check('codegraph sandbox: allowlisted env, private HOME, no network where unshare works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    // A stand-in "build": records what the index process sees.
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `import * as fs from 'node:fs'; import * as os from 'node:os';
const ifaces = Object.entries(os.networkInterfaces()).filter(([k]) => k !== 'lo').length;
fs.writeFileSync(process.env.HOME + '/seen.json', JSON.stringify({ keys: Object.keys(process.env), home: process.env.HOME, ifaces }));\n`);
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    process.env.GRAPH_ASSAY_TEST_SECRET = 'x'; process.env.CODEGRAPH_TEST_SWITCH = '1';
    const home = path.join(tmp, 'home');
    const r = codegraph.index(work, probe, { args: [], home });
    delete process.env.GRAPH_ASSAY_TEST_SECRET; delete process.env.CODEGRAPH_TEST_SWITCH;
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8'));
    assert(!seen.keys.includes('GRAPH_ASSAY_TEST_SECRET'), 'a caller variable reached the index');
    assert(seen.keys.includes('CODEGRAPH_TEST_SWITCH'), "codegraph's own switches must pass");
    assert.notEqual(seen.home, os.homedir());
    if (codegraph.canIsolateNetwork()) assert.equal(seen.ifaces, 0, 'the index process has a network interface');
    else console.log('note: unshare unavailable here; network isolation not checked');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('codebase-memory-mcp: a code file with only a File node is a file; a File never contains another file\'s definitions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-cbm-file-only-'));
  try {
    fs.mkdirSync(path.join(tmp, '.graph-assay'));
    const db = new DatabaseSync(path.join(tmp, '.graph-assay', 'cbm.db'));
    db.exec(`CREATE TABLE nodes (id, label, name, qualified_name, file_path, start_line, end_line, properties);
      CREATE TABLE edges (id, source_id, target_id, type, properties);`);
    const node = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    // Rows as cbm 0.12.1 writes them. Go (gorilla/mux): a File node, no Module, package-level qnames.
    // client.ts beside client.js (fixtures/cbm-candidates/cbm1): the .js file took the Module, the .ts file
    // is File-only, and cbm's File client.ts "defines" client.js's function. x.swift: File-only with an
    // extension the adapter does not know. user.tmpl: File-only, not code.
    for (const r of [[1, 'Project', 'graph-assay', 'graph-assay', '', 0, 0], [2, 'File', 'main.go', 'graph-assay.main.go.__file__', 'main.go', 0, 0],
      [3, 'Function', 'main', 'graph-assay.main', 'main.go', 3, 5], [4, 'Function', 'helper', 'graph-assay.helper', 'main.go', 7, 8],
      [5, 'File', 'user.tmpl', 'graph-assay.user.tmpl.__file__', 'user.tmpl', 0, 0],
      [10, 'Module', 'client', 'graph-assay.client', 'client.js', 1, 3], [11, 'File', 'client.js', 'graph-assay.client.js.__file__', 'client.js', 0, 0],
      [12, 'Function', 'send', 'graph-assay.client.send', 'client.js', 1, 3],
      [13, 'File', 'client.ts', 'graph-assay.client.ts.__file__', 'client.ts', 0, 0], [14, 'Function', 'encode', 'graph-assay.client.encode', 'client.ts', 1, 2],
      [30, 'File', 'x.swift', 'graph-assay.x.swift.__file__', 'x.swift', 0, 0], [31, 'Function', 'f', 'graph-assay.x.f', 'x.swift', 1, 2]]) node.run(...r, '{}');
    const edge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?)');
    edge.run(1, 2, 3, 'DEFINES', '{}'); edge.run(2, 3, 4, 'CALLS', JSON.stringify({ line: 4, callee: 'helper', strategy: 'same_module' }));
    edge.run(3, 13, 14, 'DEFINES', '{}'); edge.run(4, 13, 12, 'DEFINES', '{}'); edge.run(5, 13, 11, 'DEFINES', '{}');
    edge.run(6, 12, 14, 'CALLS', JSON.stringify({ line: 2, callee: 'encode' }));
    db.close();
    const snap = cbm.snapshot(tmp);
    assert.deepEqual(validateSnapshot(snap), []);
    assert.deepEqual(snap.files, [{ path: 'client.js', language: 'javascript' }, { path: 'client.ts', language: 'typescript' }, { path: 'main.go', language: 'go' }]);
    assert.deepEqual(snap.nodes.filter((n) => ['main.go', 'client.ts'].includes(n.file)).map((n) => `${n.kind} ${n.qname}`),
      ['file main.go', 'function main', 'function helper', 'file client.ts', 'function encode']);
    assert.deepEqual(snap.edges.map((e) => [e.kind, e.src, e.dst, e.line]), [['contains', '2', '3', null], ['calls', '3', '4', 4], ['contains', '13', '14', null], ['calls', '12', '14', 2]]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// #49: stores cbm 0.12.1 wrote for lib/test/adapters/codebase-memory-mcp-file-only/{go,java,py} (frozen, so a
// change in cbm's naming fails here). Every file but plain.py has only a File node.
const fileOnly = (lang: string) => {
  const snap = cbm.snapshot(path.join(here, 'test', 'adapters', 'codebase-memory-mcp-file-only', lang));
  assert.deepEqual(validateSnapshot(snap), []);
  const q = new Map(snap.nodes.map((n) => [n.id, n.qname]));
  const names = (file: string) => snap.nodes.filter((n) => n.file === file && n.kind !== 'file').map((n) => n.qname).sort();
  const contains = snap.edges.filter((e) => e.kind === 'contains').map((e) => `${q.get(e.src)} > ${q.get(e.dst)}`).sort();
  return { snap, names, contains };
};
check('codebase-memory-mcp #49: Java in File-only files: containers from the directory prefix; a class named like its file keeps its members', () => {
  const { names } = fileOnly('java');
  assert.deepEqual(names('src/A.java'), ['A', 'A::Inner', 'A::Inner::run', 'A::run', 'B', 'B::other', 'B::run']);
  assert.deepEqual(names('src/Svc.java'), ['Svc', 'Svc::Api', 'Svc::Api::call', 'Svc::Mode', 'Svc::Mode::ON', 'Svc::Mode::flip', 'Svc::run']);
  // Svc.kt beside Svc.java: Kotlin names it from the stem (`src.Svc.Kt.run`), so the stem is stripped there.
  assert.deepEqual(names('src/Svc.kt'), ['Kt', 'Kt::run']);
});
check('codebase-memory-mcp #49: Python beside a same-stem file that took the Module: containers from the stem prefix; a Module file unchanged', () => {
  const { snap, names } = fileOnly('py');
  assert.deepEqual(names('pkg/aliases.py'), ['Config', 'Config::Nested', 'Config::Nested::read_config', 'Config::read_config', 'read_config']);
  assert.deepEqual(names('pkg/plain.py'), ['Plain', 'Plain::go', 'go']);
  // aliases.ini's Module (an extension the adapter does not know) still makes it a file of its own.
  assert.deepEqual(snap.files.find((f) => f.path === 'pkg/aliases.ini'), { path: 'pkg/aliases.ini', language: null });
  assert.deepEqual(names('pkg/aliases.ini'), ['x', 'y']);
});
check('codebase-memory-mcp #49: Go: a method takes the type its parent_class names, also across files; a node cbm folded from two receivers is the method its span is', () => {
  const { names, contains } = fileOnly('go');
  // router.go:7 is `func (r *Route) Match`; cbm folded Router.Match (line 6) into it (PR #96 review, V1 redesign).
  assert.deepEqual(names('router.go'), ['Route', 'Route::Match', 'Router', 'helper']);
  assert.deepEqual(names('middleware.go'), ['Route::Name', 'Router::Use']);
  assert.deepEqual(contains, ['Route > Route::Match', 'Route > Route::Name', 'Router > Router::Use', 'middleware.go > Route::Name', 'middleware.go > Router::Use',
    'router.go > Route', 'router.go > Route::Match', 'router.go > Router', 'router.go > helper']);
});
check('codebase-memory-mcp #49 (PR #96 review, C1): a Go function cbm folded with a same-named method stays a function: no owner name, no owner edge', () => {
  // a.go: `func (t *T) M()` and `func M()` are one Function node (line 7) with T's DEFINES_METHOD; d.go `func P()`
  // folds with e.go's `func (w W) P()` the same way. b.go's method U.N absorbs c.go's `func N()` as a Method: owner kept.
  const { snap, names, contains } = fileOnly('go-fold');
  assert.deepEqual(names('a.go'), ['M', 'T']);
  assert.deepEqual(names('d.go'), ['P']);
  assert.deepEqual(names('b.go'), ['U', 'U::N']);
  assert.deepEqual(contains.filter((c) => !c.endsWith('.go') && !/\.go > /.test(c)), ['U > U::N']);
  assert.equal(snap.nodes.find((n) => n.file === 'a.go' && n.name === 'M').kind, 'function');
});
check('codebase-memory-mcp #49 (PR #96 review, C2): a class cbm folded across same-stem files contains no method of the other file', () => {
  const { snap, names, contains } = fileOnly('ts-fold');
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const cross = snap.edges.filter((e) => e.kind === 'contains' && byId.get(e.src).file !== byId.get(e.dst).file);
  assert.deepEqual(cross.map((e) => `${byId.get(e.src).qname}@${byId.get(e.src).file} > ${byId.get(e.dst).qname}@${byId.get(e.dst).file}`), []);
  assert.ok(contains.includes('A > A::onlyJs') && contains.includes('C > C::go'));
  // pkg/m.py beside m.pyi: cbm 0.12.1 writes no node for the stub, so m.py is an ordinary Module file.
  assert.deepEqual(names('pkg/m.py'), ['P', 'P::impl_only', 'P::run']);
  assert.equal(snap.files.some((f) => f.path === 'pkg/m.pyi'), false);
});
check('codebase-memory-mcp #49 (PR #96 review, C3, C1): the same owner edge written twice is still one owner; a Function takes none', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-cbm-dup-owner-'));
  try {
    fs.mkdirSync(path.join(tmp, '.graph-assay'));
    const db = new DatabaseSync(path.join(tmp, '.graph-assay', 'cbm.db'));
    db.exec(`CREATE TABLE nodes (id, label, name, qualified_name, file_path, start_line, end_line, properties);
      CREATE TABLE edges (id, source_id, target_id, type, properties);`);
    const node = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of [[1, 'File', 'r.go', 'graph-assay.r.go.__file__', 'r.go', 0, 0], [2, 'Struct', 'R', 'graph-assay.R', 'r.go', 3, 3],
      [3, 'Method', 'Use', 'graph-assay.Use', 'r.go', 5, 5], [4, 'Function', 'Open', 'graph-assay.Open', 'r.go', 7, 7]])
      node.run(...r, Number(r[0]) >= 3 ? JSON.stringify({ parent_class: 'graph-assay.R' }) : '{}');
    const edge = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?)');
    edge.run(1, 2, 3, 'DEFINES_METHOD', '{}'); edge.run(2, 2, 3, 'DEFINES_METHOD', '{}'); edge.run(3, 2, 4, 'DEFINES_METHOD', '{}');
    db.close();
    const snap = cbm.snapshot(tmp);
    assert.equal(snap.nodes.find((n) => n.id === '3').qname, 'R::Use');
    assert.ok(snap.edges.some((e) => e.kind === 'contains' && e.src === '2' && e.dst === '3'));
    // A Function never takes an owner, even one a parent_class and an owner edge would give it (C1).
    assert.equal(snap.nodes.find((n) => n.id === '4').qname, 'Open');
    assert.ok(!snap.edges.some((e) => e.kind === 'contains' && e.dst === '4' && e.src === '2'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
check('codebase-memory-mcp #49 (PR #96 review, V1): a folded Go method whose only owner edge is the absorbed method\'s takes its parent_class', () => {
  // u.go `func (t T) Close` and v.go `func (w V) Close` are one node at u.go:3 (parent_class T) whose only
  // DEFINES_METHOD comes from V.
  const { names, contains } = fileOnly('go-parent');
  assert.deepEqual(names('u.go'), ['T::Close']);
  // cbm wrote no edge from T, and V's edge is the absorbed method's: no owner edge (the adapter invents none).
  assert.deepEqual(contains.filter((c) => !/\.go > /.test(c)), []);
});
check('codebase-memory-mcp #49 (PR #96 review, V2): a Go file whose prefix does not hold still names its flat methods by their owner', () => {
  // t_linux.go and t_windows.go both declare T (build tags); cbm keeps t_linux.go's, so t_windows.go's field
  // `T.h` has no container in its file and no prefix holds there.
  const { names, contains } = fileOnly('go-buildtags');
  assert.ok(names('t_windows.go').includes('T::Handle'), names('t_windows.go').join(', '));
  assert.ok(contains.includes('T > T::Handle'));
  assert.deepEqual(names('s.go'), ['S', 'S::Run']);
});
check('codebase-memory-mcp #49: no prefix holds (a container cbm did not write): the file keeps bare names', () => {
  const rows = [{ id: 1, label: 'File', qname: 'graph-assay.pkg.m.py.__file__' }];
  const prefixes = cbm.filePrefixes(new Map([['pkg/m.py', rows[0]]]), [{ file: 'pkg/m.py', qname: 'graph-assay.pkg.m.Gone.run' }]);
  assert.equal(prefixes.has('pkg/m.py'), false);
  // A File qname of another shape (cbm's .html test resources): no prefix either.
  assert.equal(cbm.filePrefixes(new Map([['a/b.py', { id: 2, label: 'File', qname: 'a/b.py' }]]), [{ file: 'a/b.py', qname: 'graph-assay.a.b.f' }]).has('a/b.py'), false);
});

check('codebase-memory-mcp sandbox: allowlisted env, private HOME and cache, root confined, no network where unshare works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    // A stand-in binary: records what the index process sees.
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs'; import * as os from 'node:os';
const ifaces = Object.entries(os.networkInterfaces()).filter(([k]) => k !== 'lo').length;
fs.writeFileSync(process.env.HOME + '/seen.json', JSON.stringify({ keys: Object.keys(process.env), env: process.env, ifaces }));\n`, { mode: 0o755 });
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    process.env.GRAPH_ASSAY_TEST_SECRET = 'x'; process.env.CBM_WORKERS = '2'; process.env.CBM_DOWNLOAD_URL = 'http://example.invalid';
    const home = path.join(tmp, 'home');
    const r = cbm.index(work, probe, { args: [], home });
    delete process.env.GRAPH_ASSAY_TEST_SECRET; delete process.env.CBM_WORKERS; delete process.env.CBM_DOWNLOAD_URL;
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8'));
    assert(!seen.keys.includes('GRAPH_ASSAY_TEST_SECRET'), 'a caller variable reached the index');
    assert(!seen.keys.includes('CBM_DOWNLOAD_URL'), 'a cbm setting outside the allowlist reached the index');
    assert.equal(seen.env.CBM_WORKERS, '2', "cbm's tuning switches must pass");
    assert.notEqual(seen.env.HOME, os.homedir());
    assert(seen.env.CBM_CACHE_DIR.startsWith(seen.env.HOME), 'the cache must live in the sandbox HOME');
    assert.equal(seen.env.CBM_ALLOWED_ROOT, work);
    if (cbm.canIsolateNetwork()) assert.equal(seen.ifaces, 0, 'the index process has a network interface');
    else console.log('note: unshare unavailable here; network isolation not checked');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

/** Set env vars for the duration of `fn`, then restore what the caller had. */
const withEnv = (vars: Record<string, string>, fn: () => void) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { fn(); } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

check('code-review-graph sandbox: allowlisted env, private HOME and data dir, repo root pinned, enrichment off, no network where unshare works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    // A stand-in program: records what it sees and, like `build`, writes a graph.db into CRG_DATA_DIR.
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs'; import * as os from 'node:os'; import { DatabaseSync } from 'node:sqlite';
const ifaces = Object.entries(os.networkInterfaces()).filter(([k]) => k !== 'lo').length;
fs.writeFileSync(process.env.HOME + '/seen.json', JSON.stringify({ keys: Object.keys(process.env), env: process.env, ifaces, argv: process.argv.slice(2) }));
fs.mkdirSync(process.env.CRG_DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.CRG_DATA_DIR + '/graph.db');
db.exec("CREATE TABLE IF NOT EXISTS nodes (kind, name, qualified_name, file_path, line_start, line_end, language, parent_name); CREATE TABLE IF NOT EXISTS edges (id, kind, source_qualified, target_qualified, file_path, line, extra, confidence_tier, target_resolution)");
db.close();\n`, { mode: 0o755 });
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    let r; const first = path.join(tmp, 'home0');
    withEnv({ GRAPH_ASSAY_TEST_SECRET: 'x', CRG_SERIAL_PARSE: '1', CRG_OPENAI_API_KEY: 'x', CRG_REPO_ROOT: '/elsewhere' }, () => { r = crg.index(work, probe, { home: first }); });
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(first, 'seen.json'), 'utf8'));
    assert(!seen.keys.includes('GRAPH_ASSAY_TEST_SECRET'), 'a caller variable reached the index');
    assert(!seen.keys.includes('CRG_OPENAI_API_KEY'), 'an embedding-provider key reached the index');
    assert.equal(seen.env.CRG_SERIAL_PARSE, '1', "crg's parse switches must pass");
    assert.equal(seen.env.CRG_DISABLE_ENRICHMENT, '1');
    // crg walks up to the nearest .git unless told the root: the indexed dir, never a caller's value
    assert.equal(seen.env.CRG_REPO_ROOT, work);
    assert.deepEqual(seen.argv, ['build', '--repo', work]);
    assert.notEqual(seen.env.HOME, os.homedir());
    assert(seen.env.CRG_DATA_DIR.startsWith(seen.env.HOME) && seen.env.CRG_HOME.startsWith(seen.env.HOME), 'crg state must live in the sandbox HOME');
    assert(fs.existsSync(path.join(work, '.graph-assay', 'crg.db')), 'a default build extracts the graph');
    if (crg.canIsolateNetwork()) assert.equal(seen.ifaces, 0, 'the index process has a network interface');
    else console.log('note: unshare unavailable here; network isolation not checked');
    // an explicit full rebuild with a kept HOME must refresh the extract, not leave the last one
    const home = path.join(tmp, 'home');
    assert.equal(crg.index(work, probe, { home }).ok, true);
    fs.writeFileSync(path.join(work, '.graph-assay', 'crg.db'), 'stale');
    const again = crg.index(work, probe, { home, args: ['build'] });
    assert.equal(again.ok, true, again.output);
    assert.notEqual(fs.readFileSync(path.join(work, '.graph-assay', 'crg.db'), 'utf8').slice(0, 5), 'stale', 'args [build] left a stale extract');
    // crg's update ignores CRG_REPO_ROOT, so it needs --repo too; an explicit --repo is kept as given
    assert.equal(crg.index(work, probe, { home, args: ['update'] }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8')).argv, ['update', '--repo', work]);
    assert.equal(crg.index(work, probe, { home, args: ['update', '--repo', work] }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8')).argv, ['update', '--repo', work]);
    assert.equal(crg.index(work, probe, { home, args: ['update', `--repo=${work}`] }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8')).argv, ['update', `--repo=${work}`]);
    // the `env` option adds switches but never re-roots crg
    assert.equal(crg.index(work, probe, { home, env: { CRG_REPO_ROOT: '/elsewhere' } }).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8')).env.CRG_REPO_ROOT, work);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

/** A crg store `file` with the columns extract() and snapshot() read. */
const crgStore = (file: string, nodes: unknown[][], edges: unknown[][]) => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE nodes (kind, name, qualified_name, file_path, line_start, line_end, language, parent_name);
           CREATE TABLE edges (id, kind, source_qualified, target_qualified, file_path, line, extra, confidence_tier, target_resolution);`);
  db.exec('BEGIN');
  const pn = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)'); const pe = db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?)');
  for (const n of nodes) pn.run(...(n as any[]));
  for (const e of edges) pe.run(...(e as any[]));
  db.exec('COMMIT');
  db.close();
};

check('codebase-memory-mcp: links the tool leaves in its output lead the host nowhere outside the repo (V3)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-cbm-links-'));
  try {
    const work = path.join(tmp, 'repo'); const outside = path.join(tmp, 'outside'); fs.mkdirSync(work); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'host.db'), 'host file');
    // A stand-in cbm that reports an indexed store, then replaces the output dir with a link out of the repo.
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs';
fs.mkdirSync(process.env.CBM_CACHE_DIR, { recursive: true });
fs.symlinkSync(${JSON.stringify(path.join(outside, 'host.db'))}, process.env.CBM_CACHE_DIR + '/graph-assay.db');
try { fs.symlinkSync(${JSON.stringify(outside)}, '.graph-assay'); } catch { /* a read-only repo (docker) */ }
console.log('{"status":"indexed"}');\n`, { mode: 0o755 });
    const r = cbm.index(work, probe);
    assert.equal(r.ok, false, r.output); assert.match(r.output, /is a link|leads outside/);
    assert.deepEqual(fs.readdirSync(outside), ['host.db']); assert.equal(fs.readFileSync(path.join(outside, 'host.db'), 'utf8'), 'host file');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('a link or special file in any tool output fails the index before the host opens it (R3-1, N2, N3)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-vet-'));
  try {
    const victim = path.join(tmp, 'victim'); fs.writeFileSync(victim, 'host file\n'.repeat(7));
    const probe = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!${process.execPath}\nimport * as fs from 'node:fs';\n${body}\n`, { mode: 0o755 }); return p; };
    // cbm: a plain store, but a -shm sidecar link beside it (SQLite would open it read-write)
    const cbmWork = path.join(tmp, 'cbm'); fs.mkdirSync(cbmWork);
    const r1 = cbm.index(cbmWork, probe('cbm.mjs', `const c = process.env.CBM_CACHE_DIR; fs.mkdirSync(c, { recursive: true });
fs.writeFileSync(c + '/graph-assay.db', ''); fs.symlinkSync(${JSON.stringify(victim)}, c + '/graph-assay.db-shm');
console.log('{"status":"indexed"}');`));
    assert.equal(r1.ok, false); assert.match(r1.output, /graph-assay\.db-shm is a link/);
    // codegraph: a .codegraph sidecar link is a failed index, not a throw later in snapshot()
    const cgWork = path.join(tmp, 'cg'); fs.mkdirSync(cgWork);
    const r2 = codegraph.index(cgWork, probe('cg.mjs', `fs.mkdirSync('.codegraph', { recursive: true }); fs.writeFileSync('.codegraph/codegraph.db', ''); fs.symlinkSync(${JSON.stringify(victim)}, '.codegraph/codegraph.db-shm');`), { args: [] });
    assert.equal(r2.ok, false); assert.match(r2.output, /codegraph\.db-shm is a link/);
    assert.throws(() => codegraph.snapshot(cgWork), /is a link/);
    // cgr: an export naming a module path outside the repo, or a link in the repo, reads no host file
    const cgrWork = path.join(tmp, 'cgr'); fs.mkdirSync(path.join(cgrWork, '.graph-assay'), { recursive: true });
    fs.symlinkSync(victim, path.join(cgrWork, 'link.py'));
    const mod = (id, p) => ({ node_id: id, labels: ['Module'], properties: { path: p, qualified_name: `m${id}`, name: p } });
    fs.writeFileSync(path.join(cgrWork, '.graph-assay', 'export.json'), JSON.stringify({ nodes: [mod(1, '../victim'), mod(2, 'link.py')], relationships: [] }));
    const snap = cgr.snapshot(cgrWork);
    for (const n of snap.nodes.filter((x) => x.kind === 'file')) assert.equal(n.end, 1, `${n.file} was read (end ${n.end})`);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'host file\n'.repeat(7));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('every adapter mounts the indexed repo read-only and only its own output dir read-write (#51)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-mounts-')));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin); const log = path.join(tmp, 'docker.log');
  // a stub docker: records one `run`'s arguments, one per line, and does nothing
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n[ "$1" = run ] && printf '%s\\n' "$@" > ${log}\nexit 0\n`, { mode: 0o755 });
  const build = path.join(tmp, 'build'); fs.writeFileSync(build, '', { mode: 0o755 });
  const work = path.join(tmp, 'repo'); fs.mkdirSync(path.join(work, '.git'), { recursive: true });
  const oldPath = process.env.PATH;
  try {
    withEnv({ GRAPH_ASSAY_ISOLATION: 'docker', PATH: `${bin}:${oldPath}` }, () => {
      sandbox.resetBackend();
      for (const [name, adapter, writes] of [['codegraph', codegraph, ['.codegraph']], ['code-graph-rag', cgr, ['.graph-assay']],
        ['codebase-memory-mcp', cbm, []], ['code-review-graph', crg, ['.code-review-graph']]] as const) {
        fs.rmSync(log, { force: true });
        adapter.index(work, build, { home: path.join(tmp, `home-${name}`) });
        const args = fs.readFileSync(log, 'utf8').split('\n');
        const m = args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
        const target = (x: string) => /target=([^,]*)/.exec(x)![1];
        const repo = m.filter((x) => target(x) === work);
        assert.deepEqual(repo, [`type=bind,source=${work},target=${work},readonly`], `${name}: the repo is not mounted read-only`);
        const inside = m.filter((x) => target(x).startsWith(`${work}/`) && !x.endsWith(',readonly')).map((x) => path.relative(work, target(x)));
        assert.deepEqual(inside, writes, `${name}: writable inside the repo`);
        const firstInside = m.findIndex((x) => target(x).startsWith(`${work}/`));
        assert(firstInside === -1 || m.indexOf(repo[0]) < firstInside, `${name}: an output dir is mounted before the repo`);
      }
    });
  } finally { sandbox.resetBackend(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('docker (real): a tool cannot plant a git config or a link in the repo the host then uses (D1, #51)', () => {
  sandbox.resetBackend();
  if (sandbox.backend() !== 'docker') { console.log('note: docker backend not in use; D1 plants not checked'); return; }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-d1-')));
  try {
    const work = path.join(tmp, 'repo'); fs.mkdirSync(path.join(work, '.git'), { recursive: true });
    fs.writeFileSync(path.join(work, '.git', 'config'), '[core]\n'); fs.writeFileSync(path.join(work, 'a.ts'), 'x\n');
    const victim = path.join(tmp, 'victim'); fs.writeFileSync(victim, 'host file\n');
    // a stand-in codegraph exploited by the repo: a host-run git would execute core.fsmonitor; the
    // host's ts-cover.ts writes tsconfig.graph-assay-oracle.json and reads every source file
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `import * as fs from 'node:fs';
const tried = (f) => { try { f(); } catch { /* read-only */ } };
tried(() => fs.appendFileSync('.git/config', '[core]\\n\\tfsmonitor = touch ${tmp}/PWNED\\n'));
tried(() => fs.symlinkSync(${JSON.stringify(victim)}, 'tsconfig.graph-assay-oracle.json'));
tried(() => { fs.rmSync('a.ts'); fs.symlinkSync(${JSON.stringify(victim)}, 'a.ts'); });
fs.mkdirSync('.codegraph', { recursive: true }); fs.writeFileSync('.codegraph/codegraph.db', '');\n`);
    const r = codegraph.index(work, probe, { args: [] });
    assert.equal(r.ok, true, r.output);
    assert.equal(fs.readFileSync(path.join(work, '.git', 'config'), 'utf8'), '[core]\n');
    assert.equal(fs.existsSync(path.join(work, 'tsconfig.graph-assay-oracle.json')), false);
    assert.equal(fs.lstatSync(path.join(work, 'a.ts')).isFile(), true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('a repo that tracks a link or file at an output dir gets no rw mount outside it; a stale export or a missing dir is a failed index (#52 F1/F2/F4)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-tracked-')));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin); const log = path.join(tmp, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n[ "$1" = run ] && printf '%s\\n' "$@" > ${log}\nexit 0\n`, { mode: 0o755 });
  const build = path.join(tmp, 'build'); fs.writeFileSync(build, '', { mode: 0o755 });
  const host = path.join(tmp, 'host'); fs.mkdirSync(host); fs.writeFileSync(path.join(host, 'f'), 'host');
  try {
    withEnv({ GRAPH_ASSAY_ISOLATION: 'docker', PATH: `${bin}:${process.env.PATH}` }, () => {
      sandbox.resetBackend();
      for (const [name, adapter, outDir] of [['codegraph', codegraph, '.codegraph'], ['code-graph-rag', cgr, '.graph-assay']] as const) {
        for (const target of ['.', '.git', host, 'FILE']) {
          const work = path.join(tmp, `repo-${name}-${path.basename(target)}`); fs.mkdirSync(path.join(work, '.git'), { recursive: true });
          if (target === 'FILE') fs.writeFileSync(path.join(work, outDir), 'tracked'); else fs.symlinkSync(target, path.join(work, outDir));
          fs.rmSync(log, { force: true });
          const r = adapter.index(work, build, { home: path.join(tmp, `home-${name}`) });
          const args = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
          const rw = args.flatMap((a, i) => (args[i - 1] === '--mount' && !a.endsWith(',readonly') ? [a] : []));
          for (const m of rw) {
            const src = /source=([^,]*)/.exec(m)![1];
            assert(src !== work && !src.startsWith(`${work}/.git`) && !src.startsWith(host), `${name} ${outDir} -> ${target}: rw mount ${m}`);
          }
          assert.equal(fs.readFileSync(path.join(host, 'f'), 'utf8'), 'host');
          assert.equal(typeof r.ok, 'boolean');
        }
      }
      // a committed export the tool never wrote is not taken as its output
      const stale = path.join(tmp, 'repo-stale'); fs.mkdirSync(path.join(stale, '.graph-assay'), { recursive: true });
      fs.writeFileSync(path.join(stale, '.graph-assay', 'export.json'), '{"nodes":[],"relationships":[]}');
      assert.equal(cgr.index(stale, build, { home: path.join(tmp, 'home-stale') }).ok, false, 'a committed export.json was accepted');
      // a dir that does not exist is a failed index, and is not created
      const typo = path.join(tmp, 'no-such-repo');
      let r2;
      assert.doesNotThrow(() => { r2 = codegraph.index(typo, build, { home: path.join(tmp, 'home-typo') }); });
      assert.equal(r2.ok, false); assert.equal(fs.existsSync(typo), false);
    });
  } finally { sandbox.resetBackend(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-review-graph: a repo with no .git indexes; crg may write its marker dir, nothing else in the repo (#52 V1)', () => {
  sandbox.resetBackend();
  if (sandbox.backend() !== 'docker') { console.log('note: docker backend not in use; V1 not checked'); return; }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-v1-')));
  try {
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'a.py'), 'x = 1\n');
    // like crg 2.4: with no .git it makes <repo>/.code-review-graph, then writes its graph to CRG_DATA_DIR
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
fs.mkdirSync('.code-review-graph', { recursive: true }); fs.writeFileSync('.code-review-graph/.gitignore', '*\\n');
let rootWritable = true; try { fs.writeFileSync('planted', ''); } catch { rootWritable = false; }
if (rootWritable) process.exit(3);
fs.mkdirSync(process.env.CRG_DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.CRG_DATA_DIR + '/graph.db');
db.exec("CREATE TABLE nodes (kind, name, qualified_name, file_path, line_start, line_end, language, parent_name); CREATE TABLE edges (id, kind, source_qualified, target_qualified, file_path, line, extra, confidence_tier, target_resolution)");
db.close();\n`, { mode: 0o755 });
    const r = crg.index(work, probe);
    assert.equal(r.ok, true, r.output);
    assert.equal(fs.existsSync(path.join(work, 'planted')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-graph-rag: a run refused for want of isolation leaves the repo as it was (#52 V7)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-v7-')));
  try {
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, '.graph-assay'), 'tracked');
    withEnv({ GRAPH_ASSAY_ISOLATION: 'none' }, () => {
      sandbox.resetBackend();
      const r = cgr.index(work, path.join(tmp, 'build'));
      assert.equal(r.ok, false); assert.match(r.output, /refusing to run without isolation/);
    });
    assert.equal(fs.readFileSync(path.join(work, '.graph-assay'), 'utf8'), 'tracked');
  } finally { sandbox.resetBackend(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-graph-rag: a query run that leaves a link in its export dir is a failed run too (#52 F6)', () => {
  sandbox.resetBackend();
  if (!sandbox.isolated()) { console.log('note: no isolation here; code-graph-rag refuses to run, F6 not checked'); return; }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-f6-')));
  try {
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}\nimport * as fs from 'node:fs';\nfs.symlinkSync('/etc/passwd', '.graph-assay/leak');\n`, { mode: 0o755 });
    const r = cgr.index(work, probe, { args: ['query'] });
    assert.equal(r.ok, false, r.output); assert.match(r.output, /leak is a link/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('a missing build is a failed index, not a throw, and leaves no sandbox HOME behind (K5/A5)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-missing-build-'));
  // a private TMPDIR: the adapters make their sandbox HOME there, so other graph-assay runs do not count
  const priv = path.join(tmp, 'tmpdir'); fs.mkdirSync(priv); const oldTmp = process.env.TMPDIR; process.env.TMPDIR = priv;
  const homes = () => fs.readdirSync(priv).filter((d) => d.startsWith('cgqa-home-')).length;
  try {
    const before = homes();
    for (const [name, adapter] of [['codebase-memory-mcp', cbm], ['code-review-graph', crg], ['code-graph-rag', cgr]] as const) {
      const r = adapter.index(tmp, path.join(tmp, 'no-such-build'));
      assert.equal(r.ok, false, name);
    }
    assert.equal(homes(), before, 'a sandbox HOME was left behind');
  } finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-review-graph index: a store extract() cannot read is a failed index, not a crash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    const probe = path.join(tmp, 'probe.mjs'); // writes a graph.db without crg's tables (a schema change)
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
fs.mkdirSync(process.env.CRG_DATA_DIR, { recursive: true }); new DatabaseSync(process.env.CRG_DATA_DIR + '/graph.db').close();\n`, { mode: 0o755 });
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    const r = crg.index(work, probe);
    assert.equal(r.ok, false);
    assert.match(r.output, /\[graph-assay\] extract failed: /);
    assert(!fs.existsSync(path.join(work, '.graph-assay', 'crg.db')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-review-graph extract: leading repo prefix only, given or resolved path, also inside edge metadata', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-')));
  try {
    // macOS shape: the given root is a symlink whose target path contains the given path as text
    // (/var/... -> /private/var/...), and crg stores the resolved one.
    const real = path.join(tmp, 'private', tmp, 'var', 'repo'); fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(path.join(tmp, 'private', tmp, 'var'), path.join(tmp, 'var'));
    const given = path.join(tmp, 'var', 'repo');
    assert(fs.realpathSync(given).includes(given));
    const R = `${fs.realpathSync(given)}/`;
    const src = path.join(tmp, 'graph.db'); const out = path.join(tmp, 'crg.db');
    crgStore(src, [
      ['File', `${R}app.py`, `${R}app.py`, `${R}app.py`, 1, 9, 'python', null],
      ['Function', 'echo', `${R}app.py::echo`, `${R}app.py`, 1, 2, 'python', null],
      ['Function', 'v', `${R}vendor${given}/m.py::v`, `${R}vendor${given}/m.py`, 1, 1, 'python', null],
    ], [[1, 'CALLS', `${R}app.py::echo`, 'g', `${R}app.py`, 2, JSON.stringify({ ambiguous_targets: [`${R}m.py::g`], collision_endpoint: `${R}m.py::g` }), 'AMBIGUOUS', 'unresolved']]);
    crg.extract(src, out, given);
    const db = new DatabaseSync(out, { readOnly: true });
    try {
      const q = (sql: string) => db.prepare(sql).all().map((r) => Object.values(r).join('|'));
      assert.deepEqual(q('SELECT qualified_name, file_path, name FROM nodes ORDER BY rowid'),
        ['app.py|app.py|app.py', 'app.py::echo|app.py|echo', `vendor${given}/m.py::v|vendor${given}/m.py|v`]);
      assert.deepEqual(q('SELECT source_qualified, file_path, extra FROM edges'),
        [`app.py::echo|app.py|${JSON.stringify({ ambiguous_targets: ['m.py::g'], collision_endpoint: 'm.py::g' })}`]);
    } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-review-graph extract: paths inside JSON that Python escaped (non-ASCII root); a failed extract leaves no file', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-')));
  try {
    const root = path.join(tmp, 'répo "q"'); fs.mkdirSync(root);
    // Python json.dumps (ensure_ascii): non-ASCII as \uXXXX, quotes escaped
    const pyJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const src = path.join(tmp, 'graph.db'); const out = path.join(tmp, 'crg.db');
    crgStore(src, [['Function', 'f', `${root}/a.py::f`, `${root}/a.py`, 1, 1, 'python', null]],
      [[1, 'CALLS', `${root}/a.py::f`, 'g', `${root}/a.py`, 1, pyJson({ ambiguous_targets: [`${root}/a.py::g`, 'other'] }), 'AMBIGUOUS', 'unresolved']]);
    { const d = new DatabaseSync(src, { readOnly: true }); try { assert((d.prepare('SELECT extra FROM edges').get() as any).extra.includes('r\\u00e9po'), 'the source extra must hold the escaped form'); } finally { d.close(); } }
    crg.extract(src, out, root);
    const db = new DatabaseSync(out, { readOnly: true });
    try { assert.deepEqual(JSON.parse((db.prepare('SELECT extra FROM edges').get() as any).extra), { ambiguous_targets: ['a.py::g', 'other'] }); } finally { db.close(); }
    // a path as an object key; metadata Python wrote but JSON cannot parse (NaN) still loses the root
    const src2 = path.join(tmp, 'graph2.db'); const out2 = path.join(tmp, 'crg2.db');
    crgStore(src2, [], [[1, 'CALLS', 'a', 'b', 'a.py', 1, JSON.stringify({ [`${root}/k.py`]: 1 }), 'EXTRACTED', 'direct'],
      [2, 'CALLS', 'a', 'b', 'a.py', 1, `{"score": NaN, "path": ${pyJson(`${root}/n.py`)}}`, 'EXTRACTED', 'direct']]);
    crg.extract(src2, out2, root);
    const db2 = new DatabaseSync(out2, { readOnly: true });
    try { assert.deepEqual(db2.prepare('SELECT extra FROM edges ORDER BY id').all().map((r: any) => r.extra), ['{"k.py":1}', '{"score": NaN, "path": "n.py"}']); } finally { db2.close(); }
    // crg writes a root holding a backslash with a forward slash in its place
    const bs = path.join(tmp, 'a\\b'); fs.mkdirSync(bs);
    const src3 = path.join(tmp, 'graph3.db'); const out3 = path.join(tmp, 'crg3.db');
    const fwd = bs.replace(/\\/g, '/');
    crgStore(src3, [['Function', 'f', `${fwd}/a.py::f`, `${fwd}/a.py`, 1, 1, 'python', null]], []);
    crg.extract(src3, out3, bs);
    const db3 = new DatabaseSync(out3, { readOnly: true });
    try { assert.deepEqual(Object.values(db3.prepare('SELECT qualified_name, file_path FROM nodes').get()), ['a.py::f', 'a.py']); } finally { db3.close(); }
    const bad = path.join(tmp, 'bad.db'); new DatabaseSync(bad).close(); // no tables: the copy fails
    assert.throws(() => crg.extract(bad, out, root));
    assert(!fs.existsSync(out), 'a failed extract left a crg.db behind');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-review-graph snapshot: container chains from crg symbols and spans; ambiguous calls become guessed edges', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    fs.mkdirSync(path.join(tmp, '.graph-assay'));
    const F = (f: string, end: number) => ['File', f, f, f, 1, end, null, null];
    crgStore(path.join(tmp, '.graph-assay', 'crg.db'), [
      F('r.go', 3), ['Class', 'Router', 'r.go::Router', 'r.go', 1, 1, 'go', null],
      ['Function', 'Host', 'r.go::Router.Host', 'r.go', 2, 2, 'go', 'Router'], ['Function', 'use', 'r.go::use', 'r.go', 3, 3, 'go', null],
      F('c.ts', 1), ['Class', 'K', 'c.ts::K', 'c.ts', 1, 1, 'typescript', null], ['Function', 'm', 'c.ts::K.m', 'c.ts', 1, 1, 'typescript', 'K'],
      ['Class', 'L', 'c.ts::L', 'c.ts', 1, 1, 'typescript', null], ['Function', 'n', 'c.ts::L.n', 'c.ts', 1, 1, 'typescript', 'L'],
      F('i.cpp', 4), ['Class', 'I', 'i.cpp::ns.I', 'i.cpp', 1, 2, 'cpp', 'ns'], ['Function', 'm', 'i.cpp::ns.I.m(a.b)', 'i.cpp', 4, 4, 'cpp', 'I'],
      F('app.py', 12), ['Function', 'version_option', 'app.py::version_option', 'app.py', 1, 5, 'python', null],
      ['Function', 'callback', 'app.py::callback', 'app.py', 2, 3, 'python', null],
      ['Class', 'Greeter', 'app.py::Greeter', 'app.py', 6, 10, 'python', null], ['Function', 'greet', 'app.py::Greeter.greet', 'app.py', 7, 9, 'python', 'Greeter'],
      ['Function', 'helper', 'app.py::helper', 'app.py', 8, 8, 'python', null], ['Function', 'helper', 'app.py::helper:Sab12:2', 'app.py', 11, 11, 'python', null],
      ['Function', 'g', 'app.py::g', 'app.py', 12, 12, 'python', null], ['Function', 'g', 'app.py::g:Scd34', 'app.py', 12, 12, 'python', null],
      F('n.py', 20), ['Class', 'Outer', 'n.py::Outer', 'n.py', 1, 4, 'python', null], ['Class', 'Inner', 'n.py::Outer.Inner', 'n.py', 2, 4, 'python', 'Outer'],
      ['Function', 'm', 'n.py::Inner.m', 'n.py', 3, 4, 'python', 'Inner'],
      ['Class', 'C', 'n.py::C', 'n.py', 5, 9, 'python', null], ['Function', 'm', 'n.py::C.m', 'n.py', 6, 9, 'python', 'C'],
      ['Function', 'helper', 'n.py::C.helper', 'n.py', 7, 8, 'python', 'C'],
      ['Function', 'f', 'n.py::f', 'n.py', 10, 13, 'python', null], ['Class', 'A', 'n.py::A', 'n.py', 11, 13, 'python', null],
      ['Function', 'm', 'n.py::A.m', 'n.py', 12, 13, 'python', 'A'],
      ['Function', 'g', 'n.py::g', 'n.py', 14, 17, 'python', null], ['Class', 'A', 'n.py::A:S77aa', 'n.py', 15, 17, 'python', null],
      ['Function', 'm', 'n.py::A.m:S88bb', 'n.py', 16, 17, 'python', 'A'],
      // crg 2.4.0 shapes: Java one-line nested class; one-line TS classes in a function; Rust impl in a fn
      F('Main.java', 1), ['Class', 'Main', 'Main.java::Main', 'Main.java', 1, 1, 'java', null], ['Class', 'N', 'Main.java::Main.N', 'Main.java', 1, 1, 'java', 'Main'],
      ['Function', 'b', 'Main.java::Main.N.b', 'Main.java', 1, 1, 'java', 'N'], ['Function', 'a', 'Main.java::Main.a', 'Main.java', 1, 1, 'java', 'Main'],
      F('a.ts', 3), ['Function', 'f', 'a.ts::f', 'a.ts', 1, 3, 'typescript', null], ['Class', 'K', 'a.ts::K', 'a.ts', 2, 2, 'typescript', null],
      ['Function', 'm', 'a.ts::K.m', 'a.ts', 2, 2, 'typescript', 'K'], ['Class', 'L', 'a.ts::L', 'a.ts', 2, 2, 'typescript', null],
      ['Function', 'n', 'a.ts::L.n', 'a.ts', 2, 2, 'typescript', 'L'],
      F('r.rs', 6), ['Class', 'A', 'r.rs::A', 'r.rs', 1, 1, 'rust', null], ['Function', 'f', 'r.rs::f', 'r.rs', 2, 6, 'rust', null],
      ['Function', 'm', 'r.rs::A.m', 'r.rs', 4, 4, 'rust', 'A'],
      // a nested A listed before the top-level A; A.m (a Go-style member declared apart) belongs to the top-level one
      F('o.go', 9), ['Class', 'Outer', 'o.go::Outer', 'o.go', 1, 3, 'go', null], ['Class', 'A', 'o.go::Outer.A', 'o.go', 2, 3, 'go', 'Outer'],
      ['Class', 'A', 'o.go::A', 'o.go', 4, 5, 'go', null], ['Function', 'm', 'o.go::A.m', 'o.go', 7, 9, 'go', 'A'],
      // crg names some nodes with dotted text (JS prototype and CommonJS assignments, test descriptions)
      F('e.js', 9), ['Function', 'Foo.prototype.bar', 'e.js::Foo.prototype.bar', 'e.js', 1, 1, 'javascript', null],
      ['Function', 'module.exports', 'e.js::module.exports', 'e.js', 2, 4, 'javascript', null], ['Function', 'a', 'e.js::a', 'e.js', 3, 3, 'javascript', null],
      ['Test', 'it:serves index.html@L6', 'e.js::it:serves index.html@L6', 'e.js', 6, 8, 'javascript', null], ['Function', 'h', 'e.js::h', 'e.js', 7, 7, 'javascript', null],
      // Rust: impl Foo { fn t(&self) { fn helper(){} struct Local; impl Local { fn lm(){} } } }, struct Foo declared below
      F('t.rs', 20), ['Function', 't', 't.rs::Foo.t', 't.rs', 2, 14, 'rust', 'Foo'], ['Function', 'helper', 't.rs::Foo.helper', 't.rs', 5, 5, 'rust', 'Foo'],
      ['Class', 'Local', 't.rs::Foo.Local', 't.rs', 11, 11, 'rust', 'Foo'], ['Function', 'lm', 't.rs::Local.lm', 't.rs', 13, 13, 'rust', 'Local'],
      ['Class', 'Foo', 't.rs::Foo', 't.rs', 18, 18, 'rust', null],
      F('late.go', 9), ['Function', 'Run', 'late.go::Srv.Run', 'late.go', 2, 3, 'go', 'Srv'], ['Class', 'Srv', 'late.go::Srv', 'late.go', 8, 9, 'go', null],
    ], [
      [1, 'CALLS', 'app.py::version_option', 'g', 'app.py', 4, JSON.stringify({ ambiguous_targets: ['app.py::g', 'app.py::g:Scd34', 'app.py::g'] }), 'AMBIGUOUS', 'unresolved'],
      [2, 'CALLS', 'app.py::version_option', 'nowhere', 'app.py', 5, JSON.stringify({ ambiguous_targets: ['x.py::nowhere'] }), 'AMBIGUOUS', 'unresolved'],
      [3, 'CALLS', 'r.go::use', 'r.go::Router.Host', 'r.go', 3, '{}', 'EXTRACTED', 'direct'],
    ]);
    const s = crg.snapshot(tmp);
    assert.deepEqual(validateSnapshot(s), []);
    const q = Object.fromEntries(s.nodes.map((x) => [x.id, x.qname]));
    assert.deepEqual([q['n.py::Outer.Inner'], q['n.py::Inner.m'], q['n.py::C.helper'], q['n.py::A.m'], q['n.py::A.m:S88bb'], q['late.go::Srv.Run']],
      ['Outer::Inner', 'Outer::Inner::m', 'C::m::helper', 'f::A::m', 'g::A::m', 'Srv::Run']);
    assert.deepEqual([q['r.go::Router.Host'], q['c.ts::K.m'], q['c.ts::L.n'], q['i.cpp::ns.I.m(a.b)']], ['Router::Host', 'K::m', 'L::n', 'ns::I::m']);
    assert.deepEqual([q['app.py::callback'], q['app.py::Greeter.greet'], q['app.py::helper'], q['app.py::helper:Sab12:2']],
      ['version_option::callback', 'Greeter::greet', 'Greeter::greet::helper', 'helper']);
    assert.deepEqual([q['Main.java::Main.N.b'], q['Main.java::Main.a'], q['a.ts::K.m'], q['a.ts::L.n'], q['r.rs::A.m'], q['o.go::A.m']],
      ['Main::N::b', 'Main::a', 'f::K::m', 'f::L::n', 'A::m', 'A::m']);
    assert.deepEqual([q['e.js::Foo.prototype.bar'], q['e.js::module.exports'], q['e.js::a'], q['e.js::it:serves index.html@L6'], q['e.js::h']],
      ['Foo.prototype.bar', 'module.exports', 'module.exports::a', 'it:serves index.html@L6', 'it:serves index.html@L6::h']);
    assert.deepEqual([q['t.rs::Foo.t'], q['t.rs::Foo.helper'], q['t.rs::Foo.Local'], q['t.rs::Local.lm']],
      ['Foo::t', 'Foo::t::helper', 'Foo::t::Local', 'Foo::t::Local::lm']);
    const guessed = s.edges.filter((e) => e.provenance).map((e) => `${e.src}>${e.dst}:${e.provenance}`).sort();
    assert.deepEqual(guessed, ['app.py::version_option>app.py::g:Scd34:ambiguous', 'app.py::version_option>app.py::g:ambiguous']);
    assert.deepEqual(s.unresolved.map((u) => `${u.line}:${u.name}`), ['5:nowhere']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('code-review-graph snapshot: container chains stay linear in the number of members', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    fs.mkdirSync(path.join(tmp, '.graph-assay'));
    const N = 20_000; // Go receiver methods, declared apart from their type: the symbol names the owner
    const nodes: unknown[][] = [['File', 'm.go', 'm.go', 'm.go', 1, N + 2, null, null], ['Class', 'Srv', 'm.go::Srv', 'm.go', 1, 1, 'go', null]];
    for (let i = 0; i < N; i++) nodes.push(['Function', `M${i}`, `m.go::Srv.M${i}`, 'm.go', i + 2, i + 2, 'go', 'Srv']);
    crgStore(path.join(tmp, '.graph-assay', 'crg.db'), nodes, []);
    const t0 = Date.now();
    const s = crg.snapshot(tmp);
    const ms = Date.now() - t0;
    assert.equal(s.nodes.find((x) => x.id === `m.go::Srv.M${N - 1}`).qname, `Srv::M${N - 1}`);
    // linear here takes about 0.2 s, the quadratic 4b431e8 about 20 s; the bound leaves room for a loaded runner
    assert(ms < 10_000, `snapshot of ${N} methods took ${ms} ms`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

if (!process.exitCode) console.log(`${n}/${n} adapter checks`);
