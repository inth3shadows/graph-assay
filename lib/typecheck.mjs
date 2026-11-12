// The type check `graph-assay check` runs: tsc over tsconfig.json with the pinned dev dependencies.
// typescript is a dev dependency, so a missing or stale install fails the check; it never skips.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './main.mjs';

const NPM_CI = 'run `npm ci --ignore-scripts`';
// One diagnostic per match: `file(line,col): error TSn:` or, for a global (option) error, `error TSn:`.
const DIAGNOSTIC = /^(?:(.+)\(\d+,\d+\): )?error TS\d+:/gm;
// lib/ holds only .mjs, so a diagnostic in any .json file is in a tsconfig or a config it extends.
const CONFIG_FILE = /\.json$/;

/** stdout then stderr, on a line boundary so a diagnostic opening stderr stays at a line start.
 * @param {{ stdout?: string | null, stderr?: string | null }} r */
export const joinOutput = (r) => [r.stdout, r.stderr].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');

/** Count tsc's `--pretty false` output. Diagnostics in a .json file or without a file are config errors.
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
  // tsc exits 1 or 2 when it reports diagnostics; its other lines are indented elaborations. Anything
  // else (another exit code, an unindented non-diagnostic line such as a crash trace) means a partial run.
  const unexpected = out.split('\n').some((l) => /^\S/.test(l) && !/^(?:.+\(\d+,\d+\): )?error TS\d+:/.test(l));
  const short = r.error || r.signal ? why
    : unexpected ? `unexpected output, ${why}`
      : r.status !== 1 && r.status !== 2 ? why : '';
  const parts = [type && `${type} type error${type === 1 ? '' : 's'}`, config && `${config} config error${config === 1 ? '' : 's'}`];
  return { ok: false, summary: `${parts.filter(Boolean).join(', ')} (tsc -p .${short ? `; cut short: ${short}` : ''})` };
}

/** Installed packages whose version differs from package-lock.json (missing ones too).
 * Entries without a version (links, workspaces) and absent optional ones are not checked.
 * @param {any} lock parsed package-lock.json: any JSON value, so a malformed one is refused rather than thrown on
 * @param {(dir: string) => string | null} installedVersion version in `<dir>/package.json`, or null
 * @returns {string[]} */
export function staleInstall(lock, installedVersion) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return ['package-lock.json is not a JSON object'];
  if (!lock.packages) return [`package-lock.json has no "packages" (lockfileVersion ${lock.lockfileVersion ?? '?'})`];
  const stale = [];
  for (const [dir, entry] of Object.entries(lock.packages)) {
    const { version, optional, devOptional } = entry ?? {};
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
  const out = joinOutput(r);
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

// `npm run typecheck`: the same check, guards included, without the rest of `graph-assay check`.
if (isMain(import.meta.url)) {
  const r = typecheck(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  console.log(r.lines.join('\n'));
  process.exit(r.ok ? 0 : 1);
}
