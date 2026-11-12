// The type check `graph-assay check` runs: tsc over tsconfig.json with the pinned dev dependencies.
// typescript is a dev dependency, so a missing or stale install fails the check; it never skips.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NPM_CI = 'run `npm ci --ignore-scripts`';
// One diagnostic per match: `file(line,col): error TSn:` or, for a global (option) error, `error TSn:`.
const DIAGNOSTIC = /^(?:(.+)\(\d+,\d+\): )?error TS\d+:/gm;

/** Count tsc's `--pretty false` output. Diagnostics in tsconfig.json or without a file are config errors.
 * @param {string} out tsc stdout + stderr
 * @param {{ status: number | null, signal?: string | null, error?: Error }} r
 * @returns {{ ok: boolean, summary: string }} */
export function summarize(out, r) {
  if (r.status === 0 && !r.error) return { ok: true, summary: 'tsc -p . (0 errors)' };
  let type = 0; let config = 0;
  for (const m of out.matchAll(DIAGNOSTIC)) {
    if (!m[1] || path.basename(m[1]) === 'tsconfig.json') config++; else type++;
  }
  if (!type && !config) {
    const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    return { ok: false, summary: `tsc failed (${why}) with no diagnostics` };
  }
  const parts = [type && `${type} type error${type === 1 ? '' : 's'}`, config && `${config} config error${config === 1 ? '' : 's'}`];
  return { ok: false, summary: `${parts.filter(Boolean).join(', ')} (tsc -p .)` };
}

/** Installed packages whose version differs from package-lock.json (missing ones too).
 * @param {{ packages?: Record<string, { version?: string, optional?: boolean }> }} lock
 * @param {(dir: string) => string | null} installedVersion version in `<dir>/package.json`, or null
 * @returns {string[]} */
export function staleInstall(lock, installedVersion) {
  const stale = [];
  for (const [dir, { version, optional }] of Object.entries(lock.packages ?? {})) {
    if (!dir) continue; // the root project
    const have = installedVersion(dir);
    if (have === null && optional) continue; // optional packages install only on matching platforms
    if (have !== version) stale.push(`${dir.replace(/^node_modules\//, '')} ${have ?? 'missing'} (lockfile ${version})`);
  }
  return stale;
}

/** Run the type check in `root`. Returns the lines to print, last one the verdict.
 * @param {string} root
 * @returns {{ ok: boolean, lines: string[] }} */
export function typecheck(root) {
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(tsc)) return { ok: false, lines: [`FAIL  typecheck: node_modules/typescript is missing; ${NPM_CI} first`] };
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const stale = staleInstall(lock, (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
  });
  if (stale.length) return { ok: false, lines: [`FAIL  typecheck: node_modules does not match package-lock.json (${stale.join('; ')}); ${NPM_CI}`] };
  // --noEmit on the command line too: an unparseable tsconfig.json makes tsc fall back to defaults and emit .js.
  const r = spawnSync(process.execPath, [tsc, '-p', '.', '--noEmit', '--pretty', 'false'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const { ok, summary } = summarize(out, r);
  // The full output first, the verdict last, next to the check's own summary.
  return { ok, lines: ok ? [`ok    typecheck: ${summary}`] : [...(out ? [out] : []), `FAIL  typecheck: ${summary}`] };
}
