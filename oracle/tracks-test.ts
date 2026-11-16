// In-process checks of the oracle tracks (#7): a self-test case driven through createContext and
// forward() / missing() with no child process, and a rule switched off through Options alone. The
// spawned self-tests (test/run.ts) stay the full suite; this pins that the modules run on their own.
import { createContext, type Options } from './context.ts';
import { forward } from './forward.ts';
import { missing } from './missing.ts';
import { result } from './report.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
// Every other site keeps its key, and no site appears or disappears (#30 review F2).
const rest = (sites) => JSON.stringify(sites.filter((s) => s.site !== 'api.ts:10').map((s) => [s.site, s.name, s.key]));
check('a rule switched off through Options changes only its own verdict',
  keyAt(on.ctx.allSites, 'api.ts:10', 'buildMember').startsWith('noise:scip-shorthand-property')
  && !keyAt(off.ctx.allSites, 'api.ts:10', 'buildMember').startsWith('noise:')
  && on.ctx.allSites.length === off.ctx.allSites.length && rest(on.ctx.allSites) === rest(off.ctx.allSites));

// #55 review: scip-name-mismatch fires only on an identifier whose project symbol names another
// definition, never on a library symbol (F2), an import clause's span (F7) or a chain of renames (F1).
{
  const { ctx } = run('py-star-import');
  const project = (d) => `scip-python python repo 0 \`pkg.${d}`;
  check('scip-name-mismatch: a project symbol named otherwise than its identifier is a mismatch', ctx.nameMismatch('Headers', `${project('_models')}\`/Response#`));
  check('scip-name-mismatch: a library symbol is never a mismatch (F2)', !ctx.nameMismatch('exists', 'scip-python python python-stdlib 3.11 posixpath/abspath().'));
  check('scip-name-mismatch: an import clause\'s span is not an identifier (F7)', !ctx.nameMismatch('Response as Reply', `${project('_models')}\`/Response#`));
  check('scip-name-mismatch: a name renamed twice is an alias (F1)', !ctx.nameMismatch('Chain2', `${project('_impl')}\`/RealCls#`));
  check('scip-name-mismatch: a module variable is not a function, method or class (F4)', !ctx.nameMismatch('other', `${project('_models')}\`/__all__.`));
}

// #57 review: skip-composite-literal skips only the literal the edge sits on (real scip-go lines in
// go-composite-literal/main.go), never a same-named call (G1) or a function's result type (G2), and
// recognises nested type arguments (G3) and slice literals.
{
  const { ctx } = run('go-composite-literal');
  const at = (line: number, tname: string, extra = {}) => ctx.compositeLiteral({ sfile: 'main.go', line, tname, tkind: 'struct', ...extra });
  check('skip-composite-literal: a method call named like a literal type on its line is kept (G1)', !at(42, 'Options', { tkind: 'method', ref: 's.Options' }) && at(42, 'Options'));
  check('skip-composite-literal: a function\'s result type is not a literal (G2)', !at(47, 'T') && !at(45, 'T', { col: 10 }) && at(45, 'T', { col: 21 }));
  check('skip-composite-literal: nested type arguments and slice literals are literals (G3)', at(52, 'G') && at(53, 'T'));
  check('skip-composite-literal: a non-ASCII line is read in scip-go\'s byte columns (G4)', at(59, 'T'));
}
// G6: a guessed literal edge is counted as guessed on the pair track, as on the call-site track, not as
// skip-composite-literal.
{
  const dir = path.join(here, 'test', 'go-composite-literal');
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  const lit = snap.edges.find((e) => e.kind === 'instantiates' && e.line === 59);
  lit.provenance = 'heuristic';
  const tmpSnap = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-guess-')), 'snapshot.json');
  fs.writeFileSync(tmpSnap, JSON.stringify(snap));
  const ctx = createContext({ repo: dir, scipFile: path.join(dir, 'index.scip.json'), lang: 'go', missing: true, redact: false, allSites: false,
    show: 0, disabled: new Set(), exclude: '', snapshot: tmpSnap });
  const pairs = missing(ctx).extra.pairs;
  check('skip-composite-literal: a guessed literal edge counts as guessed on the pair track (G6)', pairs.skippedEdges['skip-composite-literal'] === 8);
  fs.rmSync(path.dirname(tmpSnap), { recursive: true, force: true });
}

// F5 (#30 review): an unknown language is refused in-process too, not read as TS/JS.
const tsOpts = (lang: string): Options => ({ repo: path.join(here, 'test', 'ts-forward'), scipFile: path.join(here, 'test', 'ts-forward', 'index.scip.json'), lang,
  missing: false, redact: false, allSites: false, show: 0, disabled: new Set(), exclude: '', snapshot: path.join(here, 'test', 'ts-forward', 'snapshot.json') });
let refused = '';
try { createContext(tsOpts('java')); } catch (e) { refused = String(e?.message); }
check('createContext refuses an unknown language', /ORACLE_LANG=java/.test(refused));

// F10 (#30 review): --mutate reads rules only from modules the oracle imports, never from other scripts.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-rules-'));
try {
  fs.writeFileSync(path.join(tmp, 'oracle.ts'), "import { a } from './a.ts';\n");
  fs.writeFileSync(path.join(tmp, 'a.ts'), "import { b } from './b.ts';\nexport const a = on('rule-a');\n");
  fs.writeFileSync(path.join(tmp, 'b.ts'), "export const b = on('rule-b') && on('rule-a');\n");
  fs.writeFileSync(path.join(tmp, 'site.ts'), "// on('not-a-rule')\n");
  const { oracleRules } = await import('./test/rules.ts');
  check('--mutate rules come from the modules the oracle imports', JSON.stringify(oracleRules(path.join(tmp, 'oracle.ts'))) === '["rule-a","rule-b"]');
  const real = oracleRules(path.join(here, 'oracle.ts'));
  check('the real oracle has 24 rules, corpus-exclude and skip-framework-self-site among them', real.length === 24 && real.includes('corpus-exclude') && real.includes('skip-framework-self-site'));
} catch (e) {
  check(`--mutate rule discovery (${e?.message})`, false);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const red = run('ts-forward', [], true);
const out = result(red.ctx, red.tally).out;
check('redacted result carries counts, never code or paths', out.redacted === true && !('repo' in out) && !('samples' in out) && !('sites' in out));

console.log(`${n - failed}/${n} track checks`);
process.exitCode = failed ? 1 : 0;
