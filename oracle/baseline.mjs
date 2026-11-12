#!/usr/bin/env node
// Save what one codegraph build did across every harness, and diff two saved builds.
//
//   node oracle/baseline.mjs save <baseline dir> [--work <ORACLE_WORK dir>] [--targets <targets.txt>]
//     Reads w-<name>/out.json and out-missing.json for each target, plus replay.json, pycg.json and
//     meta.json from <baseline dir> when present, and writes <baseline dir>/baseline.json.
//   node oracle/baseline.mjs diff <old baseline.json> <new baseline.json> [--fail-on-regression] [--fail-on-incomplete] [--json gate.json]
//     Prints what changed: bucket counts, groups (one cause each) that appeared or vanished,
//     fixture verdicts, PyCG categories and metamorphic diff counts.
//
// A group's signature is (codegraph target, SCIP definition), the same grouping oracle.mjs uses.
// Checkouts are cached at one HEAD per repo, so signatures are comparable across builds.
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gate } from '../lib/scores.ts';
import { recordedAdapterHash } from '../lib/provenance.ts';

const [cmd, ...args] = process.argv.slice(2);
const [a, b] = args;
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'graph-assay', 'oracle');
const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

// Bucket counts plus, per bucket, group signature -> size. When the run listed every site
// (ORACLE_ALLSITES=1, which run.sh sets), the canonical per-site results go to sites/<repo>-<mode>.txt
// (one sorted JSON line per site) and their hash into the summary, so a diff sees offsetting changes
// that counts and groups hide.
const canonical = (sites) => sites.map((x) => JSON.stringify(Object.fromEntries(Object.entries(x).sort()))).sort();
const summarize = (out, sitesFile) => {
  if (!out) return null;
  const sum = {
    adapterSha256: recordedAdapterHash(out),
    total: out.total,
    buckets: out.buckets,
    groups: Object.fromEntries(Object.entries(out.groups ?? {}).map(([k, gs]) => [k, Object.fromEntries(gs.map((g) =>
      [`${g.codegraph}|${g.scipDef ? `${g.scipDef.file}:${g.scipDef.line}` : g.scip}`, g.n]))])),
  };
  if (Array.isArray(out.sites) && sitesFile) {
    const lines = canonical(out.sites);
    fs.mkdirSync(path.dirname(sitesFile), { recursive: true });
    fs.writeFileSync(sitesFile, `${lines.join('\n')}\n`);
    sum.sites = { count: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex'), file: path.relative(path.dirname(path.dirname(sitesFile)), sitesFile) };
  }
  return sum;
};
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : null);
/** lines of xs not matched by ys (multiset) */
const minus = (xs, ys) => { const bag = new Map(); for (const y of ys) bag.set(y, (bag.get(y) ?? 0) + 1); return xs.filter((x) => { const n = bag.get(x) ?? 0; if (n) { bag.set(x, n - 1); return false; } return true; }); };

if (cmd === 'save') {
  if (!a) usage();
  const work = flag('--work', process.env.ORACLE_WORK ?? path.join(cache, 'work'));
  const targets = flag('--targets', path.join(path.dirname(fileURLToPath(import.meta.url)), 'targets.txt'));
  const names = fs.readFileSync(targets, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => n && !n.startsWith('#'));
  const repos = {};
  for (const n of names) {
    const forward = read(path.join(work, `w-${n}`, 'out.json'));
    if (!forward) { console.error(`${n}: no out.json in ${work}/w-${n} (skipped)`); continue; }
    repos[n] = {
      forward: summarize(forward, path.join(a, 'sites', `${n}-forward.txt`)),
      missing: summarize(read(path.join(work, `w-${n}`, 'out-missing.json')), path.join(a, 'sites', `${n}-missing.txt`)),
    };
  }
  const replay = read(path.join(a, 'replay.json'));
  const pycg = read(path.join(a, 'pycg.json'));
  const meta = read(path.join(a, 'meta.json'));
  const baseline = {
    savedAt: new Date().toISOString(),
    build: replay?.build ?? null,
    repos,
    adapters: { replay: recordedAdapterHash(replay), pycg: recordedAdapterHash(pycg),
      metamorphic: [...new Set((meta ?? []).map(recordedAdapterHash))] },
    canaries: replay?.canaries ?? null,
    replay: replay && Object.fromEntries(replay.results.map((r) => [r.name, r.verdict])),
    pycg: pycg?.categories ?? null,
    meta: meta && Object.fromEntries(meta.map((r) => [`${r.seed} ${r.relation}`,
      r.error ? { error: true } : r.notApplicable ? { notApplicable: true } : Object.fromEntries(Object.entries(r.diffs).map(([k, v]) => [k, v.length]))])),
  };
  fs.writeFileSync(path.join(a, 'baseline.json'), JSON.stringify(baseline, null, 1));
  console.log(`saved ${path.join(a, 'baseline.json')}: ${Object.keys(repos).length} repos`
    + `${baseline.replay ? `, ${Object.keys(baseline.replay).length} fixtures` : ''}${pycg ? ', pycg' : ''}${meta ? ', metamorphic' : ''}`);
} else if (cmd === 'diff') {
  if (!a || !b) usage();
  try {
    const A = read(a); const B = read(b);
    let changes = 0;
    const say = (s) => { console.log(s); changes++; };
    const plain = (k) => /^(ok|ok-other-column|outside-scip|missing\|found)\|/.test(k) || k === 'outside-scip';
    for (const repo of [...new Set([...Object.keys(A.repos), ...Object.keys(B.repos)])].sort()) {
      for (const mode of ['forward', 'missing']) {
        const x = A.repos[repo]?.[mode]; const y = B.repos[repo]?.[mode];
        if (!x || !y) { if (x || y) say(`${repo} ${mode}: only in ${x ? 'old' : 'new'}`); continue; }
        if (x.total !== y.total) say(`${repo} ${mode}: total ${x.total} -> ${y.total}`);
        if (x.sites && y.sites && x.sites.sha256 !== y.sites.sha256) {
          const lx = readLines(path.join(path.dirname(a), x.sites.file)); const ly = readLines(path.join(path.dirname(b), y.sites.file));
          if (lx && ly) {
            const gone = minus(lx, ly); const added = minus(ly, lx);
            say(`${repo} ${mode}: sites -${gone.length} +${added.length}`);
            for (const l of gone.slice(0, 5)) console.log(`    - ${l}`);
            for (const l of added.slice(0, 5)) console.log(`    + ${l}`);
          } else say(`${repo} ${mode}: sites differ (site files missing)`);
        }
        for (const k of [...new Set([...Object.keys(x.buckets), ...Object.keys(y.buckets)])].sort()) {
          const p = x.buckets[k] ?? 0; const q = y.buckets[k] ?? 0;
          if (p !== q) say(`${repo} ${mode}: ${String(q - p).padStart(5)}  ${k}  (${p} -> ${q})`);
          if (plain(k)) continue;
          const gx = x.groups[k] ?? {}; const gy = y.groups[k] ?? {};
          for (const s of Object.keys(gx)) if (!(s in gy)) say(`${repo} ${mode}:   vanished [${gx[s]}] ${k} ${s}`);
          for (const s of Object.keys(gy)) if (!(s in gx)) say(`${repo} ${mode}:   new      [${gy[s]}] ${k} ${s}`);
        }
      }
    }
    for (const n of [...new Set([...Object.keys(A.replay ?? {}), ...Object.keys(B.replay ?? {})])].sort()) {
      const p = A.replay?.[n] ?? '-'; const q = B.replay?.[n] ?? '-';
      if (p !== q) say(`fixture ${n}: ${p} -> ${q}`);
    }
    for (const n of Object.keys({ ...A.canaries, ...B.canaries }).sort()) {
      const p = A.canaries?.[n]?.status ?? 'NOT RUN'; const q = B.canaries?.[n]?.status ?? 'NOT RUN';
      if (p !== q) say(`canary ${n}: ${p} -> ${q}`);
    }
    for (const c of Object.keys({ ...(A.pycg ?? {}), ...(B.pycg ?? {}) }).sort()) {
      const p = A.pycg?.[c]; const q = B.pycg?.[c];
      if (!p || !q) continue;
      if (p.hit !== q.hit || p.extra !== q.extra || p.pass !== q.pass) say(`pycg ${c}: hit ${p.hit} -> ${q.hit}, pass ${p.pass} -> ${q.pass}, extra ${p.extra} -> ${q.extra} (of ${q.expected})`);
    }
    for (const k of Object.keys({ ...(A.meta ?? {}), ...(B.meta ?? {}) }).sort()) {
      const p = JSON.stringify(A.meta?.[k] ?? {}); const q = JSON.stringify(B.meta?.[k] ?? {});
      if (p !== q) say(`metamorphic ${k}: ${p} -> ${q}`);
    }
    console.log(changes ? `\n${changes} change(s): ${A.build ?? a} -> ${B.build ?? b}` : `no changes: ${A.build ?? a} -> ${B.build ?? b}`);
    const result = gate(A, B);
    for (const x of result.incomparable) console.log(`INCOMPARABLE ${x.scope}: ${x.reason}${x.before == null ? '' : ` (${x.before} -> ${x.after})`}`);
    for (const t of result.triggers) {
      const detail = t.metric === 'verdict' ? `${t.before} -> ${t.after}`
        : `${t.before.join('/')} -> ${t.after.join('/')} (${t.deltaPoints.toFixed(3)} points, ${t.sites} sites)`;
      console.log(`${t.verdict} ${t.scope} ${t.metric}: ${detail}`);
    }
    console.log(`VERDICT: ${result.verdict}`);
    const json = flag('--json', null);
    if (json) fs.writeFileSync(json, JSON.stringify(result, null, 1));
    if (args.includes('--fail-on-regression') && result.verdict === 'REGRESSION') process.exitCode = 1;
    if (result.incomplete) console.log('INCOMPLETE: a scope measured on the old build errored or is missing on the new one');
    if (args.includes('--fail-on-incomplete') && result.incomplete) process.exitCode = 1;
  } catch (error) {
    console.error(`baseline diff failed: ${error.message}`);
    process.exitCode = 2;
  }
} else usage();

function usage() {
  console.error('usage: node oracle/baseline.mjs save <baseline dir> [--work dir] [--targets file]\n       node oracle/baseline.mjs diff <old baseline.json> <new baseline.json> [--fail-on-regression] [--fail-on-incomplete] [--json gate.json]');
  process.exit(2);
}
