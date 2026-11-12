// The type check `graph-assay check` runs: tsc over tsconfig.json with the pinned dev dependencies.
// typescript is a dev dependency, so a missing or stale install fails the check; it never skips.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './main.ts';

const NPM_CI = 'run `npm ci --ignore-scripts`';
// One diagnostic per match: `file(line,col): error TSn:` or, for a global (option) error, `error TSn:`.
const DIAGNOSTIC = /^(?:(.+)\(\d+,\d+\): )?error TS\d+:/gm;
const TSCONFIG = /^tsconfig.*\.json$/;
// A stack frame: tsc (or node) crashed, so the diagnostics before it are a partial list.
const STACK_FRAME = /^\s+at \S/m;

/** Paths, relative to `root`, of the configs tsconfig.json extends, transitively: relative, absolute
 * and package `extends`, as tsc itself resolves them (it is asked, with the project's own typescript).
 * JSONC is fine, and a recoverable syntax error does not end the chain. [] when typescript cannot load
 * or its config API throws: the chain only labels errors, so it must never cost the diagnostics. */
export function extendsChain(root: string): string[] {
  const abs = path.resolve(root);
  let ts: any;
  try { ts = createRequire(path.join(abs, 'package.json'))('typescript'); } catch { return []; }
  // An unrecoverable config error (no tsconfig.json at all) is tsc's to report, not ours.
  try {
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(abs, 'tsconfig.json'), undefined, host);
    const files: string[] = parsed?.options?.configFile?.extendedSourceFiles ?? [];
    return files.map((f) => path.relative(abs, f));
  } catch { return []; }
}

/** stdout then stderr, on a line boundary so a diagnostic opening stderr stays at a line start. */
export const joinOutput = (r: { stdout?: string | null, stderr?: string | null }): string => [r.stdout, r.stderr].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');

/** Count tsc's `--pretty false` output. Config errors: no file, a tsconfig*.json, or a file in `configFiles`.
 * `out` is tsc's stdout + stderr; `configFiles` are the configs tsconfig.json extends, relative to the project root. */
export function summarize(out: string, r: { status: number | null, signal?: string | null, error?: Error }, configFiles: string[] = []): { ok: boolean, summary: string } {
  if (r.status === 0 && !r.error) return { ok: true, summary: 'tsc -p . (0 errors)' };
  let type = 0; let config = 0;
  for (const m of out.matchAll(DIAGNOSTIC)) {
    if (!m[1] || TSCONFIG.test(path.basename(m[1])) || configFiles.includes(path.normalize(m[1]))) config++; else type++;
  }
  const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  if (!type && !config) return { ok: false, summary: `tsc failed (${why}) with no diagnostics` };
  // tsc exits 1 or 2 when it reports diagnostics. Another exit code, or a stack frame in the output
  // (a crash after some diagnostics), means a partial run.
  const short = r.error || r.signal ? why
    : STACK_FRAME.test(out) ? `crashed, ${why}`
      : r.status !== 1 && r.status !== 2 ? why : '';
  const parts = [type && `${type} type error${type === 1 ? '' : 's'}`, config && `${config} config error${config === 1 ? '' : 's'}`];
  return { ok: false, summary: `${parts.filter(Boolean).join(', ')} (tsc -p .${short ? `; cut short: ${short}` : ''})` };
}

/** Installed packages whose version differs from package-lock.json (missing ones too).
 * Entries without a version (links, workspaces) and absent optional ones are not checked.
 * `lock` is the parsed package-lock.json: any JSON value, so a malformed one is refused rather than thrown on.
 * `installedVersion` gives the version in `<dir>/package.json`, or null. */
export function staleInstall(lock: unknown, installedVersion: (dir: string) => string | null): string[] {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return ['package-lock.json is not a JSON object'];
  const { packages, lockfileVersion } = lock as { packages?: unknown, lockfileVersion?: unknown };
  if (packages !== undefined && (!packages || typeof packages !== 'object' || Array.isArray(packages))) return ['package-lock.json "packages" is not an object'];
  if (!packages) return [`package-lock.json has no "packages" (lockfileVersion ${lockfileVersion ?? '?'})`];
  const stale: string[] = [];
  for (const [dir, entry] of Object.entries(packages)) {
    const name = dir.replace(/^node_modules\//, '');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { stale.push(`${name}: lockfile entry is not an object`); continue; }
    const { version, optional, devOptional } = entry as { version?: unknown, optional?: unknown, devOptional?: unknown };
    if (!dir || version === undefined) continue; // the root project; links and workspaces
    const have = installedVersion(dir);
    if (have === null && (optional || devOptional)) continue; // optional packages install only on matching platforms
    if (have !== version) stale.push(`${name} ${have ?? 'missing'} (lockfile ${version})`);
  }
  return stale;
}

/** Run tsc in `root` (no install checks). Returns the lines to print, last one the verdict.
 * `extra`: more tsc arguments (`npm run typecheck -- <flags>`). */
export function runTsc(root: string, extra: string[] = []): { ok: boolean, lines: string[] } {
  root = path.resolve(root); // tsc runs with cwd = root, so a relative path would resolve twice
  // --noEmit on the command line too: an unparseable tsconfig.json makes tsc fall back to defaults and emit .js.
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', '.', '--noEmit', '--pretty', 'false', ...extra],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const out = joinOutput(r);
  // The extends chain only labels errors, and loading typescript to find it costs ~0.4 s: only on a failure.
  const failed = r.status !== 0 || !!r.error;
  const { ok, summary } = summarize(out, r, failed ? extendsChain(root) : []);
  // The full output first, the verdict last, next to the check's own summary.
  // tsc prints nothing on a clean run unless asked (e.g. --listFilesOnly); show whatever it printed.
  return { ok, lines: [...(out ? [out] : []), `${ok ? 'ok   ' : 'FAIL '} typecheck: ${summary}`] };
}

/** The check's type check: refuse a missing or stale install, then run tsc.
 * `extra`: more tsc arguments. */
export function typecheck(root: string, extra: string[] = []): { ok: boolean, lines: string[] } {
  const refuse = (why: string) => ({ ok: false, lines: [`FAIL  typecheck: ${why}; ${NPM_CI}`] });
  if (!fs.existsSync(path.join(root, 'node_modules/typescript/bin/tsc'))) return refuse('node_modules/typescript is missing');
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')); } catch (e) {
    return refuse(`cannot read package-lock.json (${e.code ?? e.message})`);
  }
  const stale = staleInstall(lock, (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
  });
  if (stale.length) return refuse(`node_modules does not match package-lock.json (${stale.join('; ')})`);
  return runTsc(root, extra);
}

// `npm run typecheck`: the same check, guards included, without the rest of `graph-assay check`.
if (isMain(import.meta.url)) {
  const r = typecheck(path.dirname(path.dirname(fileURLToPath(import.meta.url))), process.argv.slice(2));
  console.log(r.lines.join('\n'));
  // exitCode, not exit(): exit() can cut off output still queued for a pipe.
  process.exitCode = r.ok ? 0 : 1;
}
