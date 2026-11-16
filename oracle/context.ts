// One oracle run's inputs and the state every track shares: the options (from argv and ORACLE_*), the
// SCIP index with its definitions and references, the subject's snapshot and joined edges, source
// lines, the rule switch, and the skip counts. Nothing here runs at import time: createContext does
// the loading, so a track can be driven in-process from a test.
import { loadScip } from '../lib/scip.ts';
import { loadSnapshot, joinedEdges } from '../lib/snapshot.ts';
import * as codegraph from '../lib/subjects/codegraph.ts';
import { CTOR, defName, rangeOf, scipKind, segs } from './symbols.ts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Options {
  repo: string;
  scipFile: string;
  out?: string;
  /** ORACLE_LANG: python, go, jvm, ts, or unset (TS/JS). */
  lang?: string;
  /** ORACLE_MODE=missing: the inverse check; anything else is the forward check. */
  missing: boolean;
  redact: boolean;
  allSites: boolean;
  /** ORACLE_SHOW: top groups to print per candidate bucket. */
  show: number;
  /** ORACLE_DISABLE: rule names (the strings passed to on()) switched off. */
  disabled: Set<string>;
  /** ORACLE_EXCLUDE, raw: comma-separated vendored/generated path prefixes. */
  exclude: string;
  /** ORACLE_SNAPSHOT: the subject's graph as a snapshot v1 file, instead of <repo>/.codegraph. */
  snapshot?: string;
  /** ORACLE_SUBJECT_FAILED, set by run.sh (SPEC §8). */
  subjectFailed?: string;
}

export const LANG_VALUES = ['ts', 'python', 'go', 'jvm'];
/** Why `lang` is refused, or null for a known one (or unset). */
export const langError = (lang?: string) => lang && !LANG_VALUES.includes(lang)
  ? `ORACLE_LANG=${lang}: expected ts (or unset) for TS/JS, python, go or jvm` : null;

/** The options oracle.ts reads from its command line and environment. */
export function optionsFromEnv(argv: string[], env: typeof process.env): Options {
  const [repo, scipFile, out] = argv;
  const redact = env.ORACLE_REDACT === '1';
  return {
    repo, scipFile, out, lang: env.ORACLE_LANG, missing: env.ORACLE_MODE === 'missing', redact,
    // ORACLE_ALLSITES=1 (tests): out.json also lists every compared site with its bucket key, agreements included.
    allSites: env.ORACLE_ALLSITES === '1' && !redact,
    show: redact ? 0 : Number(env.ORACLE_SHOW ?? 0),
    disabled: new Set((env.ORACLE_DISABLE ?? '').split(',').filter(Boolean)),
    exclude: env.ORACLE_EXCLUDE ?? '',
    snapshot: env.ORACLE_SNAPSHOT || undefined,
    subjectFailed: env.ORACLE_SUBJECT_FAILED || undefined,
  };
}

// SPEC §2: columns in different encodings are never compared. The oracle's encoding per document is
// its SCIP `position_encoding` when set, else the indexer's (scip-typescript and scip-python write
// UTF-16 code units, scip-go UTF-8 bytes); unknown otherwise. A subject's is its snapshot capability.
const TOOL_ENCODING = { 'scip-typescript': 'utf16', 'scip-python': 'utf16', 'scip-go': 'utf8' };

export type Context = ReturnType<typeof createContext>;

export function createContext(opts: Options) {
  const { repo, lang } = opts;
  // An unknown language would otherwise read as TS/JS and filter every edge out (#30 review F5).
  if (langError(lang)) throw new Error(langError(lang));
  const on = (rule: string) => !opts.disabled.has(rule);
  // The SCIP index: binary .scip, or decoded .json. The subject's graph: a snapshot v1 file
  // (ORACLE_SNAPSHOT), or else exported from <repo>/.codegraph by the codegraph adapter.
  const index = loadScip(opts.scipFile);
  const snap = opts.snapshot ? loadSnapshot(opts.snapshot) : codegraph.snapshot(repo);
  const allEdges = joinedEdges(snap);
  // The innermost class whose span holds `line` in `file` (from spans, not qualified names).
  const classAround = (file, line) => snap.nodes.filter((n) => n.kind === 'class' && n.file === file && n.start <= line && line <= n.end)
    .sort((a, b) => b.start - a.start)[0] ?? null;

  // symbol -> definition sites, and file:line -> references on that line
  const defs = new Map<string, { file: string; line: number }[]>();
  const refsAt = new Map<string, { start: number; end: number; symbol: string }[]>();
  const scipFiles = new Set<string>();
  const docEncoding = new Map<string, string>();
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

  const fileTexts = new Map<string, string>();
  const fileText = (file: string) => {
    if (!fileTexts.has(file)) {
      try { fileTexts.set(file, fs.readFileSync(path.join(repo, file), 'utf8')); } catch { fileTexts.set(file, ''); }
    }
    return fileTexts.get(file);
  };
  const sources = new Map<string, string[]>();
  const lineOf = (file: string, line: number) => {
    if (!sources.has(file)) {
      try { sources.set(file, fs.readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/)); } catch { sources.set(file, []); }
    }
    return sources.get(file)[line - 1] ?? '';
  };

  // ORACLE_LANG=python / go / jvm for a scip-python / scip-go / scip-java index; TS/JS otherwise.
  const LANGS = new Set({ python: ['python'], jvm: ['java', 'kotlin'], go: ['go'] }[lang] ?? ['typescript', 'tsx', 'javascript', 'jsx']);
  const PY = lang === 'python';
  const GO_LIKE = lang === 'go' || lang === 'jvm';
  const CALL_KINDS = new Set(['calls', 'instantiates']);
  // SPEC §1, §7: the corpus entry's vendored/generated path prefixes (ORACLE_EXCLUDE, comma-separated)
  // are not project code: a call from or to them leaves every denominator, and the waterfall counts them.
  const EXCLUDE = on('corpus-exclude') ? opts.exclude.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean) : [];
  const excluded = (file: string) => EXCLUDE.some((p) => file === p || file.startsWith(`${p}/`));
  // SPEC §7 file steps: files in corpus (minus exclusions) -> in a supported language -> indexed by the
  // subject -> indexed by the oracle. A Git checkout lists tracked files; any other directory is walked
  // (dot entries, node_modules and symlinks left out).
  const SUPPORTED = { python: /\.pyi?$/, go: /\.go$/, jvm: /\.(java|kt)$/ }[lang] ?? /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const waterfall = () => {
    const all = repoFiles(repo); const kept = all.filter((f) => !excluded(f)); const supported = kept.filter((f) => SUPPORTED.test(f));
    const bySubject = new Set(snap.nodes.filter((n) => LANGS.has(n.language)).map((n) => n.file));
    return { filesInCorpus: kept.length, excluded: all.length - kept.length, supportedLanguage: supported.length,
      indexedBySubject: supported.filter((f) => bySubject.has(f)).length, indexedByOracle: supported.filter((f) => scipFiles.has(f)).length };
  };

  // Everything left out of the buckets, by reason, so the coverage waterfall (SPEC §7) is published
  // next to them: `skipped` in out.json. Bucket keys never include these.
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; return true; };
  // Every compared site, with its bucket key (ORACLE_ALLSITES).
  const allSites = [];

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

  // SPEC §5 `scip-name-mismatch`, Python: the oracle's symbol for a function, method or class the
  // project defines names another definition than the identifier it sits on, so it gives no answer
  // there. scip-python 0.6.8 resolves a name a package re-exports with a star import to another
  // definition of the module (`httpx.Response` -> `_models/Request#`). Not a mismatch: a name imported
  // under another (`from m import A as B`, through any chain of such renames). scip-python keeps an
  // assignment alias's own name (`B = A` -> `B.`) and gives an instantiation the class symbol (`Foo#`),
  // so neither needs an exemption. Go and TS/JS names legitimately differ from their symbols
  // (scip-typescript's `<get>x`, a default export), so the rule is Python's.
  let renamedFrom: Map<string, Set<string>> | null = null;
  const aliased = (name: string, token: string) => {
    if (!renamedFrom) {
      renamedFrom = new Map();
      for (const doc of index.documents) {
        for (const m of fileText(doc.relative_path).matchAll(/\b([\p{L}_][\p{L}\p{N}_]*)\s+as\s+([\p{L}_][\p{L}\p{N}_]*)\b/gu)) {
          (renamedFrom.get(m[2]) ?? renamedFrom.set(m[2], new Set()).get(m[2])).add(m[1]);
        }
      }
    }
    // Every name `token` was renamed from, transitively (`A as B`, then `B as C`: C comes from A).
    const seen = new Set([token]); const todo = [token];
    while (todo.length) for (const from of renamedFrom.get(todo.pop()) ?? []) if (!seen.has(from)) { if (from === name) return true; seen.add(from); todo.push(from); }
    return false;
  };
  const nameMismatch = (token: string, symbol: string) => {
    if (!PY || !on('scip-name-mismatch') || !symbol || symbol.includes('local ')) return false;
    // An identifier only: scip-python also writes a reference over a whole `real as r1` import clause.
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(token)) return false;
    // A function, method or class the project defines (a module symbol is an unresolved import,
    // `noise:scip-unresolved-module`; a library symbol is never a unit of the missing direction).
    if (!['method', 'type'].includes(scipKind(symbol)) || !defs.has(symbol)) return false;
    const n = defName(symbol);
    return !!n && n !== token && !aliased(n, token);
  };

  // SPEC §5 `skip-composite-literal`, Go: a composite literal (`T{...}`, `&T{...}`, `pkg.T{...}`,
  // `G[map[K]V]{...}`, and of a slice, array or map type `[]T{...}`) builds a value; it is not a call,
  // as a conversion `T(x)` is not (`skip-type-without-new`). The edge must target a type, and the SCIP
  // reference it sits on (nearest its column where the columns compare, as forward.ts picks) must be a
  // type followed by `{` after any type arguments, and not a function's result type (`func f() T {`).
  // scip-go writes UTF-8 byte columns, so a non-ASCII line's offsets are converted before slicing.
  const typeArgsEnd = (text: string, i: number) => {
    let depth = 0;
    for (let k = i; k < text.length; k++) {
      if (text[k] === '[') depth++;
      else if (text[k] === ']' && --depth === 0) return k + 1;
    }
    return -1;
  };
  const literalAfter = (text: string, i: number) => {
    let k = i;
    while (/\s/.test(text[k] ?? '')) k++;
    if (text[k] === '[') { k = typeArgsEnd(text, k); if (k < 0) return false; while (/\s/.test(text[k] ?? '')) k++; }
    return text[k] === '{';
  };
  const resultType = (before: string) => /\bfunc\b[^{]*\)[\s\w.*[\]]*$/.test(before);
  const compositeLiteral = (e: { sfile: string; line?: number | null; col?: number | null; ref?: string | null; tname: string; tkind?: string }) => {
    if (opts.lang !== 'go' || !on('skip-composite-literal') || e.line == null) return false;
    if (e.tkind === 'function' || e.tkind === 'method') return false;
    const parts = segs(e.ref ?? e.tname);
    const name = parts[parts.length - 1];
    const text = lineOf(e.sfile, e.line);
    const ascii = /^[\x00-\x7f]*$/.test(text);
    const utf8 = docEncoding.get(e.sfile) === 'utf8';
    const bytes = utf8 && !ascii ? Buffer.from(text, 'utf8') : null;
    const at = (n: number) => (bytes ? bytes.subarray(0, n).toString('utf8').length : n);
    let refs = (refsAt.get(`${e.sfile}:${e.line}`) ?? []).map((r) => ({ ...r, s: at(r.start), t: at(r.end) }))
      .filter((r) => text.slice(r.s, r.t) === name);
    if (e.col != null && refs.length > 1 && (subjectEncoding === docEncoding.get(e.sfile) || ascii)) {
      refs = [refs.sort((x, y) => Math.abs(x.start - e.col) - Math.abs(y.start - e.col))[0]];
    }
    return refs.some((r) => scipKind(r.symbol) === 'type' && literalAfter(text, r.t)
      && !resultType(text.slice(0, r.s).replace(/[\w]+\.\s*$/, '')));
  };

  return {
    opts, on, index, snap, allEdges, classAround, defs, refsAt, scipFiles, docEncoding, subjectEncoding,
    fileText, lineOf, LANGS, PY, GO_LIKE, CALL_KINDS, excluded, waterfall, skipped, skip, allSites, inTarget, nameMismatch, compositeLiteral,
  };
}

function repoFiles(dir: string) {
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
