// The type check `graph-assay check` runs: tsc over tsconfig.json with the pinned dev dependencies.
// typescript is a dev dependency, so a missing or stale install fails the check; it never skips.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NPM_CI = 'run `npm ci --ignore-scripts`';
// One diagnostic per match: `file(line,col): error TSn:` or, for a global (option) error, `error TSn:`.
const DIAGNOSTIC = /^(?:(.+)\(\d+,\d+\): )?error TS\d+:/gm;
const CONFIG_FILE = /^tsconfig.*\.json$/;

/** Count tsc's `--pretty false` output. Diagnostics in a tsconfig*.json or without a file are config errors.
 * @param {string} out tsc stdout + stderr
 * @param {{ status: number | null, signal?: string | null, error?: Error }} r
 * @returns {{ ok: boolean, summary: string }} */
export function summarize(out, r) {
  if (r.status === 0 && !r.error) return { ok: true, summary: 'tsc -p . (0 errors)' };
  let type = 0; let config = 0;
  for (const m of out.matchAll(DIAGNOSTIC)) {
    if (!m[1] || CONFIG_FILE.test(path.basename(m[1]))) config++; else type++;
  }
  const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  if (!type && !config) return { ok: false, summary: `tsc failed (${why}) with no diagnostics` };
  const parts = [type && `${type} type error${type === 1 ? '' : 's'}`, config && `${config} config error${config === 1 ? '' : 's'}`];
  // A spawn error or signal means the output, and so the count, may be partial.
  const cut = r.error || r.signal ? `; cut short: ${why}` : '';
  return { ok: false, summary: `${parts.filter(Boolean).join(', ')} (tsc -p .${cut})` };
}

/** Installed packages whose version differs from package-lock.json (missing ones too).
 * Entries without a version (links, workspaces) and absent optional ones are not checked.
 * @param {{ lockfileVersion?: number, packages?: Record<string, { version?: string, optional?: boolean, devOptional?: boolean, [k: string]: unknown }>, [k: string]: unknown }} lock
 * @param {(dir: string) => string | null} installedVersion version in `<dir>/package.json`, or null
 * @returns {string[]} */
export function staleInstall(lock, installedVersion) {
  if (!lock.packages) return [`package-lock.json has no "packages" (lockfileVersion ${lock.lockfileVersion ?? '?'})`];
  const stale = [];
  for (const [dir, { version, optional, devOptional }] of Object.entries(lock.packages)) {
    if (!dir || version === undefined) continue; // the root project; links and workspaces
    const have = installedVersion(dir);
    if (have === null && (optional || devOptional)) continue; // optional packages install only on matching platforms
    if (have !== version) stale.push(`${dir.replace(/^node_modules\//, '')} ${have ?? 'missing'} (lockfile ${version})`);
  }
  return stale;
}

/** Run tsc in `root` (no install checks). Returns the lines to print, last one the verdict.
 * @param {string} root
 * @returns {{ ok: boolean, lines: string[] }} */
export function runTsc(root) {
  // --noEmit on the command line too: an unparseable tsconfig.json makes tsc fall back to defaults and emit .js.
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', '.', '--noEmit', '--pretty', 'false'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const { ok, summary } = summarize(out, r);
  // The full output first, the verdict last, next to the check's own summary.
  return { ok, lines: ok ? [`ok    typecheck: ${summary}`] : [...(out ? [out] : []), `FAIL  typecheck: ${summary}`] };
}

/** The check's type check: refuse a missing or stale install, then run tsc.
 * @param {string} root
 * @returns {{ ok: boolean, lines: string[] }} */
export function typecheck(root) {
  const refuse = (why) => ({ ok: false, lines: [`FAIL  typecheck: ${why}; ${NPM_CI}`] });
  if (!fs.existsSync(path.join(root, 'node_modules/typescript/bin/tsc'))) return refuse('node_modules/typescript is missing');
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')); } catch (e) {
    return refuse(`cannot read package-lock.json (${e.code ?? e.message})`);
  }
  const stale = staleInstall(lock, (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
  });
  if (stale.length) return refuse(`node_modules does not match package-lock.json (${stale.join('; ')})`);
  return runTsc(root);
}
