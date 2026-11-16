// The oracle-noise strata (SPEC §9), shared by the sampler (labels/sample.ts) and the tables'
// noise gate (bench/tables.ts), so a sampled stratum and a weighted stratum are the same set of sites.
// One unit = one call site (file:line + called name), keyed by its per-site results on both tracks:
//   agree         every subject's edge there agrees with SCIP (`ok*`)
//   disagree      some subject's edge contradicts SCIP (wrong-target, external, local-*, ...)
//   scip-only     SCIP resolves a call there and some subject has no edge (missing: no-ref, ...)
//   subject-only  a subject has an edge where SCIP has no reference (`no-scip-ref`)
// Anything else (a guessed or skipped edge, a subject without a forward result) is in no stratum.

export const STRATA = ['agree', 'disagree', 'scip-only', 'subject-only'] as const;
export type Stratum = typeof STRATA[number];
/** The strata where SCIP gives an answer, so "SCIP right where it answers" is defined. */
export const SCIP_STRATA: Stratum[] = ['agree', 'disagree', 'scip-only'];

/** A unit's stratum from each subject's forward keys and missing-direction keys, or null. */
export function stratumOf(fwd: string[], miss: string[], subjects: number): Stratum | null {
  if (fwd.some((k) => /^(wrong-target|external|local-shadow|cross-file-unimported|scip-local-undefined)/.test(k)) || miss.some((k) => /^missing\|wrong-edge/.test(k))) return 'disagree';
  if (miss.some((k) => /^missing\|(no-ref|unresolved-ref|not-extracted|target-not-a-node)/.test(k))) return 'scip-only';
  if (fwd.some((k) => k.startsWith('no-scip-ref'))) return 'subject-only';
  return fwd.length === subjects && fwd.every((k) => k.startsWith('ok')) ? 'agree' : null;
}

export interface StratumCount { sites: number; answered: number }
/** Sites per stratum in one repository, and how many of them SCIP answers (a SCIP symbol, unless the
 * oracle found it a local SCIP never defines, `scip-local-undefined`, as the sampler's `none`), from
 * each subject's oracle outputs (out.json, out-missing.json written with ORACLE_ALLSITES, as
 * oracle/run.sh always does). */
export function stratumCounts(outputs: { fwd: { sites?: any[] }; miss: { sites?: any[] } }[]) {
  // One key per subject and unit (the last site record wins, as in the sampler).
  const units = new Map<string, { fwd: Record<number, string>; miss: Record<number, string>; scip: boolean }>();
  const unit = (s) => { const k = `${s.site}|${s.name}`; if (!units.has(k)) units.set(k, { fwd: {}, miss: {}, scip: false }); const u = units.get(k); if (s.scip) u.scip = true; return u; };
  outputs.forEach((o, i) => {
    for (const s of o.fwd.sites ?? []) unit(s).fwd[i] = s.key;
    for (const s of o.miss.sites ?? []) unit(s).miss[i] = s.key;
  });
  const counts: Partial<Record<Stratum, StratumCount>> = {};
  for (const u of units.values()) {
    const fwd = Object.values(u.fwd); const miss = Object.values(u.miss);
    const s = stratumOf(fwd, miss, outputs.length);
    if (!s) continue;
    const c = (counts[s] ??= { sites: 0, answered: 0 });
    c.sites++;
    if (u.scip && ![...fwd, ...miss].some((k) => k.startsWith('scip-local-undefined'))) c.answered++;
  }
  return counts;
}
