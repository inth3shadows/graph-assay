// How a subject's index process is isolated from the host (SECURITY.md). One runner for every adapter:
//   unshare  `unshare -rn`: no network (Linux with unprivileged user namespaces).
//   docker   a throwaway container (docker/sandbox.Dockerfile): no network, no capabilities, no new
//            privileges, read-only root, the caller's uid, a lifetime bounded inside the container, and
//            only these bind mounts: the indexed dir and the subject's install read-only, the sandbox
//            HOME and the subject's own output dirs read-write, each at the path the caller gave (and at
//            its real path, if a symlink leads there). The indexed dir is read-only because the host
//            runs git and the oracle in it afterwards: a tool that could write it could plant a git
//            config (core.fsmonitor) or a link the host would then follow (#51). Where unshare only cuts the network, this also keeps the host's other files
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
  /** Paths the process may write (its HOME, its own output dirs): nested inside an `ro` path is fine. */ rw: string[];
  /** Paths it must read besides the executable (mounted by itself): the indexed dir, the subject's install. */ ro: string[];
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
  // A rw dir whose parent lies inside a ro mount (an output dir in the repo) must be a plain directory:
  // a link the repo tracks there (`.codegraph -> .`, `-> .git`, `-> ~`) would mount its target
  // read-write (#52). Real paths on both sides, so neither may be named through a link to dodge it.
  for (const w of o.rw) {
    const parent = real(path.dirname(path.resolve(w)));
    if (!ro.some((r) => { const rr = real(r); return parent === rr || parent.startsWith(`${rr}/`); })) continue;
    const st = fs.lstatSync(w, { throwIfNoEntry: false });
    if (!st?.isDirectory()) return { error: `refusing to mount ${w} read-write: inside a read-only mount it must be a plain directory, not a link (one the repository tracks?) or a file` };
  }
  const binds = new Map<string, { src: string; ro: boolean }>(); // dst -> source
  let clash = '';
  const add = (p: string, readOnly: boolean) => {
    const src = real(p);
    for (const dst of new Set([path.resolve(p), src])) {
      if (binds.has(dst) && binds.get(dst)!.ro !== readOnly) clash ||= dst;
      binds.set(dst, { src, ro: readOnly });
    }
  };
  for (const p of o.rw) add(p, false);
  for (const p of ro) add(p, true);
  if (clash) return { error: `refusing to mount ${clash} both read-only and read-write` };
  // the executable by itself (never its whole directory), unless a mount already holds it
  if (![...binds.keys()].some((d) => exe === d || exe.startsWith(`${d}/`))) binds.set(exe, { src: exe, ro: true });
  // a parent before anything mounted inside it (a rw output dir inside the ro repo), whatever the order given
  const depth = (d: string) => d.split('/').length;
  const ordered = [...binds].sort(([a], [b]) => depth(a) - depth(b));
  // --mount is comma-separated: a `,` (or `"`, or a newline) in a path would end the field and could
  // add options (a second source=), so such a path is refused rather than quoted.
  const unsafe = [...binds].flatMap(([d, b]) => [d, b.src]).filter((p) => /[,"\n\r]/.test(p));
  if (unsafe.length) return { error: `refusing to mount a path with a comma, quote or line break: ${JSON.stringify(unsafe[0])}` };
  const shadow = [...binds.keys()].filter((d) => SYSTEM.has(d));
  if (shadow.length) return { error: `refusing to mount ${shadow.join(', ')} over the sandbox image's own` };
  // TMPDIR must be writable inside: one outside the mounts moves under the sandbox HOME (or /tmp).
  const env = { ...o.env };
  const writable = (p: string) => [...binds].some(([d, b]) => !b.ro && (p === d || p.startsWith(`${d}/`)));
  if (env.TMPDIR && !writable(path.resolve(env.TMPDIR))) {
    env.TMPDIR = env.HOME && writable(path.resolve(env.HOME)) ? path.join(env.HOME, 'tmp') : '/tmp';
    if (env.TMPDIR !== '/tmp') fs.mkdirSync(env.TMPDIR, { recursive: true });
  }
  // after the caller's own timeout, which removes it first; none when the caller sets none (0 or unset)
  const bound = o.timeoutMs > 0 ? ['timeout', '-k', '10', String(Math.ceil(o.timeoutMs / 1000) + 5)] : [];
  // DOCKER_* configure the client (dockerEnv), never the subject
  const passed = Object.keys(env).filter((k) => k !== 'PATH' && !/^DOCKER_/.test(k));
  return {
    name,
    clientEnv: { ...Object.fromEntries(passed.map((k) => [k, env[k]])), ...dockerEnv() },
    args: ['run', '--rm', '--init', '--pull', 'never', '--name', name, '--label', 'graph-assay.sandbox=1', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--pids-limit', '4096', '--user', `${uid}:${gid}`,
      '--workdir', path.resolve(o.cwd),
      ...ordered.flatMap(([dst, b]) => ['--mount', `type=bind,source=${b.src},target=${dst}${b.ro ? ',readonly' : ''}`]),
      ...(env.PATH ? ['--env', `PATH=${env.PATH}`] : []), ...passed.flatMap((k) => ['--env', k]),
      SANDBOX_IMAGE, ...bound, ...(o.nice ? ['nice', '-n', '10'] : []), exe, ...argv.slice(1)],
  };
}

/**
 * The venv a script belongs to (`<venv>/bin/<script>` with `<venv>/pyvenv.cfg`) and, under docker,
 * whether its interpreter runs there. Every hop of `bin/python3`'s link chain must exist inside the
 * container: inside the venv, the image's /usr/bin/python3.12 itself, or under a GRAPH_ASSAY_SANDBOX_RO
 * prefix. Resolving the whole chain on the host is not enough: `bin/python3 -> /usr/bin/python3 ->
 * python3.12` ends at the image's Python, but the image has no /usr/bin/python3 (pyvenv.cfg can disagree
 * too). A venv made from another Python gets a message instead of an opaque exec failure.
 */
export function venvOf(script: string): { root: string | null; error: string | null } {
  // A venv made through a symlinked path keeps that path in its scripts: the root is the venv as the
  // caller reached it (mounted there and at its real path), else as the script really lives.
  const given = path.dirname(path.dirname(path.resolve(script))); const reallyAt = path.dirname(path.dirname(real(script)));
  const d = fs.existsSync(path.join(given, 'pyvenv.cfg')) ? given : reallyAt;
  if (!fs.existsSync(path.join(d, 'pyvenv.cfg'))) return { root: null, error: null };
  // only what dockerPlan mounts: the venv root (at the path it was reached by and its real path)
  const mounted = [d, real(d), ...extraRo().flatMap((m) => [path.resolve(m), real(m)])];
  const inside = (p: string) => p === IMAGE_PYTHON || mounted.some((m) => p === m || p.startsWith(`${m}/`));
  let p = ['python3', 'python'].map((x) => path.join(d, 'bin', x)).find((x) => fs.lstatSync(x, { throwIfNoEntry: false }));
  const why = (at: string) => ({ root: d, error: `the docker sandbox has no Python at ${at}, which the venv ${d} uses: re-run tools/setup.sh where ${IMAGE_PYTHON} exists, or mount that Python's prefix with GRAPH_ASSAY_SANDBOX_RO` });
  if (!p) return why('(none found)');
  for (let hop = 0; hop < 40; hop++) {
    if (!inside(p)) return why(p);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return why(`${p} (a dangling link)`);
    if (!st.isSymbolicLink()) return { root: d, error: null };
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
  return why(`${p} (a link loop)`);
}

/**
 * Whether `p` stays inside `root` once every link is followed (`p` itself need not exist yet). A
 * sandboxed subject had write access to its mounts, so the host must not follow a link it may have
 * planted there to another host path when it reads or writes the subject's output afterwards.
 */
export function within(root: string, p: string) {
  const r = real(root);
  let t: string;
  try {
    // a link that cannot be followed (dangling, a loop, no permission) counts as outside
    if (fs.lstatSync(p, { throwIfNoEntry: false })) t = fs.realpathSync(p);
    else {
      // missing: its nearest existing ancestor, resolved, plus the rest (which holds no link yet)
      let a = path.isAbsolute(p) ? p : `${process.cwd()}/${p}`; const rest: string[] = [];
      while (!fs.lstatSync(a, { throwIfNoEntry: false })) { rest.unshift(path.basename(a)); if (path.dirname(a) === a) return false; a = path.dirname(a); }
      // a `..` after a missing dir can step back into an existing one, through links joining cannot see
      if (rest.includes('..')) return false;
      t = path.join(fs.realpathSync(a), ...rest);
    }
  } catch { return false; }
  return t === r || t.startsWith(`${r}/`);
}
/**
 * Why the tool-writable tree at `p` must not be touched, or null: any entry in it (or `p` itself) that
 * is not a plain file or directory (a link, FIFO, socket or device). The sandboxed tool could write
 * there, so the host checks the whole tree once, after the run and before it opens anything in it,
 * instead of guarding each path it opens (SQLite alone opens -wal, -shm and -journal files beside a
 * database). A missing `p` is fine: the caller reports a missing output its own way.
 */
export function vet(p: string): string | null {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) { const bad = vet(path.join(p, e)); if (bad) return bad; }
      return null;
    }
  } catch (e) {
    // a tree the tool made too deep (ENAMETOOLONG) or unreadable (EACCES) is a failed index, not a throw
    return `[graph-assay] cannot check ${p} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); the indexed tool's output is not read`;
  }
  return st.isFile() ? null : `[graph-assay] ${p} is ${st.isSymbolicLink() ? 'a link' : 'not a plain file'}; the indexed tool's output must hold only files and directories, so it is not read`;
}
/** vet() for each of `trees`: the first problem, or null. */
export const vetAll = (...trees: string[]) => trees.map(vet).find(Boolean) ?? null;

/**
 * Remove a temp tree the sandboxed tool could write (its HOME): it may have left a directory it made
 * unreadable (mode 000), which rmSync cannot descend. Such dirs get their owner bits back, then it
 * retries. Links are never followed (lstat), so this changes nothing outside `p`.
 */
export function remove(p: string) {
  try { fs.rmSync(p, { recursive: true, force: true }); return; } catch { /* below */ }
  // `chmod -R u+rwx` and `rm -rf` descend by directory handle, so a tree too deep for one path
  // (ENAMETOOLONG) goes too; chmod -R never follows a link below p (GNU default -P).
  spawnSync('chmod', ['-R', 'u+rwx', '--', p], { stdio: 'ignore' });
  spawnSync('rm', ['-rf', '--', p], { stdio: 'ignore' });
  // cleanup never replaces the caller's result: what is left is reported, not thrown
  if (fs.lstatSync(p, { throwIfNoEntry: false })) console.error(`[graph-assay] could not remove ${p}`);
}

/**
 * Prepare `p`, a tool's output dir inside the indexed repo, before it is mounted read-write: a plain
 * directory made by the host. A link or file the repository tracks there is removed (the entry, never
 * its target), so its target is never mounted; `fresh` also empties a directory (output an earlier run
 * or the repository left). The repo dir must exist: no index of a dir that is not there. Returns why
 * it could not, or null.
 */
export function outputDir(p: string, fresh = false): string | null {
  try {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    const keep = st?.isDirectory() && !fresh;
    if (st && !keep) remove(p); // also a tree an earlier run left unreadable or too deep
    if (!keep) fs.mkdirSync(p);
    return null;
  } catch (e) {
    return `[graph-assay] cannot prepare ${p} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
}

/** `p` if it stays inside `root` (within()), else an Error naming it. */
export function confined(root: string, p: string) {
  if (!within(root, p)) throw new Error(`[graph-assay] ${p} leads outside ${root}; refusing to follow it (a link left by the indexed tool?)`);
  return p;
}
