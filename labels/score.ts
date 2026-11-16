#!/usr/bin/env node
// Score labellers against items with a known truth: accuracy with Wilson 95% intervals, split by
// truth kind (a repo definition vs outside the repo) and language, plus unanswered counts and any
// answer served by a model other than the labeller's (a gateway fallback taints that answer).
// Usage: node labels/score.ts <items.jsonl> <out dir> [--json out]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { correct } from './questions.ts';
import { isMain } from '../lib/main.ts';
import { SCIP_STRATA } from './strata.ts';

/** Wilson score interval for k of n at 95%. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n); const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/** SPEC §9: languages too noisy to score against. The labelled sample is stratified with fixed quotas
 * (labels/sample.ts), so its pooled rate reflects the sample design. Each stratum where SCIP answers
 * (labels/strata.ts SCIP_STRATA) is weighted by its share of the tabled run's sites where SCIP
 * answers: `population[lang][stratum]` sites, times the sample's SCIP-answered fraction of that
 * stratum. "SCIP right where it answers" is the weighted mean of the strata's rates; its 95% lower
 * bound is a stratified normal interval on Agresti-Coull rates ((k+2)/(n+4)). A language is
 * diagnostic when that bound is under `floor`, or when a stratum carrying at least
 * MIN_STRATUM_WEIGHT of the weight has fewer than MIN_STRATUM_LABELS labelled answers (unmeasured,
 * until a fresh sample). A stratum with no labels and less weight is dropped and the rest renormalised.
 * A tabled language with no labels is unmeasured. `table` is labels/noise.ts's `table`. */
export const DIAGNOSTIC_FLOOR = 0.8;
export const MIN_STRATUM_WEIGHT = 0.05;
export const MIN_STRATUM_LABELS = 20;
export function noiseGate(t, pop: Partial<Record<string, number>>, floor = DIAGNOSTIC_FLOOR) {
  const raw = SCIP_STRATA.map((s) => {
    const [k, n] = t?.[s]?.scip ?? [0, 0]; const consensus = t?.[s]?.consensus ?? 0;
    return { stratum: s, right: k, answered: n, sites: pop[s] ?? 0, mass: (pop[s] ?? 0) * (consensus ? n / consensus : 1) };
  }).filter((x) => x.mass > 0);
  const total = raw.reduce((a, x) => a + x.mass, 0);
  const strata = raw.map((x) => ({ ...x, weight: x.mass / total }));
  const unmeasured = strata.filter((x) => x.weight >= MIN_STRATUM_WEIGHT && x.answered < MIN_STRATUM_LABELS).map((x) => x.stratum);
  const kept = strata.filter((x) => x.answered > 0);
  const dropped = strata.filter((x) => !x.answered).map((x) => x.stratum);
  const keptMass = kept.reduce((a, x) => a + x.mass, 0);
  let estimate = 0; let variance = 0;
  for (const x of kept) {
    const w = x.mass / keptMass; const pt = (x.right + 2) / (x.answered + 4);
    estimate += (w * x.right) / x.answered; variance += (w * w * pt * (1 - pt)) / (x.answered + 4);
  }
  const lower = kept.length ? Math.max(0, estimate - 1.96 * Math.sqrt(variance)) : 0;
  const strataOut = Object.fromEntries(strata.map(({ stratum, right, answered, sites, weight }) => [stratum, { right, answered, sites, weight }]));
  return { estimate: kept.length ? estimate : null, lower, unmeasured, dropped, strata: strataOut,
    diagnostic: unmeasured.length > 0 || lower < floor }; // no labelled stratum: lower is 0
}
/** The diagnostic languages among those tabled (`population`, keyed by language). */
export function diagnosticLanguages(table, population: Record<string, Partial<Record<string, number>>>, floor = DIAGNOSTIC_FLOOR) {
  const out = new Map();
  for (const [lang, pop] of Object.entries(population)) {
    const g = noiseGate(table[lang], pop, floor);
    if (g.diagnostic) out.set(lang, { ...g, labelled: !!table[lang] });
  }
  return out;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const ji = args.indexOf('--json'); const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
  const [itemsFile, outDir] = args;
  const items = new Map(fs.readFileSync(itemsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.truth).map((i) => [i.id, i]));
  const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(0)}%` : '-');
  const ci = (k, n) => { const [a, b] = wilson(k, n); return `[${(100 * a).toFixed(0)}-${(100 * b).toFixed(0)}]`; };
  const result: Record<string, any> = {};
  console.log(`${items.size} items with a known truth\n`);
  console.log('labeller    answered  correct          95% CI     exact        reject-decoy tainted');
  for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const name = f.replace(/\.jsonl$/, '');
    const rows = new Map();
    for (const l of fs.readFileSync(path.join(outDir, f), 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); if (r.ok || !rows.has(r.id)) rows.set(r.id, r); }
    const ok = [...rows.values()].filter((r) => r.ok && items.has(r.id));
    const tainted = ok.filter((r) => (r.served_by ?? []).some((s) => s !== (r.deployment ?? r.model)));
    const clean = ok.filter((r) => !tainted.includes(r));
    const right = clean.filter((r) => correct(r.answer, items.get(r.id).truth));
    const split = (pred) => { const xs = clean.filter((r) => pred(items.get(r.id))); const k = xs.filter((r) => correct(r.answer, items.get(r.id).truth)).length; return `${k}/${xs.length}`.padEnd(12); };
    const byLang: Record<string, any> = {};
    for (const r of clean) { const lang = items.get(r.id).lang; byLang[lang] ??= [0, 0]; byLang[lang][1]++; if (correct(r.answer, items.get(r.id).truth)) byLang[lang][0]++; }
    console.log(`${name.padEnd(11)} ${`${ok.length}/${items.size}`.padEnd(9)} ${`${right.length}/${clean.length} ${pct(right.length, clean.length)}`.padEnd(16)} ${ci(right.length, clean.length).padEnd(10)} ${split((i) => !i.truth.startsWith('reject:'))} ${split((i) => i.truth.startsWith('reject:'))} ${tainted.length}`);
    console.log(`            by language: ${Object.entries(byLang).map(([k, [a, n]]) => `${k} ${a}/${n}`).join(', ')}`);
    result[name] = { answered: ok.length, clean: clean.length, correct: right.length, ci: wilson(right.length, clean.length), tainted: tainted.length, byLang,
      wrong: clean.filter((r) => !correct(r.answer, items.get(r.id).truth)).map((r) => ({ id: r.id, answer: r.answer, truth: items.get(r.id).truth, evidence: r.evidence })) };
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
}
