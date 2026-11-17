#!/usr/bin/env node
// Benchmark tables v1 (SPEC §9): call-site and function-pair tracks, per subject, from the oracle's
// per-repo results on one corpus split. Edge tiers lead (T2 compiler agreement, T1 ground truth); every score sits next
// to its coverage waterfall and resource use.
//
// Usage: node bench/tables.ts [--corpus corpus/v1.txt] [--split dev] [--t1 <dir>] [--noise <noise.json>] [--t3 <dir>]
//                              [--subjects a,b,...] [--md out.md] [--json out.json] [--seed 1] [--canonical]
//   --subjects: which subjects to table (lib/subjects/names.ts). Default: every subject with a work dir
//   for the split; with none, every subject with a T1 or T3 file; with neither, every subject. With
//   --canonical the subjects are codegraph and code-graph-rag, the reproduction's (SPEC §10); any other
//   --subjects is refused.
//   The averages cover the repos every chosen subject ran (SPEC §8), so a subject run on fewer repos
//   narrows them; a default selection that narrows them says so on stderr.
//   --canonical: tools/repro.ts passes it inside the Docker image; only those tables are canonical
//   (SPEC §10). Without it the banner marks a development run.
//   Oracle results are read from the work dirs run.sh leaves: w-pub-<name> (or w-<name>), plus
//   w-…-<subject> for the others. --t1 <dir>: replay-<tag>.json and pycg-<tag>.json (tags in names.ts).
//
// T2 call-site, forward (precision of the subject's located call edges against SCIP):
//   match     ok, ok-overload-set (SPEC §4 equivalences)       + tolerant: ok-other-column, local-module-alias
//   mismatch  wrong-target, external, local-shadow, cross-file-unimported, receiver-fallback;
//             noise:* counts as mismatch in strict and is left out in tolerant
//   unaligned no-scip-ref, outside-scip, scip-local-undefined (SCIP names a local it never defines:
//             the oracle has no answer, e.g. CommonJS require under an inferred tsconfig), scip-name-mismatch
//             (Python: SCIP's symbol names another definition than its token); not scored
// T2 call-site, missing (recall over SCIP-resolved call sites): found; tolerant adds found-other-line.
//   found-heuristic-only (the subject's only edge there is a guess) is reported, never counted.
// T2 function-pair (SPEC §3, out-missing.json `pairs`): matched (caller, callee) pairs over the oracle's
//   pairs (recall) and over the subject pairs the oracle answers for (precision); silent, skipped and
//   decorator-only pairs are shown, not scored.
// Averages: macro (mean of repos; the headline, SPEC §9) and micro (pooled sites), 95% CIs from a
// repo-cluster bootstrap, over the repos every subject ran (SPEC §8). A failed subject run is scored.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.ts';
import { summarizeRobustness, compareAll, robustnessMarkdown } from './robustness.ts';
import { SUBJECT_NAMES, TAG, workSuffix, parseSubjects } from '../lib/subjects/names.ts';
import { recordedAdapterHash } from '../lib/provenance.ts';
import { forward, missing, pairs } from '../lib/scores.ts';
import { CORPUS, readRepos } from '../differential/builds.ts';
import { DIAGNOSTIC_FLOOR, MIN_STRATUM_LABELS, MIN_STRATUM_WEIGHT, noiseGate } from '../labels/score.ts';
import { stratumCounts, type StratumCount } from '../labels/strata.ts';
import { SPEC_VERSION } from '../lib/spec.ts';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const corpus = opt('--corpus', CORPUS); const split = opt('--split', 'dev');
const t3Dir = opt('--t3', null);
const t1Dir = opt('--t1', null); const noiseFile = opt('--noise', null);
const canonical = (() => { const i = args.indexOf('--canonical'); if (i < 0) return false; args.splice(i, 1); return true; })();
const mdOut = opt('--md', null); const jsonOut = opt('--json', null); const seed = Number(opt('--seed', '1'));
const subjectsOpt = opt('--subjects', null);

const workDir = (name, sfx) => [`w-pub-${name}${sfx}`, `w-${name}${sfx}`].map((d) => path.join(config.work, d)).find((d) => fs.existsSync(path.join(d, 'out.json')));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${f}: ${e.message}`); } };

// seeded PRNG for the bootstrap
const rng = (() => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const ratio = ([k, n]) => (n ? k / n : NaN);
const micro = (xs) => ratio(xs.reduce((a, [k, n]) => [a[0] + k, a[1] + n], [0, 0]));
const macro = (xs) => { const r = xs.map(ratio).filter((x) => !Number.isNaN(x)); return r.reduce((a, b) => a + b, 0) / r.length; };
function bootstrap(xs, f, iters = 2000) {
  if (xs.length < 2) return [NaN, NaN];
  const vals = [];
  for (let i = 0; i < iters; i++) vals.push(f(xs.map(() => xs[Math.floor(rng() * xs.length)])));
  // A draw whose repos all have zero denominators has no rate; NaN would break the sort order.
  const ok = vals.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  if (ok.length < iters / 2) return [NaN, NaN];
  return [ok[Math.floor(0.025 * ok.length)], ok[Math.floor(0.975 * ok.length)]];
}
const pct = (x) => (Number.isNaN(x) ? '-' : `${(100 * x).toFixed(1)}%`);
const ci = ([a, b]) => (Number.isNaN(a) ? '' : ` [${(100 * a).toFixed(1)}-${(100 * b).toFixed(1)}]`);

const repos = readRepos(corpus, split);
const hasRun = (s) => repos.some((r) => workDir(r.name, workSuffix(s)));
const hasTier = (s) => [[t1Dir, 'replay'], [t1Dir, 'pycg'], [t3Dir, 'meta']].some(([d, stage]) => d && fs.existsSync(path.join(d, `${stage}-${TAG[s]}.json`)));
const [chosen, chosenBy] = (() => {
  if (subjectsOpt !== null) return [parseSubjects(subjectsOpt ?? ''), '--subjects'];
  if (canonical) return [['codegraph', 'code-graph-rag'], 'the canonical subjects'];
  for (const [has, why] of [[hasRun, 'every subject with a work dir'], [hasTier, 'no work dirs: every subject with a T1 or T3 file']] as const) {
    const found = SUBJECT_NAMES.filter(has); if (found.length) return [found, why];
  }
  return [SUBJECT_NAMES, 'no inputs: every subject'];
})();
// SPEC §10: canonical tables are the reproduction's (tools/repro.ts), which builds and records exactly these two.
if (canonical && [...new Set(chosen)].sort().join() !== 'code-graph-rag,codegraph') {
  console.error(`canonical tables cover codegraph and code-graph-rag (tools/repro.ts); got --subjects ${chosen.join(',')}`); process.exit(2);
}
const SUBJECTS = Object.fromEntries(chosen.map((s) => [s, { sfx: workSuffix(s), tag: TAG[s] }]));
const result: Record<string, any> = { corpus: path.basename(corpus), split, spec: SPEC_VERSION, bootstrap: { seed, resamples: 2000 }, repos: [], subjects: {}, missingRuns: [] };
for (const [subj, { sfx }] of Object.entries<any>(SUBJECTS)) {
  const rows = [];
  for (const r of repos) {
    const w = workDir(r.name, sfx);
    if (!w) { result.missingRuns.push(`${r.name} (${subj})`); continue; }
    const time = fs.existsSync(path.join(w, 'index.time')) ? fs.readFileSync(path.join(w, 'index.time'), 'utf8').trim().split('\n').pop().split(/\s+/).map(Number) : null;
    const fwd = readJson(path.join(w, 'out.json')); const miss = readJson(path.join(w, 'out-missing.json'));
    rows.push({ repo: r.name, language: r.language, spec: [fwd.spec ?? null, miss.spec ?? null],
      // SPEC §3: a subject without site lines has no call-site score (its edges are `skipped: no-site-line`)
      siteLines: fwd.siteLines ?? miss.siteLines ?? null,
      adapters: { forward: recordedAdapterHash(fwd), missing: recordedAdapterHash(miss) }, fwd: forward(fwd), miss: missing(miss), pairs: pairs(miss),
      // SPEC §8: a failed subject run is scored (recall 0 against the oracle's denominator; precision 0/0, left out)
      failed: fwd.subjectFailed ?? miss.subjectFailed ?? null,
      waterfall: miss.waterfall ?? fwd.waterfall ?? null, missSkipped: miss.skipped ?? {},
      indexSeconds: time?.[0] ?? null, peakMB: time ? Math.round(time[1] / 1024) : null });
  }
  const adapterHashes = [...new Set(rows.flatMap((r) => Object.values<any>(r.adapters)))];
  result.subjects[subj] = { rows, adapterHashes, adapterSha256: adapterHashes.length === 1 ? adapterHashes[0] : null };
}
// SPEC §8: subjects are averaged over the same repositories. A repo with no run for some subject (never
// attempted, or an oracle failure) is left out for every subject and listed; canonical tables refuse it.
if (canonical && result.missingRuns.length) { console.error(`canonical tables need every run; missing: ${result.missingRuns.join(', ')}`); process.exit(2); }
const notRun = new Set(result.missingRuns.map((m) => m.replace(/ \(.*\)$/, '')));
// SPEC §12: results scored under another spec version never mix into these tables' averages silently.
result.otherSpec = Object.entries<any>(result.subjects).flatMap(([s, v]) => v.rows.filter((x) => x.spec.some((y) => y !== SPEC_VERSION)).map((x) => `${x.repo} (${s}: ${[...new Set(x.spec)].map((y) => y ?? 'unrecorded').join(', ')})`));
if (canonical && result.otherSpec.length) { console.error(`canonical tables need ${SPEC_VERSION} results; got: ${result.otherSpec.join(', ')}`); process.exit(2); }
const averaged = repos.filter((r) => !notRun.has(r.name));
result.averagedRepos = averaged.map((r) => r.name);
// SPEC §9: a language whose oracle is too noisy to score against is diagnostic. Its repos are shown
// per repo but left out of the T2 averages. The labelled sample's strata are weighted by their share of
// this run's sites where SCIP answers (labels/score.ts noiseGate). The strata are counted as the sample
// drew them, over codegraph's and code-graph-rag's per-site results whatever --subjects picks. Where one
// of them failed on a repo, that repo's strata come from the other alone (a failed run's misses would
// all be scip-only); one subject's strata only approximate the sampled ones (sites shift between
// strata, mostly toward agree). A repo where both failed adds no sites. A language with no counted
// repo is not gated only when every tabled subject failed on all its repos: their recall there is 0
// and their precision undefined whatever the oracle says, and SPEC §8 keeps them in the averages.
// Otherwise it is diagnostic, since a subject that ran would be scored against an ungated oracle.
// Without --noise nothing is excluded.
const NOISE_SUBJECTS = ['codegraph', 'code-graph-rag'];
const population: Record<string, Record<string, StratumCount>> = {};
result.noisePopulationRepos = []; result.noiseOneSubject = []; result.noiseUncounted = [];
if (noiseFile) {
  for (const r of averaged) {
    const outputs = []; const failedSubj = [];
    for (const s of NOISE_SUBJECTS) {
      const w = workDir(r.name, workSuffix(s));
      // A run that never happened is a configuration gap, not a result (canonical tables refuse it earlier).
      if (!w) { console.error(`the noise gate counts strata over ${NOISE_SUBJECTS.join(' and ')} (the sample's subjects); ${r.name} has no ${s} run`); process.exit(2); }
      const o = { w, fwd: readJson(path.join(w, 'out.json')), miss: readJson(path.join(w, 'out-missing.json')) };
      if (o.fwd.subjectFailed || o.miss.subjectFailed) failedSubj.push(s); else outputs.push(o);
    }
    if (!outputs.length) { result.noiseUncounted.push(`${r.name} (both subjects failed)`); continue; }
    // Missing per-site records are a run configuration error (redacted, or not ORACLE_ALLSITES), never a result.
    const bare = outputs.find((o) => !Array.isArray(o.fwd.sites) || !Array.isArray(o.miss.sites));
    if (bare) { console.error(`the noise gate needs per-site records in out.json and out-missing.json (oracle run with ORACLE_ALLSITES=1, not redacted): ${bare.w} lacks them`); process.exit(2); }
    result.noisePopulationRepos.push(r.name);
    if (failedSubj.length) result.noiseOneSubject.push(`${r.name} (${failedSubj.join(', ')} failed)`);
    const pop = (population[r.language] ??= {});
    for (const [k, c] of Object.entries(stratumCounts(outputs))) { pop[k] ??= { sites: 0, scipSites: 0 }; pop[k].sites += c.sites; pop[k].scipSites += c.scipSites; }
  }
}
const noiseTable = noiseFile ? readJson(noiseFile).table : null;
// Why a gate is diagnostic, in the tables' words (md note and JSON `reason`, set on diagnostic gates only).
const gateReason = (g) => (!g.labelled ? 'no labelled sample' : g.unmeasured.length
  ? `unmeasured: ${g.unmeasured.map((s) => `${s} carries ${pct(g.strata[s].weight)} of the weight with ${g.strata[s].answered} labelled answers`).join('; ')}`
  : g.estimate == null ? 'no run sites where SCIP answers'
    : `SCIP right where it answers, stratum-weighted ${pct(g.estimate)}, 95% lower bound ${pct(g.lower)}`);
// A tabled language with no counted repo: not gated only if every tabled subject failed on all its repos.
const allFailed = (lang) => Object.values<any>(result.subjects).every((v) => v.rows.filter((x) => x.language === lang && !notRun.has(x.repo)).every((x) => x.failed));
const uncountedLangs = noiseFile ? [...new Set(averaged.map((r) => r.language))].filter((l) => !population[l]) : [];
result.noiseNotGated = uncountedLangs.filter(allFailed).map((language) => ({ language, reason: 'every tabled subject failed on every repo' }));
const gates = noiseTable ? Object.fromEntries([...Object.keys(population), ...uncountedLangs.filter((l) => !allFailed(l))].map((l) => {
  const g = noiseGate(noiseTable[l], population[l] ?? {});
  const reason = !population[l] ? 'codegraph and code-graph-rag failed on every repo, and another tabled subject ran' : gateReason(g);
  return [l, { ...g, ...(g.diagnostic ? { reason } : {}) }];
})) : {};
const diagnostic = new Map(Object.entries(gates).filter(([, g]) => g.diagnostic));
if (subjectsOpt === null && notRun.size) {
  const short = Object.keys(SUBJECTS).filter((s) => repos.some((r) => !workDir(r.name, workSuffix(s))));
  console.error(`tables: ${short.join(', ')} ran on fewer repos; every subject's averages cover only ${result.averagedRepos.join(', ') || 'none'} (SPEC §8). Pass --subjects to choose.`);
}
for (const v of Object.values<any>(result.subjects)) {
  const agg: Record<string, any> = {};
  for (const [name, pick] of ([['precision strict', (x) => x.fwd.strict], ['precision tolerant', (x) => x.fwd.tolerant], ['recall strict', (x) => x.miss.strict], ['recall tolerant', (x) => x.miss.tolerant],
    ['pair precision', (x) => x.pairs?.precision], ['pair recall', (x) => x.pairs?.recall]] as [string, (x: any) => any][])) {
    const callSite = !name.startsWith('pair');
    const rows = v.rows.filter((x) => !diagnostic.has(x.language) && !notRun.has(x.repo) && !(callSite && x.siteLines === false));
    const xs = rows.map(pick).filter(Boolean);
    // SPEC §9: a repo whose denominator is zero for a metric is left out of its averages and listed.
    const zero = rows.filter((x) => { const p = pick(x); return p && !p[1]; }).map((x) => x.repo);
    agg[name] = { micro: micro(xs), microCI: bootstrap(xs, micro), macro: macro(xs), macroCI: bootstrap(xs, macro), zeroDenominator: zero };
  }
  v.agg = agg;
  v.failed = v.rows.filter((x) => x.failed).map((x) => `${x.repo} (${x.failed})`);
  // Results from before the function-pair track (SPEC §3) carry no pairs; the track's averages leave them out.
  v.noPairs = v.rows.filter((x) => !x.pairs).map((x) => x.repo);
  v.noSiteLines = v.rows.filter((x) => x.siteLines === false).map((x) => x.repo);
}
result.repos = repos.map((r) => r.name);
result.diagnostic = Object.fromEntries(diagnostic);
result.noiseGate = noiseTable ? gates : null;

const md = [`# Benchmark tables v1 — corpus ${result.corpus}, split \`${split}\``, '',
  'Edge tiers lead (decision 2026-11-05); T0 question accuracy is experimental and not shown here. Both T2 tracks (SPEC §3), side by side, never combined.',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`bench/tables.ts\`. ${canonical ? 'Canonical: reproduced in the Docker image by `tools/repro.ts` (`manifest.json` records every input; SPEC §10).' : 'Development run: canonical tables come only from `tools/repro.ts` in the Docker image (SPEC §10); this machine\'s Python environment can resolve the standard library differently.'}`, ''];
md.push(`Subjects: ${Object.keys(SUBJECTS).join(', ')} (${chosenBy}).`, '');
md.push('Adapter hashes (from recorded inputs): ' + Object.entries<any>(result.subjects).map(([s, v]) => `${s}: ${v.adapterHashes.length ? v.adapterHashes.map((h) => h ?? 'unknown (legacy)').join(', ') : 'no inputs'}`).join('; '), '');
if (result.missingRuns.length) md.push(`**Not run (left out of every subject's averages):** ${result.missingRuns.join(', ')}`, '');
for (const [s, v] of Object.entries<any>(result.subjects)) if (v.failed.length) md.push(`**${s} failed (scored as misses, SPEC §8):** ${v.failed.join(', ')}`, '');
md.push('## T2 compiler agreement (call-site track)', '', '| subject | precision strict (macro) | precision strict (micro) | precision tolerant (macro) | recall strict (macro) | recall strict (micro) | recall tolerant (macro) |', '|---|---|---|---|---|---|---|');
for (const [s, { agg }] of Object.entries<any>(result.subjects)) {
  const g = (k, m) => `${pct(agg[k][m])}${ci(agg[k][`${m}CI`])}`;
  md.push(`| ${s} | ${g('precision strict', 'macro')} | ${g('precision strict', 'micro')} | ${g('precision tolerant', 'macro')} | ${g('recall strict', 'macro')} | ${g('recall strict', 'micro')} | ${g('recall tolerant', 'macro')} |`);
}
const diagNote = [...diagnostic].map(([l, d]) => `${l} (${d.reason})`).join(', ');
const zeroNotes = Object.entries<any>(result.subjects).flatMap(([s, v]) => Object.entries<any>(v.agg).filter(([, a]) => a.zeroDenominator.length).map(([k, a]) => `${s} ${k}: ${a.zeroDenominator.join(', ')}`));
md.push('', `Headline: macro, the mean of per-repo rates, so each repo weighs the same (SPEC §9); micro pools sites. CIs: 95%, repo-cluster bootstrap (2000 resamples, seed ${seed}).`,
  ...(zeroNotes.length ? ['', `Left out for a zero denominator (SPEC §9): ${zeroNotes.join('; ')}.`] : []),
  ...Object.entries<any>(result.subjects).filter(([, v]) => v.noSiteLines.length).map(([s, v]) => `\n${s} records no site lines: no call-site score for ${v.noSiteLines.join(', ')} (SPEC §3).`),
  ...(result.otherSpec.length ? ['', `**Inputs scored under another spec version (development only):** ${result.otherSpec.join(', ')}.`] : []),
  ...(result.subjects['code-graph-rag'] ? ['', 'code-graph-rag is not deterministic: its guessed edges vary between runs of one build (0.7.1: ky 71,498–71,506 edges over three runs, requests identical; 0.5.0: ky 72,042–72,050, requests 0–2 guessed edges), which can move a site in or out of guess-only; on 0.5.0 scores moved by about 0.1 point (SPEC §10).'] : []),
  ...(result.noiseNotGated.length ? ['', `Not gated by the oracle-noise rule (SPEC §9), kept in the averages: ${result.noiseNotGated.map((x) => `${x.language} (${x.reason}: recall 0, precision undefined)`).join(', ')}.`] : []),
  ...(diagnostic.size ? ['', `Diagnostic, left out of the averages (SPEC §9: stratum-weighted oracle-noise lower bound under ${pct(DIAGNOSTIC_FLOOR)}, or a stratum with at least ${pct(MIN_STRATUM_WEIGHT)} of the weight and under ${MIN_STRATUM_LABELS} labelled answers): ${diagNote}.`] : noiseFile ? [] : ['', 'No oracle-noise file given: no language is checked for diagnostic status.']),
  '', '## T2 compiler agreement (function-pair track)', '', '| subject | precision (macro) | precision (micro) | recall (macro) | recall (micro) |', '|---|---|---|---|---|',
  ...Object.entries<any>(result.subjects).map(([s, { agg }]) => { const g = (k, m) => `${pct(agg[k][m])}${ci(agg[k][`${m}CI`])}`; return `| ${s} | ${g('pair precision', 'macro')} | ${g('pair precision', 'micro')} | ${g('pair recall', 'macro')} | ${g('pair recall', 'micro')} |`; }),
  '', 'A unit is a (caller, callee) pair, counted once however many calls carry it (SPEC §3, §6). The caller is the innermost oracle definition around the call, else the file. Precision counts a subject pair the oracle lacks only where the oracle answers for it: an oracle reference named like the callee lies inside the caller. Pairs where it is silent are unaligned, as on the call-site track. Edges left out form no pair: an endpoint the oracle never indexed (unmapped), or an edge recorded at its target\'s own declaration (skipped, `skip-framework-self-site`, or a Go composite literal, `skip-composite-literal`; SPEC §3, §7).',
  ...Object.entries<any>(result.subjects).filter(([, v]) => v.noPairs.length).map(([s, v]) => `\n${s}: no function-pair results (recorded before the track): ${v.noPairs.join(', ')}.`),
  '', '| subject | repo | oracle pairs | subject pairs | matched | oracle disagrees | oracle silent (unaligned) | skipped | precision | recall | guess-only | decorator pairs found | edges left out: unmapped / skipped | caller ranges (enclosing / braces) | oracle sites at file level |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...Object.entries<any>(result.subjects).flatMap(([s, { rows }]) => rows.filter((x) => x.pairs).map((x) => { const p = x.pairs; return `| ${s} | ${x.repo}${x.failed ? ' (FAILED: scored as misses)' : ''} | ${p.oracle} | ${p.subject} | ${p.precision[0]} | ${p.disagrees} | ${p.silent} | ${p.skipped} | ${pct(ratio(p.precision))} | ${pct(ratio(p.recall))} | ${p.guessOnly} | ${p.decorators[1] ? `${p.decorators[0]}/${p.decorators[1]}` : '-'} | ${p.unmapped} / ${p.skippedEdges ?? 'unknown (legacy)'} | ${p.callerRanges.enclosing} / ${p.callerRanges.braces} | ${p.atFile} |`; })),
  '', '## Per repo, with the coverage waterfall', '',
  '| subject | repo | lang | call edges | skipped (guessed / other) | unaligned | scored | precision strict | missing: SCIP sites | recall strict | guess-only | @decl found | decorators found | index s | peak MB |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [s, { rows }] of Object.entries<any>(result.subjects)) {
  for (const x of rows) {
    const f = x.fwd; const guessed = Object.entries<any>(f.skippedBy).filter(([k]) => k.startsWith('guessed')).reduce((a, [, v]) => a + v, 0);
    const scored = f.strict[1];
    md.push(`| ${s} | ${x.repo}${x.failed ? ' (FAILED: scored as misses)' : ''} | ${x.language}${diagnostic.has(x.language) ? ' (diagnostic)' : ''} | ${scored + f.unaligned + f.skipped} | ${guessed} / ${f.skipped - guessed} | ${f.unaligned} | ${scored} | ${pct(ratio(f.strict))} | ${x.miss.total} | ${pct(ratio(x.miss.strict))} | ${x.miss.guessOnly} | ${x.miss.decl[1] ? `${x.miss.decl[0]}/${x.miss.decl[1]}` : '-'} | ${x.miss.decorators ? `${x.miss.decorators[0]}/${x.miss.decorators[1]}` : 'unknown (legacy)'} | ${x.indexSeconds ?? '-'} | ${x.peakMB ?? '-'} |`);
  }
}
// SPEC §7 file steps (files in corpus after exclusions -> supported language -> indexed by the subject
// -> indexed by the oracle), then the missing direction's units: SCIP call sites skipped by rule and scored.
md.push('', '## Coverage waterfall (files, then SCIP call sites)', '',
  '| subject | repo | files in corpus | excluded paths | supported language | indexed by subject | indexed by oracle | call sites skipped (by rule) | call sites scored |', '|---|---|---|---|---|---|---|---|---|');
for (const [s, { rows }] of Object.entries<any>(result.subjects)) {
  for (const x of rows) {
    const w = x.waterfall; const sk = Object.entries<any>(x.missSkipped).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    md.push(w ? `| ${s} | ${x.repo} | ${w.filesInCorpus} | ${w.excluded} | ${w.supportedLanguage} | ${w.indexedBySubject} | ${w.indexedByOracle} | ${sk} | ${x.miss.total} |`
      : `| ${s} | ${x.repo} | unknown (legacy) | - | - | - | - | ${sk} | ${x.miss.total} |`);
  }
}
if (t1Dir) {
  md.push('', '## T1 ground truth', '', '| subject | fixture replay (codegraph-derived regression set) | PyCG micro recall | PyCG extra edges | PyCG guess-only |', '|---|---|---|---|---|');
  for (const [s, { tag }] of Object.entries<any>(SUBJECTS)) {
    const rp = path.join(t1Dir, `replay-${tag}.json`); const pp = path.join(t1Dir, `pycg-${tag}.json`);
    const replayInput = fs.existsSync(rp) ? readJson(rp) : null;
    const pycgInput = fs.existsSync(pp) ? readJson(pp) : null;
    result.subjects[s].t1Adapters = { replay: recordedAdapterHash(replayInput), pycg: recordedAdapterHash(pycgInput) };
    const replay = replayInput ? Object.entries<any>(replayInput.results.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ') : '-';
    let pycg = ['-', '-', '-'];
    if (pycgInput) { const c = Object.values<any>(pycgInput.categories); const e = c.reduce((a, x) => a + x.expected, 0); const h = c.reduce((a, x) => a + x.hit, 0); pycg = [`${h}/${e} ${pct(h / e)}`, String(c.reduce((a, x) => a + x.extra, 0)), c.every((x) => x.guessOnly != null) ? String(c.reduce((a, x) => a + x.guessOnly, 0)) : 'unknown (legacy)']; }
    md.push(`| ${s} | ${replay} | ${pycg[0]} | ${pycg[1]} | ${pycg[2]} |`);
  }
  md.push('', 'T1 adapter hashes: ' + Object.entries<any>(result.subjects).map(([s, v]) => `${s}: replay ${v.t1Adapters.replay ?? 'unknown'}, PyCG ${v.t1Adapters.pycg ?? 'unknown'}`).join('; '));
  md.push('', 'The fixture replay is a selected defect corpus drawn from codegraph bugs: it is not exhaustive truth and favours other subjects.');
}
if (noiseFile) {
  const n = readJson(noiseFile);
  // SPEC §9: the labelling protocol is pinned and named by its hash in every table that uses the sample.
  result.noiseProtocol = n.protocol?.sha256 ?? null;
  if (canonical && !n.protocol) { console.error('canonical tables need a noise file made with --protocol (labels/protocol.json)'); process.exit(2); }
  md.push('', '## Oracle noise (blind labelled sample, truth = 2 of 3 with a tie-breaker)', '',
    n.protocol ? `Labelling protocol \`${n.protocol.sha256.slice(0, 16)}\` (sha256 of \`labels/protocol.json\`, which pins every labelling file, the prompt template \`${n.protocol.promptTemplateSha256.slice(0, 16)}\` and the models).` : 'Labelling protocol: not pinned (noise file made without --protocol; development only).', '',
    ...(n.protocol ? ['| labeller | model | role | qualification (known-answer items) |', '|---|---|---|---|',
      ...Object.entries<any>(n.protocol.labellers).map(([k, v]) => `| ${k} | ${v.model} (${v.effort}) | ${v.role} | ${v.qualification ? `${v.qualification.correct}/${v.qualification.answered} ${pct(v.qualification.correct / v.qualification.answered)}${ci(v.qualification.ci)}` : '-'} |`), ''] : []),
    `Labellers: ${n.labellers.join(', ')}.${n.labellers[2] && n.sided ? ` Where ${n.labellers[0]} and ${n.labellers[1]} disagree, ${n.labellers[2]} sided with: ${Object.entries<any>(n.sided).map(([k, v]) => `${k} ${v}`).join(', ') || 'none asked'}.` : ''}`, '', '| language | sites | consensus | no consensus (not imputed) | SCIP right when it answers, pooled (sample design) |', '|---|---|---|---|---|');
  for (const [lang, t] of Object.entries<any>(n.table)) { const a = t.ALL; md.push(`| ${lang} | ${a.items} | ${a.consensus} | ${a.items - a.consensus} ${pct((a.items - a.consensus) / a.items)} | ${a.scip[1] ? `${a.scip[0]}/${a.scip[1]} ${pct(a.scip[0] / a.scip[1])}` : '-'} |`); }
  // SPEC §9: the gate weights each stratum by its share of this run's sites where SCIP answers.
  md.push('', `Noise gate, strata weighted by this run's sites where SCIP answers (SPEC §9): each stratum's weight and its SCIP-right labelled answers. Counted over ${result.noisePopulationRepos.join(', ') || 'no repo'}${result.noiseOneSubject.length ? `; from one subject where the other failed: ${result.noiseOneSubject.join(', ')}` : ''}${result.noiseUncounted.length ? `; not counted in the strata: ${result.noiseUncounted.join(', ')}` : ''}.`, '',
    '| language | agree | disagree | scip-only | weighted SCIP right | 95% lower bound | diagnostic |', '|---|---|---|---|---|---|---|');
  for (const [lang, g] of Object.entries<any>(result.noiseGate)) {
    const cell = (st) => { const x = g.strata[st]; return x ? `${pct(x.weight)}: ${x.answered ? `${x.right}/${x.answered}` : 'no labels'}` : '-'; };
    md.push(`| ${lang} | ${cell('agree')} | ${cell('disagree')} | ${cell('scip-only')} | ${g.estimate == null ? '-' : pct(g.estimate)} | ${g.estimate == null ? '-' : pct(g.lower)} | ${g.diagnostic ? `yes${g.unmeasured.length ? ` (unmeasured: ${g.unmeasured.join(', ')})` : ''}` : 'no'} |`);
  }
  md.push('', 'SCIP accuracy is measured only on sites with a consensus; the sites without one are likely the harder ones, so it may read high.');
}
const robustness: Record<string, any> = {};
result.missingT3Runs = [];
for (const [name, { tag }] of Object.entries<any>(SUBJECTS)) {
  const file = t3Dir && path.join(t3Dir, `meta-${tag}.json`);
  robustness[name] = summarizeRobustness(file && fs.existsSync(file) ? readJson(file) : null, name);
  result.subjects[name].robustness = robustness[name];
  if (robustness[name].status === 'NOT RUN') result.missingT3Runs.push(name);
}
result.t3Comparison = compareAll(Object.values(robustness));
if (canonical && (Object.values<any>(robustness).some((s) => !s.complete || Object.values<any>(s.relations).some((r) => r.errors || r.unverified))
  || result.t3Comparison.mismatched.length || result.t3Comparison.unknown.length || result.t3Comparison.unpaired.length)) throw new Error('incomplete or mismatched canonical T3 evidence');
md.push('', ...robustnessMarkdown(robustness, result.t3Comparison), '');
const text = `${md.join('\n')}\n`;
if (mdOut) fs.writeFileSync(mdOut, text); else process.stdout.write(text);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
