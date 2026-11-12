// Shared T2 bucket mapping for benchmark tables and build-vs-build effect-size gating.
const STRICT_OK = /^(ok|ok-overload-set)\|/; const TOL_OK = /^(ok-other-column|local-module-alias)\|/;
const MISMATCH = /^(wrong-target|external|local-shadow|cross-file-unimported|receiver-fallback)\|/;
const NOISE = /^noise:/; const UNALIGNED = /^(no-scip-ref|outside-scip|scip-local-undefined)/;

export function forward(j) {
  const c = { match: 0, tol: 0, mismatch: 0, noise: 0, unaligned: 0 };
  for (const [k, v] of Object.entries(j.buckets)) {
    const key = `${k}|`;
    if (STRICT_OK.test(key)) c.match += v; else if (TOL_OK.test(key)) c.tol += v; else if (MISMATCH.test(key)) c.mismatch += v;
    else if (NOISE.test(key)) c.noise += v; else if (UNALIGNED.test(key)) c.unaligned += v;
    else throw new Error(`unknown forward verdict ${k} (SPEC §5): fix the oracle or the mapping`);
  }
  return { ...c, skipped: Object.values(j.skipped ?? {}).reduce((a, b) => a + b, 0), skippedBy: j.skipped ?? {},
    strict: [c.match, c.match + c.tol + c.mismatch + c.noise], tolerant: [c.match + c.tol, c.match + c.tol + c.mismatch] };
}
const CAUSES = new Set(['found', 'found-heuristic-only', 'found-other-line', 'receiver-fallback', 'wrong-edge',
  'unresolved-ref', 'no-ref', 'target-not-a-node', 'file-not-indexed', 'target-file-not-indexed']);
export function missing(j) {
  const c = {};
  for (const [k, v] of Object.entries(j.buckets)) {
    const cause = k.split('|')[1];
    if (!CAUSES.has(cause)) throw new Error(`unknown missing-edge verdict ${k} (SPEC §5): fix the oracle or the mapping`);
    c[cause] = (c[cause] ?? 0) + v;
  }
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  // SPEC §4 columns: @decl units (in the headline, also shown alone) and decorator sites (never in it).
  const decl = [0, 0];
  for (const [k, v] of Object.entries(j.buckets)) if (k.split('|')[3]?.includes('@decl')) { decl[1] += v; if (k.split('|')[1] === 'found') decl[0] += v; }
  const decorators = j.decorators ? [j.decorators.causes?.found ?? 0, j.decorators.total] : null;
  return { causes: c, total, strict: [c.found ?? 0, total], tolerant: [(c.found ?? 0) + (c['found-other-line'] ?? 0), total], guessOnly: c['found-heuristic-only'] ?? 0, decl, decorators };
}

// SPEC §3 function-pair track, from out-missing.json `pairs`; null for results that predate it.
// Precision counts a subject pair the oracle lacks only where the oracle answers for it (it has a
// reference named like the callee inside the caller); silent, skipped and decorator-only pairs are
// shown, never scored. One variant: noise and line-window rules are call-site rules.
export function pairs(j) {
  const p = j.pairs;
  if (!p) return null;
  return { precision: [p.matched, p.matched + p.subjectOnly.oracleDisagrees], recall: [p.matched, p.oracle],
    oracle: p.oracle, subject: p.subject, disagrees: p.subjectOnly.oracleDisagrees, silent: p.subjectOnly.oracleSilent,
    skipped: p.skipped, guessOnly: p.guessOnly, decorators: [p.decorators.found, p.decorators.total],
    unmapped: p.unmappedEdges.caller + p.unmappedEdges.target,
    // null for results that predate the count (before #39)
    skippedEdges: p.skippedEdges ? Object.values(p.skippedEdges).reduce((a, b) => a + b, 0) : null,
    callerRanges: p.callerRanges, atFile: p.unitsAtFileLevel };
}

/** Compare saved baselines. Rates use strict scores; undefined rates cannot trigger.
 * Incomparable repos are excluded from BOTH micro pools. No input is mutated.
 * For changing precision denominators, sites = max(lost matches, added mismatches)
 * (reversed for a gain), avoiding double-counting a match becoming a mismatch.
 */
export function gate(old, next) {
  const triggers = []; const incomparable = [];
  const pools = { precision: [[0, 0], [0, 0]], recall: [[0, 0], [0, 0]] };
  const compare = (scope, metric, before, after, scale, siteFloor = 0) => {
    if (!before[1] || !after[1]) return;
    // Cross multiplication keeps inclusive 1.0 / 0.5 point boundaries exact.
    const diff = BigInt(after[0]) * BigInt(before[1]) - BigInt(before[0]) * BigInt(after[1]);
    const magnitude = diff < 0n ? -diff : diff;
    if (magnitude * BigInt(scale) < BigInt(before[1]) * BigInt(after[1])) return;
    const [a, b] = diff < 0n ? [before, after] : [after, before];
    const sites = Math.max(a[0] - b[0], (b[1] - b[0]) - (a[1] - a[0]));
    if (sites < siteFloor) return;
    triggers.push({ scope, metric, before, after, sites,
      deltaPoints: 100 * (after[0] / after[1] - before[0] / before[1]),
      verdict: diff < 0n ? 'REGRESSION' : 'IMPROVEMENT' });
  };
  for (const repo of Object.keys({ ...old.repos, ...next.repos }).sort()) {
    const a = old.repos?.[repo]; const b = next.repos?.[repo];
    if (!a?.forward || !a?.missing || !b?.forward || !b?.missing) {
      incomparable.push({ scope: repo, reason: 'repo or oracle mode missing', lost: !!(a?.forward && a?.missing) });
      continue;
    }
    if (a.missing.total !== b.missing.total) {
      incomparable.push({ scope: repo, reason: 'missing-mode total changed', before: a.missing.total, after: b.missing.total });
      continue;
    }
    for (const [metric, score] of [['precision', forward], ['recall', missing]]) {
      const mode = metric === 'precision' ? 'forward' : 'missing';
      const before = score(a[mode]).strict; const after = score(b[mode]).strict;
      compare(repo, metric, before, after, 100, 3);
      // A zero denominator has no rate; omit that metric on both sides of the pool.
      if (before[1] && after[1]) {
        for (let i = 0; i < 2; i++) { pools[metric][0][i] += before[i]; pools[metric][1][i] += after[i]; }
      }
    }
  }
  for (const [metric, [before, after]] of Object.entries(pools)) compare('T2 micro', metric, before, after, 200);

  const badFixtures = ['BROKEN', 'CHANGED', 'GUESSED'];
  for (const name of Object.keys({ ...old.replay, ...next.replay }).sort()) {
    const before = old.replay?.[name]; const after = next.replay?.[name];
    if (before == null || after == null || before === 'ERROR' || after === 'ERROR') {
      incomparable.push({ scope: `fixture ${name}`, reason: 'fixture missing or errored', lost: before != null && before !== 'ERROR' });
    } else if ((before === 'FIXED' && badFixtures.includes(after)) || (after === 'FIXED' && badFixtures.includes(before))) {
      triggers.push({ scope: `fixture ${name}`, metric: 'verdict', before, after,
        verdict: before === 'FIXED' ? 'REGRESSION' : 'IMPROVEMENT' });
    }
  }
  if (old.pycg || next.pycg) {
    const sum = (cs) => Object.values(cs).reduce(([k, n], c) => [k + c.hit, n + c.expected], [0, 0]);
    if (!old.pycg || !next.pycg) incomparable.push({ scope: 'PyCG', reason: 'run missing', lost: !!old.pycg });
    else {
      const before = sum(old.pycg); const after = sum(next.pycg);
      if (before[1] !== after[1]) incomparable.push({ scope: 'PyCG', reason: 'expected total changed', before: before[1], after: after[1] });
      else compare('PyCG micro', 'recall', before, after, 200);
    }
  }
  for (const name of Object.keys({ ...old.canaries, ...next.canaries }).sort()) {
    const before = old.canaries?.[name]?.status; const after = next.canaries?.[name]?.status;
    if (!before || !after) incomparable.push({ scope: `canary ${name}`, reason: 'canary not run on both builds', lost: !!before });
    else if (before === 'PASS' && ['FAIL', 'ERROR'].includes(after)) triggers.push({ scope: `canary ${name}`, metric: 'verdict', before, after, verdict: 'REGRESSION' });
    else if (after === 'PASS' && ['FAIL', 'ERROR'].includes(before)) triggers.push({ scope: `canary ${name}`, metric: 'verdict', before, after, verdict: 'IMPROVEMENT' });
  }
  const verdict = triggers.some((t) => t.verdict === 'REGRESSION') ? 'REGRESSION'
    : triggers.length ? 'IMPROVEMENT' : 'NO MATERIAL CHANGE';
  // Incomplete: something measured on the old build errored or vanished on the new one. The verdict
  // stays about what both builds measured; a caller that must fail closed checks `incomplete`.
  return { verdict, triggers, incomparable, incomplete: incomparable.some((x) => x.lost) };
}
