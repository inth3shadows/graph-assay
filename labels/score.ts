#!/usr/bin/env node
// Score labellers against items with a known truth: accuracy with Wilson 95% intervals, split by
// truth kind (a repo definition vs outside the repo) and language, plus unanswered counts and any
// answer served by a model other than the labeller's (a gateway fallback taints that answer).
// Usage: node labels/score.ts <items.jsonl> <out dir> [--json out]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { correct } from './questions.ts';
import { isMain } from '../lib/main.ts';

/** Wilson score interval for k of n at 95%. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n); const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/** SPEC §9: languages too noisy to score against. A noise table (labels/noise.ts `table`) entry is
 * diagnostic when the 95% Wilson lower bound of "SCIP right where it answers" is under `floor`. */
export const DIAGNOSTIC_FLOOR = 0.8;
export function diagnosticLanguages(table, floor = DIAGNOSTIC_FLOOR) {
  const out = new Map();
  for (const [lang, t] of Object.entries<any>(table)) {
    const [k, n] = t.ALL.scip; const lower = n ? wilson(k, n)[0] : 0;
    if (lower < floor) out.set(lang, { right: k, answered: n, lower });
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
