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

/** Brace-matching over the files `fileText` returns, lexed as Go/JVM (`goLike`) or TS/JS. */
export function braces(fileText: (file: string) => string, goLike: boolean) {
  const GO_LIKE = goLike;
  // Offsets of each line start.
  const starts = new Map<string, number[]>();
  const lineStarts = (file: string) => {
    if (!starts.has(file)) { const t = fileText(file); const a = [0]; for (let i = 0; i < t.length; i++) if (t[i] === '\n') a.push(i + 1); starts.set(file, a); }
    return starts.get(file);
  };
  const lineAt = (file: string, off: number) => {
    const a = lineStarts(file); let lo = 0; let hi = a.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= off) lo = m; else hi = m - 1; }
    return lo + 1;
  };
  const skipLex = (t: string, i: number, prev: string) => {
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
  const skipBlock = (t: string, open: number) => {
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
  const skipParens = (t: string, i: number) => {
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
  const braceRange = (file: string, from: number): [number, number] | null => {
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
  return { braceRange, lineStarts };
}
