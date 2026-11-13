#!/usr/bin/env node
// Hermetic checks for oracle/site.ts's pure core: bucket meanings and the explanation's content.
import { explainSite, meaningOf, MEANING } from './site.ts';

let n = 0; let failed = 0;
const check = (name, ok) => { n++; if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`); };

check('meaning: forward key reads its first segment', meaningOf('wrong-target|calls|exact-match|function>term') === MEANING['wrong-target']);
check('meaning: missing key reads its cause', meaningOf('missing|no-ref|py|function') === MEANING['no-ref']);
check('meaning: any noise:* rule', meaningOf('noise:scip-unresolved-module|calls|-|function>module') === MEANING.noise);
check('meaning: unknown cause points at the oracle', /oracle\.ts/.test(meaningOf('brand-new|calls')));

const rec = { site: 'a.js:3', name: 'f', key: 'wrong-target|calls|exact-match|function>term', target: 'b.js:f:9', scip: 'npm x a.js/f.' };
const lines = explainSite({ subject: 'codegraph', site: 'a.js:3', name: 'f', records: { forward: [rec], missing: [] }, source: 'f(1)',
  edges: [{ kind: 'calls', tqname: 'f', tfile: 'b.js', tstart: 9, prov: null }], defs: [{ file: 'a.js', line: 1, text: 'var f = g.f' }], skipped: {} });
const text = lines.join('\n');
check('explain: key, meaning, target, SCIP symbol and definition, edges', text.includes(rec.key) && text.includes(MEANING['wrong-target'])
  && text.includes('subject target: b.js:f:9') && text.includes('SCIP symbol: npm x a.js/f.') && text.includes('a.js:1  var f = g.f') && text.includes('calls f b.js:9'));
const none = explainSite({ subject: 'codegraph', site: 'a.js:1', records: { forward: [], missing: [] }, source: null, edges: [], defs: null, skipped: { 'skip-decorator': 2, unused: 0 } }).join('\n');
check('explain: no record names the skip counts, not zero ones', /no oracle record/.test(none) && none.includes('skip-decorator 2') && !none.includes('unused'));
check('explain: --no-scip prints no SCIP definition line', !/SCIP definition/.test(none));

console.log(`${n - failed}/${n} site checks`);
process.exit(failed ? 1 : 0);
