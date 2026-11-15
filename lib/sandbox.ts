// How a subject's index process is isolated from the host (SECURITY.md). One runner for every adapter:
//   unshare  `unshare -rn`: no network (Linux with unprivileged user namespaces).
//   docker   a throwaway container (docker/sandbox.Dockerfile): no network, no capabilities, no new
//            privileges, read-only root, the caller's uid, a lifetime bounded inside the container, and
//            only these bind mounts: the indexed dir and the sandbox HOME read-write, the subject's
//            install read-only, each at the path the caller gave (and at its real path, if a symlink
//            leads there). Where unshare only cuts the network, this also keeps the host's other files
//            (~/.ssh, other repos, credentials) out of reach.
//   none     no isolation (macOS, or nothing above works): the subject runs with network access.
// GRAPH_ASSAY_ISOLATION=unshare|docker|none picks one; otherwise the first that works, in that order
// (docker only once the image is built: tools/setup.sh), with a warning when that is none. A caller
// that needs isolation passes `require: true` and gets a failed result instead of a run with network.
// GRAPH_ASSAY_SANDBOX_RO=<path>[:<path>...] adds read-only mounts to the docker backend (a toolchain the
// image lacks, such as the prefix of a venv's Python).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const SANDBOX_IMAGE = 'graph-assay-sandbox:1';
export const BACKENDS = ['unshare', 'docker', 'none'] as const;
export type Backend = (typeof BACKENDS)[number];
/** The image's Python, the only interpreter a venv may use under docker (unless mounted). */
export const IMAGE_PYTHON = '/usr/bin/python3.12';
/** How long the docker probe may take: a hung or unreachable daemon must not stall every index. */
const PROBE_MS = 5_000;
/** Host dirs the image has its own copy of: mounting one would replace the image's. */
const SYSTEM = new Set(['/', '/bin', '/sbin', '/lib', '/lib64', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/etc', '/tmp']);

/** The docker client's own environment, the same for every docker call: which daemon and config. */
export function dockerEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const [k, v] of Object.entries(process.env)) if (/^DOCKER_/.test(k) && v !== undefined) env[k] = v;
  env.DOCKER_CONFIG ??= path.join(os.homedir(), '.docker');
  return env;
}

let chosen: Backend | undefined;
/** The isolation in use, chosen once per process (GRAPH_ASSAY_ISOLATION, else the first that works). */
export function backend(): Backend {
  if (chosen) return chosen;
  const forced = process.env.GRAPH_ASSAY_ISOLATION;
  if (forced) {
    if (!(BACKENDS as readonly string[]).includes(forced)) throw new Error(`GRAPH_ASSAY_ISOLATION must be one of ${BACKENDS.join(', ')}; got ${forced}`);
    return (chosen = forced as Backend);
  }
  if (spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore', timeout: PROBE_MS }).status === 0) return (chosen = 'unshare');
  if (spawnSync('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: 'ignore', env: dockerEnv(), timeout: PROBE_MS }).status === 0) return (chosen = 'docker');
  console.error(`[graph-assay] no isolation: unshare -rn does not work here and the ${SANDBOX_IMAGE} image is not usable (tools/setup.sh); subjects index with network access (SECURITY.md)`);
  return (chosen = 'none');
}
/** Tests only: forget the cached choice. */
export const resetBackend = () => { chosen = undefined; };
export const isolated = () => backend() !== 'none';
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** Extra read-only mounts for the docker backend (GRAPH_ASSAY_SANDBOX_RO). */
export const extraRo = () => (process.env.GRAPH_ASSAY_SANDBOX_RO ?? '').split(':').filter(Boolean).map((p) => path.resolve(p));

export type RunOptions = {
  cwd: string; env: Record<string, string>; timeoutMs: number; nice?: boolean; maxBuffer?: number;
  /** Paths the process may write (the indexed dir, its HOME). */ rw: string[];
  /** Paths it must read besides the executable (mounted by itself): the subject's install. */ ro: string[];
  /** The executable is a Python venv's script: mount the venv and check its interpreter. */ venv?: boolean;
  /** Refuse to run without isolation. */ require?: boolean;
};
export type RunResult = { status: number | null; signal: ReturnType<typeof spawnSync>['signal']; stdout: string; stderr: string; error?: Error; isolation: Backend };
const failed = (how: Backend, stderr: string): RunResult => ({ status: 1, signal: null, stdout: '', stderr: `[graph-assay] ${stderr}`, isolation: how });

/** Run `argv` (absolute executable first) under the chosen isolation. */
export function run(argv: string[], o: RunOptions): RunResult {
  const how = backend();
  const nice = o.nice ? ['nice', '-n', '10'] : [];
  const spawn = (cmd: string[], env: Record<string, string>) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: o.cwd, env, encoding: 'utf8', maxBuffer: o.maxBuffer ?? 64 << 20, timeout: o.timeoutMs });
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, isolation: how };
  };
  if (how === 'none' && o.require) return failed(how, 'refusing to run without isolation: unshare -rn does not work here and the sandbox image is not built (tools/setup.sh); see SECURITY.md');
  if (how === 'unshare') return spawn([...nice, 'unshare', '-rn', ...argv], o.env);
  if (how === 'none') return spawn([...nice, ...argv], o.env);
  const plan = dockerPlan(argv, o, `graph-assay-${process.pid}-${randomBytes(4).toString('hex')}`);
  if ('error' in plan) return failed(how, plan.error);
  const r = spawn(['docker', ...plan.args], plan.clientEnv);
  // A timeout kills the docker client, not the container: remove it (the inner timeout bounds it anyway).
  if (r.signal || r.error) spawnSync('docker', ['rm', '-f', plan.name], { stdio: 'ignore', env: dockerEnv(), timeout: 30_000 });
  return r;
}

/**
 * The `docker run` arguments and the docker client's environment for one isolated process (exported
 * for the hermetic tests), or why it cannot run. Each mount binds the path's real source to the path
 * the caller gave (and to the real path, when they differ), so args and env that name the given paths
 * work inside. `--mount` refuses a missing source where `--volume` would create a root-owned one.
 * The subject's environment travels by name (`--env K`), its values in the client's environment, so
 * they are not on the docker command line.
 */
export function dockerPlan(argv: string[], o: RunOptions, name: string): { args: string[]; clientEnv: Record<string, string>; name: string } | { error: string } {
  const uid = process.getuid?.() ?? 0; const gid = process.getgid?.() ?? 0;
  const exe = real(argv[0]);
  const ro = [...o.ro, ...extraRo()];
  if (o.venv && fs.existsSync(argv[0])) {
    const v = venvOf(argv[0]);
    if (v.error) return { error: v.error };
    if (v.root) ro.push(v.root);
  }
  const binds = new Map<string, { src: string; ro: boolean }>(); // dst -> source
  const add = (p: string, readOnly: boolean) => {
    const src = real(p);
    for (const dst of new Set([path.resolve(p), src])) if (!binds.has(dst) || !readOnly) binds.set(dst, { src, ro: readOnly });
  };
  for (const p of o.rw) add(p, false);
  for (const p of ro) add(p, true);
  // the executable by itself (never its whole directory), unless a mount already holds it
  if (![...binds.keys()].some((d) => exe === d || exe.startsWith(`${d}/`))) binds.set(exe, { src: exe, ro: true });
  const shadow = [...binds.keys()].filter((d) => SYSTEM.has(d));
  if (shadow.length) return { error: `refusing to mount ${shadow.join(', ')} over the sandbox image's own` };
  // TMPDIR must be writable inside: one outside the mounts moves under the sandbox HOME (or /tmp).
  const env = { ...o.env };
  const writable = (p: string) => [...binds].some(([d, b]) => !b.ro && (p === d || p.startsWith(`${d}/`)));
  if (env.TMPDIR && !writable(path.resolve(env.TMPDIR))) {
    env.TMPDIR = env.HOME && writable(path.resolve(env.HOME)) ? path.join(env.HOME, 'tmp') : '/tmp';
    if (env.TMPDIR !== '/tmp') fs.mkdirSync(env.TMPDIR, { recursive: true });
  }
  const seconds = Math.ceil(o.timeoutMs / 1000) + 5; // after the caller's own timeout, which removes it first
  const passed = Object.keys(env).filter((k) => k !== 'PATH');
  return {
    name,
    clientEnv: { ...Object.fromEntries(passed.map((k) => [k, env[k]])), ...dockerEnv() },
    args: ['run', '--rm', '--init', '--name', name, '--label', 'graph-assay.sandbox=1', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--pids-limit', '4096', '--user', `${uid}:${gid}`,
      '--workdir', path.resolve(o.cwd),
      ...[...binds].flatMap(([dst, b]) => ['--mount', `type=bind,source=${b.src},target=${dst}${b.ro ? ',readonly' : ''}`]),
      ...(env.PATH ? ['--env', `PATH=${env.PATH}`] : []), ...passed.flatMap((k) => ['--env', k]),
      SANDBOX_IMAGE, 'timeout', '-k', '10', String(seconds), ...(o.nice ? ['nice', '-n', '10'] : []), exe, ...argv.slice(1)],
  };
}

/**
 * The venv a script belongs to (the dir holding pyvenv.cfg) and, under docker, whether its interpreter
 * runs there: where `bin/python3` really points (pyvenv.cfg can disagree) must be the image's
 * /usr/bin/python3.12 or sit under a GRAPH_ASSAY_SANDBOX_RO prefix. A venv made from another Python
 * (another version, Homebrew's, pyenv's) gets a message instead of an opaque exec failure.
 */
export function venvOf(script: string): { root: string | null; error: string | null } {
  for (let d = path.dirname(real(script)); d !== path.dirname(d); d = path.dirname(d)) {
    if (!fs.existsSync(path.join(d, 'pyvenv.cfg'))) continue;
    const link = ['python3', 'python'].map((x) => path.join(d, 'bin', x)).find((x) => fs.existsSync(x));
    const py = link ? real(link) : null;
    const ok = py === IMAGE_PYTHON || (py !== null && extraRo().map(real).some((m) => py.startsWith(`${m}/`)));
    return { root: d, error: ok ? null : `the docker sandbox has no Python at ${py ?? '(none found)'}, which the venv ${d} uses: re-run tools/setup.sh where ${IMAGE_PYTHON} exists, or mount that Python's prefix with GRAPH_ASSAY_SANDBOX_RO` };
  }
  return { root: null, error: null };
}
