// Pure helpers over SCIP occurrences and symbols, shared by every oracle track. No state, no I/O.

/** An occurrence's [line, start, end] or [line, start, endLine, end]: older SCIP writers set `range`,
 * newer ones (scip-go 0.2.x) a TypedRange. */
export const rangeOf = (o): number[] => {
  if (o.range) return o.range;
  const t = o.TypedRange ?? o.typed_range ?? {};
  if (t.SingleLineRange) return [t.SingleLineRange.line ?? 0, t.SingleLineRange.start_character ?? 0, t.SingleLineRange.end_character ?? 0];
  const m = t.MultiLineRange ?? {};
  return [m.start_line ?? 0, m.start_character ?? 0, m.end_line ?? 0, m.end_character ?? 0];
};

/** A name as a literal inside a RegExp (`$http`, `a.b` would otherwise be metacharacters). */
export const reLit = (s: unknown) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The kind of a SCIP symbol, from its last descriptor's suffix. */
export const scipKind = (s: string | null | undefined) => !s ? '-' : s.includes('local ') ? 'local' : /\)\.$/.test(s) ? 'method'
  : /\([^()]*\)$/.test(s) ? 'parameter' : s.endsWith('#') ? 'type' : s.endsWith('.') ? 'term'
  : s.endsWith('/') ? 'namespace' : s.endsWith(':') ? 'meta' : s.endsWith(']') ? 'typeparam' : 'other';

/** A subject's reference text split into name segments (`a.b`, `A::b`, `A#b`). */
export const segs = (ref: string) => ref.split(/\.|::|#/).map((x) => x.replace(/[?!()]/g, '')).filter(Boolean);

/** The callee's own name: the last descriptor of its SCIP symbol (`pkg.models/Req#prepare().` ->
 * `prepare`); null for a local. */
export const defName = (sym: string | null | undefined): string | null => {
  if (!sym || sym.includes('local ')) return null;
  const m = sym.replace(/\([^()]*\)\.?$/, '').replace(/[#.:/]$/, '').match(/(`(?:[^`]|``)+`|[^\s`/#.:()[\]]+)$/);
  return m ? m[1].replace(/^`|`$/g, '') : null;
};

export const CTOR = new Set(['constructor', '__init__', '__new__']);

/** `new X()` references X's constructor, which has no definition of its own. */
export const unctor = (sym: string) => sym.replace(/`<constructor>`\(\)\.$/, '');
