// Every subject graph-assay measures, as data. No adapter is imported here, so the scorers
// (bench/tables.ts, bench/triage.ts) can use it and still read snapshots only. lib/subjects/index.ts
// registers the adapters under the same names (names-test.ts checks the two agree).
export const SUBJECT_NAMES = ['codegraph', 'code-graph-rag', 'codebase-memory-mcp', 'code-review-graph'];

/** Short tag in T1/T3 result file names: replay-<tag>.json, pycg-<tag>.json, meta-<tag>.json. */
export const TAG = { codegraph: 'cg', 'code-graph-rag': 'cgr', 'codebase-memory-mcp': 'cbm', 'code-review-graph': 'crg' };

/** Work-dir suffix, as oracle/run.sh names them: w-<name> for codegraph, w-<name>-<subject> otherwise. */
export const workSuffix = (subject: string) => (subject === 'codegraph' ? '' : `-${subject}`);

/** The run's codegraph work dir for any subject's work dir (strips a subject suffix). */
export function baseWorkDir(dir: string) {
  const s = SUBJECT_NAMES.find((n) => n !== 'codegraph' && dir.endsWith(workSuffix(n)));
  return s ? dir.slice(0, -workSuffix(s).length) : dir;
}

/** Parse `--subjects a,b`; exits with usage on an unknown name. */
export function parseSubjects(list: string) {
  const names = list.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !SUBJECT_NAMES.includes(n));
  if (bad.length || !names.length) { console.error(`unknown subject ${bad.join(', ') || '(none)'}; subjects: ${SUBJECT_NAMES.join(', ')}`); process.exit(2); }
  return names;
}
