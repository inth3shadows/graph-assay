#!/usr/bin/env node
// README's Status counts match fixtures/ (#63): codegraph repros in oracle-candidates/, how many name
// an upstream issue or PR (expect.json `issue`) and how many distinct, code-graph-rag's and
// codebase-memory-mcp's repro counts, and code-review-graph's "none yet". A fixture is a committed
// `fixtures/<set>/<name>/expect.json` (git ls-files, as `check` scopes everything; one level, as
// fixtures/replay.mts reads them). `issue` 0 or null names no upstream issue (t2-ts-typed-instance-member).
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readme = fs.readFileSync(path.join(qa, 'README.md'), 'utf8').replace(/\s+/g, ' ');
const tracked = (spawnSync('git', ['ls-files', 'fixtures'], { cwd: qa, encoding: 'utf8' }).stdout ?? '').split('\n');
assert.ok(tracked.some((f) => f.endsWith('/expect.json')), 'git ls-files listed no fixture (not a git checkout?)');

const fixtures = (set: string) => tracked.filter((f) => new RegExp(`^fixtures/${set}/[^/]+/expect\\.json$`).test(f));
const issueOf = (f: string) => {
  try { return JSON.parse(fs.readFileSync(path.join(qa, f), 'utf8')).issue; } catch (e) { throw new Error(`${f}: ${e.message}`); }
};
const num = (re: RegExp, what: string) => {
  const m = readme.match(re);
  assert.ok(m, `README.md no longer states ${what} in the form this test reads (${re})`);
  return m.slice(1).map(Number);
};

const named = fixtures('oracle-candidates').map(issueOf).filter((i) => i);
const cg = { fixtures: fixtures('oracle-candidates').length, named: named.length, distinct: new Set(named).size };
const [total, n, distinct, cgr] = num(/holds (\d+) codegraph repros \((\d+) name the upstream issue or PR they reproduce, (\d+) distinct\), plus (\d+) for code-graph-rag/, 'the fixture counts');
assert.deepEqual({ fixtures: total, named: n, distinct }, cg, 'README codegraph fixture counts vs fixtures/oracle-candidates/');
assert.equal(cgr, fixtures('cgr-candidates').length, 'README code-graph-rag count vs fixtures/cgr-candidates/');
const [cbm] = num(/codebase-memory-mcp also has (\d+) repros? of its own/, "codebase-memory-mcp's count");
assert.equal(cbm, fixtures('cbm-candidates').length, 'README codebase-memory-mcp count vs fixtures/cbm-candidates/');
const crg = fixtures('crg-candidates').length;
assert.ok(crg === 0 ? /code-review-graph none yet/.test(readme) : num(/code-review-graph (\d+) repros?/, "code-review-graph's count")[0] === crg,
  `README code-review-graph count vs fixtures/crg-candidates/ (${crg})`);
console.log(`ok  README counts: ${cg.fixtures} codegraph (${cg.named} named, ${cg.distinct} distinct), ${cgr} code-graph-rag, ${cbm} codebase-memory-mcp, ${crg} code-review-graph`);
