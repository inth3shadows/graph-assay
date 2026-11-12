// Fixture expectations (schema/expect.v1.json): validate one, or every fixture in a tree.
//
//   node lib/expect.ts [dir ...]   checks every expect.json under the dirs (default: fixtures/)
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMain } from './main.ts';
import type { JoinedEdge } from './snapshot.ts';
import type { ExpectEdge, Snapshot } from './types.ts';

const EDGE_KEYS = new Set(['from', 'fromFile', 'kind', 'to', 'toLine']);

function checkEdge(e: any, where: string, p: string[]): void {
  if (!e || typeof e !== 'object') { p.push(`${where} not an object`); return; }
  for (const k of Object.keys(e)) if (!EDGE_KEYS.has(k)) p.push(`${where}.${k} unknown`);
  if (typeof e.from !== 'string' || !e.from) p.push(`${where}.from missing`);
  if (typeof e.kind !== 'string' || !e.kind) p.push(`${where}.kind missing`);
  if (typeof e.to !== 'string' || !/^[^:]+:.+/.test(e.to)) p.push(`${where}.to must be "<file>:<qualified name>"`);
  if (e.toLine !== undefined && !Number.isInteger(e.toLine)) p.push(`${where}.toLine not an integer`);
  if (e.fromFile !== undefined && typeof e.fromFile !== 'string') p.push(`${where}.fromFile not a string`);
}

/** Problems with one parsed expect.json (empty when valid). `x` is untrusted input, checked field by field. */
export function validateExpect(x: any): string[] {
  const p: string[] = [];
  if (!x || typeof x !== 'object') return ['not an object'];
  for (const k of Object.keys(x)) if (!['issue', 'wrong', 'right', 'note'].includes(k)) p.push(`${k} unknown`);
  if (!(x.issue === null || Number.isInteger(x.issue))) p.push('issue must be a number or null');
  for (const list of ['wrong', 'right']) {
    if (!Array.isArray(x[list])) { p.push(`${list} must be an array`); continue; }
    x[list].forEach((e, i) => checkEdge(e, `${list}[${i}]`, p));
  }
  if (Array.isArray(x.wrong) && Array.isArray(x.right) && !x.wrong.length && !x.right.length) p.push('wrong and right are both empty');
  return p;
}

// Tool-neutral endpoint matching. A name like `p::App::run` or `App::run(File,int)` is a container
// chain (signatures ignored). Two chains match when they are equal after dropping, from the longer
// one, leading segments that name no definition in the file: one subject writes the Java package
// (`p::App::run`), another does not (`App::run`), but `a::helper` (nested in function `a`) never
// matches a top-level `helper`.
const chain = (q: string) => q.split('::').map((x) => x.replace(/\(.*\)$/, ''));
export function chainMatch(a: string, b: string, defined: Set<string> = new Set()): boolean {
  let x = chain(a); let y = chain(b);
  if (x.length < y.length) [x, y] = [y, x];
  const extra = x.slice(0, x.length - y.length);
  return extra.every((s) => !defined.has(s)) && x.slice(extra.length).every((v, i) => v === y[i]);
}

/** Names of every definition (not file nodes) per file, for chainMatch. */
export function definedNames(snapshot: Snapshot): (file: string) => Set<string> {
  const m = new Map<string, Set<string>>();
  for (const n of snapshot.nodes) if (n.kind !== 'file') { if (!m.has(n.file)) m.set(n.file, new Set()); m.get(n.file).add(n.name); }
  return (file) => m.get(file) ?? new Set();
}

/** Is expectation edge `x` among `edges` (joinedEdges of `snapshot`)? `defined` = definedNames(snapshot). */
export function present(x: ExpectEdge, edges: JoinedEdge[], defined: (file: string) => Set<string>): boolean {
  const cut = x.to.indexOf(':');
  const toFile = x.to.slice(0, cut); const toName = x.to.slice(cut + 1);
  return edges.some((h) => h.kind === x.kind && h.tfile === toFile && chainMatch(h.tqname, toName, defined(h.tfile))
    && chainMatch(h.sname, x.from, defined(h.sfile)) && (!x.toLine || h.tstart === x.toLine) && (!x.fromFile || h.sfile === x.fromFile));
}

if (isMain(import.meta.url)) {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')];
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === 'expect.json') files.push(f); } };
  roots.forEach(walk);
  let bad = 0;
  for (const f of files.sort()) {
    let p;
    try { p = validateExpect(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (err) { p = [`unparsable: ${err.message}`]; }
    if (p.length) { bad++; console.log(`${f}: ${p.join('; ')}`); }
  }
  console.log(`${files.length} expect.json checked, ${bad} invalid`);
  process.exit(bad ? 1 : 0);
}
