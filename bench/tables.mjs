#!/usr/bin/env node
// Benchmark tables v1 (SPEC §9): call-site and function-pair tracks, per subject, from the oracle's
// per-repo results on one corpus split. Edge tiers lead (T2 compiler agreement, T1 ground truth); every score sits next
// to its coverage waterfall and resource use.
//
// Usage: node bench/tables.mjs [--corpus corpus/v1.txt] [--split dev] [--t1 <dir>] [--noise <noise.json>] [--t3 <dir>]
//                              [--md out.md] [--json out.json] [--seed 1] [--canonical]
//   --canonical: tools/repro.mjs passes it inside the Docker image; only those tables are canonical
//   (SPEC §10). Without it the banner marks a development run.
//   Oracle results are read from the work dirs run.sh leaves: w-pub-<name> (or w-<name>), plus
//   w-…-code-graph-rag. --t1 <dir>: replay-<tag>.json and pycg-<tag>.json (tag cg / cgr).
//
// T2 call-site, forward (precision of the subject's located call edges against SCIP):
//   match     ok, ok-overload-set (SPEC §4 equivalences)       + tolerant: ok-other-column, local-module-alias
//   mismatch  wrong-target, external, local-shadow, cross-file-unimported, receiver-fallback;
//             noise:* counts as mismatch in strict and is left out in tolerant
//   unaligned no-scip-ref, outside-scip, scip-local-undefined (SCIP names a local it never defines:
//             the oracle has no answer, e.g. CommonJS require under an inferred tsconfig); not scored
// T2 call-site, missing (recall over SCIP-resolved call sites): found; tolerant adds found-other-line.
//   found-heuristic-only (the subject's only edge there is a guess) is reported, never counted.
// T2 function-pair (SPEC §3, out-missing.json `pairs`): matched (caller, callee) pairs over the oracle's
//   pairs (recall) and over the subject pairs the oracle answers for (precision); silent, skipped and
//   decorator-only pairs are shown, not scored.
// Averages: macro (mean of repos; the headline, SPEC §9) and micro (pooled sites), 95% CIs from a
// repo-cluster bootstrap, over the repos every subject ran (SPEC §8). A failed subject run is scored.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.mjs';
import { summarizeRobustness, compareChallenges, robustnessMarkdown } from './robustness.mjs';
import { recordedAdapterHash } from '../lib/provenance.mjs';
import { forward, missing, pairs } from '../lib/scores.mjs';
import { CORPUS, readRepos } from '../differential/builds.mjs';
import { DIAGNOSTIC_FLOOR, diagnosticLanguages } from '../labels/score.mjs';
import { SPEC_VERSION } from '../lib/spec.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const corpus = opt('--corpus', CORPUS); const split = opt('--split', 'dev');
const t3Dir = opt('--t3', null);
const t1Dir = opt('--t1', null); const noiseFile = opt('--noise', null);
const canonical = (() => { const i = args.indexOf('--canonical'); if (i < 0) return false; args.splice(i, 1); return true; })();
const mdOut = opt('--md', null); const jsonOut = opt('--json', null); const seed = Number(opt('--seed', '1'));
const SUBJECTS = { codegraph: { sfx: '', tag: 'cg' }, 'code-graph-rag': { sfx: '-code-graph-rag', tag: 'cgr' } };

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
// SPEC §9: a language whose oracle is too noisy to score against is diagnostic. Its repos are shown
// per repo but left out of the T2 averages. Rule: the 95% Wilson lower bound of "SCIP right where it
// answers" in the labelled sample is under DIAGNOSTIC_FLOOR. Without --noise nothing is excluded.
const diagnostic = noiseFile ? diagnosticLanguages(readJson(noiseFile).table) : new Map();
const result = { corpus: path.basename(corpus), split, spec: SPEC_VERSION, bootstrap: { seed, resamples: 2000 }, repos: [], subjects: {}, missingRuns: [] };
for (const [subj, { sfx }] of Object.entries(SUBJECTS)) {
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
  const adapterHashes = [...new Set(rows.flatMap((r) => Object.values(r.adapters)))];
  result.subjects[subj] = { rows, adapterHashes, adapterSha256: adapterHashes.length === 1 ? adapterHashes[0] : null };
}
// SPEC §8: subjects are averaged over the same repositories. A repo with no run for some subject (never
// attempted, or an oracle failure) is left out for every subject and listed; canonical tables refuse it.
if (canonical && result.missingRuns.length) { console.error(`canonical tables need every run; missing: ${result.missingRuns.join(', ')}`); process.exit(2); }
const notRun = new Set(result.missingRuns.map((m) => m.replace(/ \(.*\)$/, '')));
// SPEC §12: results scored under another spec version never mix into these tables' averages silently.
result.otherSpec = Object.entries(result.subjects).flatMap(([s, v]) => v.rows.filter((x) => x.spec.some((y) => y !== SPEC_VERSION)).map((x) => `${x.repo} (${s}: ${[...new Set(x.spec)].map((y) => y ?? 'unrecorded').join(', ')})`));
if (canonical && result.otherSpec.length) { console.error(`canonical tables need ${SPEC_VERSION} results; got: ${result.otherSpec.join(', ')}`); process.exit(2); }
result.averagedRepos = repos.map((r) => r.name).filter((n) => !notRun.has(n));
for (const v of Object.values(result.subjects)) {
  const agg = {};
  for (const [name, pick] of [['precision strict', (x) => x.fwd.strict], ['precision tolerant', (x) => x.fwd.tolerant], ['recall strict', (x) => x.miss.strict], ['recall tolerant', (x) => x.miss.tolerant],
    ['pair precision', (x) => x.pairs?.precision], ['pair recall', (x) => x.pairs?.recall]]) {
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

const md = [`# Benchmark tables v1 — corpus ${result.corpus}, split \`${split}\``, '',
  'Edge tiers lead (decision 2026-11-05); T0 question accuracy is experimental and not shown here. Both T2 tracks (SPEC §3), side by side, never combined.',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`bench/tables.mjs\`. ${canonical ? 'Canonical: reproduced in the Docker image by `tools/repro.mjs` (`manifest.json` records every input; SPEC §10).' : 'Development run: canonical tables come only from `tools/repro.mjs` in the Docker image (SPEC §10); this machine\'s Python environment can resolve the standard library differently.'}`, ''];
md.push('Adapter hashes (from recorded inputs): ' + Object.entries(result.subjects).map(([s, v]) => `${s}: ${v.adapterHashes.length ? v.adapterHashes.map((h) => h ?? 'unknown (legacy)').join(', ') : 'no inputs'}`).join('; '), '');
if (result.missingRuns.length) md.push(`**Not run (left out of every subject's averages):** ${result.missingRuns.join(', ')}`, '');
for (const [s, v] of Object.entries(result.subjects)) if (v.failed.length) md.push(`**${s} failed (scored as misses, SPEC §8):** ${v.failed.join(', ')}`, '');
md.push('## T2 compiler agreement (call-site track)', '', '| subject | precision strict (macro) | precision strict (micro) | precision tolerant (macro) | recall strict (macro) | recall strict (micro) | recall tolerant (macro) |', '|---|---|---|---|---|---|---|');
for (const [s, { agg }] of Object.entries(result.subjects)) {
  const g = (k, m) => `${pct(agg[k][m])}${ci(agg[k][`${m}CI`])}`;
  md.push(`| ${s} | ${g('precision strict', 'macro')} | ${g('precision strict', 'micro')} | ${g('precision tolerant', 'macro')} | ${g('recall strict', 'macro')} | ${g('recall strict', 'micro')} | ${g('recall tolerant', 'macro')} |`);
}
const diagNote = [...diagnostic].map(([l, d]) => `${l} (SCIP right ${d.right}/${d.answered} where it answers, 95% lower bound ${pct(d.lower)})`).join(', ');
const zeroNotes = Object.entries(result.subjects).flatMap(([s, v]) => Object.entries(v.agg).filter(([, a]) => a.zeroDenominator.length).map(([k, a]) => `${s} ${k}: ${a.zeroDenominator.join(', ')}`));
md.push('', `Headline: macro, the mean of per-repo rates, so each repo weighs the same (SPEC §9); micro pools sites. CIs: 95%, repo-cluster bootstrap (2000 resamples, seed ${seed}).`,
  ...(zeroNotes.length ? ['', `Left out for a zero denominator (SPEC §9): ${zeroNotes.join('; ')}.`] : []),
  ...Object.entries(result.subjects).filter(([, v]) => v.noSiteLines.length).map(([s, v]) => `\n${s} records no site lines: no call-site score for ${v.noSiteLines.join(', ')} (SPEC §3).`),
  ...(result.otherSpec.length ? ['', `**Inputs scored under another spec version (development only):** ${result.otherSpec.join(', ')}.`] : []),
  ...(result.subjects['code-graph-rag'] ? ['', 'code-graph-rag 0.5.0 is not deterministic: its guessed edges vary between runs of one build (ky 72,042–72,050 edges over three runs, requests 0–2 guessed edges), which can move a site in or out of guess-only; scores move by about 0.1 point (SPEC §10).'] : []),
  ...(diagnostic.size ? ['', `Diagnostic, left out of the averages (SPEC §9: oracle noise lower bound under ${pct(DIAGNOSTIC_FLOOR)}): ${diagNote}.`] : noiseFile ? [] : ['', 'No oracle-noise file given: no language is checked for diagnostic status.']),
  '', '## T2 compiler agreement (function-pair track)', '', '| subject | precision (macro) | precision (micro) | recall (macro) | recall (micro) |', '|---|---|---|---|---|',
  ...Object.entries(result.subjects).map(([s, { agg }]) => { const g = (k, m) => `${pct(agg[k][m])}${ci(agg[k][`${m}CI`])}`; return `| ${s} | ${g('pair precision', 'macro')} | ${g('pair precision', 'micro')} | ${g('pair recall', 'macro')} | ${g('pair recall', 'micro')} |`; }),
  '', 'A unit is a (caller, callee) pair, counted once however many calls carry it (SPEC §3, §6). The caller is the innermost oracle definition around the call, else the file. Precision counts a subject pair the oracle lacks only where the oracle answers for it: an oracle reference named like the callee lies inside the caller. Pairs where it is silent are unaligned, as on the call-site track. Edges left out form no pair: an endpoint the oracle never indexed (unmapped), or an edge recorded at its target\'s own declaration (skipped, `skip-framework-self-site`; SPEC §3, §7).',
  ...Object.entries(result.subjects).filter(([, v]) => v.noPairs.length).map(([s, v]) => `\n${s}: no function-pair results (recorded before the track): ${v.noPairs.join(', ')}.`),
  '', '| subject | repo | oracle pairs | subject pairs | matched | oracle disagrees | oracle silent (unaligned) | skipped | precision | recall | guess-only | decorator pairs found | edges left out: unmapped / skipped | caller ranges (enclosing / braces) | oracle sites at file level |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...Object.entries(result.subjects).flatMap(([s, { rows }]) => rows.filter((x) => x.pairs).map((x) => { const p = x.pairs; return `| ${s} | ${x.repo}${x.failed ? ' (FAILED: scored as misses)' : ''} | ${p.oracle} | ${p.subject} | ${p.precision[0]} | ${p.disagrees} | ${p.silent} | ${p.skipped} | ${pct(ratio(p.precision))} | ${pct(ratio(p.recall))} | ${p.guessOnly} | ${p.decorators[1] ? `${p.decorators[0]}/${p.decorators[1]}` : '-'} | ${p.unmapped} / ${p.skippedEdges ?? 'unknown (legacy)'} | ${p.callerRanges.enclosing} / ${p.callerRanges.braces} | ${p.atFile} |`; })),
  '', '## Per repo, with the coverage waterfall', '',
  '| subject | repo | lang | call edges | skipped (guessed / other) | unaligned | scored | precision strict | missing: SCIP sites | recall strict | guess-only | @decl found | decorators found | index s | peak MB |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [s, { rows }] of Object.entries(result.subjects)) {
  for (const x of rows) {
    const f = x.fwd; const guessed = Object.entries(f.skippedBy).filter(([k]) => k.startsWith('guessed')).reduce((a, [, v]) => a + v, 0);
    const scored = f.strict[1];
    md.push(`| ${s} | ${x.repo}${x.failed ? ' (FAILED: scored as misses)' : ''} | ${x.language}${diagnostic.has(x.language) ? ' (diagnostic)' : ''} | ${scored + f.unaligned + f.skipped} | ${guessed} / ${f.skipped - guessed} | ${f.unaligned} | ${scored} | ${pct(ratio(f.strict))} | ${x.miss.total} | ${pct(ratio(x.miss.strict))} | ${x.miss.guessOnly} | ${x.miss.decl[1] ? `${x.miss.decl[0]}/${x.miss.decl[1]}` : '-'} | ${x.miss.decorators ? `${x.miss.decorators[0]}/${x.miss.decorators[1]}` : 'unknown (legacy)'} | ${x.indexSeconds ?? '-'} | ${x.peakMB ?? '-'} |`);
  }
}
// SPEC §7 file steps (files in corpus after exclusions -> supported language -> indexed by the subject
// -> indexed by the oracle), then the missing direction's units: SCIP call sites skipped by rule and scored.
md.push('', '## Coverage waterfall (files, then SCIP call sites)', '',
  '| subject | repo | files in corpus | excluded paths | supported language | indexed by subject | indexed by oracle | call sites skipped (by rule) | call sites scored |', '|---|---|---|---|---|---|---|---|---|');
for (const [s, { rows }] of Object.entries(result.subjects)) {
  for (const x of rows) {
    const w = x.waterfall; const sk = Object.entries(x.missSkipped).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    md.push(w ? `| ${s} | ${x.repo} | ${w.filesInCorpus} | ${w.excluded} | ${w.supportedLanguage} | ${w.indexedBySubject} | ${w.indexedByOracle} | ${sk} | ${x.miss.total} |`
      : `| ${s} | ${x.repo} | unknown (legacy) | - | - | - | - | ${sk} | ${x.miss.total} |`);
  }
}
if (t1Dir) {
  md.push('', '## T1 ground truth', '', '| subject | fixture replay (codegraph-derived regression set) | PyCG micro recall | PyCG extra edges | PyCG guess-only |', '|---|---|---|---|---|');
  for (const [s, { tag }] of Object.entries(SUBJECTS)) {
    const rp = path.join(t1Dir, `replay-${tag}.json`); const pp = path.join(t1Dir, `pycg-${tag}.json`);
    const replayInput = fs.existsSync(rp) ? readJson(rp) : null;
    const pycgInput = fs.existsSync(pp) ? readJson(pp) : null;
    result.subjects[s].t1Adapters = { replay: recordedAdapterHash(replayInput), pycg: recordedAdapterHash(pycgInput) };
    const replay = replayInput ? Object.entries(replayInput.results.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ') : '-';
    let pycg = ['-', '-', '-'];
    if (pycgInput) { const c = Object.values(pycgInput.categories); const e = c.reduce((a, x) => a + x.expected, 0); const h = c.reduce((a, x) => a + x.hit, 0); pycg = [`${h}/${e} ${pct(h / e)}`, String(c.reduce((a, x) => a + x.extra, 0)), c.every((x) => x.guessOnly != null) ? String(c.reduce((a, x) => a + x.guessOnly, 0)) : 'unknown (legacy)']; }
    md.push(`| ${s} | ${replay} | ${pycg[0]} | ${pycg[1]} | ${pycg[2]} |`);
  }
  md.push('', 'T1 adapter hashes: ' + Object.entries(result.subjects).map(([s, v]) => `${s}: replay ${v.t1Adapters.replay ?? 'unknown'}, PyCG ${v.t1Adapters.pycg ?? 'unknown'}`).join('; '));
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
      ...Object.entries(n.protocol.labellers).map(([k, v]) => `| ${k} | ${v.model} (${v.effort}) | ${v.role} | ${v.qualification ? `${v.qualification.correct}/${v.qualification.answered} ${pct(v.qualification.correct / v.qualification.answered)}${ci(v.qualification.ci)}` : '-'} |`), ''] : []),
    `Labellers: ${n.labellers.join(', ')}.${n.labellers[2] && n.sided ? ` Where ${n.labellers[0]} and ${n.labellers[1]} disagree, ${n.labellers[2]} sided with: ${Object.entries(n.sided).map(([k, v]) => `${k} ${v}`).join(', ') || 'none asked'}.` : ''}`, '', '| language | sites | consensus | no consensus (not imputed) | SCIP right when it answers |', '|---|---|---|---|---|');
  for (const [lang, t] of Object.entries(n.table)) { const a = t.ALL; md.push(`| ${lang} | ${a.items} | ${a.consensus} | ${a.items - a.consensus} ${pct((a.items - a.consensus) / a.items)} | ${a.scip[1] ? `${a.scip[0]}/${a.scip[1]} ${pct(a.scip[0] / a.scip[1])}` : '-'} |`); }
  md.push('', 'SCIP accuracy is measured only on sites with a consensus; the sites without one are likely the harder ones, so it may read high.');
}
const robustness = {};
result.missingT3Runs = [];
for (const [name, { tag }] of Object.entries(SUBJECTS)) {
  const file = t3Dir && path.join(t3Dir, `meta-${tag}.json`);
  robustness[name] = summarizeRobustness(file && fs.existsSync(file) ? readJson(file) : null, name);
  result.subjects[name].robustness = robustness[name];
  if (robustness[name].status === 'NOT RUN') result.missingT3Runs.push(name);
}
result.t3Comparison = compareChallenges(robustness.codegraph, robustness['code-graph-rag']);
if (canonical && (Object.values(robustness).some((s) => !s.complete || Object.values(s.relations).some((r) => r.errors || r.unverified))
  || result.t3Comparison.mismatched.length || result.t3Comparison.unknown.length || result.t3Comparison.unpaired.length)) throw new Error('incomplete or mismatched canonical T3 evidence');
md.push('', ...robustnessMarkdown(robustness, result.t3Comparison), '');
const text = `${md.join('\n')}\n`;
if (mdOut) fs.writeFileSync(mdOut, text); else process.stdout.write(text);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
