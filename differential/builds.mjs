#!/usr/bin/env node
// Build edge diff: index each repo with two codegraph builds and diff the graphs canonically
// (multisets of files, nodes, joined edges with every column, unresolved refs; see modes.mjs).
// Repeated edges count and every column is compared.
//
// Usage: node differential/builds.mjs <old codegraph.js> <new codegraph.js> <dir ...> [--json out] [--md out] [--show N]
//        node differential/builds.mjs --fetch <dest dir> [corpus file] [split]   clone the corpus (corpus/v1.txt,
//          split dev by default; `all` for every repo) at its pins
// Exit 0 = every repo the same graph, 1 = some differ or failed, 2 = usage.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { adapterHash } from '../lib/provenance.mjs';
import { placeFixtureInstall } from '../lib/fixture-install.mjs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as codegraph from '../lib/subjects/codegraph.mjs';
import { canonical, diffCanonical } from './modes.mjs';
import { isMain } from '../lib/main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['.codegraph', 'node_modules']);

export const CORPUS = path.join(here, '..', 'corpus', 'v1.txt');
/** The corpus file's repos: {name, url, sha, language, license, split, category, setup, exclude}, optionally
 * one split. `exclude` is the list of vendored/generated path prefixes (SPEC §1); a missing or `-` column is []. */
export function readRepos(file = CORPUS, split = null) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [name, url, sha, language, license, sp, category, setup, ex] = l.split(/\s+/);
      return { name, url, sha, language, license, split: sp, category, setup, exclude: !ex || ex === '-' ? [] : ex.split(',').filter(Boolean) }; })
    .filter((r) => !split || split === 'all' || r.split === split);
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Clone each repo at its pin into dest/<name> (reused when already at the pin). */
export function fetchRepos(dest, repos) {
  fs.mkdirSync(dest, { recursive: true });
  return repos.map((r) => {
    const dir = path.join(dest, r.name);
    if (!fs.existsSync(path.join(dir, '.git'))) { fs.mkdirSync(dir, { recursive: true }); git(['init', '-q'], dir); git(['remote', 'add', 'origin', r.url], dir); }
    if (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim() !== r.sha) {
      git(['fetch', '-q', '--depth', '1', 'origin', r.sha], dir);
      git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
    }
    return dir;
  });
}

function graph(build, src) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-builds-'));
  try {
    fs.cpSync(src, work, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) });
    placeFixtureInstall(work);
    const r = codegraph.index(work, build);
    if (!r.ok) return { error: `status ${r.status}${r.signal ? ` ${r.signal}` : ''}: ${r.output.trim().split('\n').slice(-2).join(' | ')}`, ms: r.ms };
    const s = codegraph.snapshot(work);
    return { canon: canonical(s), ms: r.ms, size: { nodes: s.nodes.length, edges: s.edges.length, unresolved: s.unresolved.length } };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const lost = (d) => d.reduce((n, x) => n + Math.max(0, x.a - x.b), 0);
const gained = (d) => d.reduce((n, x) => n + Math.max(0, x.b - x.a), 0);

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--fetch') {
    if (!args[1]) { console.error('usage: builds.mjs --fetch <dest dir> [corpus file] [split]'); process.exit(2); }
    for (const d of fetchRepos(args[1], readRepos(args[2] || CORPUS, args[3] ?? 'dev'))) console.log(d);
    process.exit(0);
  }
  const opt = (k) => {
    const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1];
    if (v == null || v.startsWith('--')) { console.error(`${k} needs a value`); process.exit(2); }
    args.splice(i, 2); return v;
  };
  const jsonOut = opt('--json'); const mdOut = opt('--md'); const show = Number(opt('--show') ?? 10);
  const [oldB, newB, ...dirs] = args;
  if (!oldB || !newB || !dirs.length) { console.error('usage: builds.mjs <old codegraph.js> <new codegraph.js> <dir ...> [--json out] [--md out] [--show N]'); process.exit(2); }

  const results = [];
  for (const dir of dirs) {
    const a = graph(oldB, dir); const b = graph(newB, dir);
    const row = { repo: path.basename(path.resolve(dir)), old: a.size ?? null, new: b.size ?? null, ms: [a.ms, b.ms] };
    if (a.error || b.error) { row.verdict = 'FAILED'; row.error = a.error ? `old: ${a.error}` : `new: ${b.error}`; } else {
      row.diff = diffCanonical(a.canon, b.canon);
      row.verdict = Object.keys(row.diff).length ? 'DIFFER' : 'SAME';
    }
    results.push(row);
    const counts = Object.entries(row.diff ?? {}).map(([c, d]) => `${c} -${lost(d)} +${gained(d)}`).join(', ');
    console.log(`${row.verdict.padEnd(7)} ${row.repo.padEnd(12)} ${row.old ? `${row.old.edges} -> ${row.new.edges} edges` : ''}  ${counts}${row.error ? row.error : ''}`);
    for (const [c, d] of Object.entries(row.diff ?? {})) for (const x of d.slice(0, show)) console.log(`          ${c} ${x.a} -> ${x.b}  ${x.key}`);
  }

  if (mdOut) {
    const md = ['## codegraph build edge diff', '', `old \`${codegraph.version(oldB) ?? oldB}\` → new \`${codegraph.version(newB) ?? newB}\``, '',
      '| repo | verdict | edges old → new | edges −/+ | nodes −/+ | unresolved −/+ |', '|---|---|---|---|---|---|'];
    const pm = (r, c) => (r.diff?.[c] ? `−${lost(r.diff[c])} / +${gained(r.diff[c])}` : '0');
    for (const r of results) md.push(`| ${r.repo} | ${r.verdict}${r.error ? `: ${r.error.replaceAll('|', '/')}` : ''} | ${r.old ? `${r.old.edges} → ${r.new.edges}` : ''} | ${pm(r, 'edges')} | ${pm(r, 'nodes')} | ${pm(r, 'unresolved')} |`);
    for (const r of results.filter((x) => x.diff?.edges)) {
      md.push('', `<details><summary>${r.repo}: first ${Math.min(show, r.diff.edges.length)} of ${r.diff.edges.length} differing edges (old count → new count)</summary>`, '', '```');
      // joined edge columns: kind, line, col, ref, resolvedBy, provenance, src file/name/lang/kind, dst kind/name/qname/file/start/end
      for (const x of r.diff.edges.slice(0, show)) md.push(`${x.a} -> ${x.b}  ${x.key}`);
      md.push('```', '', '</details>');
    }
    fs.writeFileSync(mdOut, `${md.join('\n')}\n`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ old: oldB, new: newB, adapterSha256: adapterHash('codegraph'), results }, null, 1));
  process.exit(results.every((r) => r.verdict === 'SAME') ? 0 : 1);
}
