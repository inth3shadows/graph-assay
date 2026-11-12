#!/usr/bin/env node
// Shadow diff of agent-facing output: index each pinned repo with two codegraph builds, ask both
// the same questions through the CLI (`explore`, `callers`, `callees`, `node`: the same text the MCP
// tools return), and diff the answers. Edge diffs say what changed in the graph; this says what an
// agent reading the answers would see change.
//
// Usage: node differential/shadow.mjs <old codegraph.js> <new codegraph.js> [questions.json] [--json out] [--show N]
//   questions.json defaults to differential/questions.json.
// Each question is asked twice per build; an answer that differs between the two asks is UNSTABLE
// (reported, never diffed). Verdicts: SAME, CHANGED (diff printed, N lines, default 40), UNSTABLE,
// FAILED. Exit 0 = all SAME, 1 = anything else, 2 = usage.
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { adapterHash } from '../lib/provenance.mjs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as codegraph from '../lib/subjects/codegraph.mjs';
import { isMain } from '../lib/main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const qa = path.join(here, '..');
const SKIP = new Set(['.codegraph', 'node_modules']);
const QUERY_ENV = { CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', NO_COLOR: '1' };

/** A repo name from the targets file (ORACLE_TARGETS, default oracle/targets.txt), or a path relative to the qa root. */
function resolveRepo(name) {
  const targets = process.env.ORACLE_TARGETS ?? path.join(qa, 'oracle/targets.txt');
  for (const line of fs.existsSync(targets) ? fs.readFileSync(targets, 'utf8').split('\n') : []) {
    const [n, src] = line.trim().split(/\s+/);
    if (n === name && !n.startsWith('#') && src) return src.replace(/^~(?=\/)/, os.homedir());
  }
  const dir = path.resolve(qa, name);
  if (!fs.existsSync(dir)) throw new Error(`repo ${name}: not in the targets file (${targets}) and not a path under ${qa}`);
  return dir;
}

/** Line-level diff (LCS), as '-'/'+'/' ' lines. Answers are small, so O(n*m) is fine. */
export function lineDiff(a, b) {
  const x = a.split('\n'); const y = b.split('\n');
  const L = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push(` ${x[i]}`); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`-${x[i++]}`); else out.push(`+${y[j++]}`);
  }
  while (i < x.length) out.push(`-${x[i++]}`);
  while (j < y.length) out.push(`+${y[j++]}`);
  return out;
}

/** Changed lines with `ctx` lines of context; '...' marks skipped runs. */
function hunks(diff, ctx = 2) {
  const keep = diff.map((l) => l[0] !== ' ');
  const out = [];
  let skipped = false;
  diff.forEach((l, k) => {
    const near = keep.slice(Math.max(0, k - ctx), k + ctx + 1).some(Boolean);
    if (near) { if (skipped) out.push('  ...'); out.push(l); skipped = false; } else skipped = true;
  });
  return out;
}

/** Index `src` with `build` in a fresh copy; returns {ask(q) -> text, done()} or {error}. */
function open(build, src) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-shadow-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-home-'));
  const done = () => { for (const d of [work, home]) fs.rmSync(d, { recursive: true, force: true }); };
  fs.cpSync(src, work, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) });
  const r = codegraph.index(work, build, { home, env: QUERY_ENV });
  if (!r.ok) { done(); return { error: `index failed (status ${r.status}): ${r.output.trim().split('\n').slice(-2).join(' | ')}` }; }
  const ask = (q) => {
    const a = codegraph.index(work, build, { home, env: QUERY_ENV, args: q, timeoutMs: 120_000 });
    // the work dir's path is the only per-run text an answer may carry
    return { ok: a.status === 0, text: a.stdout.split(work).join('<ROOT>').trimEnd(), err: a.output.trim().split('\n').slice(-2).join(' | ') };
  };
  return { ask, done };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1];
    if (v == null || v.startsWith('--')) { console.error(`${k} needs a value`); process.exit(2); }
    args.splice(i, 2); return v;
  };
  const jsonOut = opt('--json');
  const show = Number(opt('--show') ?? 40);
  const [oldB, newB, qfile = path.join(here, 'questions.json')] = args;
  if (!oldB || !newB) { console.error('usage: shadow.mjs <old codegraph.js> <new codegraph.js> [questions.json] [--json out] [--show N]'); process.exit(2); }
  const { questions } = JSON.parse(fs.readFileSync(qfile, 'utf8'));
  const byRepo = new Map();
  for (const q of questions) { if (!byRepo.has(q.repo)) byRepo.set(q.repo, []); byRepo.get(q.repo).push(q.q); }

  const results = [];
  const tally = {};
  for (const [repo, qs] of byRepo) {
    const src = resolveRepo(repo);
    const sides = [open(oldB, src), open(newB, src)];
    try {
      for (const q of qs) {
        const row = { repo, q };
        const err = sides.find((s) => s.error)?.error;
        if (err) { row.verdict = 'FAILED'; row.error = err; } else {
          const [a1, a2, b1, b2] = [sides[0].ask(q), sides[0].ask(q), sides[1].ask(q), sides[1].ask(q)];
          const bad = [a1, a2, b1, b2].find((x) => !x.ok);
          if (bad) { row.verdict = 'FAILED'; row.error = bad.err; } else if (a1.text !== a2.text || b1.text !== b2.text) row.verdict = 'UNSTABLE';
          else if (a1.text === b1.text) row.verdict = 'SAME';
          else { row.verdict = 'CHANGED'; row.diff = hunks(lineDiff(a1.text, b1.text)); }
          row.lines = [a1.text.split('\n').length, b1.text.split('\n').length];
        }
        tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
        results.push(row);
        console.log(`${row.verdict.padEnd(9)} ${repo}: ${q.join(' ')}${row.lines ? `  (${row.lines[0]} -> ${row.lines[1]} lines)` : ''}${row.error ? `  ${row.error}` : ''}`);
        for (const l of (row.diff ?? []).slice(0, show)) console.log(`    ${l}`);
        if ((row.diff ?? []).length > show) console.log(`    ... ${row.diff.length - show} more diff lines (--show N)`);
      }
    } finally {
      for (const s of sides) s.done?.();
    }
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ old: oldB, new: newB, adapterSha256: adapterHash('codegraph'), results }, null, 1));
  console.log(`\n${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  process.exit(Object.keys(tally).every((k) => k === 'SAME') ? 0 : 1);
}
