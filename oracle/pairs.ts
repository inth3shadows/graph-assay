// SPEC §3 function-pair track: units are (C, D) sets. D is the unit's callee symbol; C is the
// innermost oracle definition whose range contains the site, else the file (SPEC §2).
// Oracle definition ranges ("containers"): a SCIP definition's `enclosing_range`; where the indexer
// gives none, in brace languages only, the body found by brace matching from the definition's name
// (braces.ts; scip-go 0.2.8 writes no ranges; scip-typescript 0.5.2 none for property functions such
// as `app.handle = function handle() {`). Locals are never containers, so a nested local function's
// calls belong to the function around it, on both sides. A range starts at the definition's own
// line: decorators and the lines above run in the enclosing scope (scip-python's enclosing_range
// includes a function's decorators). `callerRanges` records which source each range came from.
// A subject edge (any site line or none; guessed edges only for the guess-only count) is mapped by
// its endpoints: the caller node to the container it holds (by name, span as §2), else to the
// container around the node's start, else the file; the target node to the definition it holds
// (by name and span, nearest its start). A constructor stands for its class (§4) on both sides.
import { braces } from './braces.ts';
import type { Context } from './context.ts';
import { CTOR, defName, rangeOf, scipKind, unctor } from './symbols.ts';

/** A call-site reference the missing check considered (or skipped), as the pair track reads it. */
export interface Unit { file: string; line: number; sym: string; decorator?: boolean }

export function pairTrack(ctx: Context, units: Unit[], skippedUnits: Unit[]) {
  const { on, index, defs, refsAt, scipFiles, fileText, lineOf, LANGS, PY, GO_LIKE, CALL_KINDS, excluded, allEdges } = ctx;
  const ALLSITES = ctx.opts.allSites;
  const name = (sym) => {
    let n = defName(sym);
    if (!n) return null;
    n = n.replace(/^<(?:get|set)>/, '').replace(/^<(?:constructor|init)>$/, 'constructor');
    return sym.endsWith(':') ? n.replace(/\d+$/, '') : n;
  };
  const nameOk = (sym, n) => { const d = name(sym); return d === n || (CTOR.has(d) && CTOR.has(n)); };
  // A constructor's symbol (`X#__init__().`, TS `X#`<constructor>`().` before unctor) becomes its class's.
  const canon = (sym) => { const s = unctor(sym); if (!CTOR.has(name(s))) return s; const c = s.replace(/[^#]+$/, ''); return c.endsWith('#') ? c : s; };
  const { braceRange, lineStarts } = braces(fileText, GO_LIKE);
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
        const base = (lineStarts(file)[l0] ?? 0) + col;
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
    const where = c.startsWith('file:') ? [{ file: c.slice(5), s: 1, e: Number.POSITIVE_INFINITY }] : rangesOf.get(c) ?? [];
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
