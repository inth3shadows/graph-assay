#!/usr/bin/env node
// Diff codegraph's resolved call edges against a SCIP index (compiler-grade
// references) of the same checkout.
//
// Usage: [ORACLE_LANG=python] node oracle.ts <repo dir with .codegraph/> <index.scip> [out.json]
//
// For each non-heuristic `calls`/`instantiates` edge, find the SCIP reference
// at the call site (same file, same line, identifier text == the called name,
// nearest column) and compare where each says it goes:
//   ok             SCIP's definition sits inside the codegraph target's lines
//   wrong-target   SCIP defines it in the project, somewhere else
//   external       SCIP resolves it outside the project (a library / lib.d.ts),
//                  but codegraph linked a project node: a fabricated edge
//   scip-local     SCIP says it is a local binding (parameter, local const)
//   no-scip-ref    no SCIP reference with that name on that line (alignment gap)
// Refinements of a disagreement (checked in this order):
//   ok-other-column              the name appears twice on the line; the other occurrence agrees
//   noise:pytest-fixture-param   Python: SCIP sees a parameter, codegraph links the pytest
//                                fixture that parameter receives (deliberate, isFixtureInReach)
//   noise:scip-unresolved-module SCIP points at a module symbol (`pkg.mod`/__init__:): pyright
//                                could not resolve the import (sys.path tricks), so it has no answer
//   noise:scip-shorthand-property SCIP defines the name at an object literal's shorthand
//                                property (`{ buildMember, ... }`); codegraph links the function itself
//   noise:scip-builtin-shadowed  Python: SCIP says builtin, but the caller's own file defines the
//                                name at module level and codegraph links that (it is what runs)
//   noise:external-target-outside-scip
//                                SCIP says external but never indexed the target file
//                                (a .mjs / allowJs file outside the tsconfig)
//   cross-file-unimported        Python: a bare-name call linked into another file the caller
//                                never imports (no import names that module or a package of it)
// Bucket keys are verdict|kind|resolvedBy, plus |target kind>SCIP symbol kind for a disagreement.
// ORACLE_SHOW=N prints the top N groups (same codegraph target + same SCIP definition) per bucket.
// ORACLE_REDACT=1 is for code that must not leave its machine: stdout and out.json carry only
// bucket keys, counts and group sizes (no code, paths, names or SCIP symbols); ORACLE_SHOW is
// ignored, and an error prints only its kind.
import { loadScip } from '../lib/scip.ts';
import { recordedAdapterHash } from '../lib/provenance.ts';
import { SPEC_VERSION } from '../lib/spec.ts';
import { loadSnapshot, joinedEdges } from '../lib/snapshot.ts';
import * as codegraph from '../lib/subjects/codegraph.ts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REDACT = process.env.ORACLE_REDACT === '1';
// ORACLE_DISABLE=rule,rule switches named rules off (oracle/test/run.ts --mutate uses it to prove
// every rule is pinned by a test). Rule names are the strings passed to on().
const DISABLED = new Set((process.env.ORACLE_DISABLE ?? '').split(',').filter(Boolean));
const on = (rule) => !DISABLED.has(rule);
// ORACLE_ALLSITES=1 (tests): out.json also lists every compared site with its bucket key, agreements included.
const ALLSITES = process.env.ORACLE_ALLSITES === '1' && !REDACT;
const allSites = [];
if (REDACT) {
  process.on('uncaughtException', (err) => {
    console.error(`oracle failed (${err?.name ?? 'Error'}); details withheld under ORACLE_REDACT`);
    process.exit(1);
  });
}

const [repo, scipFile, out] = process.argv.slice(2);
if (process.env.ORACLE_LANG && !['ts', 'python', 'go', 'jvm'].includes(process.env.ORACLE_LANG)) {
  console.error(`ORACLE_LANG=${process.env.ORACLE_LANG}: expected ts (or unset) for TS/JS, python, go or jvm`); process.exit(2);
}
// The SCIP index: binary .scip, or decoded .json. The subject's graph: a snapshot v1 file
// (ORACLE_SNAPSHOT), or else exported from <repo>/.codegraph by the codegraph adapter.
const index = loadScip(scipFile);
const snap = process.env.ORACLE_SNAPSHOT ? loadSnapshot(process.env.ORACLE_SNAPSHOT) : codegraph.snapshot(repo);
const allEdges = joinedEdges(snap);
// The innermost class whose span holds `line` in `file` (from spans, not qualified names).
const classAround = (file, line) => snap.nodes.filter((n) => n.kind === 'class' && n.file === file && n.start <= line && line <= n.end)
  .sort((a, b) => b.start - a.start)[0] ?? null;

// An occurrence's [line, start, end] or [line, start, endLine, end]: older SCIP writers set `range`,
// newer ones (scip-go 0.2.x) a TypedRange.
const rangeOf = (o) => {
  if (o.range) return o.range;
  const t = o.TypedRange ?? o.typed_range ?? {};
  if (t.SingleLineRange) return [t.SingleLineRange.line ?? 0, t.SingleLineRange.start_character ?? 0, t.SingleLineRange.end_character ?? 0];
  const m = t.MultiLineRange ?? {};
  return [m.start_line ?? 0, m.start_character ?? 0, m.end_line ?? 0, m.end_character ?? 0];
};
// symbol -> definition sites, and file:line -> references on that line
const defs = new Map();
const refsAt = new Map();
const scipFiles = new Set();
// SPEC §2: columns in different encodings are never compared. The oracle's encoding per document is
// its SCIP `position_encoding` when set, else the indexer's (scip-typescript and scip-python write
// UTF-16 code units, scip-go UTF-8 bytes); unknown otherwise. A subject's is its snapshot capability.
const TOOL_ENCODING = { 'scip-typescript': 'utf16', 'scip-python': 'utf16', 'scip-go': 'utf8' };
const docEncoding = new Map();
const subjectEncoding = snap.capabilities?.columnEncoding ?? 'unknown';
for (const doc of index.documents) {
  const file = doc.relative_path;
  scipFiles.add(file);
  docEncoding.set(file, { 1: 'utf8', 2: 'utf16', 3: 'utf32' }[doc.position_encoding] ?? TOOL_ENCODING[index.metadata?.tool_info?.name] ?? 'unknown');
  for (const o of doc.occurrences ?? []) {
    const [line, start, a, b] = rangeOf(o);
    const end = b === undefined ? a : b;
    if ((o.symbol_roles ?? 0) & 1) {
      // `local N` symbols are numbered per document
      const sym = o.symbol.startsWith('local ') ? `${file}#${o.symbol}` : o.symbol;
      const list = defs.get(sym) ?? [];
      list.push({ file, line: line + 1 });
      defs.set(sym, list);
    } else {
      const key = `${file}:${line + 1}`;
      const list = refsAt.get(key) ?? [];
      list.push({ start, end, symbol: o.symbol.startsWith('local ') ? `${file}#${o.symbol}` : o.symbol });
      refsAt.set(key, list);
    }
  }
}

const fileTexts = new Map();
const fileText = (file) => {
  if (!fileTexts.has(file)) {
    try { fileTexts.set(file, fs.readFileSync(path.join(repo, file), 'utf8')); } catch { fileTexts.set(file, ''); }
  }
  return fileTexts.get(file);
};
const sources = new Map();
const lineOf = (file, line) => {
  if (!sources.has(file)) {
    try { sources.set(file, fs.readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/)); } catch { sources.set(file, []); }
  }
  return sources.get(file)[line - 1] ?? '';
};

// ORACLE_LANG=python / go / jvm for a scip-python / scip-go / scip-java index; TS/JS otherwise.
/** A name as a literal inside a RegExp (`$http`, `a.b` would otherwise be metacharacters). */
const reLit = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LANGS = new Set({ python: ['python'], jvm: ['java', 'kotlin'], go: ['go'] }[process.env.ORACLE_LANG] ?? ['typescript', 'tsx', 'javascript', 'jsx']);
const CALL_KINDS = new Set(['calls', 'instantiates']);
// SPEC §1, §7: the corpus entry's vendored/generated path prefixes (ORACLE_EXCLUDE, comma-separated)
// are not project code: a call from or to them leaves every denominator, and the waterfall counts them.
const EXCLUDE = on('corpus-exclude') ? (process.env.ORACLE_EXCLUDE ?? '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean) : [];
const excluded = (file) => EXCLUDE.some((p) => file === p || file.startsWith(`${p}/`));
// SPEC §7 file steps: files in corpus (minus exclusions) -> in a supported language -> indexed by the
// subject -> indexed by the oracle. A Git checkout lists tracked files; any other directory is walked
// (dot entries, node_modules and symlinks left out).
const SUPPORTED = { python: /\.pyi?$/, go: /\.go$/, jvm: /\.(java|kt)$/ }[process.env.ORACLE_LANG] ?? /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function repoFiles(dir) {
  const git = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean);
  const out = [];
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p); else if (ent.isFile()) out.push(p);
    }
  };
  walk('');
  return out;
}
const waterfall = () => {
  const all = repoFiles(repo); const kept = all.filter((f) => !excluded(f)); const supported = kept.filter((f) => SUPPORTED.test(f));
  const bySubject = new Set(snap.nodes.filter((n) => LANGS.has(n.language)).map((n) => n.file));
  return { filesInCorpus: kept.length, excluded: all.length - kept.length, supportedLanguage: supported.length,
    indexedBySubject: supported.filter((f) => bySubject.has(f)).length, indexedByOracle: supported.filter((f) => scipFiles.has(f)).length };
};
// Only edges the subject asserts: any provenance (codegraph `heuristic`; code-graph-rag `heuristic`,
// `overload`) marks a guess, which SPEC §4 scores outside the main tables.
const edges = allEdges.filter((e) => CALL_KINDS.has(e.kind) && e.prov == null && e.line != null && LANGS.has(e.slang));
// Everything left out of the buckets, by reason, so the coverage waterfall (SPEC §7) is published
// next to them: `skipped` in out.json. Bucket keys never include these.
const skipped: Record<string, number> = {};
const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; return true; };
if (process.env.ORACLE_MODE !== 'missing') {
  for (const e of allEdges) {
    if (!CALL_KINDS.has(e.kind) || !LANGS.has(e.slang)) continue;
    if (e.prov != null) skip(`guessed:${e.prov}`);
    else if (e.line == null) skip('no-site-line');
  }
}

const PY = process.env.ORACLE_LANG === 'python';
// The kind of a SCIP symbol, from its last descriptor's suffix.
const scipKind = (s) => !s ? '-' : s.includes('local ') ? 'local' : /\)\.$/.test(s) ? 'method'
  : /\([^()]*\)$/.test(s) ? 'parameter' : s.endsWith('#') ? 'type' : s.endsWith('.') ? 'term'
  : s.endsWith('/') ? 'namespace' : s.endsWith(':') ? 'meta' : s.endsWith(']') ? 'typeparam' : 'other';

// Python: every module path a file imports (anywhere in the file, relative ones resolved),
// as path segments. `from a.b import c` yields a/b and a/b/c (c may be a submodule).
const pyImportCache = new Map();
const pyImports = (file) => {
  if (pyImportCache.has(file)) return pyImportCache.get(file);
  let text = '';
  try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch {}
  const here = path.dirname(file).split('/').filter((x) => x && x !== '.');
  const mod = (spec) => {
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
const pyImportsFile = (file, tfile) => {
  const t = tfile.replace(/\.pyi?$/, '').split('/');
  if (t[t.length - 1] === '__init__') t.pop();
  return pyImports(file).some((imp) => {
    for (let i = 0; i + imp.length <= t.length; i++) if (imp.every((x, k) => t[i + k] === x)) return true;
    return false;
  });
};
const isPytestFixture = (file, start) => [start - 3, start - 2, start - 1, start]
  .some((l) => l > 0 && /^\s*@(pytest\.)?fixture\b/.test(lineOf(file, l)));

const buckets = {};
const samples = {};
const segs = (ref) => ref.split(/\.|::|#/).map((x) => x.replace(/[?!()]/g, '')).filter(Boolean);
// The callee's own name: the last descriptor of its SCIP symbol (`pkg.models/Req#prepare().` ->
// `prepare`); null for a local.
const defName = (sym) => {
  if (!sym || sym.includes('local ')) return null;
  const m = sym.replace(/\([^()]*\)\.?$/, '').replace(/[#.:/]$/, '').match(/(`(?:[^`]|``)+`|[^\s`/#.:()[\]]+)$/);
  return m ? m[1].replace(/^`|`$/g, '') : null;
};
const CTOR = new Set(['constructor', '__init__', '__new__']);
// SPEC §2: the target node holds the callee only if it is named like it, not merely if its span
// contains the definition (a class edge on `Req().prepare()` is not an edge to `prepare`). Either
// name counts: the definition's (an aliased import, `import { a as b }`) or the one called at the
// site (scip-typescript's `attendance0:` for property `attendance`, `<get>x`, Java `<init>`).
// SPEC §4 constructor: a constructor node stands for its class, and a class node for a constructor.
const sameCallee = (e, name, sym) => {
  const callee = defName(sym);
  return e.tname === name || e.tname === callee || CTOR.has(e.tname) || (CTOR.has(callee) && e.tkind === 'class');
};
// codegraph starts `const x =\n  (...) =>` at the arrow's line; SCIP at the declaration's.
// So a same-named definition up to two lines above the target's start is the same symbol.
const inTarget = (d, e, name, sym) => d && (!on('callee-name') || sameCallee(e, name, sym))
  && d.some((x) => x.file === e.tfile && x.line <= e.tend && (x.line >= e.tstart || (name === e.tname && x.line >= e.tstart - 2)));
// `new X()` references X's constructor, which has no definition of its own.
const unctor = (sym) => sym.replace(/`<constructor>`\(\)\.$/, '');
if (process.env.ORACLE_MODE === 'missing') { missingMode(); process.exit(0); }
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

report(buckets, samples, edges.length, 'edges', { waterfall: waterfall() });

// Group each bucket's samples by (codegraph target, SCIP definition): one group is usually one cause.
// Writes out.json and prints the buckets, then (ORACLE_SHOW) the top groups of each candidate bucket.
function report(buckets: Record<string, number>, samples: Record<string, any[]>, total, unit, extra = {}) {
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
  const result: Record<string, unknown> = REDACT
    ? { redacted: true, total, buckets: Object.fromEntries(sorted), skipped,
        groupSizes: Object.fromEntries(Object.entries(groups).map(([k, gs]) => [k, gs.map((g) => g.n)])) }
    : { repo, total, buckets: Object.fromEntries(sorted), skipped, groups, samples, ...(ALLSITES ? { sites: allSites } : {}) };
  Object.assign(result, extra);
  // SPEC §8: run.sh sets this when the subject failed and the oracle ran against an empty snapshot.
  if (process.env.ORACLE_SUBJECT_FAILED) result.subjectFailed = process.env.ORACLE_SUBJECT_FAILED;
  result.spec = SPEC_VERSION;
  result.subject = snap.subject.name;
  // SPEC §10: position encodings (subject, oracle documents) and whether the subject records site lines.
  result.positionEncoding = { subject: subjectEncoding, oracle: [...new Set(docEncoding.values())].sort() };
  result.siteLines = snap.capabilities?.siteLines ?? null;
  result.adapterSha256 = recordedAdapterHash(snap);
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
  for (const [k, v] of sorted) console.log(`${String(v).padStart(6)}  ${k}`);
  for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  (skipped) ${k}`);
  const show = REDACT ? 0 : Number(process.env.ORACLE_SHOW ?? 0);
  if (show > 0) {
    for (const [k] of sorted) {
      if (!groups[k] || k.startsWith('noise:') || k.startsWith('no-scip-ref')) continue;
      console.log(`\n##### ${k}  (${samples[k].length} ${unit}, ${groups[k].length} groups)`);
      for (const v of groups[k].slice(0, show)) {
        console.log(`  [${v.n}] ${v.sites[0]} | ${v.code.slice(0, 90)}\n       cg=${v.codegraph}\n       scip=${v.scipDef ? `${v.scipDef.file}:${v.scipDef.line} ` : ''}${(v.scip ?? '').slice(-70)}`);
      }
    }
  }
}

// ORACLE_MODE=missing: the inverse check. For each SCIP reference at a call site (`name(`,
// `name<T>(`, `new name`) to a symbol the project defines, look for the codegraph edge that
// should carry it: calls/instantiates from that file and line to a node holding the definition.
// Causes, in order:
//   found                  a non-heuristic edge
//   found-heuristic-only   only a heuristic (synthesized) edge
//   found-other-line       a non-heuristic edge within 3 lines (a call written over several lines)
//   receiver-fallback      a same-line edge links the receiver instead (`db.insert()` -> `db`)
//   wrong-edge             a same-line edge for that name goes elsewhere (the forward oracle's domain)
//   file-not-indexed       codegraph has no nodes for the caller's file
//   target-file-not-indexed  ... or for the definition's file
//   target-not-a-node      no codegraph node of that name at the definition site
//   unresolved-ref         codegraph kept an unresolved reference for that name on that line
//   no-ref                 codegraph extracted nothing for it
// Bucket keys are missing|cause|language|SCIP symbol kind (+ @decl when the definition has no body:
// .d.ts, type literal or interface member; + >target node kind when one exists).
// Decorator sites go to `decorators` in out-missing.json, not the buckets (SPEC §4). Skipped: an
// object literal's method shorthand and (TS) a type without `new`.
function missingMode() {
  const nodesByFile = new Map();
  for (const n of snap.nodes) {
    if (!LANGS.has(n.language) || n.kind === 'file') continue;
    (nodesByFile.get(n.file) ?? nodesByFile.set(n.file, []).get(n.file)).push({ kind: n.kind, name: n.name, file: n.file, s: n.start, e: n.end });
  }
  const indexed = new Set(snap.nodes.filter((n) => LANGS.has(n.language)).map((n) => n.file));
  const edgesAt = new Map();
  for (const e of allEdges) {
    if (!CALL_KINDS.has(e.kind) || e.line == null || !LANGS.has(e.slang)) continue;
    const k = `${e.sfile}:${e.line}`;
    (edgesAt.get(k) ?? edgesAt.set(k, []).get(k)).push(e);
  }
  // `decorates` edges by line, for decorator sites (SPEC §4 decorator).
  const decoratesAt = new Map();
  for (const e of allEdges) {
    if (e.kind !== 'decorates' || e.line == null || !LANGS.has(e.slang)) continue;
    const k = `${e.sfile}:${e.line}`;
    (decoratesAt.get(k) ?? decoratesAt.set(k, []).get(k)).push(e);
  }
  const unresolvedAt = new Map();
  for (const u of snap.unresolved) {
    if (!CALL_KINDS.has(u.kind)) continue;
    const k = `${u.file}:${u.line}`;
    (unresolvedAt.get(k) ?? unresolvedAt.set(k, []).get(k)).push(u.name);
  }

  // The definition is a declaration with no body: a .d.ts file, a type literal's member, or a
  // member of an interface / type alias. Tagged `@decl` in the bucket key.
  const isDecl = (sym, d) => /\.d\.ts$/.test(d[0].file) || sym.includes('typeLiteral')
    || (nodesByFile.get(d[0].file) ?? []).some((n) => (n.kind === 'interface' || n.kind === 'type_alias')
      && n.s <= d[0].line && d[0].line <= n.e && n.s !== d[0].line);
  // `register(on) {` / `get(...params: any[]): Row {` opening an object literal's method: SCIP records
  // only a reference to the interface member it implements, no definition.
  const isMethodShorthand = (before, after) => {
    if (!/^\s*(?:(?:async|get|set|static)\s+|\*\s*)*$/.test(before)) return false;
    const open = after.indexOf('(');
    let depth = 0;
    for (let i = open; i < after.length; i++) {
      if (after[i] === '(') depth++;
      else if (after[i] === ')' && --depth === 0) return /^\s*(?::[^=]*)?\{\s*$/.test(after.slice(i + 1));
    }
    return false;
  };
  const langOf = (f) => (f.match(/\.(\w+)$/)?.[1] ?? '-').replace(/^(m|c)(js|ts)$/, '$2');
  const namesIt = (ref, name) => ref && (ref === name || ref.endsWith(`.${name}`) || ref.endsWith(`::${name}`));
  const buckets = {};
  const samples = {};
  let considered = 0;
  const units = []; const skippedUnits = [];
  for (const doc of index.documents) {
    const file = doc.relative_path;
    for (const o of doc.occurrences ?? []) {
      if ((o.symbol_roles ?? 0) & 1 || o.symbol.startsWith('local ')) continue;
      const sym = unctor(o.symbol);
      const kind = scipKind(sym);
      if (kind !== 'method' && kind !== 'term' && kind !== 'type') continue;
      const d = defs.get(sym);
      if (!d) continue;
      const [l0, start, a, b] = rangeOf(o);
      if (b !== undefined) continue; // a reference spanning lines is not a call name
      const line = l0 + 1;
      const text = lineOf(file, line);
      const name = text.slice(start, a);
      const before = text.slice(0, start);
      const after = text.slice(a);
      const isNew = !PY && /\bnew\s+(?:[\w$]+\s*\.\s*)*$/.test(before);
      const isCall = PY ? /^\s*\(/.test(after) : /^\s*!?\s*(?:\?\.)?\s*(?:<[^()]*>)?\s*\(/.test(after);
      // SPEC §4: a decorator application (`@d`, `@d(...)`) is scored in its own column, never the headline.
      const decorator = on('decorator-column') && /@\s*(?:[\w$]+\s*\.\s*)*$/.test(before);
      if (!isNew && !isCall && !decorator) continue;
      // A skipped call is out of both tracks: its function pair is skipped too, not judged (SPEC §3).
      const skipUnit = (why) => { skippedUnits.push({ file, line, sym }); return skip(why); };
      if (on('skip-type-without-new') && !PY && kind === 'type' && !isNew && skipUnit('skip-type-without-new')) continue; // `Matcher<Args<P>>(`: a type position, not a call
      if (on('skip-method-shorthand') && !PY && isMethodShorthand(before, after) && skipUnit('skip-method-shorthand')) continue;
      // `var request = require('supertest')`: SCIP's definition is the binding line, but the callee is
      // an installed package's export, so the call never had a project target (cf. local-module-alias).
      if (on('skip-external-module-binding') && !PY && d.every((x) => /=\s*require\(\s*['"](?![./])/.test(lineOf(x.file, x.line))) && skipUnit('skip-external-module-binding')) continue;
      // `var basename = path.basename`, `, Router = express.Router`: SCIP's definition is a binding to a
      // member of a required module. SCIP stops at the binding, and no subject should link a call to
      // that line, so whether the subject has the edge is unanswerable here (#15). Forward mode still
      // scores these sites: a subject linking `resolve(...)` to an unrelated `resolve` is a real error.
      const memberAlias = (x) => {
        const m = new RegExp(`(?:^|[\\s,;])${reLit(name)}\\s*=\\s*(?:(require\\([^)]*\\))|([\\w$]+))\\s*\\.\\s*[\\w$]+\\s*[;,]?\\s*$`).exec(lineOf(x.file, x.line));
        return !!m && (!!m[1] || new RegExp(`\\b${reLit(m[2])}\\s*=\\s*require\\(`).test(fileText(x.file)));
      };
      if (on('skip-module-member-alias') && !PY && d.every(memberAlias) && skipUnit('skip-module-member-alias')) continue;
      if ((excluded(file) || d.every((x) => excluded(x.file))) && skipUnit('corpus-exclude')) continue;
      if (!decorator) considered++;
      units.push({ file, line, start, sym, kind, d, name, text, decorator });
    }
  }
  // SPEC §6: a subject edge carries at most one unit, so one edge can't be credited for two calls
  // (`r.name("a").name("b")`), nor a neighbouring call's edge for this one. Same-line edges are
  // assigned first, in SCIP document order, then edges up to 3 lines away, nearest first. Guessed
  // edges are never assigned: they only mark a unit found-heuristic-only.
  const used = new Set();
  // A `decorates` edge holds the decorator from either end.
  const asSource = (e) => ({ ...e, tname: e.ssimple, tkind: e.skind, tfile: e.sfile, tstart: e.sstart, tend: e.send });
  const holds = (u, e) => inTarget(u.d, e, u.name, u.sym);
  const hits = (u, k) => [
    ...(edgesAt.get(`${u.file}:${u.line + k}`) ?? []).filter((e) => holds(u, e)),
    ...(u.decorator ? (decoratesAt.get(`${u.file}:${u.line + k}`) ?? []).filter((e) => holds(u, e) || holds(u, asSource(e))) : []),
  ];
  const take = (u, k) => {
    const e = hits(u, k).find((x) => x.prov == null && !used.has(x));
    if (e && on('one-edge-per-unit')) used.add(e);
    return e;
  };
  for (const u of units) u.found = take(u, 0);
  for (const u of units) {
    if (u.found) continue;
    u.heuristic = hits(u, 0).some((e) => e.prov != null);
    if (!u.heuristic && on('found-other-line')) for (const k of [-1, 1, -2, 2, -3, 3]) if ((u.other = take(u, k))) break;
  }
  const decorators = { total: 0, causes: {} };
  for (const u of units) {
    const { file, line, start, sym, kind, d, name, text } = u;
    const site = { file, line };
    let cause;
    let tkind = null;
    let cg = null;
    if (u.found) cause = 'found';
    else if (u.heuristic) cause = 'found-heuristic-only';
    else if (u.other) cause = 'found-other-line';
    else {
      // An edge already credited to another call is not this call's wrong edge.
      const same = (edgesAt.get(`${file}:${line}`) ?? []).filter((e) => !used.has(e) && (namesIt(e.ref, name) || e.tname === name));
      const segsOf = (r) => (r ?? '').split(/\.|::/);
      const recv = same.find((e) => e.tname !== name && segsOf(e.ref).length > 1 && segsOf(e.ref).includes(e.tname));
      const wrong = same.find((e) => e !== recv);
      const tnode = (nodesByFile.get(d[0].file) ?? []).find((n) => n.name === name
        && d.some((x) => x.file === n.file && x.line <= n.e && x.line >= n.s - 2));
      if (recv) { cause = 'receiver-fallback'; cg = recv; }
      else if (wrong) { cause = 'wrong-edge'; cg = wrong; }
      else if (!indexed.has(file)) cause = 'file-not-indexed';
      else if (!indexed.has(d[0].file)) cause = 'target-file-not-indexed';
      else if (!tnode) cause = 'target-not-a-node';
      else if ((unresolvedAt.get(`${file}:${line}`) ?? []).some((r) => namesIt(r, name))) cause = 'unresolved-ref';
      else cause = 'no-ref';
      tkind = tnode?.kind ?? null;
    }
    if (u.decorator) {
      decorators.total++; decorators.causes[cause] = (decorators.causes[cause] ?? 0) + 1;
      if (ALLSITES) allSites.push({ site: `${file}:${line}`, name, key: `decorator|${cause}|${langOf(file)}|${kind}`, target: cg ? `${cg.tfile}:${cg.tqname}:${cg.tstart}` : null, scip: sym });
      continue;
    }
    const key = `missing|${cause}|${langOf(file)}|${kind}${on('decl-tag') && isDecl(sym, d) ? '@decl' : ''}${tkind ? `>${tkind}` : ''}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
    if (ALLSITES) allSites.push({ site: `${file}:${line}`, name, key, target: cg ? `${cg.tfile}:${cg.tqname}:${cg.tstart}` : null, scip: sym });
    if (cause === 'found') continue;
    (samples[key] ??= []).push({
      site: `${site.file}:${site.line}:${start}`, code: text.trim().slice(0, 140), ref: name,
      codegraph: cg ? `${cg.tkind} ${cg.tfile}:${cg.tqname}:${cg.tstart}` : cause, scip: sym, scipDef: d[0],
    });
  }
  console.log(`call-site references considered: ${considered}`);
  const pairs = pairTrack(units, skippedUnits);
  console.log(`function pairs: oracle ${pairs.oracle}, subject ${pairs.subject}, matched ${pairs.matched}`);
  report(buckets, samples, considered, 'call sites', { decorators, waterfall: waterfall(), pairs });
}

// SPEC §3 function-pair track: units are (C, D) sets. D is the unit's callee symbol; C is the
// innermost oracle definition whose range contains the site, else the file (SPEC §2).
// Oracle definition ranges ("containers"): a SCIP definition's `enclosing_range`; where the indexer
// gives none, in brace languages only, the body found by brace matching from the definition's name
// (scip-go 0.2.8 writes no ranges; scip-typescript 0.5.2 none for property functions such as
// `app.handle = function handle() {`). Locals are never containers, so a nested local function's
// calls belong to the function around it, on both sides. A range starts at the definition's own
// line: decorators and the lines above run in the enclosing scope (scip-python's enclosing_range
// includes a function's decorators). `callerRanges` records which source each range came from.
// A subject edge (any site line or none; guessed edges only for the guess-only count) is mapped by
// its endpoints: the caller node to the container it holds (by name, span as §2), else to the
// container around the node's start, else the file; the target node to the definition it holds
// (by name and span, nearest its start). A constructor stands for its class (§4) on both sides.
function pairTrack(units, skippedUnits) {
  const GO_LIKE = process.env.ORACLE_LANG === 'go' || process.env.ORACLE_LANG === 'jvm';
  const name = (sym) => {
    let n = defName(sym);
    if (!n) return null;
    n = n.replace(/^<(?:get|set)>/, '').replace(/^<(?:constructor|init)>$/, 'constructor');
    return sym.endsWith(':') ? n.replace(/\d+$/, '') : n;
  };
  const nameOk = (sym, n) => { const d = name(sym); return d === n || (CTOR.has(d) && CTOR.has(n)); };
  // A constructor's symbol (`X#__init__().`, TS `X#`<constructor>`().` before unctor) becomes its class's.
  const canon = (sym) => { const s = unctor(sym); if (!CTOR.has(name(s))) return s; const c = s.replace(/[^#]+$/, ''); return c.endsWith('#') ? c : s; };
  // Offsets of each line start, for the brace fallback.
  const starts = new Map();
  const lineAt = (file, off) => {
    if (!starts.has(file)) { const t = fileText(file); const a = [0]; for (let i = 0; i < t.length; i++) if (t[i] === '\n') a.push(i + 1); starts.set(file, a); }
    const a = starts.get(file); let lo = 0; let hi = a.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= off) lo = m; else hi = m - 1; }
    return lo + 1;
  };
  // The brace fallback for caller ranges (SPEC §2), kept to two narrow shapes so its lexing stays
  // small: a Go/JVM method (`func (r *R) Name(...) T {`) and a TS/JS `function` expression assigned to
  // a property or variable (`app.handle = function handle(req) {`, `text: function () {`). Arrow
  // functions take no fallback: scip-typescript gives function-valued variables an enclosing range,
  // and an arrow it gives none (a property value) has no caller of its own on either side.
  // Per-language lexing: comments, '"' and "'" strings, and backticks: a Go raw string (no escapes)
  // or a JS template (escapes, `${...}` nested). A JS regex literal opens only where a value can
  // start (after one of ( , = : [ ! & | ? { } ; or at a line's start), so a JSX closing tag `</li>` is
  // not read as one. Known gaps (review 2026-11-12, latent: no TSX or JVM repo in the corpus): a JSX
  // `/>` right after `}` (`b={c} />`) and an apostrophe in JSX text still lex as a regex or a string;
  // a regex after a keyword (`return /x/`) reads as division, which matters if it holds a brace, quote
  // or backtick; Java text blocks and Kotlin raw strings are not lexed; a `{` in a string or comment
  // inside a Go/JVM signature is taken as the body; a generic `function <T>(` or a comment between
  // `)` and `{` gives no range. Each wrong range moves calls to the enclosing caller or the file.
  const skipLex = (t, i, prev) => {
    const c = t[i];
    if (c === '/' && t[i + 1] === '/') { const j = t.indexOf('\n', i); return j < 0 ? t.length : j; }
    if (c === '/' && t[i + 1] === '*') { const j = t.indexOf('*/', i + 2); return j < 0 ? t.length : j + 2; }
    if (c === '"' || c === "'") {
      for (let j = i + 1; j < t.length; j++) { if (t[j] === '\\') j++; else if (t[j] === c) return j + 1; else if (t[j] === '\n') return j; }
      return t.length;
    }
    if (c === '`' && GO_LIKE) { const j = t.indexOf('`', i + 1); return j < 0 ? t.length : j + 1; }
    if (c === '`') {
      for (let j = i + 1; j < t.length;) {
        if (t[j] === '\\') j += 2; else if (t[j] === '`') return j + 1;
        else if (t[j] === '$' && t[j + 1] === '{') { const k = skipBlock(t, j + 1); if (k < 0) return t.length; j = k; } else j++;
      }
      return t.length;
    }
    if (c === '/' && !GO_LIKE && (prev === '' || prev === '\n' || '(,=:[!&|?{};'.includes(prev))) {
      let inClass = false;
      for (let j = i + 1; j < t.length; j++) {
        const ch = t[j];
        if (ch === '\\') j++;
        else if (ch === '\n') return i;
        else if (inClass) { if (ch === ']') inClass = false; } else if (ch === '[') inClass = true;
        else if (ch === '/') { j++; while (/[a-z]/i.test(t[j] ?? '')) j++; return j; }
      }
    }
    return i;
  };
  // t[open] is `{`: the index just after its matching `}`, or -1 when the file ends first.
  const skipBlock = (t, open) => {
    let d = 0; let prev = '';
    for (let j = open; j < t.length;) {
      const k = skipLex(t, j, prev); if (k !== j) { j = k; prev = 'x'; continue; }
      if (t[j] === '{') d++; else if (t[j] === '}' && --d === 0) return j + 1;
      if (t[j] === '\n') prev = '\n'; else if (!/\s/.test(t[j])) prev = t[j];
      j++;
    }
    return -1;
  };
  // Skip balanced (...) starting at t[i] === '('; returns the index after `)`, or -1.
  const skipParens = (t, i) => {
    let d = 0; let prev = '';
    for (let j = i; j < t.length;) {
      const k = skipLex(t, j, prev); if (k !== j) { j = k; prev = 'x'; continue; }
      if (t[j] === '(') d++; else if (t[j] === ')' && --d === 0) return j + 1;
      if (!/\s/.test(t[j])) prev = t[j];
      j++;
    }
    return -1;
  };
  // [first line, last line] of the body whose signature starts at `from`, or null.
  // TS/JS: `from` is just after `function`; an optional name, the parameter list, then `{` (a return
  // type annotation gives no range: its braces would be ambiguous). Go/JVM: `from` is just after the
  // method's name; the parameter list, then any result types up to the body's `{` on the same line
  // (a `{` right after `interface` or `struct` is a type in the signature, not the body; a newline
  // first means a declaration without a body, such as an interface method).
  const braceRange = (file, from) => {
    const t = fileText(file);
    let i = from;
    const ws = () => { while (i < t.length && /[ \t]/.test(t[i])) i++; };
    ws();
    if (!GO_LIKE) { const m = /^[\w$]*/.exec(t.slice(i, i + 200)); i += m[0].length; ws(); }
    if (GO_LIKE && t[i] === '[') { let d = 0; for (; i < t.length; i++) { if (t[i] === '[') d++; else if (t[i] === ']' && --d === 0) { i++; break; } } ws(); }
    if (t[i] !== '(') return null;
    i = skipParens(t, i); if (i < 0) return null;
    let open = -1;
    if (!GO_LIKE) { while (i < t.length && /\s/.test(t[i])) i++; if (t[i] === '{') open = i; } else {
      for (let n = 0; i < t.length && n < 400; n++) {
        const c = t[i];
        if (c === '\n') return null;
        if (c === '(') { i = skipParens(t, i); if (i < 0) return null; continue; }
        if (c === '{') {
          if (/\b(?:interface|struct)\s*$/.test(t.slice(Math.max(from, i - 20), i))) { const k = skipBlock(t, i); if (k < 0) return null; i = k; continue; }
          open = i; break;
        }
        i++;
      }
    }
    if (open < 0) return null;
    const close = skipBlock(t, open);
    return close < 0 ? null : [lineAt(file, open), lineAt(file, close - 1)];
  };
  const containers = new Map();
  const callerRanges = { enclosing: 0, braces: 0 };
  for (const doc of index.documents) {
    const file = doc.relative_path;
    for (const o of doc.occurrences ?? []) {
      if (!((o.symbol_roles ?? 0) & 1) || o.symbol.startsWith('local ')) continue;
      const kind = scipKind(o.symbol);
      if (!['method', 'type', 'term', 'meta'].includes(kind)) continue;
      const [l0, , a, b] = rangeOf(o);
      const er = o.enclosing_range;
      let range = null; let src = 'enclosing';
      if (er?.length) range = [er[0] + 1, (er.length === 4 ? er[2] : er[0]) + 1];
      else if (!PY) {
        const col = b === undefined ? a : b;
        const after = lineOf(file, l0 + 1).slice(col);
        lineAt(file, 0); // fills starts
        const base = (starts.get(file)[l0] ?? 0) + col;
        let from = -1;
        if (GO_LIKE ? kind === 'method' && /^\s*[([]/.test(after) : kind === 'term' || kind === 'meta') {
          const m = GO_LIKE ? [''] : /^\s*[=:]\s*(?:async\s+)?function\b\s*\*?/.exec(after);
          if (m) from = base + m[0].length;
        }
        if (from >= 0) { range = braceRange(file, from); src = 'braces'; }
      }
      if (!range) continue;
      callerRanges[src]++;
      (containers.get(file) ?? containers.set(file, []).get(file)).push({ sym: o.symbol, line: l0 + 1, s: l0 + 1, e: range[1] });
    }
  }
  const fileId = (f) => `file:${f}`;
  const callerAt = (file, line) => {
    let best = null;
    for (const c of containers.get(file) ?? []) if (c.s <= line && line <= c.e && (!best || c.e - c.s < best.e - best.s || (c.e - c.s === best.e - best.s && c.s > best.s))) best = c;
    return best ? best.sym : fileId(file);
  };
  const nearest = (list, start) => list.sort((x, y) => Math.abs(x.line - start) - Math.abs(y.line - start))[0];
  const mapCaller = (e) => {
    if (!scipFiles.has(e.sfile)) return null;
    if (e.skind === 'file' || e.skind === 'module') return fileId(e.sfile);
    const held = (containers.get(e.sfile) ?? []).filter((c) => c.line <= e.send && c.line >= e.sstart - 2 && nameOk(c.sym, e.ssimple));
    return held.length ? nearest(held, e.sstart).sym : callerAt(e.sfile, e.sstart);
  };
  const defsIn = new Map();
  for (const [sym, list] of defs) {
    if (sym.includes('#local ') || !['method', 'type', 'term'].includes(scipKind(sym))) continue;
    for (const x of list) (defsIn.get(x.file) ?? defsIn.set(x.file, []).get(x.file)).push({ sym, line: x.line });
  }
  const mapTarget = (e) => {
    if (!scipFiles.has(e.tfile)) return null;
    const held = (defsIn.get(e.tfile) ?? []).filter((x) => x.line <= e.tend && x.line >= e.tstart - 2 && nameOk(x.sym, e.tname));
    return held.length ? canon(nearest(held, e.tstart).sym) : null;
  };
  const key = (c, d) => `${c}\u0000${d}`;
  // SPEC §4: a pair only decorator sites carry is scored in the decorators column, never the headline.
  const oracle = new Map(); const decoratorOnly = new Map();
  let atFile = 0;
  for (const u of units) {
    const c = callerAt(u.file, u.line);
    if (!u.decorator && c.startsWith('file:')) atFile++;
    (u.decorator ? decoratorOnly : oracle).set(key(c, canon(u.sym)), [c, canon(u.sym)]);
  }
  for (const k of oracle.keys()) decoratorOnly.delete(k);
  const skippedPairs = new Set(skippedUnits.map((u) => key(callerAt(u.file, u.line), canon(u.sym))));
  const subject = new Map(); const guessed = new Set();
  const unmappedEdges = { caller: 0, target: 0 };
  // A subject pair the oracle lacks is judged only where the oracle answers for it: some oracle
  // reference (a project, library or defined local symbol) named like the callee lies inside C. Where
  // none does, the oracle is silent (dynamic dispatch, an unresolved import): the pair is unaligned,
  // as a call-site edge with no oracle reference is (SPEC §5). This needs no site line.
  const refNames = new Map();
  for (const [k, list] of refsAt) {
    const i = k.lastIndexOf(':'); const file = k.slice(0, i); const line = Number(k.slice(i + 1)); const text = lineOf(file, line);
    // A local the oracle never defines is no answer (forward `scip-local-undefined`, SPEC §5).
    for (const r of list) if (!r.symbol.includes('#local ') || defs.has(r.symbol)) (refNames.get(file) ?? refNames.set(file, []).get(file)).push({ line, name: text.slice(r.start, r.end) });
  }
  const rangesOf = new Map();
  for (const [file, list] of containers) for (const c of list) (rangesOf.get(c.sym) ?? rangesOf.set(c.sym, []).get(c.sym)).push({ file, s: c.s, e: c.e });
  const answers = (c, d, tname) => {
    const names = new Set([name(d), tname]);
    const where = c.startsWith('file:') ? [{ file: c.slice(5), s: 1, e: Infinity }] : rangesOf.get(c) ?? [];
    return where.some((w) => (refNames.get(w.file) ?? []).some((r) => r.line >= w.s && r.line <= w.e && names.has(r.name)));
  };
  const voiced = new Set();
  const skippedEdges = {};
  for (const e of allEdges) {
    if (!CALL_KINDS.has(e.kind) || !LANGS.has(e.slang) || excluded(e.sfile) || excluded(e.tfile)) continue;
    // As on the call-site track: a framework edge at its target's own declaration is no call.
    if (on('skip-framework-self-site') && e.line != null && e.sfile === e.tfile && e.line === e.tstart) { skippedEdges['skip-framework-self-site'] = (skippedEdges['skip-framework-self-site'] ?? 0) + 1; continue; }
    const c = mapCaller(e); const d = c && mapTarget(e);
    if (!c) { unmappedEdges.caller++; continue; }
    if (!d) { unmappedEdges.target++; continue; }
    if (e.prov != null) { guessed.add(key(c, d)); continue; }
    subject.set(key(c, d), [c, d]);
    if (!voiced.has(key(c, d)) && answers(c, d, e.tname)) voiced.add(key(c, d));
  }
  const matched = [...subject.keys()].filter((k) => oracle.has(k));
  const decorators = { total: decoratorOnly.size, found: [...decoratorOnly.keys()].filter((k) => subject.has(k)).length };
  const guessOnly = [...oracle.keys()].filter((k) => !subject.has(k) && guessed.has(k)).length;
  const only = [...subject.keys()].filter((k) => !oracle.has(k) && !decoratorOnly.has(k) && !skippedPairs.has(k));
  const skippedSubject = [...subject.keys()].filter((k) => !oracle.has(k) && !decoratorOnly.has(k) && skippedPairs.has(k)).length;
  const subjectOnly = { oracleDisagrees: only.filter((k) => voiced.has(k)).length, oracleSilent: only.filter((k) => !voiced.has(k)).length };
  const show = ([c, d]) => `${c.startsWith('file:') ? c : name(c)} -> ${name(d)}`;
  return { oracle: oracle.size, subject: subject.size, matched: matched.length, guessOnly, subjectOnly, skipped: skippedSubject, decorators, unmappedEdges, skippedEdges, callerRanges, unitsAtFileLevel: atFile,
    ...(ALLSITES ? { sets: { oracle: [...oracle.values()].map(show).sort(), subject: [...subject.values()].map(show).sort(), matched: matched.map((k) => show(subject.get(k))).sort(),
      disagrees: only.filter((k) => voiced.has(k)).map((k) => show(subject.get(k))).sort(), silent: only.filter((k) => !voiced.has(k)).map((k) => show(subject.get(k))).sort(),
      decorators: [...decoratorOnly.values()].map(show).sort() } } : {}) };
}
