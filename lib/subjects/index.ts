// Subject registry: every tool graph-assay can measure. Each module exports name, defaultBuild(),
// index(dir, build, opts) -> {ok, status, signal, output, stdout, ms}, snapshot(dir, {build}) and
// version(build).
import * as codegraph from './codegraph.ts';
import * as cgr from './code-graph-rag.ts';
import * as cbm from './codebase-memory-mcp.ts';
import { isMain } from '../main.ts';

export const SUBJECTS = { codegraph, 'code-graph-rag': cgr, 'codebase-memory-mcp': cbm };

/** The subject called `name` (default codegraph); exits with usage on an unknown name. */
export function subject(name = 'codegraph') {
  const s = SUBJECTS[name];
  if (!s) { console.error(`unknown subject ${name}; subjects: ${Object.keys(SUBJECTS).join(', ')}`); process.exit(2); }
  return s;
}

/** `default` (or nothing) means the subject's own default build. */
export const buildFor = (s, b) => (!b || b === 'default' ? s.defaultBuild() : b);

// CLI, for shell scripts:
//   node lib/subjects/index.ts <subject> default-build
//   node lib/subjects/index.ts <subject> index <dir> <build>              exit status = the subject's
//   node lib/subjects/index.ts <subject> snapshot <dir> <out.json> <build>
if (isMain(import.meta.url)) {
  const [name, cmd, dir, a, b] = process.argv.slice(2);
  const s = subject(name);
  if (cmd === 'default-build') console.log(s.defaultBuild());
  else if (cmd === 'index' && dir && a) {
    const r = s.index(dir, a, { nice: process.env.CGQA_NICE === '1' });
    process.stdout.write(r.output);
    process.exit(r.ok ? 0 : (r.status || 1));
  } else if (cmd === 'snapshot' && dir && a) {
    const { writeSnapshot } = await import('../snapshot.ts');
    writeSnapshot(a, s.snapshot(dir, { build: b ?? null }));
  } else {
    console.error('usage: index.ts <subject> default-build | index <dir> <build> | snapshot <dir> <out.json> [build]');
    process.exit(2);
  }
}
