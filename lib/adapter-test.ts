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

check('code-review-graph sandbox: allowlisted env, private HOME and data dir, enrichment off, no network where unshare works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-adapter-test-'));
  try {
    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `#!${process.execPath}
import * as fs from 'node:fs'; import * as os from 'node:os';
const ifaces = Object.entries(os.networkInterfaces()).filter(([k]) => k !== 'lo').length;
fs.writeFileSync('seen.json', JSON.stringify({ keys: Object.keys(process.env), env: process.env, ifaces }));\n`, { mode: 0o755 });
    const work = path.join(tmp, 'repo'); fs.mkdirSync(work);
    process.env.GRAPH_ASSAY_TEST_SECRET = 'x'; process.env.CRG_SERIAL_PARSE = '1'; process.env.CRG_OPENAI_API_KEY = 'x';
    const r = crg.index(work, probe, { args: ['probe'] });
    delete process.env.GRAPH_ASSAY_TEST_SECRET; delete process.env.CRG_SERIAL_PARSE; delete process.env.CRG_OPENAI_API_KEY;
    assert.equal(r.ok, true, r.output);
    const seen = JSON.parse(fs.readFileSync(path.join(work, 'seen.json'), 'utf8'));
    assert(!seen.keys.includes('GRAPH_ASSAY_TEST_SECRET'), 'a caller variable reached the index');
    assert(!seen.keys.includes('CRG_OPENAI_API_KEY'), 'an embedding-provider key reached the index');
    assert.equal(seen.env.CRG_SERIAL_PARSE, '1', "crg's parse switches must pass");
    assert.equal(seen.env.CRG_DISABLE_ENRICHMENT, '1');
    assert.notEqual(seen.env.HOME, os.homedir());
    assert(seen.env.CRG_DATA_DIR.startsWith(seen.env.HOME) && seen.env.CRG_HOME.startsWith(seen.env.HOME), 'crg state must live in the sandbox HOME');
    if (crg.canIsolateNetwork()) assert.equal(seen.ifaces, 0, 'the index process has a network interface');
    else console.log('note: unshare unavailable here; network isolation not checked');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

if (!process.exitCode) console.log(`${n}/${n} adapter checks`);
