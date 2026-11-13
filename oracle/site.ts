#!/usr/bin/env node
// One call site, explained: everything the oracle recorded there, and how to re-run it (SPEC P3
// inspectability). Reads a finished oracle work dir (run.sh with ORACLE_ALLSITES=1); runs nothing.
//
// Usage: node oracle/site.ts <name | work dir> <file:line> [called name]
//                              [--subject codegraph|code-graph-rag|all] [--no-scip]
//   <name>: the run.sh name (`pub-express`) or a corpus name (`express`); work dirs are
//   w-<name> and w-<name>-code-graph-rag under the oracle work dir. --subject all (default) shows
//   every subject that has a work dir. --no-scip skips decoding the SCIP index (large repos).
// For each subject: the forward and missing-edge records at the site (bucket key and what it means),
// the subject's call / instantiate edges on that line, SCIP's symbol and definition(s), and the
// command that re-runs that repo's oracle. A site with no record was not a call site or was skipped
// by a rule (the work dir's skip counts are printed).
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.ts';
import { isMain } from '../lib/main.ts';

/** What each bucket's first segment means (oracle.ts; SPEC §9 maps them to match / mismatch / unaligned). */
export const MEANING = {
  ok: "the subject's target is SCIP's definition",
  'ok-other-column': "another SCIP reference on the line resolves to the subject's target",
  'ok-overload-set': "SCIP defines the function at an `@overload` stub; the subject's target is the implementation (SPEC §4)",
  'receiver-fallback': 'the subject linked the call to its receiver object (codegraph convention for an unresolved member)',
  'local-module-alias': 'SCIP stops at a local alias bound from import()/require(); the subject followed it',
  'wrong-target': "SCIP resolves the call to a different definition than the subject's target",
  external: 'SCIP resolves the call outside the repo; the subject linked an in-repo node',
  'local-shadow': 'SCIP resolves to a local binding that shadows the name the subject linked',
  'cross-file-unimported': 'the subject linked a same-named definition in a file this one never imports (Python)',
  'no-scip-ref': 'SCIP has no reference at this call (unaligned, not scored)',
  'outside-scip': 'the file is outside the SCIP index (unaligned, not scored)',
  'scip-local-undefined': 'SCIP names a local it never defines: no answer (unaligned, not scored)',
  noise: 'a known SCIP quirk (the rule is in the key), counted as mismatch in strict and left out in tolerant',
  found: 'missing-edge mode: the subject has a located edge to SCIP\'s definition here',
  'found-other-line': 'missing-edge mode: the subject has the edge within 3 lines of the site (tolerant only)',
  'found-heuristic-only': 'missing-edge mode: the subject\'s only edge here is a guess (provenance set); reported, not counted',
  'wrong-edge': 'missing-edge mode: the subject has an edge here naming the callee, to another target',
  'no-ref': 'missing-edge mode: the subject has nothing at this call',
  'unresolved-ref': 'missing-edge mode: the subject saw the reference but left it unresolved',
  'target-not-a-node': "missing-edge mode: SCIP's definition is not a node in the subject's graph",
  'file-not-indexed': 'missing-edge mode: the subject did not index this file',
  'target-file-not-indexed': "missing-edge mode: the subject did not index the definition's file",
};
export const meaningOf = (key) => {
  const parts = key.split('|'); const cause = parts[0] === 'missing' ? parts[1] : parts[0];
  return MEANING[cause] ?? (cause.startsWith('noise:') ? MEANING.noise : '(no description: see oracle/oracle.ts)');
};

/**
 * Pure core: the explanation's lines for one subject at one site.
 * records: {forward: [...], missing: [...]} out.json / out-missing.json `sites` entries at the site;
 * source: the site's source line; edges: joined edges on the line; defs: [{file, line, text}] for
 * SCIP's symbol (null when not looked up); skipped: the work dir's skip counts by rule.
 */
export function explainSite({ subject, site, name, records, source, edges, defs, skipped }: { subject: string; site: string; name?: string;
  records: { forward: any[]; missing: any[] }; source: string | null; edges: any[]; defs: { file: string; line: number; text: string | null }[] | null; skipped: Record<string, number> }) {
  const out = [`== ${subject}  ${site}${name ? `  ${name}` : ''}`, `   ${source ?? '(source line not found)'}`];
  const all = [...records.forward.map((r) => ['forward', r]), ...records.missing.map((r) => ['missing', r])];
  if (!all.length) {
    out.push('   no oracle record here: not a call site the oracle considered, or skipped by a rule.');
    const sk = Object.entries(skipped ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
    if (sk) out.push(`   skipped in this work dir: ${sk}`);
  }
  for (const [mode, r] of all) {
    out.push(`   ${mode.padEnd(8)} ${r.name.padEnd(20)} ${r.key}`, `            ${meaningOf(r.key)}`);
    if (r.target) out.push(`            subject target: ${r.target}`);
    if (r.scip) out.push(`            SCIP symbol: ${r.scip}`);
  }
  if (defs) out.push(defs.length ? `   SCIP definition: ${defs.map((d) => `${d.file}:${d.line}  ${d.text ?? ''}`.trim()).join('\n                    ')}` : '   SCIP definition: none in the index (external, or a local it never defines)');
  out.push(edges.length ? `   ${subject} edges on this line: ${edges.map((e) => `${e.kind} ${e.tqname} ${e.tfile}:${e.tstart}${e.prov ? ` [${e.prov}]` : ''}`).join('\n                              ')}` : `   ${subject} edges on this line: none`);
  return out;
}

const LANG = { python: 'python', go: 'go', typescript: 'ts', javascript: 'ts' };

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
  const flag = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
  const which = opt('--subject', 'all'); const noScip = flag('--no-scip');
  const [target, site, name] = args;
  if (!target || !/:\d+$/.test(site ?? '')) { console.error('usage: site.ts <name | work dir> <file:line> [called name] [--subject codegraph|code-graph-rag|all] [--no-scip]'); process.exit(2); }
  const file = site.slice(0, site.lastIndexOf(':')); const line = Number(site.slice(site.lastIndexOf(':') + 1));

  const base = fs.existsSync(target) ? path.resolve(target).replace(/-code-graph-rag$/, '')
    : [`w-pub-${target}`, `w-${target}`].map((d) => path.join(config.work, d)).find((d) => fs.existsSync(d));
  if (!base) { console.error(`no work dir for ${target} under ${config.work}`); process.exit(1); }
  const runName = path.basename(base).replace(/^w-/, '');
  const subjects = Object.entries({ codegraph: base, 'code-graph-rag': `${base}-code-graph-rag` })
    .filter(([s, d]) => (which === 'all' || which === s) && fs.existsSync(path.join(d, 'out.json')));
  if (!subjects.length) { console.error(`no oracle results for ${which} at ${base}`); process.exit(1); }

  const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  const at = (sites) => (sites ?? []).filter((s) => s.site === site && (!name || s.name === name));
  const lineIn = (dir, f, l) => { try { return fs.readFileSync(path.join(dir, 'repo', f), 'utf8').split('\n')[l - 1]?.trim(); } catch { return null; } };

  let defsFor: (sym: string | undefined) => { file: string; line: number; text: string | null }[] | null = () => null;
  if (!noScip) {
    const scipFile = fs.readdirSync(config.scipCache).filter((f) => f.startsWith(`${runName}-`) && f.endsWith('.scip'))
      .map((f) => path.join(config.scipCache, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (scipFile) {
      const { loadScip } = await import('../lib/scip.ts');
      const defs = new Map();
      for (const d of loadScip(scipFile).documents ?? []) for (const o of d.occurrences ?? []) {
        if (!((o.symbol_roles ?? 0) & 1) || !o.symbol) continue;
        const key = o.symbol.startsWith('local ') ? `${d.relative_path}#${o.symbol}` : o.symbol;
        const t = o.TypedRange ?? o.typed_range ?? {}; const l0 = o.range?.[0] ?? t.SingleLineRange?.line ?? t.MultiLineRange?.start_line ?? 0;
        (defs.get(key) ?? defs.set(key, []).get(key)).push({ file: d.relative_path, line: l0 + 1 });
      }
      defsFor = (sym) => (sym ? (defs.get(sym) ?? defs.get(sym.replace(/`<constructor>`\(\)\.$/, '')) ?? []).map((d) => ({ ...d, text: lineIn(base, d.file, d.line) })) : null);
    }
  }

  for (const [subj, dir] of subjects) {
    const fwd = readJson(path.join(dir, 'out.json')); const miss = readJson(path.join(dir, 'out-missing.json'));
    const records = { forward: at(fwd.sites), missing: at(miss.sites) };
    let snap = null;
    try {
      snap = subj === 'codegraph' ? (await import('../lib/subjects/codegraph.ts')).snapshot(path.join(dir, 'repo'))
        : (await import('../lib/snapshot.ts')).loadSnapshot(path.join(dir, 'snapshot.json'));
    } catch { /* no store: edges are not shown */ }
    const { joinedEdges } = await import('../lib/snapshot.ts');
    const edges = snap ? joinedEdges(snap).filter((e) => e.sfile === file && e.line === line && (e.kind === 'calls' || e.kind === 'instantiates') && (!name || e.tname === name || (e.ref ?? '').endsWith(name))) : [];
    const sym = [...records.forward, ...records.missing].map((r) => r.scip).find(Boolean);
    const lines = explainSite({ subject: subj, site, name, records, source: lineIn(dir, file, line), edges, defs: defsFor(sym), skipped: { ...fwd.skipped, ...miss.skipped } });
    console.log(lines.join('\n'));
  }
  const corpusName = runName.replace(/^pub-/, '');
  const row = (await import('../differential/builds.mjs')).readRepos(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'corpus', 'v2.txt'), 'all').find((r) => r.name === corpusName);
  console.log('\nre-run this repo\'s oracle (seconds once its SCIP index is cached):');
  if (row) console.log(`  node differential/builds.mjs --fetch <dest> corpus/v2.txt all   # ${row.name} @ ${row.sha.slice(0, 12)}`);
  for (const [subj] of subjects) console.log(`  CGQA_SUBJECT=${subj} ORACLE_ALLSITES=1 bash oracle/run.sh ${runName} ${row ? `<dest>/${row.name}` : '<src repo>'} ${row ? LANG[row.language] : '<ts|python|go>'}`);
}
