#!/usr/bin/env node
// Metamorphic checks: change a project in a way that must not change its graph,
// re-index, and diff the edges. No oracle needed: the original index is the reference.
//
// Usage: node metamorphic/run.mjs [--subject name] <build | default> <seed dir...> [--relations decoy,shift,repeat] [--json out.json]
//   A seed is any project dir (it is copied; .git, .codegraph and node_modules are skipped).
//   `fixtures` as a seed expands to every fixtures/oracle-candidates/* dir.
//
// Relations:
//   decoy  add zz_cg_decoy/ files that define every name the project calls (each edge target's
//          name, and the last segment of each unresolved call) as an unimported function, class
//          and method. Nothing imports them, so (Python, TS/JS) nothing may link to them.
//            CAPTURED  an edge from the original code now lands in a decoy file
//            LOST      an original edge is gone (its resolvedBy says whether it was a guess)
//            GAINED    a new edge between original nodes
//   shift  insert 3 blank lines at the top of every source file (after a shebang / coding line).
//          Edges must be identical with their lines moved by 3.
//            MOVED     an edge that is not in the original once lines are shifted back
//            LOST      an original edge with no shifted counterpart
// Exit code: 0 when every seed is clean, 1 when any diff was found, 2 on usage / index errors.
import { fileURLToPath } from 'node:url';
import { joinedEdges } from '../lib/snapshot.mjs';
import { canonical, diffCanonical, rawHash } from '../differential/modes.mjs';
import { applyRelation, RELATIONS, SKIP, DECOY_DIR, SHIFT } from './relations.mjs';
import { buildFor, subject } from '../lib/subjects/index.mjs';
import * as fs from 'node:fs';
import { adapterHash } from '../lib/provenance.mjs';
import { SPEC_VERSION } from '../lib/spec.mjs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = args.indexOf(flag); if (i < 0) return dflt; const v = args[i + 1];
  if (v == null || v.startsWith('--')) { console.error(`${flag} needs a value`); process.exit(2); }
  return args.splice(i, 2)[1];
};
const jsonOut = opt('--json', null);
const relations = opt('--relations', RELATIONS.join(',')).split(',');
const subj = subject(opt('--subject', 'codegraph'));
const [buildArg, ...seedArgs] = args;
const build = buildArg && buildFor(subj, buildArg);
if (!build || !fs.existsSync(build) || seedArgs.length === 0 || relations.some((r) => !RELATIONS.includes(r)) || new Set(relations).size !== relations.length) {
  console.error('usage: node metamorphic/run.mjs [--subject name] <build | default> <seed dir...> [--relations decoy,shift,repeat] [--json out.json]');
  process.exit(2);
}
const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = path.join(qa, 'fixtures/oracle-candidates');
const seeds = seedArgs.flatMap((s) => s === 'fixtures'
  ? fs.readdirSync(fixtureRoot).sort().map((n) => path.join(fixtureRoot, n)) : [path.resolve(s)]);
if (!seeds.length) { console.error('no metamorphic seeds selected'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-meta-'));
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) && !/^\.env(?:\.|$)/.test(path.basename(p)) });


function index(dir) {
  const r = subj.index(dir, build);
  if (!r.ok) throw new Error(`index failed in ${dir}: ${r.output.trim().split('\n').slice(-3).join(' | ')}`);
  const snap = subj.snapshot(dir, { build });
  const edges = joinedEdges(snap).filter((e) => e.kind !== 'contains')
    .map((e) => ({ ...e, sq: e.sname, tq: e.tqname }));
  const unresolved = snap.unresolved.filter((u) => u.kind === 'calls' || u.kind === 'instantiates').map((u) => u.name);
  const langs = new Set(snap.nodes.map((n) => n.language));
  return { edges, unresolved, langs, snapshot: snap };
}
// An edge's identity: caller, kind, target, site line and column. A node is its file, kind and
// line span, never a name: a subject may encode position in names (code-graph-rag calls a second
// `setup` `setup@26` and a closure `anonymous_3_18`). `ds` / `dt` shift the source / target spans
// back (file nodes do not move). Diffs are multisets, so a duplicated or dropped copy shows up.
const node = (file, kind, start, end, d) => `${file}:${kind}@${kind === 'file' ? '' : `${start + d}-${end + d}`}`;
const key = (e, ds = 0, dt = 0) => `${node(e.sfile, e.skind, e.sstart, e.send, ds)}|${e.kind}|${node(e.tfile, e.tkind, e.tstart, e.tend, dt)}|${e.line == null ? '-' : e.line + ds}:${e.col ?? '-'}`;
/** The items of `xs` (by keyX) left over after matching each item of `ys` (by keyY) at most once. */
const minus = (xs, keyX, ys, keyY) => {
  const bag = new Map();
  for (const y of ys) { const k = keyY(y); bag.set(k, (bag.get(k) ?? 0) + 1); }
  return xs.filter((x) => { const k = keyX(x); const n = bag.get(k) ?? 0; if (n > 0) { bag.set(k, n - 1); return false; } return true; });
};
const show = (e) => `${e.sfile}:${e.line} ${e.sq} -${e.kind}-> ${e.tfile}:${e.tq} (${e.by ?? e.prov ?? '-'})`;


const results = [];
let dirty = false;
let errors = 0;
try {
  for (const [i, seed] of seeds.entries()) {
    // A cached corpus checkout is <name>/repo: name it after its parent.
    const name = path.basename(seed) === 'repo' ? path.basename(path.dirname(seed)).replace(/^w-/, '') : path.basename(seed);
    const slot = `${i}-${name}`;
    const orig = path.join(work, `${slot}-orig`);
    let base;
    try {
      copy(seed, orig);
      base = index(orig);
    } catch (err) { for (const relation of relations) results.push({ seed: name, relation, error: String(err.message) }); errors++; continue; }
    for (const rel of relations) {
      const dir = path.join(work, `${slot}-${rel}`);
      copy(seed, dir);
      const res = { seed: name, relation: rel, edges: base.edges.length, diffs: {} };
      try {
        Object.assign(res, applyRelation(dir, rel));
        if (res.notApplicable) { results.push(res); continue; }
        if (rel === 'decoy') {
          const after = index(dir).edges.filter((e) => !e.sfile.startsWith(`${DECOY_DIR}/`));
          const intoDecoy = (e) => e.tfile.startsWith(`${DECOY_DIR}/`);
          res.diffs.CAPTURED = after.filter(intoDecoy).map(show);
          res.diffs.LOST = minus(base.edges, key, after, key).map(show);
          res.diffs.GAINED = minus(after.filter((e) => !intoDecoy(e)), key, base.edges, key).map(show);
        } else if (rel === 'shift') {
          const shifted = new Set(res.shiftedFiles);
          const dl = (f) => (shifted.has(f) ? SHIFT : 0);
          const back = (e) => key(e, dl(e.sfile), dl(e.tfile));
          const after = index(dir).edges;
          res.diffs.MOVED = minus(after, key, base.edges, back).map(show);
          res.diffs.LOST = minus(base.edges, back, after, key).map(show);
        } else if (rel === 'repeat') {
          const after = index(dir).snapshot;
          res.byteIdentical = rawHash(base.snapshot) === rawHash(after);
          const diff = diffCanonical(canonical(base.snapshot), canonical(after));
          res.diffs.REPEAT = Object.entries(diff).flatMap(([category, entries]) => entries.map((x) => `${category}: ${x.a} -> ${x.b} ${x.key}`));
        }
      } catch (err) { res.error = String(err.message); errors++; }
      for (const v of Object.values(res.diffs)) if (v.length) dirty = true;
      results.push(res);
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const limit = Number(process.env.META_SHOW ?? 5);
for (const r of results) {
  if (r.notApplicable) { console.log(`N/A      ${r.seed} ${r.relation}: ${r.reason}`); continue; }
  if (r.error) { console.log(`ERROR    ${r.seed} ${r.relation}: ${r.error}`); continue; }
  const counts = Object.entries(r.diffs).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.length}`);
  console.log(`${counts.length ? 'DIFF ' : 'clean'}    ${r.seed.padEnd(28)} ${r.relation.padEnd(6)} edges ${r.edges}${r.decoys != null ? `, decoys ${r.decoys}` : ''}${counts.length ? `  ${counts.join(', ')}` : ''}`);
  for (const [k, v] of Object.entries(r.diffs)) for (const x of v.slice(0, limit)) console.log(`           ${k.padEnd(8)} ${x}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results.map((r) => ({ ...r, spec: SPEC_VERSION, subject: subj.name, adapterSha256: adapterHash(subj.name) })), null, 1));
process.exit(errors ? 2 : dirty ? 1 : 0);
