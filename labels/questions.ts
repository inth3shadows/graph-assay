// Labelling questions: one call site, a shuffled unattributed candidate list, and three fixed
// answers (outside the repo, local binding, cannot tell). Items are JSONL:
//   {id, lang, repo: <source dir>, site: {file, line, name}, candidates: [{file, line, kind, name}],
//    truth?: "<file>:<line>" | "outside" (X or Y counts) | "reject:<file>:<line>,..." (any answer but
//    those and cannot-tell), stratum?, meta?}
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config.ts';
import { FIXTURE_INSTALL } from '../lib/fixture-install.ts';

export const FIXED = { W: 'other-in-repo', X: 'external', Y: 'local', Z: 'cannot-tell' };
// Never shown to a labeller: subject outputs, answer keys, and agent instructions or tool configs.
const HIDE = new Set(['.git', '.codegraph', '.graph-assay', 'node_modules', FIXTURE_INSTALL, 'expect.json', 'case.json', 'snapshot.json', 'index.scip.json',
  'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.claude', '.codex', '.cursor']);

const key = (c) => `${c.file}:${c.line}`;
const order = (id, cands) => [...cands].sort((a, b) => createHash('sha256').update(`${id}|${key(a)}`).digest('hex')
  .localeCompare(createHash('sha256').update(`${id}|${key(b)}`).digest('hex')));

/** A labeller's copy of the item's repo: cached per source dir, with HIDE removed. */
export function repoCopy(src) {
  const name = createHash('sha256').update(path.resolve(src)).digest('hex').slice(0, 12);
  const dst = path.join(config.oracleCache, '..', 'labels', 'repos', `${path.basename(src)}-${name}`);
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, `${dst}.tmp`, { recursive: true, filter: (p) => !HIDE.has(path.basename(p)) });
    fs.renameSync(`${dst}.tmp`, dst);
  }
  return dst;
}

/** {prompt, letters: {A: "<file>:<line>", ..., X/Y/Z: fixed}} for one item. */
export function question(item, repoDir) {
  const lineText = (f, l) => { try { return fs.readFileSync(path.join(repoDir, f), 'utf8').split('\n')[l - 1]?.trim() ?? ''; } catch { return ''; } };
  // A..V for candidates: W..Z are the fixed answers. Item builders cap candidates at 22.
  if (item.candidates.length > 22) throw new Error(`${item.id}: ${item.candidates.length} candidates, at most 22`);
  const letters: Record<string, any> = {};
  const rows = order(item.id, item.candidates).map((c, i) => {
    const L = String.fromCharCode(65 + i);
    letters[L] = key(c);
    return `${L}) ${c.file}:${c.line}  ${lineText(c.file, c.line).slice(0, 140)}`;
  });
  for (const [L, v] of Object.entries<any>(FIXED)) letters[L] = v;
  const prompt = `You are labelling one call site in the repository in the current directory.

Call site: ${item.site.file}, line ${item.site.line}:
    ${lineText(item.site.file, item.site.line)}
The called name is \`${item.site.name}\`.

Question: when this line runs, which definition does the call to \`${item.site.name}\` execute?

${rows.join('\n')}
W) A definition in this repository that is not listed above (put its file:line in evidence)
X) Something outside this repository (a builtin, the standard library, or an installed package)
Y) A local binding: a parameter, local variable, or closure inside the calling function
Z) Cannot tell from the code

Read whatever you need; follow imports. Answer with only one line of JSON:
{"choice": "<letter>", "evidence": "<file:line that decides it>", "confidence": "high|medium|low"}`;
  return { prompt, letters };
}

/** Parse a labeller's reply into {choice, answer, evidence, confidence} or null. */
export function parseAnswer(text, letters) {
  // the last `{"choice"...}` object that parses (an evidence string may itself hold braces)
  const t = text ?? '';
  let j = null;
  for (let at = t.lastIndexOf('{'); at >= 0 && !j; at = at > 0 ? t.lastIndexOf('{', at - 1) : -1) {
    if (!/^\{\s*"choice"/.test(t.slice(at))) continue;
    for (let end = t.indexOf('}', at); end >= 0; end = t.indexOf('}', end + 1)) {
      try { j = JSON.parse(t.slice(at, end + 1)); break; } catch { /* keep extending */ }
    }
  }
  if (!j) return null;
  try {
    // Exactly one letter: 'cannot-tell' or 'none' must not be read as C or N.
    const choice = String(j.choice ?? '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(choice) || !letters[choice]) return null;
    return { choice, answer: letters[choice], evidence: j.evidence ?? null, confidence: j.confidence ?? null };
  } catch { return null; }
}

/** Is `answer` correct for `truth`? `outside` accepts external or local; `reject:` any answer but the listed ones. */
export const correct = (answer, truth) => {
  if (truth === 'outside') return answer === 'external' || answer === 'local';
  if (truth.startsWith('reject:')) return answer !== 'cannot-tell' && !truth.slice(7).split(',').includes(answer);
  return answer === truth;
};

// SPEC §4 overload set (Python): a `@overload` stub and its implementation are one target, so
// every answer naming a stub is read as the implementation it belongs to.
const sourceCache = new Map();
/** The item's repo checkout; a relative `repo` (committed snapshots, labels/data/) is under the oracle work dir. */
export const repoOf = (item) => path.resolve(config.work, item.repo);
const fileLines = (repo, f) => { const k = `${repo}|${f}`; if (!sourceCache.has(k)) { try { sourceCache.set(k, fs.readFileSync(path.join(repo, f), 'utf8').split('\n')); } catch { sourceCache.set(k, []); } } return sourceCache.get(k); };
export function unstub(item, ans) {
  const m = /^(.*):(\d+)$/.exec(ans ?? '');
  if (!m || item.lang !== 'python') return ans;
  if (item.stubs) return item.stubs[ans] ?? ans; // precomputed by labels/export.ts
  const lines = fileLines(repoOf(item), m[1]); let i = Number(m[2]) - 1;
  const isStub = (k) => { for (let j = k - 1; j >= 0 && /^\s*@/.test(lines[j]); j--) if (/^\s*@(?:[\w.]+\.)?overload\b/.test(lines[j])) return true; return false; };
  while (i >= 0 && /^\s*@/.test(lines[i])) i++; // a span may start at the decorator
  const name = /^\s*(?:async\s+)?def\s+(\w+)/.exec(lines[i] ?? '')?.[1];
  if (!name || !isStub(i)) return ans;
  for (let k = i + 1; k < lines.length; k++) {
    if (new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\b`).test(lines[k]) && !isStub(k)) {
      let s = k; while (s > 0 && /^\s*@/.test(lines[s - 1])) s--; // report at the implementation's span start
      const impl = item.candidates.find((c) => c.file === m[1] && c.line >= s + 1 && c.line <= k + 1);
      return impl ? `${impl.file}:${impl.line}` : `${m[1]}:${k + 1}`;
    }
  }
  return ans;
}

