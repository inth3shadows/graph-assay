#!/usr/bin/env node
// Stratified sample of call sites for the oracle-noise study, from the oracle's per-site results
// (run.sh with ORACLE_ALLSITES, both subjects) on the public corpus. One unit = one call site
// (file:line + called name), whatever each subject and SCIP said about it. Strata:
//   agree         every subject's edge there agrees with SCIP (`ok*`)
//   disagree      some subject's edge contradicts SCIP (wrong-target, external, local-*, ...)
//   scip-only     SCIP resolves a call there and some subject has no edge (missing: no-ref, ...)
//   subject-only  a subject has an edge where SCIP has no reference (`no-scip-ref`)
// Candidates: SCIP's definition, every subject's target and same-named definitions, each
// canonicalized to the innermost definition span (SCIP anchors at the name token, subjects at
// the declaration or decorator), so one definition is one letter. Which source proposed which
// candidate stays in `meta`, never in the question.
//
// Usage: node labels/sample.mjs <out.jsonl> [--per-lang 200] [--seed 1] [--targets name:lang,...] [--exclude a.jsonl,...]
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.ts';
import { loadScip } from '../lib/scip.ts';
import { loadSnapshot } from '../lib/snapshot.ts';
import * as codegraph from '../lib/subjects/codegraph.ts';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const perLang = Number(opt('--per-lang', '200'));
const seed = opt('--seed', '1');
// --exclude a.jsonl[,b.jsonl]: leave out units already in earlier samples (a fresh sample to validate
// a rule must not reuse the sites that motivated it, SPEC §9).
const excluded = new Set(opt('--exclude', '').split(',').filter(Boolean).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)));
const targets = opt('--targets', 'pub-requests:python,pub-click:python,mux:go').split(',').map((t) => { const [name, lang] = t.split(':'); return { name, lang }; });
const [outFile] = args;
if (!outFile) { console.error('usage: sample.mjs <out.jsonl> [--per-lang N] [--seed S] [--targets name:lang,...]'); process.exit(2); }
const QUOTA = { agree: 0.25, disagree: 0.35, 'scip-only': 0.2, 'subject-only': 0.2 };
const SUBJECTS = { codegraph: '', 'code-graph-rag': '-code-graph-rag' };
const rank = (k) => createHash('sha256').update(`${seed}|${k}`).digest('hex');

const rangeOf = (o) => o.range ?? (() => { const t = o.TypedRange ?? o.typed_range ?? {}; if (t.SingleLineRange) return [t.SingleLineRange.line ?? 0]; return [t.MultiLineRange?.start_line ?? 0]; })();
function scipDefs(file) {
  const defs = new Map();
  for (const d of loadScip(file).documents ?? []) for (const o of d.occurrences ?? []) {
    if (((o.symbol_roles ?? 0) & 1) && o.symbol) {
      // A `local N` symbol is document-scoped: the oracle names it `<file>#local N`.
      const key = o.symbol.startsWith('local ') ? `${d.relative_path}#${o.symbol}` : o.symbol;
      if (!defs.has(key)) defs.set(key, []);
      defs.get(key).push({ file: d.relative_path, line: rangeOf(o)[0] + 1 });
    }
  }
  return defs;
}
const latest = (dir, prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.scip'))
  .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

const items = [];
for (const lang of [...new Set(targets.map((t) => t.lang))]) {
  const units = [];
  for (const t of targets.filter((x) => x.lang === lang)) {
    const w = path.join(config.work, `w-${t.name}`);
    const scipFile = latest(config.scipCache, `${t.name}-`);
    const defs = scipDefs(scipFile);
    const snaps = { codegraph: codegraph.snapshot(path.join(w, 'repo')), 'code-graph-rag': loadSnapshot(path.join(`${w}-code-graph-rag`, 'snapshot.json')) };
    const nodes = Object.values(snaps).flatMap((s) => s.nodes.filter((n) => n.kind !== 'file'));
    // innermost definition with that name whose span holds the line, else the line itself
    const canon = (file, line, name) => {
      const n = nodes.filter((x) => x.file === file && x.start <= line && line <= x.end && (!name || x.name === name)).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      return n ? { file, line: n.start, kind: n.kind, name: n.name } : { file, line, kind: '?', name: name ?? '?' };
    };
    const byUnit = new Map();
    const unit = (s) => { const k = `${s.site}|${s.name}`; if (!byUnit.has(k)) byUnit.set(k, { site: s.site, name: s.name, scip: s.scip ?? null, fwd: {}, miss: {} }); return byUnit.get(k); };
    for (const [subj, sfx] of Object.entries(SUBJECTS)) {
      for (const s of JSON.parse(fs.readFileSync(path.join(`${w}${sfx}`, 'out.json'), 'utf8')).sites ?? []) { const u = unit(s); u.fwd[subj] = { key: s.key, target: s.target }; u.scip ??= s.scip; }
      for (const s of JSON.parse(fs.readFileSync(path.join(`${w}${sfx}`, 'out-missing.json'), 'utf8')).sites ?? []) { const u = unit(s); u.miss[subj] = { key: s.key }; u.scip ??= s.scip; }
    }
    for (const u of byUnit.values()) {
      const f = Object.values(u.fwd).map((x) => x.key); const m = Object.values(u.miss).map((x) => x.key);
      const stratum = f.some((k) => /^(wrong-target|external|local-shadow|cross-file-unimported|scip-local-undefined)/.test(k)) || m.some((k) => /^missing\|wrong-edge/.test(k)) ? 'disagree'
        : m.some((k) => /^missing\|(no-ref|unresolved-ref|not-extracted|target-not-a-node)/.test(k)) ? 'scip-only'
          : f.some((k) => k.startsWith('no-scip-ref')) ? 'subject-only'
            : f.length === Object.keys(SUBJECTS).length && f.every((k) => k.startsWith('ok')) ? 'agree' : null;
      if (!stratum) continue;
      const [file, line] = [u.site.slice(0, u.site.lastIndexOf(':')), Number(u.site.slice(u.site.lastIndexOf(':') + 1))];
      const sources = {};
      const cands = new Map();
      const add = (c, who) => { const k = `${c.file}:${c.line}`; if (!cands.has(k)) cands.set(k, c); (sources[k] ??= []).push(who); };
      let sd = u.scip ? defs.get(u.scip.replace(/`<constructor>`\(\)\.$/, '')) ?? defs.get(u.scip) : null;
      // A local SCIP symbol is SCIP's answer as a definition when a node of the called name starts at
      // its definition (a test helper inside a callback, a module-level alias the subjects extract);
      // a binding no subject extracts as a node (a parameter, `var express = require('../')` in a
      // test) is the `local` answer, and adds no candidate. A local SCIP never defines is no answer.
      const isLocal = !!u.scip && /(^|#)local /.test(u.scip);
      const localUndefined = isLocal && !sd; // SCIP names a local it never defines: no answer (SPEC §9 scip-local-undefined)
      if (isLocal && sd) { const c = canon(sd[0].file, sd[0].line, u.name); if (!(c.line === sd[0].line && c.name === u.name)) sd = null; }
      if (sd) for (const d of sd) add(canon(d.file, d.line, null), 'scip');
      for (const [subj, x] of Object.entries(u.fwd)) {
        if (!x.target) continue;
        const parts = x.target.split(':'); const start = Number(parts.pop()); const tf = parts[0];
        add(canon(tf, start, null), subj);
      }
      for (const n of nodes.filter((x) => x.name === u.name)) add({ file: n.file, line: n.start, kind: n.kind, name: n.name }, 'same-name');
      const scipAnswer = !u.scip || localUndefined ? 'none' : isLocal && !sd ? 'local' : sd ? `${canon(sd[0].file, sd[0].line, null).file}:${canon(sd[0].file, sd[0].line, null).line}` : 'external';
      const ordered = [...cands.entries()].sort((a, b) => (sources[b[0]].includes('same-name') && sources[b[0]].length === 1 ? 0 : 1) - (sources[a[0]].includes('same-name') && sources[a[0]].length === 1 ? 0 : 1));
      units.push({
        id: `s:${t.name}:${u.site}:${u.name}`, lang, repo: path.join(w, 'repo'), site: { file, line, name: u.name },
        candidates: ordered.slice(0, 22).map(([, c]) => c), stratum,
        meta: { target: t.name, scip: scipAnswer, scipSymbol: u.scip, sources: Object.fromEntries(ordered.slice(0, 22).map(([k]) => [k, sources[k]])), fwd: u.fwd, miss: u.miss, truncated: ordered.length > 22 },
      });
    }
  }
  // quotas per stratum, then round-robin over repos within a stratum so no repo dominates
  for (const [stratum, q] of Object.entries(QUOTA)) {
    const want = Math.round(perLang * q);
    const pools = new Map();
    for (const u of units.filter((x) => x.stratum === stratum && !excluded.has(x.id)).sort((a, b) => rank(a.id).localeCompare(rank(b.id)))) {
      if (!pools.has(u.meta.target)) pools.set(u.meta.target, []);
      pools.get(u.meta.target).push(u);
    }
    const picked = [];
    while (picked.length < want && [...pools.values()].some((p) => p.length)) for (const p of pools.values()) if (p.length && picked.length < want) picked.push(p.shift());
    items.push(...picked);
    console.error(`${lang} ${stratum}: ${picked.length}/${want} (pool ${units.filter((x) => x.stratum === stratum).length})`);
  }
}
fs.writeFileSync(outFile, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
console.error(`${items.length} items -> ${outFile}`);
