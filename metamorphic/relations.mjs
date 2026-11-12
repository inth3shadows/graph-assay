// Shared source-derived transformations; neither the challenge nor its identity reads a subject graph.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
export const SKIP = new Set(['.git', '.codegraph', '.graph-assay', 'node_modules', 'expect.json', '.claude', '.codex', '.agents', 'AGENTS.md', 'CLAUDE.md', '.mcp.json']);
export const DECOY_DIR = 'zz_cg_decoy';
const SRC = /\.(py|pyi|[cm]?[jt]sx?)$/;
const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => {
  const r = path.join(rel, d.name);
  if (d.isDirectory()) return SKIP.has(d.name) ? [] : walk(dir, r);
  return d.isFile() && SRC.test(d.name) ? [r] : [];
});

const PY_KW = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print'.split(' '));
const JS_KW = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await constructor arguments eval'.split(' '));
const TS_CLASS_KW = new Set([...JS_KW, 'any', 'unknown', 'never', 'number', 'bigint', 'boolean', 'string', 'symbol', 'object', 'undefined', 'intrinsic', 'globalThis']);
const ident = (n) => /^[A-Za-z_$][\w$]*$/.test(n);

export function writeDecoys(dir) {
  // A lexical call/class inventory is deliberately independent of either subject's extraction.
  const fn = new Set(); const cls = new Set(); const meth = new Set();
  const files = walk(dir);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) { fn.add(match[1]); meth.add(match[1]); }
    for (const match of text.matchAll(/\b(?:class|new)\s+([A-Za-z_$][\w$]*)/g)) cls.add(match[1]);
  }
  const out = path.join(dir, DECOY_DIR);
  fs.mkdirSync(out);
  const py = files.some((f) => /\.pyi?$/.test(f));
  const ts = files.some((f) => /\.[cm]?tsx?$/.test(f));
  const js = files.some((f) => /\.[cm]?jsx?$/.test(f));
  const pick = (set, kw) => [...set].filter((n) => ident(n) && (kw !== PY_KW || /^[A-Za-z_]\w*$/.test(n)) && !kw.has(n) && !n.startsWith('__')).sort();
  let n = 0;
  if (py) {
    const f = pick(fn, PY_KW); const c = pick(cls, PY_KW); const m = pick(meth, PY_KW);
    fs.writeFileSync(path.join(out, 'decoy_fns.py'), f.map((x) => `def ${x}(*args, **kwargs):\n    return None\n`).join('\n'));
    fs.writeFileSync(path.join(out, 'decoy_classes.py'), c.map((x) => `class ${x}:\n    pass\n`).join('\n'));
    fs.writeFileSync(path.join(out, 'decoy_methods.py'), `class CgDecoyHost:\n${m.map((x) => `    def ${x}(self, *args, **kwargs):\n        return None\n`).join('\n')}    pass\n`);
    n += f.length + c.length + m.length;
  }
  for (const [on, ext] of [[ts, 'ts'], [js, 'js']]) {
    if (!on) continue;
    const f = pick(fn, JS_KW); const c = pick(cls, ext === 'ts' ? TS_CLASS_KW : JS_KW); const m = pick(meth, JS_KW);
    const ty = ext === 'ts' ? ': unknown[]' : '';
    fs.writeFileSync(path.join(out, `decoy-fns.${ext}`), f.map((x) => `export function ${x}(...args${ty}) { return args; }\n`).join(''));
    fs.writeFileSync(path.join(out, `decoy-classes.${ext}`), c.map((x) => `export class ${x} {}\n`).join(''));
    fs.writeFileSync(path.join(out, `decoy-methods.${ext}`), `export class CgDecoyHost {\n${m.map((x) => `  ${x}(...args${ty}) { return args; }\n`).join('')}}\n`);
    n += f.length + c.length + m.length;
  }
  return n;
}

export function shiftFiles(dir) {
  const shifted = new Set();
  for (const rel of walk(dir)) {
    shifted.add(rel.split(path.sep).join('/'));
    const p = path.join(dir, rel);
    const raw = fs.readFileSync(p, 'utf8');
    // A byte-order mark must stay the first character; blank lines go after it.
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const lines = raw.slice(bom.length).split('\n');
    // Keep a shebang and a Python coding line where they must be (lines 1-2).
    let at = 0;
    while (at < 2 && at < lines.length && (/^#!/.test(lines[at]) || /^#.*coding[:=]/.test(lines[at]))) at++;
    if (at > 0) { fs.writeFileSync(p, bom + lines.slice(0, at).join('\n') + '\n\n\n\n' + lines.slice(at).join('\n')); continue; }
    fs.writeFileSync(p, `${bom}\n\n\n${lines.join('\n')}`);
  }
  return shifted;
}
// Every Python / TS / JS file gets the 3 lines, so an edge from one moves by 3 (other languages'
// files are left alone and their edges must not move at all).
export const SHIFT = 3;

const SOURCE = /\.(?:pyi?|[cm]?[jt]sx?|go|php|java|rs|c|h|cc|cpp|hpp|cs|rb|kt|scala|lua|sh|swift)$/;
function sourceHash(dir) {
  const hash = createHash('sha256');
  const visit = (rel = '') => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      if (SKIP.has(e.name) || /^\.env(?:\.|$)/.test(e.name)) continue;
      const f = path.join(rel, e.name);
      if (e.isDirectory()) visit(f);
      else if (e.isFile() && SOURCE.test(e.name)) {
        const content = fs.readFileSync(path.join(dir, f));
        hash.update(`${f.split(path.sep).join('/')}\0${content.length}\0`).update(content);
      }
    }
  };
  visit(); return hash.digest('hex');
}
export const RELATIONS = ['decoy', 'shift', 'repeat'];
export function applyRelation(dir, relation) {
  if (!RELATIONS.includes(relation)) throw new Error(`unknown relation ${relation}`);
  const before = sourceHash(dir); const result = {};
  if (relation === 'decoy') {
    result.decoys = writeDecoys(dir);
    if (!result.decoys) Object.assign(result, { notApplicable: true, reason: 'no supported source call/class names' });
  } else if (relation === 'shift') {
    result.shiftedFiles = [...shiftFiles(dir)].sort();
    if (!result.shiftedFiles.length) Object.assign(result, { notApplicable: true, reason: 'no supported files to shift' });
  }
  // Include actual transformed bytes and the transform implementation, not a subject's output.
  result.challengeSha256 = createHash('sha256').update(`${relation}\0${before}\0${sourceHash(dir)}\0`)
    .update(fs.readFileSync(new URL(import.meta.url))).digest('hex');
  return result;
}
