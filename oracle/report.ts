// A track's tally to out.json and stdout. Each bucket's samples are grouped by (codegraph target,
// SCIP definition), since one group is usually one cause. Writes out.json and prints the buckets,
// then (ORACLE_SHOW) the top groups of each candidate bucket. ORACLE_REDACT keeps only bucket keys,
// counts and group sizes.
import { recordedAdapterHash } from '../lib/provenance.ts';
import { SPEC_VERSION } from '../lib/spec.ts';
import type { Context } from './context.ts';
import * as fs from 'node:fs';

/** One track's result, as forward() and missing() return it. */
export interface Tally {
  buckets: Record<string, number>;
  samples: Record<string, any[]>;
  total: number;
  /** What `total` counts, for the ORACLE_SHOW headings: edges or call sites. */
  unit: string;
  extra: Record<string, unknown>;
}

/** The out.json object for a tally, and its groups (for printing). */
export function result(ctx: Context, { buckets, samples, total, extra }: Tally) {
  const { opts, skipped, snap } = ctx;
  const groups: Record<string, any[]> = {};
  for (const [key, list] of Object.entries(samples)) {
    const g = new Map();
    for (const x of list) {
      const k = `${x.codegraph}|${x.scipDef ? `${x.scipDef.file}:${x.scipDef.line}` : x.scip}`;
      if (!g.has(k)) g.set(k, { n: 0, codegraph: x.codegraph, scip: x.scip, scipDef: x.scipDef, code: x.code, sites: [] });
      const v = g.get(k);
      v.n++;
      if (v.sites.length < 5) v.sites.push(x.site);
    }
    groups[key] = [...g.values()].sort((a, b) => b.n - a.n);
  }
  const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  const out: Record<string, unknown> = opts.redact
    ? { redacted: true, total, buckets: Object.fromEntries(sorted), skipped,
        groupSizes: Object.fromEntries(Object.entries(groups).map(([k, gs]) => [k, gs.map((g) => g.n)])) }
    : { repo: opts.repo, total, buckets: Object.fromEntries(sorted), skipped, groups, samples, ...(opts.allSites ? { sites: ctx.allSites } : {}) };
  Object.assign(out, extra);
  // SPEC §8: run.sh sets this when the subject failed and the oracle ran against an empty snapshot.
  if (opts.subjectFailed) out.subjectFailed = opts.subjectFailed;
  out.spec = SPEC_VERSION;
  out.subject = snap.subject.name;
  // SPEC §10: position encodings (subject, oracle documents) and whether the subject records site lines.
  out.positionEncoding = { subject: ctx.subjectEncoding, oracle: [...new Set(ctx.docEncoding.values())].sort() };
  out.siteLines = snap.capabilities?.siteLines ?? null;
  out.adapterSha256 = recordedAdapterHash(snap);
  return { out, groups, sorted };
}

export function report(ctx: Context, tally: Tally) {
  const { opts, skipped } = ctx;
  const { out, groups, sorted } = result(ctx, tally);
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(out, null, 1));
  for (const [k, v] of sorted) console.log(`${String(v).padStart(6)}  ${k}`);
  for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  (skipped) ${k}`);
  const show = opts.show;
  if (show > 0) {
    for (const [k] of sorted) {
      if (!groups[k] || k.startsWith('noise:') || k.startsWith('no-scip-ref')) continue;
      console.log(`\n##### ${k}  (${tally.samples[k].length} ${tally.unit}, ${groups[k].length} groups)`);
      for (const v of groups[k].slice(0, show)) {
        console.log(`  [${v.n}] ${v.sites[0]} | ${v.code.slice(0, 90)}\n       cg=${v.codegraph}\n       scip=${v.scipDef ? `${v.scipDef.file}:${v.scipDef.line} ` : ''}${(v.scip ?? '').slice(-70)}`);
      }
    }
  }
}
