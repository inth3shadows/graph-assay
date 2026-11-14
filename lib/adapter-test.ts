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
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
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
fs.writeFileSync('seen.json', JSON.stringify({ keys: Object.keys(process.env), home: process.env.HOME, ifaces }));\n`);
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    process.env.GRAPH_ASSAY_TEST_SECRET = 'x'; process.env.CODEGRAPH_TEST_SWITCH = '1';
    const r = codegraph.index(work, probe, { args: [] });
    delete process.env.GRAPH_ASSAY_TEST_SECRET; delete process.env.CODEGRAPH_TEST_SWITCH;
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8'));
    assert(!seen.keys.includes('GRAPH_ASSAY_TEST_SECRET'), 'a caller variable reached the index');
    assert(seen.keys.includes('CODEGRAPH_TEST_SWITCH'), "codegraph's own switches must pass");
    assert.notEqual(seen.home, os.homedir());
    if (codegraph.canIsolateNetwork()) assert.equal(seen.ifaces, 0, 'the index process has a network interface');
    else console.log('note: unshare unavailable here; network isolation not checked');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('codebase-memory-mcp sandbox: allowlisted env, private HOME and cache, root confined, no network where unshare works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    // A stand-in binary: records what the index process sees.
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs'; import * as os from 'node:os';
const ifaces = Object.entries(os.networkInterfaces()).filter(([k]) => k !== 'lo').length;
fs.writeFileSync('seen.json', JSON.stringify({ keys: Object.keys(process.env), env: process.env, ifaces }));\n`, { mode: 0o755 });
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    process.env.GRAPH_ASSAY_TEST_SECRET = 'x'; process.env.CBM_WORKERS = '2'; process.env.CBM_DOWNLOAD_URL = 'http://example.invalid';
    const r = cbm.index(work, probe, { args: [] });
    delete process.env.GRAPH_ASSAY_TEST_SECRET; delete process.env.CBM_WORKERS; delete process.env.CBM_DOWNLOAD_URL;
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8'));
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
fs.writeFileSync('seen.json', JSON.stringify({ keys: Object.keys(process.env), env: process.env, ifaces, argv: process.argv.slice(2) }));
fs.mkdirSync(process.env.CRG_DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.CRG_DATA_DIR + '/graph.db');
db.exec("CREATE TABLE IF NOT EXISTS nodes (kind, name, qualified_name, file_path, line_start, line_end, language, parent_name); CREATE TABLE IF NOT EXISTS edges (id, kind, source_qualified, target_qualified, file_path, line, extra, confidence_tier, target_resolution)");
db.close();\n`, { mode: 0o755 });
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    let r;
    withEnv({ GRAPH_ASSAY_TEST_SECRET: 'x', CRG_SERIAL_PARSE: '1', CRG_OPENAI_API_KEY: 'x', CRG_REPO_ROOT: '/elsewhere' }, () => { r = crg.index(work, probe); });
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8'));
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8')).argv, ['update', '--repo', work]);
    assert.equal(crg.index(work, probe, { home, args: ['update', '--repo', work] }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8')).argv, ['update', '--repo', work]);
    assert.equal(crg.index(work, probe, { home, args: ['update', `--repo=${work}`] }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8')).argv, ['update', `--repo=${work}`]);
    // the `env` option adds switches but never re-roots crg
    assert.equal(crg.index(work, probe, { home, env: { CRG_REPO_ROOT: '/elsewhere' } }).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8')).env.CRG_REPO_ROOT, work);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

/** A crg store `file` with the columns extract() and snapshot() read. */
const crgStore = (file: string, nodes: unknown[][], edges: unknown[][]) => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE nodes (kind, name, qualified_name, file_path, line_start, line_end, language, parent_name);
           CREATE TABLE edges (id, kind, source_qualified, target_qualified, file_path, line, extra, confidence_tier, target_resolution);`);
  for (const n of nodes) db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)').run(...(n as any[]));
  for (const e of edges) db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?)').run(...(e as any[]));
  db.close();
};

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
      F('late.go', 9), ['Function', 'Run', 'late.go::Srv.Run', 'late.go', 2, 3, 'go', 'Srv'], ['Class', 'Srv', 'late.go::Srv', 'late.go', 8, 9, 'go', null],
    ], [
      [1, 'CALLS', 'app.py::version_option', 'g', 'app.py', 4, JSON.stringify({ ambiguous_targets: ['app.py::g', 'app.py::g:Scd34'] }), 'AMBIGUOUS', 'unresolved'],
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
    assert(ms < 5000, `snapshot of ${N} methods took ${ms} ms`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

if (!process.exitCode) console.log(`${n}/${n} adapter checks`);
