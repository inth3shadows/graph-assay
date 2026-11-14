#!/usr/bin/env node
// Re-index every oracle-candidate fixture with a given codegraph build and
// report whether each fixture's wrong edge is still there.
//
// Usage: node fixtures/replay.mts [--subject name] [--root dir] <build | default> [fixture ...] [--json out.json] [--canary]
//   --subject: codegraph (default; build = dist/bin/codegraph.js) or code-graph-rag (build = the cgr binary)
//   --root: the fixture set (default fixtures/oracle-candidates, codegraph's regression set; code-graph-rag's
//           own findings live in fixtures/cgr-candidates)
//
// Each fixture dir holds an expect.json:
//   { "issue": 3229,
//     "wrong": [{ "from": "test_one", "kind": "calls", "to": "pkg/core.py:reverts", "toLine"?: 7 }],
//     "right": [ ...edges a fix should produce; [] when the fix is "no edge" ] }
// `from` is the source's qualified name; `to` is "<target file>:<target qualified name>"; names match
// tool-neutrally (lib/expect.ts `present`: same last name, suffix-compatible container chain).
//
// Verdicts:
//   BROKEN   a wrong edge is present (or, for a missing-edge fixture with `wrong: []`, a right edge is missing)
//   GUESSED  a wrong edge is present, but only as edges the subject marks guessed (provenance set;
//            SPEC.md §4 scores those in their own column)
//   FIXED    no wrong edge, every right edge present
//   CHANGED  no wrong edge, but a right edge is missing (look by hand)
//   ERROR    index failed
//
// Indexes run wasm-only (CODEGRAPH_KERNEL=0 unless set; any other value must load
// the native kernel or the fixture is an ERROR), telemetry off, in a
// copy of the fixture under a temp dir with a sandboxed HOME.
import { fileURLToPath } from 'node:url';
import { copyFixture, markerLeaks, scoreFixture } from '../lib/fixture.ts';
import { adapterHash } from '../lib/provenance.ts';
import { SPEC_VERSION } from '../lib/spec.ts';
import { buildFor, subject } from '../lib/subjects/index.ts';
import { validateExpect } from '../lib/expect.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const subjAt = args.indexOf('--subject');
const subj = subject(subjAt >= 0 ? args.splice(subjAt, 2)[1] : 'codegraph');
const canaryAt = args.indexOf('--canary');
const canary = canaryAt >= 0;
if (canary) args.splice(canaryAt, 1);
const rootAt = args.indexOf('--root');
const rootArg = rootAt >= 0 ? args.splice(rootAt, 2)[1] : null;
const adapterSha256 = adapterHash(subj.name);
const [buildArg, ...only] = args;
const build = buildArg && buildFor(subj, buildArg);
if (!build || !fs.existsSync(build)) {
  console.error('usage: node fixtures/replay.mts [--subject name] [--root dir] <build | default> [fixture ...] [--json out.json] [--canary]');
  process.exit(2);
}

const root = rootArg ? path.resolve(rootArg) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'oracle-candidates');
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error(`--root: not a directory: ${rootArg}`); process.exit(2); }
const unknown = only.filter((n) => n.includes('/') || n.includes(path.sep) || !fs.existsSync(path.join(root, n, 'expect.json')));
if (unknown.length) { console.error(`no such fixture under ${root}: ${unknown.join(', ')}`); process.exit(2); }
const names = (only.length ? only : fs.readdirSync(root)).filter((n) => fs.existsSync(path.join(root, n, 'expect.json'))).sort();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-replay-'));
// Asked for the native kernel: prove each index loaded it, or the run says nothing about the kernel.
const kernel = process.env.CODEGRAPH_KERNEL ?? '0';

const results = [];
const run = (dir) => {
  const r = subj.index(dir, build, { kernel });
  if (!r.ok) throw new Error(r.status === 0 && subj.name === 'codegraph' && kernel !== '0' ? 'native kernel requested but did not load (CODEGRAPH_KERNEL_DEBUG shows why)'
    : r.status === 0 ? 'index exited 0 but produced no graph' : r.output.trim().split('\n').slice(-3).join(' | ') || `index failed (status ${r.status}${r.signal ? `, ${r.signal}` : ''})`);
  return subj.snapshot(dir, { build, kernel });
};
try {
  for (const name of names) {
    const row: Record<string, any> = { name, issue: null, verdict: 'ERROR', detail: '' };
    results.push(row);
    try {
      const source = path.join(root, name);
      const expect = JSON.parse(fs.readFileSync(path.join(source, 'expect.json'), 'utf8'));
      row.issue = expect.issue;
      const bad = validateExpect(expect);
      if (bad.length) throw new Error(`expect.json: ${bad.join('; ')}`);
      const dir = path.join(work, name);
      copyFixture(source, dir);
      Object.assign(row, scoreFixture(run(dir), expect));
      if (canary) {
        // No fixture/issue name in the second directory. File names and symbol names stay intact.
        const anonymous = fs.mkdtempSync(path.join(work, 'sample-'));
        try {
          const input = copyFixture(source, anonymous, { canary: true });
          const snap = run(anonymous);
          const scored = scoreFixture(snap, expect);
          const leaks = markerLeaks(snap, input.marker);
          row.canary = { ...input, verdict: scored.verdict, leaks,
            status: scored.verdict === row.verdict && !leaks.length ? 'PASS' : 'FAIL' };
        } catch (error) { row.canary = { status: 'ERROR', error: error.message }; }
      }
    } catch (error) { row.verdict = 'ERROR'; row.detail = error.message; }
  }
} finally { fs.rmSync(work, { recursive: true, force: true }); }

for (const r of results) console.log(`${r.verdict.padEnd(8)} #${String(r.issue).padEnd(5)} ${r.name.padEnd(22)} ${r.detail}`);
if (canary) for (const r of results) console.log(`CANARY ${r.canary?.status ?? 'ERROR'} ${r.name}${r.canary?.error ? `: ${r.canary.error}` : ''}`);
const tally = results.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {});
console.log(Object.entries<any>(tally).map(([k, v]) => `${k} ${v}`).join(', '));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ spec: SPEC_VERSION, subject: subj.name, adapterSha256, build, results,
  canaries: canary ? Object.fromEntries(results.map((r) => [r.name, r.canary ?? { status: 'ERROR', error: r.detail }])) : null }, null, 1));
process.exit(!results.length || results.some((r) => r.verdict === 'ERROR' || (canary && r.canary?.status !== 'PASS')) ? 1 : 0);
