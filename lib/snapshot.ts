// Snapshot v1 (schema/snapshot.v1.json): load, validate, and the joins scorers need.
import * as fs from 'node:fs';
import type { Snapshot } from './types.ts';

export const SNAPSHOT_SCHEMA: Snapshot['schema'] = 'graph-assay/snapshot@1';

const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const optStr = (v: unknown) => v === undefined || v === null || isStr(v);
const optInt = (v: unknown) => v === undefined || v === null || isInt(v);

/** One edge joined with its two nodes; see joinedEdges. */
export interface JoinedEdge {
  kind: string; line: number | null; col: number | null; ref: string | null; by: string | null; prov: string | null;
  sfile: string; sname: string; slang: string | null; skind: string;
  tkind: string; tname: string; tqname: string; tfile: string; tstart: number; tend: number;
  ssimple: string; sstart: number; send: number;
}

/** Returns a list of problems (empty when valid). Checks what scorers rely on, not every nicety.
 * `s` is untrusted input, so it is read as `any` and checked field by field. */
export function validateSnapshot(s: any): string[] {
  const p: string[] = [];
  if (!s || typeof s !== 'object') return ['not an object'];
  if (s.schema !== SNAPSHOT_SCHEMA) p.push(`schema is ${JSON.stringify(s.schema)}, expected ${SNAPSHOT_SCHEMA}`);
  if (!s.subject || !isStr(s.subject.name)) p.push('subject.name missing');
  if (s.subject?.adapterSha256 !== undefined && (typeof s.subject.adapterSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.subject.adapterSha256))) p.push('subject.adapterSha256 not a SHA-256');
  const c = s.capabilities ?? {};
  for (const k of ['siteLines', 'siteColumns', 'unresolved', 'provenance']) if (typeof c[k] !== 'boolean') p.push(`capabilities.${k} not boolean`);
  for (const k of ['files', 'nodes', 'edges', 'unresolved']) if (!Array.isArray(s[k])) p.push(`${k} not an array`);
  if (p.length) return p;
  const ids = new Set<string>();
  s.nodes.forEach((n, i) => {
    if (!isStr(n.id) || !isStr(n.kind) || !isStr(n.name) || !isStr(n.file) || !isInt(n.start) || !isInt(n.end) || !optStr(n.qname)) p.push(`nodes[${i}] malformed`);
    else if (ids.has(n.id)) p.push(`nodes[${i}] duplicate id ${n.id}`);
    else ids.add(n.id);
  });
  s.edges.forEach((e, i) => {
    if (!isStr(e.kind) || !isStr(e.src) || !isStr(e.dst) || !optInt(e.line) || !optInt(e.col) || !optStr(e.ref) || !optStr(e.provenance)) p.push(`edges[${i}] malformed`);
    else if (!ids.has(e.src) || !ids.has(e.dst)) p.push(`edges[${i}] endpoint not a node`);
    else if (c.siteLines && e.line === undefined) p.push(`edges[${i}] has no line but capabilities.siteLines is true`);
  });
  s.unresolved.forEach((u, i) => {
    if (!isStr(u.file) || !isInt(u.line) || !isStr(u.name) || !isStr(u.kind) || !optInt(u.col)) p.push(`unresolved[${i}] malformed`);
  });
  s.files.forEach((f, i) => { if (!isStr(f.path)) p.push(`files[${i}] malformed`); });
  return p.slice(0, 20);
}

export function loadSnapshot(file: string): Snapshot {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateSnapshot(s);
  if (problems.length) throw new Error(`invalid snapshot ${file}: ${problems.join('; ')}`);
  return s;
}

export function writeSnapshot(file: string, s: Snapshot): void {
  const problems = validateSnapshot(s);
  if (problems.length) throw new Error(`refusing to write an invalid snapshot: ${problems.join('; ')}`);
  fs.writeFileSync(file, JSON.stringify(s));
}

/**
 * Every edge joined with its two nodes, flattened the way the scorers read it:
 * {kind, line, col, ref, by, prov, sfile, sname (qname), slang, skind, tkind, tname, tqname, tfile, tstart, tend,
 * ssimple, sstart, send} (the source's own name and span, for identity that does not read names).
 */
export function joinedEdges(s: Snapshot): JoinedEdge[] {
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  return s.edges.map((e) => {
    const a = byId.get(e.src); const b = byId.get(e.dst);
    return {
      kind: e.kind, line: e.line ?? null, col: e.col ?? null, ref: e.ref ?? null, by: e.resolvedBy ?? null, prov: e.provenance ?? null,
      sfile: a.file, sname: a.qname ?? a.name, slang: a.language ?? null, skind: a.kind,
      tkind: b.kind, tname: b.name, tqname: b.qname ?? b.name, tfile: b.file, tstart: b.start, tend: b.end,
      ssimple: a.name, sstart: a.start, send: a.end,
    };
  });
}
