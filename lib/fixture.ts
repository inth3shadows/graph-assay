// Keep evaluation answers out of a subject's input; score original and anonymous canary copies alike.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { joinedEdges } from './snapshot.ts';
import { definedNames, present as hasEdge } from './expect.ts';
import { placeFixtureInstall } from './fixture-install.ts';

export { FIXTURE_INSTALL, placeFixtureInstall } from './fixture-install.ts';

const HIDDEN = new Set(['expect.json', '.git', '.claude', '.codex', '.agents', 'AGENTS.md', 'CLAUDE.md', '.mcp.json']);
const comment = (file) => /\.pyi?$/.test(file) ? '#' : /\.(?:[cm]?[jt]sx?|go|java|rs|c|h|cpp|hpp|cs|php)$/.test(file) ? '//' : null;

/** Copies source only. Canary comments append after the original source, preserving its coordinates. */
export function copyFixture(source, target, { canary = false } = {}) {
  fs.cpSync(source, target, { recursive: true, filter: (file) => {
    const name = path.basename(file);
    if (HIDDEN.has(name) || name.startsWith('.codegraph') || /^\.env(?:\.|$)/.test(name)) return false;
    if (file === path.join(source, 'node_modules')) return false; // stray: the install is node_modules.fixture/
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('fixture input contains a symlink');
    return true;
  } });
  placeFixtureInstall(target);
  if (!canary) return null;
  const marker = `CGQA_CANARY_${randomBytes(16).toString('hex')}`;
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && comment(file)) {
        let suffix = `\n${comment(file)} ${marker}\n`;
        if (file.endsWith('.php')) {
          const text = fs.readFileSync(file, 'utf8');
          const opens = text.match(/<\?php\b/g) ?? []; const closes = text.match(/\?>/g) ?? [];
          // Support a single PHP block, open at EOF or ending in ?>. Do not guess the state of
          // mixed templates or tag-like strings: an explicit error is safer than injecting text.
          if (opens.length !== 1 || !/^(?:#![^\n]*\n)?\s*<\?php\b/.test(text) || closes.length > 1
            || (closes.length && !/\?>\s*$/.test(text))) throw new Error('canary cannot safely annotate mixed PHP templates');
          if (closes.length) suffix = `\n<?php /* ${marker} */ ?>\n`;
        }
        fs.appendFileSync(file, suffix);
        files.push(path.relative(target, file).split(path.sep).join('/'));
      }
    }
  };
  visit(target);
  if (!files.length) throw new Error('canary has no supported source files');
  return { marker, files: files.sort() };
}

export function markerLeaks(snapshot, marker) {
  return [...snapshot.nodes.flatMap((n) => [n.name, n.qname]), ...snapshot.edges.map((e) => e.ref),
    ...snapshot.unresolved.map((u) => u.name)].filter((value) => typeof value === 'string' && value.includes(marker));
}

const show = (e) => `${e.from} -${e.kind}-> ${e.to}${e.toLine ? `@${e.toLine}` : ''}`;
/** Same endpoint/provenance rules for ordinary replay and its canary, with no subject-specific names. */
export function scoreFixture(snapshot, expect) {
  const have = joinedEdges(snapshot); const defined = definedNames(snapshot);
  const present = (x) => hasEdge(x, have, defined);
  const asserted = have.filter((h) => h.prov === null);
  const wrong = expect.wrong.filter((x) => hasEdge(x, asserted, defined));
  const guessed = expect.wrong.filter((x) => !wrong.includes(x) && present(x));
  // SPEC §4: a guess never satisfies a `right` edge; one only a guess holds is missing, listed in guessOnly.
  const missing = expect.right.filter((x) => !hasEdge(x, asserted, defined));
  const guessOnly = missing.filter((x) => present(x));
  // FIXED means the wrong edge is gone from a graph that holds its caller: an empty or partial index
  // (a failed parse, a subject missing a language) must not read as a fix.
  const names = new Set(snapshot.nodes.map((n) => n.name));
  const lastName = (q) => q.split('::').pop().replace(/\(.*\)$/, '');
  // A caller also counts when a node that is not a file has exactly `from` as its qualified name (its
  // name when it has none), in `fromFile` when the fixture names one. A codegraph route node is named
  // `GET /api/...`; only its qualified name is the fixture's `from` (#29). This path is exact and skips
  // file nodes, which exist even when their file produced nothing. The name check above it is older
  // and looser (any file, last segment only, file nodes included); #34 tracks unifying the two.
  const callers = new Set(snapshot.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.file}\0${n.qname ?? n.name}`));
  const callerQnames = new Set(snapshot.nodes.filter((n) => n.kind !== 'file').map((n) => n.qname ?? n.name));
  const hasCaller = (x) => names.has(lastName(x.from)) || (x.fromFile ? callers.has(`${x.fromFile}\0${x.from}`) : callerQnames.has(x.from));
  const absent = [...new Set([...expect.wrong, ...expect.right].filter((x) => !hasCaller(x)).map((x) => x.from))];
  let verdict = wrong.length || (!expect.wrong.length && missing.length) ? 'BROKEN' : guessed.length ? 'GUESSED' : missing.length ? 'CHANGED' : 'FIXED';
  if (verdict === 'FIXED' && absent.length) verdict = 'CHANGED';
  const detail = verdict === 'CHANGED' && !missing.length ? `caller not in graph: ${absent.join(', ')}` : wrong.length ? wrong.map(show).join('; ') : guessed.length ? `guessed ${guessed.map(show).join('; ')}` : missing.length ? `missing ${missing.map(show).join('; ')}${guessOnly.length ? ` (only guessed: ${guessOnly.map(show).join('; ')})` : ''}` : '';
  return { verdict, detail, guessOnly: guessOnly.map(show) };
}
