#!/usr/bin/env node
// SPEC §7: the TS/JS oracle covers every tracked TS/JS file, not only those the repo's tsconfig
// includes (ky's tsconfig.json covers source/, not test/ or test-d/). oracle/run.sh indexes a repo
// with a root tsconfig.json through the project this writes at the repo root (coverPath), extending
// that tsconfig (so its compiler options and paths apply) and listing every tracked TS/JS file, with
// allowJs and noEmit. scip-typescript takes a tsconfig file as a project. It must sit at the root:
// TypeScript looks up `types` and `@types` from the top config's directory, so a project elsewhere
// loses the repo's type packages (TS2688). The file is untracked; run.sh deletes it after indexing.
//
// Usage: node oracle/ts-cover.mjs <repo dir>   (writes coverPath(repo), prints its path)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMain } from '../lib/main.ts';

export const TS_JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Where the covering project goes: the repo root, under a name no repo uses. */
export const coverPath = (repo) => path.join(path.resolve(repo), 'tsconfig.graph-assay-oracle.json');

/** The covering project for `repo` (a Git checkout with a root tsconfig.json). */
export function coverTsconfig(repo) {
  const root = path.resolve(repo);
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (git.status !== 0) throw new Error(`git ls-files failed in ${root}: ${git.stderr.trim()}`);
  const files = git.stdout.split('\0').filter((f) => TS_JS.test(f)).sort().map((f) => `./${f}`);
  return { extends: './tsconfig.json', compilerOptions: { allowJs: true, noEmit: true }, files, include: [] };
}

if (isMain(import.meta.url)) {
  const [repo] = process.argv.slice(2);
  if (!repo) { console.error('usage: ts-cover.mjs <repo dir>'); process.exit(2); }
  const cfg = coverTsconfig(repo);
  fs.writeFileSync(coverPath(repo), `${JSON.stringify(cfg, null, 1)}\n`);
  console.error(`oracle project: ${cfg.files.length} tracked TS/JS files`);
  console.log(coverPath(repo));
}
