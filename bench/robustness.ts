// T3 seed-run evidence is separate from accuracy. Errors stay in the eligible denominator.
import { recordedAdapterHash } from '../lib/provenance.ts';

export const T3_RELATIONS = ['decoy', 'shift', 'repeat'];
const empty = () => ({ total: 0, clean: 0, changed: 0, errors: 0, notApplicable: 0, unverified: 0, eligible: 0,
  byteIdentical: 0, graphOnly: 0, rawUnknown: 0, passRate: null });
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function summarizeRobustness(rows, subject) {
  const result = { status: 'NOT RUN', relations: Object.fromEntries(T3_RELATIONS.map((r) => [r, empty()])),
    adapterHashes: [], challenges: {}, complete: false };
  if (rows == null) return result;
  if (!Array.isArray(rows)) throw new Error('T3 evidence must be an array');
  const seen = new Set(); const hashes = new Set();
  for (const row of rows) {
    if (!row || typeof row.seed !== 'string' || !row.seed || typeof row.relation !== 'string') throw new Error('malformed T3 seed/relation');
    const relation = row.relation === '-' && row.error ? 'setup' : row.relation;
    if (![...T3_RELATIONS, 'setup'].includes(relation)) throw new Error(`unknown T3 relation ${relation}`);
    if (row.subject !== undefined && row.subject !== subject) throw new Error(`T3 subject mismatch: expected ${subject}`);
    const key = JSON.stringify([row.seed, relation]);
    if (seen.has(key)) throw new Error(`duplicate T3 seed/relation ${key}`);
    seen.add(key);
    const hash = recordedAdapterHash(row);
    if (hash !== null && !isHash(hash)) throw new Error('invalid T3 adapter hash');
    if (row.challengeSha256 != null && !isHash(row.challengeSha256)) throw new Error('invalid T3 challenge hash');
    hashes.add(hash); result.challenges[key] = row.challengeSha256 ?? null;
    if (row.notApplicable !== undefined && typeof row.notApplicable !== 'boolean') throw new Error('invalid T3 precondition flag');
    if (row.byteIdentical !== undefined && typeof row.byteIdentical !== 'boolean') throw new Error('invalid T3 raw identity flag');
    const counts = result.relations[relation] ??= empty(); counts.total++;
    if (row.error !== undefined) { if (typeof row.error !== 'string' || !row.error) throw new Error('invalid T3 error evidence'); counts.errors++; continue; }
    if (row.notApplicable === true || (relation === 'decoy' && row.decoys === 0)) {
      if ((row.diffs != null && (typeof row.diffs !== 'object' || Array.isArray(row.diffs))) || (row.notApplicable && (typeof row.reason !== 'string' || !row.reason)) || Object.values<any>(row.diffs ?? {}).some((v) => !Array.isArray(v) || v.length)) throw new Error('invalid T3 precondition evidence');
      counts.notApplicable++; continue;
    }
    if (!row.diffs || typeof row.diffs !== 'object' || Array.isArray(row.diffs) || Object.values<any>(row.diffs).some((v) => !Array.isArray(v))) throw new Error('invalid T3 diff evidence');
    const changed = Object.values<any>(row.diffs).some((v) => v.length);
    if (changed && row.byteIdentical === true) throw new Error('byte-identical T3 result has graph differences');
    if (!row.challengeSha256) { counts.unverified++; continue; }
    counts[changed ? 'changed' : 'clean']++;
    if (relation === 'repeat' && !changed) {
      if (row.byteIdentical === true) counts.byteIdentical++;
      else if (row.byteIdentical === false) counts.graphOnly++;
      else counts.rawUnknown++;
    }
  }
  for (const counts of Object.values<any>(result.relations)) {
    counts.eligible = counts.total - counts.notApplicable - counts.unverified;
    counts.passRate = counts.eligible ? counts.clean / counts.eligible : null;
  }
  const seeds = new Set(rows.map((r) => r.seed));
  result.complete = seeds.size > 0 && [...seeds].every((seed) => T3_RELATIONS.every((relation) => seen.has(JSON.stringify([seed, relation]))));
  result.adapterHashes = [...hashes];
  result.status = rows.length ? 'RECORDED' : 'NOT RUN';
  return result;
}

/** Missing fingerprints cannot establish shared challenges; never infer a match from two nulls. */
export function compareChallenges(a, b) {
  const result = { matched: [], mismatched: [], unknown: [], unpaired: [] };
  for (const key of new Set([...Object.keys(a.challenges), ...Object.keys(b.challenges)])) {
    if (!Object.hasOwn(a.challenges, key) || !Object.hasOwn(b.challenges, key)) result.unpaired.push(key);
    else if (!a.challenges[key] || !b.challenges[key]) result.unknown.push(key);
    else result[a.challenges[key] === b.challenges[key] ? 'matched' : 'mismatched'].push(key);
  }
  return result;
}

export function robustnessMarkdown(subjects, comparison) {
  const md = ['## T3 robustness (seed runs)', '',
    '| subject | relation | clean / eligible | changed | errors | not applicable | unverified | repeat: raw identical / graph-only / unknown |',
    '|---|---|---|---|---|---|---|---|'];
  for (const [name, summary] of Object.entries<any>(subjects)) {
    for (const [relation, c] of Object.entries<any>(summary.relations)) {
      const score = c.eligible ? `${c.clean}/${c.eligible}` : c.total ? 'N/A' : 'NOT RUN';
      md.push(`| ${name} | ${relation} | ${score} | ${c.changed} | ${c.errors} | ${c.notApplicable} | ${c.unverified} | ${relation === 'repeat' ? `${c.byteIdentical} / ${c.graphOnly} / ${c.rawUnknown}` : '-'} |`);
    }
  }
  md.push('', 'Errors remain in the eligible denominator; unsupported or empty transformations are not applicable. Legacy evidence without challenge fingerprints is unverified and excluded from eligible counts. Clean repeat runs have the same canonical graph; raw id/order drift is reported separately.',
    `Shared challenge fingerprints: ${comparison.matched.length} matched, ${comparison.mismatched.length} mismatched, ${comparison.unknown.length} unknown, ${comparison.unpaired.length} unpaired. Unknown or unmatched evidence does not establish a paired subject comparison.`);
  for (const [name, summary] of Object.entries<any>(subjects)) md.push(`${name} T3 adapter hashes: ${summary.adapterHashes.length ? summary.adapterHashes.map((h) => h ?? 'unknown (legacy)').join(', ') : 'no inputs'}.`);
  return md;
}
