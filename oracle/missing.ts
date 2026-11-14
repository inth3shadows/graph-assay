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
import type { Context } from './context.ts';
import { pairTrack } from './pairs.ts';
import type { Tally } from './report.ts';
import { rangeOf, reLit, scipKind, unctor } from './symbols.ts';

export function missing(ctx: Context): Tally {
  const { on, index, snap, allEdges, defs, fileText, lineOf, LANGS, PY, CALL_KINDS, excluded, skip, allSites, inTarget } = ctx;
  const ALLSITES = ctx.opts.allSites;
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
  const buckets: Record<string, number> = {};
  const samples: Record<string, any[]> = {};
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
  const pairs = pairTrack(ctx, units, skippedUnits);
  console.log(`function pairs: oracle ${pairs.oracle}, subject ${pairs.subject}, matched ${pairs.matched}`);
  return { buckets, samples, total: considered, unit: 'call sites', extra: { decorators, waterfall: ctx.waterfall(), pairs } };
}
