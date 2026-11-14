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
    ], [
      [1, 'CALLS', 'app.py::version_option', 'g', 'app.py', 4, JSON.stringify({ ambiguous_targets: ['app.py::g', 'app.py::g:Scd34'] }), 'AMBIGUOUS', 'unresolved'],
      [2, 'CALLS', 'app.py::version_option', 'nowhere', 'app.py', 5, JSON.stringify({ ambiguous_targets: ['x.py::nowhere'] }), 'AMBIGUOUS', 'unresolved'],
      [3, 'CALLS', 'r.go::use', 'r.go::Router.Host', 'r.go', 3, '{}', 'EXTRACTED', 'direct'],
    ]);
    const s = crg.snapshot(tmp);
    assert.deepEqual(validateSnapshot(s), []);
    const q = Object.fromEntries(s.nodes.map((x) => [x.id, x.qname]));
    assert.deepEqual([q['r.go::Router.Host'], q['c.ts::K.m'], q['c.ts::L.n'], q['i.cpp::ns.I.m(a.b)']], ['Router::Host', 'K::m', 'L::n', 'ns::I::m']);
    assert.deepEqual([q['app.py::callback'], q['app.py::Greeter.greet'], q['app.py::helper'], q['app.py::helper:Sab12:2']],
      ['version_option::callback', 'Greeter::greet', 'Greeter::greet::helper', 'helper']);
    const guessed = s.edges.filter((e) => e.provenance).map((e) => `${e.src}>${e.dst}:${e.provenance}`).sort();
    assert.deepEqual(guessed, ['app.py::version_option>app.py::g:Scd34:ambiguous', 'app.py::version_option>app.py::g:ambiguous']);
    assert.deepEqual(s.unresolved.map((u) => `${u.line}:${u.name}`), ['5:nowhere']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

if (!process.exitCode) console.log(`${n}/${n} adapter checks`);
