// In-process checks of the oracle tracks (#7): a self-test case driven through createContext and
// forward() / missing() with no child process, and a rule switched off through Options alone. The
// spawned self-tests (test/run.ts) stay the full suite; this pins that the modules run on their own.
import { createContext, type Options } from './context.ts';
import { forward } from './forward.ts';
import { missing } from './missing.ts';
import { result } from './report.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0; let failed = 0;
const check = (name: string, ok: boolean) => { n++; if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`); };

// A case's own sources are only read, never indexed, so the oracle can run on them in place.
function run(name: string, disabled: string[] = [], redact = false) {
  const dir = path.join(here, 'test', name);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const opts: Options = {
    repo: dir, scipFile: path.join(dir, 'index.scip.json'), lang: spec.lang === 'python' || spec.lang === 'go' ? spec.lang : undefined,
    missing: spec.mode === 'missing', redact, allSites: !redact, show: 0, disabled: new Set(disabled),
    exclude: (spec.exclude ?? []).join(','), snapshot: path.join(dir, 'snapshot.json'),
  };
  const ctx = createContext(opts);
  const tally = opts.missing ? missing(ctx) : forward(ctx);
  return { spec, ctx, tally };
}

// The case's own expectations, read as test/run.ts reads them.
const meets = (spec, sites) => spec.expect.every((x) => {
  const hits = sites.filter((s) => s.site === x.at && s.name === x.name);
  if (x.absent) return hits.length === 0;
  return x.all ? hits.length > 0 && hits.every((h) => h.key.startsWith(x.key)) : hits.some((h) => h.key.startsWith(x.key));
});

for (const name of ['ts-forward', 'py-forward', 'ts-missing']) {
  const { spec, ctx } = run(name);
  check(`${name}: every expectation holds in-process (${spec.expect.length})`, meets(spec, ctx.allSites));
}

const keyAt = (sites, at, name) => sites.find((s) => s.site === at && s.name === name)?.key ?? '';
const on = run('ts-forward');
const off = run('ts-forward', ['noise:scip-shorthand-property']);
check('a rule switched off through Options changes only its own verdict',
  keyAt(on.ctx.allSites, 'api.ts:10', 'buildMember').startsWith('noise:scip-shorthand-property')
  && !keyAt(off.ctx.allSites, 'api.ts:10', 'buildMember').startsWith('noise:')
  && on.ctx.allSites.filter((s) => s.site !== 'api.ts:10').every((s, i) => s.key === off.ctx.allSites.filter((x) => x.site !== 'api.ts:10')[i]?.key));

const red = run('ts-forward', [], true);
const out = result(red.ctx, red.tally).out;
check('redacted result carries counts, never code or paths', out.redacted === true && !('repo' in out) && !('samples' in out) && !('sites' in out));

console.log(`${n - failed}/${n} track checks`);
process.exitCode = failed ? 1 : 0;
