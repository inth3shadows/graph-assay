#!/usr/bin/env node
// README's Status counts match fixtures/ (#63): codegraph repros in oracle-candidates/, how many name
// an upstream issue or PR (expect.json `issue`) and how many distinct, code-graph-rag's and
// codebase-memory-mcp's repro counts.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readme = fs.readFileSync(path.join(qa, 'README.md'), 'utf8').replace(/\s+/g, ' ');

function count(set: string) {
  const dir = path.join(qa, 'fixtures', set);
  const issues = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'expect.json')))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'expect.json'), 'utf8')).issue);
  const named = issues.filter((i) => i);
  return { fixtures: issues.length, named: named.length, distinct: new Set(named).size };
}

const num = (re: RegExp, what: string) => {
  const m = readme.match(re);
  assert.ok(m, `README.md no longer states ${what} in the form this test reads (${re})`);
  return m.slice(1).map(Number);
};
const cg = count('oracle-candidates');
const [fixtures, named, distinct, cgr] = num(/holds (\d+) codegraph repros \((\d+) name the upstream issue or PR they reproduce, (\d+) distinct\), plus (\d+) for code-graph-rag/, 'the fixture counts');
assert.deepEqual({ fixtures, named, distinct }, cg, 'README codegraph fixture counts vs fixtures/oracle-candidates/');
assert.equal(cgr, count('cgr-candidates').fixtures, 'README code-graph-rag count vs fixtures/cgr-candidates/');
const [cbm] = num(/codebase-memory-mcp also has (\d+) repros of its own/, "codebase-memory-mcp's count");
assert.equal(cbm, count('cbm-candidates').fixtures, 'README codebase-memory-mcp count vs fixtures/cbm-candidates/');
console.log(`ok  README counts: ${cg.fixtures} codegraph (${cg.named} named, ${cg.distinct} distinct), ${cgr} code-graph-rag, ${cbm} codebase-memory-mcp`);
