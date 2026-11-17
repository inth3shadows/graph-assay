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
  const src = fs.readFileSync(path.join(here, 'test', 'go-composite-literal', 'main.go'), 'utf8').split('\n');
  const at = (line: number, tname: string, extra = {}) => ctx.compositeLiteral({ kind: 'instantiates', sfile: 'main.go', line, tname, tkind: 'struct', ...extra });
  // The column of the n-th `tname` on a line, as an edge would carry it.
  const nth = (line: number, tname: string, n: number) => { let c = -1; for (let i = 0; i <= n; i++) c = src[line - 1].indexOf(tname, c + 1); return { col: c }; };
  check('skip-composite-literal: a method call named like a literal type on its line is kept (G1)', !at(42, 'Options', { tkind: 'method', ref: 's.Options' }) && at(42, 'Options'));
  check('skip-composite-literal: a function\'s result type is not a literal (G2)', !at(47, 'T') && !at(45, 'T', { col: 10 }) && at(45, 'T', { col: 21 }));
  // Round 2: a `calls` edge resolved to a same-named type (code-graph-rag leaves `ref` null) is a call,
  // and a multi-line signature's closing `) T {` is a result type.
  check('skip-composite-literal: a calls edge is never a literal, even to a type (round 2)', !at(42, 'Options', { kind: 'calls', tkind: 'class' }));
  check('skip-composite-literal: a multi-line signature\'s `) T {` is a result type (round 2)', !at(64, 'T') && at(65, 'T'));
  check('skip-composite-literal: nested type arguments and slice literals are literals (G3)', at(52, 'G') && at(53, 'T'));
  check('skip-composite-literal: a non-ASCII line is read in scip-go\'s byte columns (G4)', at(59, 'T'));
  // #57 follow-ups: a result type is read from the caller's own signature, whatever its layout (I1);
  // a literal after a leading `)` is a literal (I2); a func element type, a map key and a function-local
  // type are parts of a literal's type (H4, H5, H6); a closure's result type is not a literal.
  check('skip-composite-literal: a result type in a signature over several lines is not a literal (I1)',
    !at(69, 'T') && !at(75, 'T') && !at(81, 'T') && !at(85, 'T'));
  check('skip-composite-literal: a literal after a leading `)` is a literal (I2)', at(91, 'T'));
  check('skip-composite-literal: a func element type and a map key are inside a literal\'s type (H4, H5)', at(95, 'T') && at(96, 'T'));
  check('skip-composite-literal: a closure\'s result type is not a literal', !at(97, 'T'));
  check('skip-composite-literal: a function-local struct type is a type (H6)', at(106, 'key'));
  // Follow-ups round 1: signatures are read from the file's own source, lexed whole, never from the
  // subject's caller (J1, J4); a func literal's signature over several lines or with an `interface{}`
  // parameter, at package level too, is a signature (J2, J3); a local type in a grouped type block is a
  // type (J5); a literal's type runs through `struct{}` and a func type's lists (J6), and a conversion
  // `T(...)` is not a literal.
  check('skip-composite-literal: a multi-line raw string or block comment holding a brace does not hide the body (J1)', at(115, 'T') && at(121, 'T'));
  check('skip-composite-literal: a func literal\'s multi-line signature is a signature, at package level too (J2)',
    !at(127, 'T') && at(128, 'T') && !at(140, 'T') && at(141, 'T'));
  check('skip-composite-literal: a one-line func literal taking `interface{}` has a result type (J3)', !at(130, 'T') && at(131, 'T'));
  check('skip-composite-literal: a function-local type declared in a grouped type block is a type (J5)', at(149, 'key2'));
  check('skip-composite-literal: a literal\'s type runs through `struct{}` and a func type\'s lists (J6)',
    at(154, 'T') && at(155, 'T') && at(156, 'T', nth(156, 'T', 0)) && at(156, 'T', nth(156, 'T', 1)));
  check('skip-composite-literal: a conversion is not a literal, the literal inside it is', !at(157, 'T', nth(157, 'T', 0)) && at(157, 'T', nth(157, 'T', 1)));
  check('skip-composite-literal: a conversion or type assertion before a block\'s `{` is not a literal', !at(162, 'T') && at(163, 'T') && !at(166, 'T'));
  check('skip-composite-literal: a func type without a body ends at `=`, so the next literal is one', !at(171, 'T') && at(172, 'T'));
  check('skip-composite-literal: a brace inside a func type\'s list does not close it', at(175, 'T'));
  check('skip-composite-literal: a `func` in a comment opens no signature', at(176, 'T'));
  // Verify round: a line break ends a type, so a declaration after `x[0]` has a signature (K1), and a
  // parameter list of any length does (K2).
  check('skip-composite-literal: a function declared after a line ending in `]` has a result type (K1)', !at(182, 'T') && at(183, 'T'));
  check('skip-composite-literal: a signature longer than 4,000 characters is a signature (K2)',
    !at(454, 'T', { sfile: 'long.go' }) && at(455, 'T', { sfile: 'long.go' }));
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
  const skippedOf = (snapshot: string) => (missing(createContext({ repo: dir, scipFile: path.join(dir, 'index.scip.json'), lang: 'go', missing: true, redact: false,
    allSites: false, show: 0, disabled: new Set(), exclude: '', snapshot })).extra as { pairs: { skippedEdges: Record<string, number> } }).pairs.skippedEdges['skip-composite-literal'];
  try { check('skip-composite-literal: a guessed literal edge counts as guessed on the pair track (G6)', skippedOf(tmpSnap) === skippedOf(path.join(dir, 'snapshot.json')) - 1); }
  finally { fs.rmSync(path.dirname(tmpSnap), { recursive: true, force: true }); }
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
