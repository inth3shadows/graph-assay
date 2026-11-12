#!/usr/bin/env node
// Oracle self-tests. Each case dir holds sources, case.json, and frozen inputs from regen.mjs:
// snapshot.json (the subject's graph, snapshot v1) and index.scip.json (decoded SCIP). The oracle
// runs on those, so these tests pin the oracle's rules, not codegraph's current behavior, and need
// neither codegraph nor the scip binary (hermetic: CI runs them).
//
// Usage: node oracle/test/run.mjs [--mutate] [case ...]
//   case.json: { "lang": "python"|"ts"|"go", "mode": "forward"|"missing", "exclude": [path prefixes], "waterfall": {...},
//                "expect": [{ "at": "file:line", "name": "called name", "key": "bucket key prefix" },
//                           { "at": "file:line", "name": "...", "absent": true }] }
//   `key` must prefix the bucket of the site with that name on that line (with "all": true, of every
//   record there, as when several edges share a line); `absent` means the oracle
//   must skip the site (no bucket at all).
//   "pairs" (missing mode, SPEC §3): { "<set>": ["caller -> callee", ...] } — each pair must be in that
//   set of out-missing.json's pairs.sets (oracle, subject, matched, disagrees, silent, decorators); a
//   leading "!" means it must not be. "pairCounts": a subset of the pairs counts (oracle, matched, ...).
//   "dropLines": true runs the case on its snapshot with every edge's site line removed (a subject
//   without site lines, scored on the function-pair track only).
//   "inputs": "<case>" reuses that case's sources and frozen inputs (regen.mjs skips such a case).
//   "patch": edits applied to the frozen snapshot at test time, to give the oracle a subject error no
//   real subject makes on the case: { "op": "drop", "at": "file:line", "kind" } removes call edges;
//   { "op": "retarget", "at", "to": { "name", "kind" } } points them at another node; { "op": "add",
//   "from": { "name" }, "to": { "name", "kind" }, "line", "provenance"? } adds a call edge (a guessed
//   one with "provenance").
// --dump: print every site's bucket per case (for writing expectations), then exit.
// --mutate: re-run every case once per rule in oracle.mjs (each `on('<rule>')`) with that rule
// disabled. A rule whose removal fails no expectation is untested; the run exits 1 if any is.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const oracle = path.join(here, '..', 'oracle.mjs');
const args = process.argv.slice(2);
const mutate = args.includes('--mutate');
const dump = args.includes('--dump');
const only = args.filter((a) => !a.startsWith('--'));
const cases = (only.length ? only : fs.readdirSync(here).filter((n) => fs.existsSync(path.join(here, n, 'case.json')))).sort();
const FROZEN = new Set(['case.json', 'snapshot.json', 'index.scip.json']);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-selftest-'));
// Copy each case's sources once (the oracle reads source lines from them).
const prepared = new Map();
function prepare(name) {
  if (prepared.has(name)) return prepared.get(name);
  const spec = JSON.parse(fs.readFileSync(path.join(here, name, 'case.json'), 'utf8'));
  // "inputs": another case whose sources and frozen inputs this one reuses (with its own patch/expect).
  const dir = path.join(here, spec.inputs ?? name);
  const repo = path.join(work, name);
  fs.cpSync(dir, repo, { recursive: true, filter: (p) => !FROZEN.has(path.basename(p)) });
  let snapshot = path.join(dir, 'snapshot.json');
  if (spec.dropLines || spec.patch) {
    const snap = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    const node = (q) => { const n = snap.nodes.find((x) => x.name === q.name && (!q.kind || x.kind === q.kind)); if (!n) throw new Error(`${name}: patch: no node ${JSON.stringify(q)}`); return n; };
    const at = (e, where) => { const src = snap.nodes.find((x) => x.id === e.src); return `${src.file}:${e.line}` === where; };
    const CALLS = new Set(['calls', 'instantiates']);
    for (const p of spec.patch ?? []) {
      if (p.op === 'drop') snap.edges = snap.edges.filter((e) => !(CALLS.has(e.kind) && at(e, p.at) && (!p.kind || e.kind === p.kind)));
      else if (p.op === 'retarget') for (const e of snap.edges) { if (CALLS.has(e.kind) && at(e, p.at)) e.dst = node(p.to).id; }
      else if (p.op === 'add') snap.edges.push({ kind: 'calls', src: node(p.from).id, dst: node(p.to).id, line: p.line, col: null, provenance: p.provenance ?? null, ref: p.to.name, resolvedBy: null });
      else throw new Error(`${name}: unknown patch op ${p.op}`);
    }
    if (spec.dropLines) {
      for (const e of snap.edges) { e.line = null; e.col = null; }
      snap.capabilities = { ...snap.capabilities, siteLines: false, siteColumns: false };
    }
    snapshot = path.join(work, `${name}.snapshot.json`);
    fs.writeFileSync(snapshot, JSON.stringify(snap));
  }
  const p = { spec, repo, scip: path.join(dir, 'index.scip.json'), snapshot };
  prepared.set(name, p);
  return p;
}

// Run one case; returns the list of failed expectations.
function check(name, disable = '') {
  const { spec, repo, scip, snapshot } = prepare(name);
  const out = path.join(work, `${name}.out.json`);
  const r = spawnSync(process.execPath, [oracle, repo, scip, out], {
    encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ORACLE_ALLSITES: '1', ORACLE_SHOW: '0', ORACLE_REDACT: '',
      ORACLE_LANG: spec.lang === 'python' || spec.lang === 'go' ? spec.lang : '', ORACLE_MODE: spec.mode === 'missing' ? 'missing' : '', ORACLE_DISABLE: disable, ORACLE_SNAPSHOT: snapshot, ORACLE_EXCLUDE: (spec.exclude ?? []).join(',') },
  });
  if (r.status !== 0) return [`oracle exited ${r.status}: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`];
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  const sites = result.sites;
  if (dump) for (const s of sites) console.log(`  ${s.site.padEnd(22)} ${s.name.padEnd(16)} ${s.key}`);
  if (dump && result.pairs) { const { sets, ...counts } = result.pairs; console.log(`  pairs ${JSON.stringify(counts)}`); for (const [k, v] of Object.entries(sets ?? {})) console.log(`  pairs.${k}: ${v.join(' | ')}`); }
  const fails = [];
  // `waterfall`: expected SPEC §7 file counts (a subset of out.json's waterfall)
  for (const [k, v] of Object.entries(spec.waterfall ?? {})) if (result.waterfall?.[k] !== v) fails.push(`waterfall.${k}: expected ${v}, got ${result.waterfall?.[k]}`);
  for (const [set, want] of Object.entries(spec.pairs ?? {})) {
    const have = new Set(result.pairs?.sets?.[set] ?? []);
    for (const w of want) {
      const neg = w.startsWith('!'); const p = neg ? w.slice(1) : w;
      if (have.has(p) === neg) fails.push(`pairs.${set}: ${neg ? 'unexpected' : 'missing'} ${p}`);
    }
  }
  for (const [k, v] of Object.entries(spec.pairCounts ?? {})) if (JSON.stringify(result.pairs?.[k]) !== JSON.stringify(v)) fails.push(`pairs.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(result.pairs?.[k])}`);
  for (const x of spec.expect) {
    const hits = sites.filter((s) => s.site === x.at && s.name === x.name);
    if (x.absent) { if (hits.length) fails.push(`${x.at} ${x.name}: expected skipped, got ${hits.map((h) => h.key).join(', ')}`); continue; }
    // "all": every record at that site and name must have the key (several edges can share a line).
    if (x.all ? !hits.length || !hits.every((h) => h.key.startsWith(x.key)) : !hits.some((h) => h.key.startsWith(x.key))) {
      fails.push(`${x.at} ${x.name}: expected ${x.key}, got ${hits.map((h) => h.key).join(', ') || 'nothing'}`);
    }
  }
  return fails;
}

let failed = 0;
try {
  for (const name of cases) {
    const fails = check(name);
    const sp = prepare(name).spec;
    const n = sp.expect.length + Object.values(sp.pairs ?? {}).flat().length + Object.keys(sp.pairCounts ?? {}).length;
    console.log(`${fails.length ? 'FAIL' : 'ok  '}  ${name.padEnd(12)} ${n - fails.length}/${n}`);
    for (const f of fails) console.log(`        ${f}`);
    failed += fails.length;
  }
  if (mutate && failed === 0) {
    const rules = [...new Set([...fs.readFileSync(oracle, 'utf8').matchAll(/\bon\('([^']+)'\)/g)].map((m) => m[1]))].sort();
    console.log(`\nmutation: ${rules.length} rules, each disabled in turn`);
    const survivors = [];
    for (const rule of rules) {
      const killedBy = cases.filter((c) => check(c, rule).length > 0);
      console.log(`${killedBy.length ? 'killed  ' : 'SURVIVED'}  ${rule.padEnd(36)} ${killedBy.join(', ')}`);
      if (!killedBy.length) survivors.push(rule);
    }
    if (survivors.length) { console.log(`\n${survivors.length} rule(s) no test pins: ${survivors.join(', ')}`); failed += survivors.length; }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
