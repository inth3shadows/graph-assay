// Which oracle indexer a fixture's sources go to (tools/triage/tag-fixtures.ts), or null when there is no single
// answer (#95). An allow-list, not a deny-list: a deny-list of other languages always misses one codegraph
// indexes, and a .sh helper or a .sql schema is no reason to untag a fixture.
// - Installed packages, codegraph's own data and local junk (node_modules.fixture/, node_modules/, __pycache__/,
//   and any dot entry: .codegraph/, .venv/, .git/, .DS_Store, .gitignore) are not the fixture's sources: ignored.
//   tag-fixtures still copies them, so the oracle would read sources in a dot directory; no fixture has one.
// - Neutral files (manifests, docs, lockfiles, scripts, schemas, web assets) say nothing about the language: ignored.
// - Every other file must be a Go, Python or TS/JS source, by the oracle's own filter (oracle/sources.ts, so
//   case-sensitive, and no .pyw). Any other file (a .java, a .vue, a Makefile) means untagged: tagging from a
//   TS/JS or Python file it also ships (a build script, a webpack config) would record the wrong shapes, or none,
//   and count it as "produces no shape" instead of untagged.
// - Sources in more than one oracle language also mean untagged: one SCIP index covers one language.
import { SOURCES } from '../../oracle/sources.ts';

const IGNORED_DIRS = new Set(['node_modules.fixture', 'node_modules', '__pycache__']);
export const ignored = (f: string) => f.split(/[\\/]/).some((p) => p.startsWith('.') || IGNORED_DIRS.has(p));
const NEUTRAL = /(\.(json|jsonc|md|toml|ya?ml|lock|mod|sum|work|txt|sh|bash|sql|cfg|ini|html?|css|map)|(^|[\\/])py\.typed)$/i;
const ORACLE: [RegExp, 'go' | 'python' | 'ts'][] = [[SOURCES.go, 'go'], [SOURCES.python, 'python'], [SOURCES.ts, 'ts']];

export const langOf = (files: string[]): 'go' | 'python' | 'ts' | null => {
  const langs = new Set<'go' | 'python' | 'ts'>();
  for (const f of files) {
    if (ignored(f) || NEUTRAL.test(f)) continue;
    const hit = ORACLE.find(([re]) => re.test(f));
    if (!hit) return null;
    langs.add(hit[1]);
  }
  return langs.size === 1 ? [...langs][0] : null;
};
