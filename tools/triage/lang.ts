// Which oracle indexer a fixture's sources go to (tools/triage/tag-fixtures.ts), or null when there is no single
// answer (#95). An allow-list, not a deny-list: a deny-list of other languages always misses one codegraph
// indexes, and a .sh helper or a .sql schema is no reason to untag a fixture.
// - Installed packages and codegraph's own data (node_modules.fixture/, node_modules/, .codegraph/) are not the
//   fixture's sources: ignored.
// - Neutral files (manifests, docs, lockfiles, scripts, schemas) say nothing about the language: ignored.
// - Every other file must be a Go, Python or TS/JS source. Any other file (a .java, a .vue, a Makefile) means
//   untagged: tagging from a TS/JS or Python file it also ships (a build script, a webpack config) would record
//   the wrong shapes, or none, and count it as "produces no shape" instead of untagged.
// - Sources in more than one oracle language also mean untagged: one SCIP index covers one language.
export const IGNORED_DIRS = new Set(['node_modules.fixture', 'node_modules', '.codegraph']);
const NEUTRAL = /\.(json|md|toml|ya?ml|lock|mod|sum|txt|sh|bash|sql|cfg|ini)$/i;
const ORACLE: [RegExp, 'go' | 'python' | 'ts'][] = [[/\.go$/i, 'go'], [/\.py[iw]?$/i, 'python'], [/\.[cm]?[jt]sx?$/i, 'ts']];

export const langOf = (files: string[]): 'go' | 'python' | 'ts' | null => {
  const langs = new Set<'go' | 'python' | 'ts'>();
  for (const f of files) {
    if (f.split(/[\\/]/).some((p) => IGNORED_DIRS.has(p)) || NEUTRAL.test(f)) continue;
    const hit = ORACLE.find(([re]) => re.test(f));
    if (!hit) return null;
    langs.add(hit[1]);
  }
  return langs.size === 1 ? [...langs][0] : null;
};
