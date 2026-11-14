// The forward check: each subject call edge compared with SCIP at its call site (the verdicts and
// refinements are listed in oracle.ts's header).
import type { Context } from './context.ts';
import type { Tally } from './report.ts';
import { reLit, scipKind, segs, unctor } from './symbols.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function forward(ctx: Context): Tally {
  const { on, allEdges, classAround, defs, refsAt, scipFiles, docEncoding, subjectEncoding, fileText, lineOf, LANGS, PY,
    CALL_KINDS, excluded, skip, allSites, inTarget } = ctx;
  const ALLSITES = ctx.opts.allSites;
  for (const e of allEdges) {
    if (!CALL_KINDS.has(e.kind) || !LANGS.has(e.slang)) continue;
    if (e.prov != null) skip(`guessed:${e.prov}`);
    else if (e.line == null) skip('no-site-line');
  }
  // Only edges the subject asserts: any provenance (codegraph `heuristic`; code-graph-rag `heuristic`,
  // `overload`) marks a guess, which SPEC §4 scores outside the main tables.
  const edges = allEdges.filter((e) => CALL_KINDS.has(e.kind) && e.prov == null && e.line != null && LANGS.has(e.slang));
  const { pyImportsFile, isPytestFixture } = python(ctx);

  const buckets: Record<string, number> = {};
  const samples: Record<string, any[]> = {};
  for (const e of edges) {
    if ((excluded(e.sfile) || excluded(e.tfile)) && skip('corpus-exclude')) continue;
    // A framework edge recorded at the target's own declaration (Next.js route -> page).
    if (on('skip-framework-self-site') && e.sfile === e.tfile && e.line === e.tstart && skip('skip-framework-self-site')) continue;
    // A file the SCIP index didn't cover (outside the tsconfig's include).
    if (!scipFiles.has(e.sfile)) {
      buckets['outside-scip'] = (buckets['outside-scip'] ?? 0) + 1;
      if (ALLSITES) allSites.push({ site: `${e.sfile}:${e.line}`, name: e.tname, key: 'outside-scip', target: `${e.tfile}:${e.tqname}:${e.tstart}` });
      continue;
    }
    const parts = segs(e.ref ?? e.tname);
    const member = parts[parts.length - 1];
    // SPEC §4 constructor: an edge to a Python `__init__` (code-graph-rag links `Foo()` there) is an
    // edge to its class, so the site is compared at the class name against the class's span.
    // An explicit `__init__(...)` call (`super().__init__()`) is a call to the method itself. Read from the
    // site's text, never the subject's `ref`, which a subject may leave empty (code-graph-rag 0.5.0).
    const text = lineOf(e.sfile, e.line);
    // The line may hold both: `super().__init__(Helper())` is an explicit call to the base's `__init__`
    // and a constructor call of Helper. The class's name called on the line makes this edge the latter.
    const around = on('ctor-init') && PY && e.tname === '__init__' ? classAround(e.tfile, e.tstart) : null;
    const cls = around && (!/\b__init__\s*\(/.test(text) || new RegExp(`(?:^|[^\\w.])${reLit(around.name)}\\s*\\(`).test(text)) ? around : null;
    const t = cls ? { ...e, tname: cls.name, tstart: cls.start, tend: cls.end } : e;
    const want = cls ? cls.name : member;
    // codegraph's convention for a member it can't find: link the call to the
    // receiver object itself (`db.insert()` -> `db`, `fn.bind()` -> `fn`).
    // Also through an aliased import (`import { targetCounties as seeds }`, then `seeds.forEach()`).
    const receiverFallback = parts.length > 1 && e.tname !== member && (e.tname === parts[0]
      || (e.tkind !== 'function' && e.tkind !== 'method' && fileText(e.sfile).includes(`${e.tname} as ${parts[0]}`)));
    const onLine = refsAt.get(`${e.sfile}:${e.line}`) ?? [];
    // The called name, or (a chain broken over lines) the target's own name.
    let cands = onLine.filter((r) => text.slice(r.start, r.end) === want);
    if (cands.length === 0) cands = onLine.filter((r) => text.slice(r.start, r.end) === t.tname);
    // A member call: the occurrence right after a `.` (not a receiver of the same name).
    if (parts.length > 1 && cands.length > 0) {
      const dotted = cands.filter((r) => /[.?]\s*$/.test(text.slice(0, r.start)));
      if (dotted.length > 0) cands = dotted;
      // The member is on this line but SCIP left it unresolved: don't compare against a
      // same-named argument (`idx.lexical.query(query)`).
      else if (text.includes(`.${member}`)) cands = [];
    }
    let verdict;
    let scip = null;
    if (cands.length === 0) {
      verdict = 'no-scip-ref';
    } else {
      // Nearest column, when the subject's columns are in the oracle's encoding (or the line is ASCII, where
      // every encoding agrees); otherwise the oracle's document order.
      if (e.col != null && (subjectEncoding === docEncoding.get(e.sfile) || /^[\x00-\x7f]*$/.test(text))) {
        cands = cands.sort((x, y) => Math.abs(x.start - e.col) - Math.abs(y.start - e.col));
      }
      const r = cands[0];
      scip = unctor(r.symbol);
      const d = defs.get(scip) ?? defs.get(r.symbol);
      if (inTarget(d, t, want, scip)) verdict = 'ok';
      else if (on('receiver-fallback') && receiverFallback) verdict = 'receiver-fallback';
      else if (!d) verdict = r.symbol.includes('#local ') ? 'scip-local-undefined' : 'external';
      else if (r.symbol.includes('#local ')) {
        // A local binding: an alias of a module's export when bound from a
        // dynamic import or require; otherwise codegraph linked a name the
        // code shadows locally.
        const bound = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => lineOf(d[0].file, d[0].line + k)).join(' ');
        verdict = on('local-module-alias') && /^[^;]*\b(import|require)\(/.test(bound) ? 'local-module-alias' : 'local-shadow';
      } else verdict = 'wrong-target';
      // SPEC §5: `scip-local-undefined` is unaligned (no oracle answer), so no refinement applies.
      if (verdict !== 'ok' && verdict !== 'receiver-fallback' && verdict !== 'local-module-alias' && verdict !== 'scip-local-undefined') {
        if (on('ok-other-column') && cands.slice(1).some((c) => inTarget(defs.get(unctor(c.symbol)) ?? defs.get(c.symbol), e, member, unctor(c.symbol)))) verdict = 'ok-other-column';
        // SPEC §4 overload set, Python: scip-python defines an `@overload`ed function at its first stub;
        // a subject may keep only the implementation. Same file, same name, every SCIP definition an
        // `@overload` stub above the target.
        else if (on('ok-overload-set') && PY && d && member === e.tname && d.every((x) => x.file === e.tfile && x.line < e.tstart
          && /^\s*@(?:[\w.]+\.)?overload\b/.test(lineOf(x.file, x.line - 1)))) verdict = 'ok-overload-set';
        else if (on('noise:scip-shorthand-property') && scipKind(scip) === 'meta' && d && d.some((x) => new RegExp(`^\\s*[{,]?\\s*${reLit(member)}\\s*[,}]?\\s*$`).test(lineOf(x.file, x.line)))) verdict = 'noise:scip-shorthand-property';
        else if (on('noise:scip-builtin-shadowed') && PY && verdict === 'external' && /python-stdlib .*builtins\//.test(scip) && e.tfile === e.sfile
          && new RegExp(`^(class|def)\\s+${reLit(member)}\\b`, 'm').test(fileText(e.sfile))) verdict = 'noise:scip-builtin-shadowed';
        else if (on('noise:pytest-fixture-param') && PY && scipKind(scip) === 'parameter' && isPytestFixture(e.tfile, e.tstart)) verdict = 'noise:pytest-fixture-param';
        else if (on('noise:scip-unresolved-module') && verdict === 'external' && /\/__init__:$/.test(scip)) verdict = 'noise:scip-unresolved-module';
        else if (on('noise:external-target-outside-scip') && verdict === 'external' && !scipFiles.has(e.tfile)) verdict = 'noise:external-target-outside-scip';
        else if (on('cross-file-unimported') && PY && !/\.\s*$/.test(text.slice(0, r.start)) && e.tfile !== e.sfile && !pyImportsFile(e.sfile, e.tfile)) verdict = 'cross-file-unimported';
      }
    }
    const plain = verdict === 'ok' || verdict === 'ok-other-column' || verdict === 'outside-scip';
    const key = plain ? `${verdict}|${e.kind}|${e.by ?? '-'}` : `${verdict}|${e.kind}|${e.by ?? '-'}|${e.tkind}>${scipKind(scip)}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
    if (ALLSITES) allSites.push({ site: `${e.sfile}:${e.line}`, name: member, key, target: `${e.tfile}:${e.tqname}:${e.tstart}`, scip });
    if (!plain) {
      (samples[key] ??= []).push({
        site: `${e.sfile}:${e.line}:${e.col}`, code: text.trim().slice(0, 140), ref: e.ref,
        codegraph: `${e.tkind} ${e.tfile}:${e.tqname}:${e.tstart}`, scip, scipDef: scip ? defs.get(scip)?.[0] ?? null : null,
      });
    }
  }
  return { buckets, samples, total: edges.length, unit: 'edges', extra: { waterfall: ctx.waterfall() } };
}

// Python's import and fixture helpers for the forward refinements.
function python(ctx: Context) {
  const { opts: { repo }, lineOf } = ctx;
  // Every module path a file imports (anywhere in the file, relative ones resolved), as path
  // segments. `from a.b import c` yields a/b and a/b/c (c may be a submodule).
  const pyImportCache = new Map<string, string[][]>();
  const pyImports = (file: string) => {
    if (pyImportCache.has(file)) return pyImportCache.get(file);
    let text = '';
    try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch {}
    const here = path.dirname(file).split('/').filter((x) => x && x !== '.');
    const mod = (spec: string) => {
      const dots = spec.match(/^\.*/)[0].length;
      const rest = spec.slice(dots).split('.').filter(Boolean);
      return dots ? [...here.slice(0, here.length - (dots - 1)), ...rest] : rest;
    };
    const out = [];
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*)/gm)) {
      const base = mod(m[1]);
      if (base.length) out.push(base);
      for (const n of m[2].replace(/[()\\]/g, ' ').split(',')) {
        const name = n.trim().split(/\s+/)[0];
        if (name && name !== '*') out.push([...base, name]);
      }
    }
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(/\s+/)[0];
        if (name) out.push(mod(name));
      }
    }
    pyImportCache.set(file, out);
    return out;
  };
  // Does `file` import the module `tfile` (or a package containing it)?
  const pyImportsFile = (file: string, tfile: string) => {
    const t = tfile.replace(/\.pyi?$/, '').split('/');
    if (t[t.length - 1] === '__init__') t.pop();
    return pyImports(file).some((imp) => {
      for (let i = 0; i + imp.length <= t.length; i++) if (imp.every((x, k) => t[i + k] === x)) return true;
      return false;
    });
  };
  const isPytestFixture = (file: string, start: number) => [start - 3, start - 2, start - 1, start]
    .some((l) => l > 0 && /^\s*@(pytest\.)?fixture\b/.test(lineOf(file, l)));
  return { pyImportsFile, isPytestFixture };
}
