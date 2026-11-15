// How a subject's index process is isolated from the host (SECURITY.md). One runner for every adapter:
//   unshare  `unshare -rn`: no network (Linux with unprivileged user namespaces).
//   docker   a throwaway container (docker/sandbox.Dockerfile): no network, no capabilities, no new
//            privileges, read-only root, the caller's uid, and only these mounts: the indexed dir and
//            the sandbox HOME read-write, the subject's install read-only, each at its host path.
//            Where unshare only cuts the network, this also keeps the host's files (~/.ssh, other
//            repos, credentials) out of reach.
//   none     no isolation (macOS, or nothing above works): the subject runs with network access.
// GRAPH_ASSAY_SANDBOX_RO=<path>[:<path>...] adds read-only mounts to the docker backend (a toolchain the
// image lacks, such as a Homebrew prefix a venv's Python lives under).
// GRAPH_ASSAY_ISOLATION=unshare|docker|none picks one; otherwise the first that works, in that order
// (docker only once the image is built: tools/setup.sh). A caller that needs isolation passes
// `require: true` and gets a failed result instead of a run with network access.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SANDBOX_IMAGE = 'graph-assay-sandbox:1';
export const BACKENDS = ['unshare', 'docker', 'none'] as const;
export type Backend = (typeof BACKENDS)[number];

let chosen: Backend | undefined;
/** The isolation in use, chosen once per process (GRAPH_ASSAY_ISOLATION, else the first that works). */
export function backend(): Backend {
  if (chosen) return chosen;
  const forced = process.env.GRAPH_ASSAY_ISOLATION;
  if (forced) {
    if (!(BACKENDS as readonly string[]).includes(forced)) throw new Error(`GRAPH_ASSAY_ISOLATION must be one of ${BACKENDS.join(', ')}; got ${forced}`);
    return (chosen = forced as Backend);
  }
  if (spawnSync('unshare', ['-rn', 'true']).status === 0) return (chosen = 'unshare');
  if (spawnSync('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: 'ignore' }).status === 0) return (chosen = 'docker');
  return (chosen = 'none');
}
/** Tests only: forget the cached choice. */
export const resetBackend = () => { chosen = undefined; };
export const isolated = () => backend() !== 'none';
/** Extra read-only mounts for the docker backend (GRAPH_ASSAY_SANDBOX_RO). */
export const extraRo = () => (process.env.GRAPH_ASSAY_SANDBOX_RO ?? '').split(':').filter(Boolean).map((p) => path.resolve(p));

export type RunOptions = {
  cwd: string; env: Record<string, string>; timeoutMs: number; nice?: boolean; maxBuffer?: number;
  /** Paths the process may write (the indexed dir, its HOME). */ rw: string[];
  /** Paths it must read: the subject's install, its interpreter. */ ro: string[];
  /** Refuse to run without isolation. */ require?: boolean;
};
export type RunResult = { status: number | null; signal: ReturnType<typeof spawnSync>['signal']; stdout: string; stderr: string; error?: Error; isolation: Backend };

/** Run `argv` (absolute executable first) under the chosen isolation. */
export function run(argv: string[], o: RunOptions): RunResult {
  const how = backend();
  const nice = o.nice ? ['nice', '-n', '10'] : [];
  const spawn = (cmd: string[], env: Record<string, string>) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: o.cwd, env, encoding: 'utf8', maxBuffer: o.maxBuffer ?? 64 << 20, timeout: o.timeoutMs });
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, isolation: how };
  };
  if (how === 'none' && o.require) {
    return { status: 1, signal: null, stdout: '', stderr: '[graph-assay] refusing to run without isolation: unshare -rn does not work here and the sandbox image is not built (tools/setup.sh); see SECURITY.md', isolation: how };
  }
  if (how === 'unshare') return spawn([...nice, 'unshare', '-rn', ...argv], o.env);
  if (how === 'none') return spawn([...nice, ...argv], o.env);
  const name = `graph-assay-${process.pid}-${randomBytes(4).toString('hex')}`;
  const r = spawn(['docker', ...dockerArgs(argv, o, name)], { PATH: process.env.PATH ?? '/usr/bin:/bin' });
  // A timeout kills the docker client, not the container: remove it.
  if (r.signal || r.error) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  return r;
}

/** The `docker run` arguments for one isolated process (exported for the hermetic tests). */
export function dockerArgs(argv: string[], o: RunOptions, name: string) {
  const uid = process.getuid?.() ?? 0; const gid = process.getgid?.() ?? 0;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rw = [...new Set(o.rw.map(real))]; const ro = [...new Set([...o.ro, ...extraRo()].map(real))].filter((p) => !rw.includes(p));
  return ['run', '--rm', '--init', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp', '--pids-limit', '4096', '--user', `${uid}:${gid}`, '--workdir', real(o.cwd),
    ...rw.flatMap((p) => ['--volume', `${p}:${p}`]), ...ro.flatMap((p) => ['--volume', `${p}:${p}:ro`]),
    ...Object.entries(o.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    // The executable by its real path: a symlink in its path (a venv link) points outside the mounts.
    SANDBOX_IMAGE, ...(o.nice ? ['nice', '-n', '10'] : []), real(argv[0]), ...argv.slice(1)];
}

/**
 * A Python venv build's read-only mounts: the venv itself. Its interpreter (where `bin/python3` really
 * points; pyvenv.cfg can disagree) must be one the sandbox image has (/usr/bin); a venv made from another Python (Homebrew's, pyenv's) is refused
 * under docker with a message, since mounting a foreign interpreter tree would mount its whole prefix.
 */
export function venvMounts(build: string): { ro: string[]; error: string | null } {
  const real = fs.realpathSync(build);
  for (let d = path.dirname(real); d !== path.dirname(d); d = path.dirname(d)) {
    const cfg = path.join(d, 'pyvenv.cfg');
    if (!fs.existsSync(cfg)) continue;
    const exe = ['python3', 'python'].map((x) => path.join(d, 'bin', x)).find((x) => fs.existsSync(x));
    const home = exe ? path.dirname(fs.realpathSync(exe)) : (/^home\s*=\s*(.+)$/m.exec(fs.readFileSync(cfg, 'utf8'))?.[1].trim() ?? '');
    const mounted = home === '/usr/bin' || extraRo().some((m) => home === m || home.startsWith(`${m}/`));
    const error = backend() === 'docker' && !mounted
      ? `[graph-assay] the docker sandbox has no Python at ${home || '(unknown)'}, which the venv ${d} was made from: re-run tools/setup.sh with python3 = /usr/bin/python3.12, or mount that Python's prefix with GRAPH_ASSAY_SANDBOX_RO` : null;
    return { ro: [d, path.dirname(build)], error };
  }
  return { ro: [path.dirname(build)], error: null };
}
